import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { resourcesDir } from './local-file';

const execFileAsync = promisify(execFile);

/** 漫画包内视为页面图片的扩展名 */
const COMIC_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** 支持的容器格式：CBZ=zip、CBT=tar、CBR=rar、CB7=7z */
export type ArchiveKind = 'zip' | 'tar' | 'rar' | '7z' | 'unknown';

/**
 * 自然序比较：把字符串切成数字段与非数字段逐段比较，
 * 使「10.jpg」排在「2.jpg」之后（纯字典序会反过来）。
 */
export function naturalCompare(a: string, b: string): number {
  const segments = (s: string) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const xs = segments(a);
  const ys = segments(b);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
      // 数值相同（如前导零数量不同），短者优先，保证顺序稳定
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 是否为漫画页面图片：排除 macOS 打包残留、隐藏文件与非图片 */
export function isComicPage(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes('__macosx/')) return false;
  const base = lower.split('/').pop() ?? '';
  if (!base || base.startsWith('.')) return false;
  return COMIC_IMAGE_EXTS.includes(path.extname(base));
}

/** 按魔数判定容器格式：后缀写错的文件也能正确打开 */
export function detectArchiveKind(head: Buffer): ArchiveKind {
  const startsWith = (sig: number[]) =>
    sig.length <= head.length && sig.every((b, i) => head[i] === b);
  if (startsWith([0x50, 0x4b])) return 'zip';
  if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'; // Rar!
  if (startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  // tar 的 'ustar' 标记固定出现在偏移 257
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return 'unknown';
}

// ---- tar 读取：格式是 512 字节定长头，为它引一个库不值得 ----

const TAR_BLOCK = 512;

/** 读取以 NUL 结尾的定长字段 */
function readCString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8');
}

export interface TarEntry {
  name: string;
  /** 文件内容在归档中的起始偏移 */
  offset: number;
  size: number;
}

/** 解析 tar 归档的条目表（只取常规文件，忽略目录/链接等） */
export function readTarEntries(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(pos, pos + TAR_BLOCK);
    // 全零块表示归档结束
    if (header.every(b => b === 0)) break;
    const size = parseInt(readCString(header.subarray(124, 136)).trim(), 8) || 0;
    const typeFlag = header[156];
    // '0' 或 NUL 都表示常规文件（老式归档用 NUL）
    const isFile = typeFlag === 0x30 || typeFlag === 0;
    const prefix = readCString(header.subarray(345, 500));
    const name = prefix
      ? `${prefix}/${readCString(header.subarray(0, 100))}`
      : readCString(header.subarray(0, 100));
    const dataStart = pos + TAR_BLOCK;
    if (isFile && name) entries.push({ name, offset: dataStart, size });
    pos = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return entries;
}

// ---- rar / 7z：走随包附带的 7z.exe ----
//
// Node 生态里没有能解 rar 的纯 JS 实现；WASM 方案（libarchive.js）在 Windows + Electron 下
// 实测跑不通（worker 路径拼接错误、Comlink 握手超时，见 docs/依赖选型调研.md 第 5.3 节）。
// 7z.exe + 7z.dll 约 2.4MB，一个工具同时覆盖 rar / 7z / tar / zip。

const sevenZipPath = () => path.join(resourcesDir(), 'tools', '7z.exe');

/** 列出 rar / 7z 内的文件条目（-slt 每条带 Folder = +，据此排除目录） */
async function listEntriesVia7z(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(sevenZipPath(), ['l', '-slt', archivePath], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const files: string[] = [];
  let currentPath = '';
  let isFolder = false;
  const flush = () => {
    if (currentPath && !isFolder) files.push(currentPath);
    currentPath = '';
    isFolder = false;
  };
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('Path = ')) {
      flush();
      currentPath = line.slice(7);
    } else if (line === 'Folder = +') {
      isFolder = true;
    }
  }
  flush();
  return files;
}

/** 取出单个条目的原始字节（-so 把内容写到 stdout） */
async function readEntryVia7z(archivePath: string, name: string): Promise<Buffer> {
  const result = (await execFileAsync(sevenZipPath(), ['x', '-so', archivePath, name], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })) as unknown as { stdout: Buffer };
  return Buffer.from(result.stdout);
}

// ---- 缓存：一次只开一本书，避免每翻一页重开压缩包（漫画包常有上百 MB） ----

type CacheEntry =
  | { kind: 'zip'; path: string; mtimeMs: number; zip: JSZip }
  | { kind: 'tar'; path: string; mtimeMs: number; entries: TarEntry[]; buffer: Buffer }
  | { kind: 'rar' | '7z'; path: string; mtimeMs: number; entries: string[] };

let cache: CacheEntry | null = null;

/** 只读文件头判格式：rar / 7z 不必把整个包读进内存，交给 7z.exe 按需解 */
function readSignature(filePath: string, bytes = 512): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

async function loadArchive(archivePath: string): Promise<CacheEntry> {
  const stat = fs.statSync(archivePath);
  if (cache && cache.path === archivePath && cache.mtimeMs === stat.mtimeMs) return cache;

  const kind = detectArchiveKind(readSignature(archivePath));
  if (kind === 'zip') {
    cache = {
      kind,
      path: archivePath,
      mtimeMs: stat.mtimeMs,
      zip: await JSZip.loadAsync(fs.readFileSync(archivePath)),
    };
  } else if (kind === 'tar') {
    const buffer = fs.readFileSync(archivePath);
    cache = { kind, path: archivePath, mtimeMs: stat.mtimeMs, entries: readTarEntries(buffer), buffer };
  } else if (kind === 'rar' || kind === '7z') {
    cache = {
      kind,
      path: archivePath,
      mtimeMs: stat.mtimeMs,
      entries: await listEntriesVia7z(archivePath),
    };
  } else {
    throw new Error('无法识别的压缩包格式（支持 CBZ / CBR / CBT / CB7）');
  }
  return cache;
}

/** 列出漫画包内的页面条目名，按自然序排列 */
export async function listComicPages(archivePath: string): Promise<string[]> {
  const archive = await loadArchive(archivePath);
  if (archive.kind === 'zip') {
    const zip = archive.zip;
    return Object.keys(zip.files)
      .filter(name => !zip.files[name].dir && isComicPage(name))
      .sort(naturalCompare);
  }
  if (archive.kind === 'tar') {
    return archive.entries.map(e => e.name).filter(isComicPage).sort(naturalCompare);
  }
  return archive.entries.filter(isComicPage).sort(naturalCompare);
}

/** 读取指定页面，返回 base64 与 MIME；条目不存在返回 null */
export async function readComicPage(
  archivePath: string,
  name: string,
): Promise<{ data: string; mime: string } | null> {
  const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/jpeg';
  const archive = await loadArchive(archivePath);
  if (archive.kind === 'zip') {
    const file = archive.zip.file(name);
    if (!file) return null;
    return { data: await file.async('base64'), mime };
  }
  if (archive.kind === 'tar') {
    const entry = archive.entries.find(e => e.name === name);
    if (!entry) return null;
    const data = archive.buffer.subarray(entry.offset, entry.offset + entry.size);
    return { data: Buffer.from(data).toString('base64'), mime };
  }
  if (!archive.entries.includes(name)) return null;
  return { data: (await readEntryVia7z(archivePath, name)).toString('base64'), mime };
}

/** 清理缓存（关闭书籍时调用，及时释放内存） */
export function clearComicCache() {
  cache = null;
}
