import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { listComicPages, readComicPage, naturalCompare } from './comic';
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

/**
 * 解析 EPUB 的容器与 OPF，返回 zip 句柄、OPF 原文、id→条目路径映射与图片条目清单。
 *
 * 抽封面与「提取全部内嵌图片」都要这一步，所以独立出来共用——两处各写一遍 OPF 解析，
 * 迟早会在「href 是相对 OPF 所在目录的」这类细节上分叉，而那种分叉表现为「某本书的图
 * 时有时无」，极难回头定位。
 *
 * 条目路径已按 OPF 目录归一化，并做了百分号编码回退：zip 里存的名字可能是编码过的
 * （中文文件名尤其常见），两种都要试一次。
 */
async function readEpubManifest(epubPath: string): Promise<{
  zip: JSZip;
  opf: string;
  byId: Map<string, string>;
  images: { id: string; href: string; entryPath: string }[];
} | null> {
  if (!fs.existsSync(epubPath)) return null;
  const zip = await JSZip.loadAsync(fs.readFileSync(epubPath));
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml ?? '')?.[1];
  if (!opfPath) return null;
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) return null;

  const opfDir = path.posix.dirname(opfPath);
  const byId = new Map<string, string>();
  const images: { id: string; href: string; entryPath: string }[] = [];
  for (const m of opf.matchAll(/<item\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    const href = /href="([^"]+)"/.exec(attrs)?.[1];
    const type = /media-type="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!id || !href) continue;
    const raw = normalizeZipPath(opfDir === '.' ? href : `${opfDir}/${href}`);
    const entryPath = zip.file(raw) ? raw : zip.file(decodeHref(raw)) ? decodeHref(raw) : raw;
    byId.set(id, entryPath);
    if (type.startsWith('image/')) images.push({ id, href, entryPath });
  }
  return { zip, opf, byId, images };
}

/** EPUB 封面：优先 OPF 里 meta[name=cover] 指向的图，其次取 id 或 href 含 cover 的图片条目 */
async function epubCoverData(epubPath: string): Promise<CoverData | null> {
  const manifest = await readEpubManifest(epubPath);
  if (!manifest) return null;
  const { zip, opf, byId, images } = manifest;

  const metaCoverId = /<meta[^>]*name="cover"[^>]*content="([^"]+)"/.exec(opf)?.[1];
  const entryPath =
    (metaCoverId ? byId.get(metaCoverId) : undefined) ??
    images.find(i => /cover/i.test(i.id) || /cover/i.test(i.href))?.entryPath;
  if (!entryPath) return null;

  const file = zip.file(entryPath);
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

/** 一本书的内嵌图片集合：已打开的句柄，逐张取字节 */
export interface BookImages {
  /** 条目名。EPUB 是 zip 内路径，漫画是包内条目名；均按自然序 */
  names: string[];
  /** 按条目名读原始字节；条目不存在或内容为空返回 null */
  read(name: string): Promise<Buffer | null>;
}

async function openEpubImages(epubPath: string): Promise<BookImages | null> {
  const manifest = await readEpubManifest(epubPath);
  if (!manifest) return null;
  const { zip, images } = manifest;
  // 同一张图可能被多个 item 指向同一个条目，去重后按自然序排；OPF 声明了但包里没有的跳过
  const names = [...new Set(images.map(i => i.entryPath))]
    .filter(p => zip.file(p))
    .sort(naturalCompare);
  if (names.length === 0) return null;
  return {
    names,
    read: async name => {
      const file = zip.file(name);
      if (!file) return null;
      const data = Buffer.from(await file.async('nodebuffer'));
      return data.length ? data : null;
    },
  };
}

async function openComicImages(comicPath: string): Promise<BookImages | null> {
  const names = await listComicPages(comicPath);
  if (names.length === 0) return null;
  return {
    names,
    read: async name => {
      const page = await readComicPage(comicPath, name);
      if (!page) return null;
      const data = Buffer.from(page.data, 'base64');
      return data.length ? data : null;
    },
  };
}

/**
 * 打开一本书的内嵌图片集合；这种格式没有内嵌图片可取时返回 null。
 *
 * 刻意返回「一次打开、逐张取」的句柄，而不是「先列名、再逐张打开」：EPUB 每读一个条目
 * 都要先 `loadAsync` 解析整包，逐张重新打开等于把整个 zip 解 N 遍。漫画侧复用 comic.ts
 * 的归档缓存（关书时由 `releaseComicCacheFor` 释放），这边只管取。
 *
 * 只认 EPUB 与漫画四格式：PDF 的位图混在页面内容流里、不是能独立取出的资源；
 * TXT / Markdown / Word 的图片要么是外链要么另有打包方式，都不在这里处理。
 */
export async function openBookImages(filePath: string, fileType: string): Promise<BookImages | null> {
  const type = fileType.toLowerCase().replace(/^\./, '');
  if (type === 'epub') return openEpubImages(filePath);
  if (['cbz', 'cbr', 'cbt', 'cb7'].includes(type)) return openComicImages(filePath);
  return null;
}

/**
 * 读取封面原始数据。
 * 支持 EPUB（OPF 指定图）与漫画包（取自然序第一张图）；PDF 需渲染页面，暂不支持；TXT 无封面。
 */
export async function extractCoverData(filePath: string, ext: string): Promise<CoverData | null> {
  switch (ext.toLowerCase()) {
    case '.epub':
      return epubCoverData(filePath);
    // 四种漫画容器共用同一条封面路径：归档层（comic.ts）是按文件头识别 zip / rar / tar / 7z 的，
    // 与扩展名无关，所以这里不必分别处理。此前只列了 .cbz，导致 rar / tar / 7z 三族导入后一律无封面。
    case '.cbz':
    case '.cbr':
    case '.cbt':
    case '.cb7':
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
