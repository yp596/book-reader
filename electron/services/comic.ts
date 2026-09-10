import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { app } from 'electron';
import JSZip from 'jszip';
import { Archive } from 'libarchive.js/dist/libarchive-node.mjs';

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

/** 容器格式：CBZ=zip、CBR=rar、CB7=7z、CBT=tar */
export type ArchiveKind = 'zip' | 'rar' | '7z' | 'tar' | 'unknown';

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

function readHead(filePath: string, bytes = 512): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- 缓存：一次只开一本书，避免每翻一页重开压缩包（漫画包常有上百 MB） ----

let zipCache: { path: string; mtimeMs: number; zip: JSZip } | null = null;
let archiveCache: { path: string; mtimeMs: number; archive: any } | null = null;

async function loadZip(archivePath: string): Promise<JSZip> {
  const stat = fs.statSync(archivePath);
  if (zipCache && zipCache.path === archivePath && zipCache.mtimeMs === stat.mtimeMs) {
    return zipCache.zip;
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
  archiveCache = null;
  zipCache = { path: archivePath, mtimeMs: stat.mtimeMs, zip };
  return zip;
}

/**
 * libarchive 的 Node 入口自己按模块位置拼 worker 路径，在 Windows 上会拼成
 * `D:\D:\%E6%A1%8C...`（盘符重复且未解码），worker 起不来。
 * 这里用官方提供的 getWorker 扩展点，改成我们解析出的绝对路径。
 */
let libarchiveReady: Promise<void> | null = null;
async function ensureLibarchive(): Promise<void> {
  if (!libarchiveReady) {
    libarchiveReady = (async () => {
      const distDir = path.join(app.getAppPath(), 'node_modules', 'libarchive.js', 'dist');
      const workerUrl = pathToFileURL(path.join(distDir, 'worker-bundle-node.mjs')).href;
      Archive.init({ getWorker: () => new Worker(workerUrl) });
    })();
  }
  return libarchiveReady;
}

async function loadArchive(archivePath: string): Promise<any> {
  const stat = fs.statSync(archivePath);
  if (archiveCache && archiveCache.path === archivePath && archiveCache.mtimeMs === stat.mtimeMs) {
    return archiveCache.archive;
  }
  await ensureLibarchive();
  const archive = await (Archive as any).open(archivePath);
  zipCache = null;
  archiveCache = { path: archivePath, mtimeMs: stat.mtimeMs, archive };
  return archive;
}

/** 列出漫画包内的页面条目名，按自然序排列 */
export async function listComicPages(archivePath: string): Promise<string[]> {
  const kind = detectArchiveKind(readHead(archivePath));
  if (kind === 'zip') {
    const zip = await loadZip(archivePath);
    return Object.keys(zip.files)
      .filter(name => !zip.files[name].dir && isComicPage(name))
      .sort(naturalCompare);
  }
  const archive = await loadArchive(archivePath);
  const entries = await archive.getFilesArray();
  return entries
    .map((entry: any) => entry.path as string)
    .filter(isComicPage)
    .sort(naturalCompare);
}

/** 读取指定页面，返回 base64 与 MIME；条目不存在返回 null */
export async function readComicPage(
  archivePath: string,
  name: string,
): Promise<{ data: string; mime: string } | null> {
  const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/jpeg';
  const kind = detectArchiveKind(readHead(archivePath));
  if (kind === 'zip') {
    const zip = await loadZip(archivePath);
    const file = zip.file(name);
    if (!file) return null;
    return { data: await file.async('base64'), mime };
  }
  const archive = await loadArchive(archivePath);
  const entries = await archive.getFilesArray();
  const entry = entries.find((e: any) => e.path === name);
  if (!entry) return null;
  const extracted = await entry.file.extract();
  const buffer = Buffer.from(await extracted.arrayBuffer());
  return { data: buffer.toString('base64'), mime };
}

/** 清理缓存（关闭书籍时调用，及时释放内存） */
export function clearComicCache() {
  zipCache = null;
  archiveCache = null;
  libarchiveReady = null;
}
