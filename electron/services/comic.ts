import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

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

/**
 * 单条缓存：一次只读一本书，避免每翻一页都重读整个压缩包。
 * 漫画包常有上百 MB，多条缓存会迅速吃满内存。
 */
let cache: { archivePath: string; mtimeMs: number; zip: JSZip } | null = null;

async function loadZip(archivePath: string): Promise<JSZip> {
  const stat = fs.statSync(archivePath);
  if (cache && cache.archivePath === archivePath && cache.mtimeMs === stat.mtimeMs) {
    return cache.zip;
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
  cache = { archivePath, mtimeMs: stat.mtimeMs, zip };
  return zip;
}

/** 列出漫画包内的页面条目名，按自然序排列 */
export async function listComicPages(archivePath: string): Promise<string[]> {
  const zip = await loadZip(archivePath);
  return Object.keys(zip.files)
    .filter(name => !zip.files[name].dir && isComicPage(name))
    .sort(naturalCompare);
}

/** 读取指定页面，返回 base64 与 MIME；条目不存在返回 null */
export async function readComicPage(
  archivePath: string,
  name: string,
): Promise<{ data: string; mime: string } | null> {
  const zip = await loadZip(archivePath);
  const file = zip.file(name);
  if (!file) return null;
  return {
    data: await file.async('base64'),
    mime: MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'image/jpeg',
  };
}

/** 清理缓存（关闭书籍时调用，及时释放内存） */
export function clearComicCache() {
  cache = null;
}
