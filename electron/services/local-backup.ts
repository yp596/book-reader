import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { DatabaseService } from './db.service';

/** 可备份的本地数据（不含书籍原文件、不含向量索引这类可重建数据） */
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
  for (const t of TABLES) {
    const rows = db.exportRowsSince(t, since);
    if (rows.length === 0) continue;
    if (t === 'book_sources') data.sources = rows;
    else if (t === 'books') data.books = rows;
    else if (t === 'bookmarks') data.bookmarks = rows;
    else if (t === 'notes') data.notes = rows;
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

/** 写备份文件到磁盘（UTF-8 JSON） */
export function writeBackup(filePath: string, payload: BackupFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

/** 读取并校验备份文件 */
export function readBackup(filePath: string): BackupFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as BackupFile;
  if (!parsed || parsed.version !== 2 || typeof parsed.data !== 'object') {
    throw new Error('备份文件格式不正确');
  }
  return parsed;
}

/**
 * 合并备份数据到当前库。
 * 幂等：按自然键去重，重复恢复不会产生重复条目。
 * 返回本次实际新增/更新的条数。
 */
export function mergeBackup(db: DatabaseService, payload: BackupFile): number {
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

  // 2) 书籍进度：仅当备份更晚时更新
  for (const rb of d.books ?? []) {
    const local = findBook(rb.title);
    if (!local) continue;
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
