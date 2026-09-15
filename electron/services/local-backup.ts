import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { app } from 'electron';
import { DatabaseService } from './db.service';
import { localFileUrl, filePathFromUrl } from './local-file';

/**
 * 可备份的本地数据。
 * 全量备份的容器里还会带上书籍文件与封面（见 writeBackupArchive），
 * 这样换机器恢复时才真的能把书找回来；向量索引这类可重建数据始终不入备份。
 */
export interface BackupData {
  books?: any[];
  bookmarks?: any[];
  notes?: any[];
  words?: any[];
  sources?: any[];
  settings?: { key: string; value: string }[];
}

export interface BackupFile {
  version: 2;
  kind: 'full' | 'incremental';
  createdAt: string;
  /** 增量起点（该时刻之后的变更）；全量为 null */
  since: string | null;
  data: BackupData;
}

/** 纳入备份的设置项白名单（排除窗口尺寸这类设备相关值） */
const BACKUP_SETTINGS = [
  'fontSize', 'lineHeight', 'theme', 'fontFamily', 'ttsRate',
  'autoTheme', 'autoThemeDayStart', 'autoThemeNightStart', 'autoThemeDay', 'autoThemeNight',
  'aiProvider', 'aiBaseUrl', 'aiModel', 'aiEmbedUrl',
  // 键位与阅读样式属于「用户配置」，换机器恢复时最需要——
  // 漏掉它们会出现「备份还原后改键和自定义 CSS 全没了」
  'shortcutPreset', 'shortcutCustom', 'readingStylePreset', 'customReadingCss',
];

const TABLES = ['books', 'bookmarks', 'notes', 'words', 'book_sources'] as const;

/** 采集待备份数据；since 为 null 时全量，否则只取该时刻后变更的行 */
export function collectBackup(db: DatabaseService, since: string | null): BackupData {
  const data: BackupData = {};
  // 书签与笔记只带 book_id 是无法还原的：ID 是自增的，换台机器或删掉重导入后
  // 对不上，恢复时会把批注挂到别的书上（见 mergeBackup 的按书名匹配）。
  // 这里把书名一并写进备份，让恢复侧有据可依。
  const titleById = new Map<number, string>();
  for (const b of db.getAllBooks() as { id: number; title: string }[]) {
    titleById.set(b.id, b.title);
  }
  const withBookTitle = (rows: any[]) =>
    rows.map(r => ({ ...r, book_title: titleById.get(r.book_id) ?? '' }));

  for (const t of TABLES) {
    const rows = db.exportRowsSince(t, since);
    if (rows.length === 0) continue;
    if (t === 'book_sources') data.sources = rows;
    else if (t === 'books') data.books = rows;
    else if (t === 'bookmarks') data.bookmarks = withBookTitle(rows);
    else if (t === 'notes') data.notes = withBookTitle(rows);
    else data.words = rows;
  }
  // 设置全量带上（体量极小，且跨设备恢复时最需要）
  const settings = BACKUP_SETTINGS
    .map(k => ({ key: k, value: db.getSetting(k) }))
    .filter(s => s.value !== null) as { key: string; value: string }[];
  if (settings.length > 0) data.settings = settings;
  return data;
}

/** 生成备份文件内容 */
export function buildBackupFile(
  db: DatabaseService,
  since: string | null,
): BackupFile {
  return {
    version: 2,
    kind: since ? 'incremental' : 'full',
    createdAt: new Date().toISOString(),
    since,
    data: collectBackup(db, since),
  };
}

/** 写备份文件到磁盘（UTF-8 JSON）。快照仍是纯 JSON：体积小、随取随用 */
export function writeBackup(filePath: string, payload: BackupFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

// ============ 归档（zip）：全量备份连书籍文件一起带走 ============

/** 归档内的固定结构：backup.json + books/<书id>__<文件名> + covers/… */
const ARCHIVE_JSON = 'backup.json';
const ARCHIVE_BOOK_DIR = 'books';
const ARCHIVE_COVER_DIR = 'covers';

/** zip 的魔数判断：旧备份是 JSON 文本，两者靠头四个字节区分 */
const isZipBuffer = (buf: Buffer) =>
  buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/**
 * 把数据与书籍文件写成一个 zip。
 * 书籍文件多为已压缩格式（epub/漫画），再压一遍收益极小，所以用 STORE 原样存，
 * 省 CPU 也少一层解压出错的可能；只有 backup.json 走 DEFLATE。
 */
export async function writeBackupArchive(
  filePath: string,
  payload: BackupFile,
  files: { archiveName: string; sourcePath: string }[] = [],
): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const zip = new JSZip();
  zip.file(ARCHIVE_JSON, JSON.stringify(payload, null, 2));
  for (const f of files) {
    zip.file(f.archiveName, fs.readFileSync(f.sourcePath), { compression: 'STORE' });
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(filePath, buf);
}

/** 归档内书籍文件在 zip 里的路径 */
export const archiveEntryName = (kind: 'book' | 'cover', id: number, sourcePath: string) =>
  `${kind === 'book' ? ARCHIVE_BOOK_DIR : ARCHIVE_COVER_DIR}/${id}__${path.basename(sourcePath)}`;

/**
 * 挑出要随全量备份打包的书籍文件与封面。
 * 源文件已经不在本机的书（导入后把原文件删了、换了盘符）会被计入 skipped：
 * 这类书恢复时无法重建，界面上要如实说明，不能让用户以为备份是完整的。
 */
export function collectBookFileEntries(books: any[]): {
  files: { archiveName: string; sourcePath: string }[];
  skipped: number;
} {
  const files: { archiveName: string; sourcePath: string }[] = [];
  let skipped = 0;
  for (const b of books) {
    const src = b.file_path as string | undefined;
    if (!src || !fs.existsSync(src)) {
      skipped++;
      continue;
    }
    files.push({ archiveName: archiveEntryName('book', b.id, src), sourcePath: src });
    if (b.cover_path) {
      try {
        const coverPath = filePathFromUrl(b.cover_path as string);
        if (fs.existsSync(coverPath)) {
          files.push({ archiveName: archiveEntryName('cover', b.id, coverPath), sourcePath: coverPath });
        }
      } catch { /* 封面地址异常就不带，不影响正文 */ }
    }
  }
  return { files, skipped };
}

/**
 * 读取并校验备份（zip 归档与旧版 JSON 都认）。
 * 只取数据部分；书籍文件由 extractBackupFiles 单独还原。
 */
export async function readBackup(filePath: string): Promise<BackupFile> {
  const buf = fs.readFileSync(filePath);
  let text: string;
  if (isZipBuffer(buf)) {
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file(ARCHIVE_JSON);
    if (!entry) throw new Error('备份文件里没有数据部分，可能不是本软件导出的备份');
    text = await entry.async('string');
  } else {
    text = buf.toString('utf-8');
  }
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('备份文件不是合法的数据格式');
  }
  if (!parsed || parsed.version !== 2 || typeof parsed.data !== 'object') {
    throw new Error('备份文件格式不正确');
  }
  return parsed;
}

/**
 * 从 zip 备份里还原书籍文件与封面到书库目录。
 * 返回「备份中的书 id → 本地文件」，供 mergeBackup 重建书籍时使用；
 * 旧版 JSON 备份没有文件，返回空表（调用方据此跳过书籍重建）。
 */
export async function extractBackupFiles(
  filePath: string,
  targetDir: string,
): Promise<Map<number, { filePath: string; coverPath?: string }>> {
  const result = new Map<number, { filePath: string; coverPath?: string }>();
  const buf = fs.readFileSync(filePath);
  if (!isZipBuffer(buf)) return result;
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter(n => {
    const m = /^(books|covers)\/(\d+)__(.+)$/.exec(n);
    return !!m && !zip.files[n].dir;
  });
  if (names.length === 0) return result;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  for (const name of names) {
    const m = /^(books|covers)\/(\d+)__(.+)$/.exec(name)!;
    const kind = m[1] as 'books' | 'covers';
    const id = Number(m[2]);
    // 只取 basename：归档里的路径不可信，避免被写成路径穿越
    const base = path.basename(m[3]);
    if (!base) continue;
    // 与导入同一约定：加时间戳前缀，避免与书库里已有文件同名互相覆盖
    const dest = path.join(targetDir, `${Date.now()}-${base}`);
    const data = await zip.file(name)!.async('nodebuffer');
    fs.writeFileSync(dest, data);
    const cur = result.get(id) ?? { filePath: '' };
    if (kind === 'books') {
      cur.filePath = dest;
    } else {
      // 封面在库里存的是渲染进程用的协议地址，不是裸路径
      cur.coverPath = localFileUrl(dest);
    }
    result.set(id, cur);
  }
  return result;
}

/**
 * 合并备份数据到当前库。
 * 幂等：按自然键去重，重复恢复不会产生重复条目。
 * 返回本次实际新增/更新的条数。
 *
 * restoredFiles 是归档里还原出来的书籍文件（备份中的书 id → 本地文件）。
 * 有了它，本地没有的书会被重建；没有它（增量备份或旧版 JSON 备份）则只合并
 * 已有书的批注与进度，不会凭空造出一条打不开的记录。
 */
export function mergeBackup(
  db: DatabaseService,
  payload: BackupFile,
  restoredFiles?: Map<number, { filePath: string; coverPath?: string }>,
): number {
  const d = payload.data ?? {};
  let changed = 0;

  const books = db.getAllBooks() as any[];
  const findBook = (title: string) => books.find(b => b.title === title);
  const titleOf = (bookId: number) => books.find(b => b.id === bookId)?.title ?? '';

  // 1) 设置：直接覆盖（不含密钥类）
  for (const s of d.settings ?? []) {
    if (s.value != null && db.getSetting(s.key) !== s.value) {
      db.setSetting(s.key, s.value);
      changed++;
    }
  }

  // 2) 书籍：本地没有就用归档里的文件重建一本，已有则只按更晚的时间更新进度
  for (const rb of d.books ?? []) {
    const local = findBook(rb.title);
    if (!local) {
      const file = restoredFiles?.get(rb.id);
      if (!file?.filePath) continue;
      const newId = db.insertBook({
        title: rb.title,
        author: rb.author ?? undefined,
        cover_path: file.coverPath,
        file_path: file.filePath,
        file_type: rb.file_type,
        hash: rb.hash ?? '',
      }) as number | undefined;
      if (!newId) continue;
      // 书架上的元信息一并带回，否则恢复出来是一堆「未读、无分类、无评分」的书
      if (rb.progress) db.updateBookProgress(newId, rb.progress);
      if (rb.status) db.setBookStatus(newId, rb.status);
      if (rb.rating) db.setBookRating(newId, rb.rating);
      if (rb.category) db.setCategory(newId, rb.category);
      if (rb.series) db.setBookSeries(newId, rb.series);
      if (rb.favorite) db.setFavorite(newId, true);
      if (rb.locked) db.setBookLock(newId, true);
      // 目录与位置索引也带上：省一次重新解析，EPUB 的百分比跳转也能立刻用
      if (rb.toc) {
        try {
          db.setBookToc(newId, rb.toc, rb.toc_source === 'manual' ? 'manual' : 'auto');
        } catch { /* 目录异常不影响书籍本身 */ }
      }
      if (rb.locations) {
        try {
          db.setBookLocations(newId, rb.locations);
        } catch { /* 同上 */ }
      }
      // 让后面按书名找书签、笔记时能认领到这本新书
      books.push({ id: newId, title: rb.title, last_read_at: rb.last_read_at ?? null });
      changed++;
      continue;
    }
    const remoteAt = rb.last_read_at ?? '';
    const localAt = local.last_read_at ?? '';
    if (remoteAt > localAt) {
      db.updateBookProgress(local.id, rb.progress ?? 0);
      changed++;
    }
  }

  // 3) 书签：按「书名 + 位置」去重
  for (const m of d.bookmarks ?? []) {
    const local = findBook(m.book_title ?? titleOf(m.book_id));
    if (!local) continue;
    const exists = (db.getBookmarksByBookId(local.id) as any[]).some(x => x.position === m.position);
    if (!exists) {
      db.insertBookmark({ book_id: local.id, position: m.position, text: m.text, color: m.color });
      changed++;
    }
  }

  // 4) 笔记：按「书名 + 位置 + 正文」去重
  for (const n of d.notes ?? []) {
    const local = findBook(n.book_title ?? titleOf(n.book_id));
    if (!local) continue;
    const exists = (db.getNotesByBookId(local.id) as any[]).some(
      x => x.position === n.position && x.note === n.note,
    );
    if (!exists) {
      db.insertNote({
        book_id: local.id,
        position: n.position,
        selected_text: n.selected_text,
        note: n.note,
      });
      changed++;
    }
  }

  // 5) 生词本：按词条去重
  const words = db.getAllWords() as any[];
  for (const w of d.words ?? []) {
    if (!w.word) continue;
    if (words.some(x => x.word === w.word)) continue;
    db.insertWord({
      book_id: null,
      word: w.word,
      definition: w.definition ?? '',
      context: w.context ?? '',
    });
    changed++;
  }

  // 6) 书源：按「名称 + 地址」去重
  const sources = db.getAllSources() as any[];
  for (const s of d.sources ?? []) {
    if (!s.name) continue;
    if (sources.some(x => x.name === s.name && x.url === s.url)) continue;
    db.insertSource({
      name: s.name,
      url: s.url ?? '',
      search_url: s.search_url ?? '',
      chapters_url: s.chapters_url ?? '',
      content_url: s.content_url ?? '',
      rules: s.rules ?? '',
    });
    changed++;
  }

  return changed;
}

// ============ 本地快照 ============

export function snapshotDir(): string {
  const dir = path.join(app.getPath('userData'), 'snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成一份全量快照，返回文件路径 */
export function createSnapshot(db: DatabaseService): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(snapshotDir(), `snapshot-${stamp}.json`);
  writeBackup(file, buildBackupFile(db, null));
  return file;
}

export interface SnapshotInfo {
  file: string;
  name: string;
  createdAt: string;
  sizeKB: number;
}

export function listSnapshots(): SnapshotInfo[] {
  const dir = snapshotDir();
  return fs
    .readdirSync(dir)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
    .map(f => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return {
        file: full,
        name: f,
        createdAt: stat.mtime.toISOString(),
        sizeKB: Math.max(1, Math.round(stat.size / 1024)),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 只保留最近 max 份快照，返回删除数量 */
export function pruneSnapshots(max = 14): number {
  const list = listSnapshots();
  const stale = list.slice(max);
  for (const s of stale) {
    try {
      fs.unlinkSync(s.file);
    } catch { /* 忽略 */ }
  }
  return stale.length;
}
