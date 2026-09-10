import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { listComicPages, readComicPage } from './comic';
import { booksDir, localFileUrl } from './local-file';

/** 封面体积上限：超过说明取到的多半不是封面图，直接放弃 */
const MAX_COVER_BYTES = 8 * 1024 * 1024;

type CoverData = { data: Buffer; ext: string };

/** 统一扩展名，避免 .jpeg 之类在协议侧拿不到正确的 content-type */
const coverExt = (name: string) => {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  return ['.jpg', '.png', '.gif', '.webp', '.bmp'].includes(ext) ? ext : '.jpg';
};

/** 归一化 ZIP 内相对路径（处理 ./ 与 ../） */
const normalizeZipPath = (p: string) => {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
};

const decodeHref = (href: string) => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

/** EPUB 封面：优先 OPF 里 meta[name=cover] 指向的图，其次取 id 或 href 含 cover 的图片条目 */
async function epubCoverData(epubPath: string): Promise<CoverData | null> {
  const zip = await JSZip.loadAsync(fs.readFileSync(epubPath));
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml ?? '')?.[1];
  if (!opfPath) return null;
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) return null;

  const byId = new Map<string, string>();
  const images: { id: string; href: string }[] = [];
  for (const m of opf.matchAll(/<item\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    const href = /href="([^"]+)"/.exec(attrs)?.[1];
    const type = /media-type="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!id || !href) continue;
    byId.set(id, href);
    if (type.startsWith('image/')) images.push({ id, href });
  }

  const metaCoverId = /<meta[^>]*name="cover"[^>]*content="([^"]+)"/.exec(opf)?.[1];
  const href =
    (metaCoverId ? byId.get(metaCoverId) : undefined) ??
    images.find(i => /cover/i.test(i.id) || /cover/i.test(i.href))?.href;
  if (!href) return null;

  const opfDir = path.posix.dirname(opfPath);
  const entryPath = normalizeZipPath(opfDir === '.' ? href : `${opfDir}/${href}`);
  const file = zip.file(entryPath) ?? zip.file(decodeHref(entryPath));
  if (!file) return null;
  const data = Buffer.from(await file.async('nodebuffer'));
  if (data.length === 0 || data.length > MAX_COVER_BYTES) return null;
  return { data, ext: coverExt(entryPath) };
}

/** CBZ 封面：压缩包内自然序第一张图 */
async function comicCoverData(comicPath: string): Promise<CoverData | null> {
  const pages = await listComicPages(comicPath);
  if (pages.length === 0) return null;
  const page = await readComicPage(comicPath, pages[0]);
  if (!page) return null;
  const data = Buffer.from(page.data, 'base64');
  if (data.length === 0 || data.length > MAX_COVER_BYTES) return null;
  return { data, ext: coverExt(pages[0]) };
}

/**
 * 读取封面原始数据。
 * 目前支持 EPUB（OPF 指定图）与 CBZ（首页）；PDF 需渲染页面，暂不支持；TXT 无封面。
 */
export async function extractCoverData(filePath: string, ext: string): Promise<CoverData | null> {
  switch (ext.toLowerCase()) {
    case '.epub':
      return epubCoverData(filePath);
    case '.cbz':
      return comicCoverData(filePath);
    default:
      return null;
  }
}

/**
 * 提取封面并落盘到书库目录，返回可直接给渲染进程 <img src> 用的 URL。
 * 文件名带内容指纹，重复提取不会堆积文件；无封面或失败返回 null。
 */
export async function extractCover(
  filePath: string,
  ext: string,
  hash: string,
): Promise<string | null> {
  const cover = await extractCoverData(filePath, ext);
  if (!cover) return null;
  const dir = booksDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${hash}-cover${cover.ext}`);
  fs.writeFileSync(outPath, cover.data);
  return localFileUrl(outPath);
}
