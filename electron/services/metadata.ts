import fs from 'fs';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';

export interface BookMetadata {
  title: string;
  author?: string;
}

export interface TocEntry {
  label: string;
  /** EPUB 为 href，TXT/PDF 为页码（1 起） */
  href: string;
  page?: number;
}

/** 从文件内容提取书名和作者，失败返回 null（调用方回退文件名） */
export async function extractMetadata(filePath: string, ext: string): Promise<BookMetadata | null> {
  try {
    switch (ext.toLowerCase()) {
      case '.epub':
        return await extractEpubMetadata(filePath);
      case '.pdf':
        return await extractPdfMetadata(filePath);
      case '.txt':
        return extractTxtMetadata(filePath);
      default:
        return null;
    }
  } catch (err) {
    console.error(`解析元数据失败 [${filePath}]:`, err);
    return null;
  }
}

/** EPUB：解包 OPF，读 dc:title / dc:creator */
async function extractEpubMetadata(filePath: string): Promise<BookMetadata | null> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  // 1. 找 OPF 路径
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) return null;
  const containerXml = await containerFile.async('string');
  const opfPath = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) return null;

  // 2. 读 OPF 元数据
  const opfFile = zip.file(opfPath);
  if (!opfFile) return null;
  const opf = await opfFile.async('string');
  const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(opf)?.[1]?.trim();
  const author = /<dc:creator[^>]*>([^<]+)<\/dc:creator>/.exec(opf)?.[1]?.trim();

  if (!title) return null;
  return { title: decodeXmlEntities(title), author: author ? decodeXmlEntities(author) : undefined };
}

/** PDF：读文档信息字典 */
async function extractPdfMetadata(filePath: string): Promise<BookMetadata | null> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer).slice().buffer as ArrayBuffer;
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const { info } = await pdfDoc.getMetadata();
    const title = (info as any)?.Title as string | undefined;
    const author = (info as any)?.Author as string | undefined;
    if (!title?.trim()) return null;
    return { title: title.trim(), author: author?.trim() || undefined };
  } finally {
    await pdfDoc.destroy();
  }
}

/** TXT：取首个非空行当书名，匹配「作者：XXX」 */
function extractTxtMetadata(filePath: string): BookMetadata | null {
  const buffer = fs.readFileSync(filePath);
  let head: string;
  try {
    head = new TextDecoder('utf-8', { fatal: true }).decode(buffer.slice(0, 4096));
  } catch {
    head = new TextDecoder('gbk').decode(buffer.slice(0, 4096));
  }
  const lines = head.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let author: string | undefined;
  for (const line of lines.slice(0, 5)) {
    const m = /作\s*者\s*[:：\s]\s*([^\s，,。；;、]+)/.exec(line);
    if (m) {
      author = m[1].trim();
      break;
    }
  }

  // 跳过纯作者行，取第一个像书名的行
  const title = lines.find(l => !/作\s*者\s*[:：]/.test(l)) ?? lines[0];
  const clean = title
    .replace(/^[《〈【]/, '')
    .replace(/[》〉】]$/, '')
    .trim();
  if (!clean || clean.length > 60) return null;
  return { title: clean, author };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 从文件内容提取目录：EPUB 读 NCX，TXT 识别章节标题行，PDF 读大纲 */
export async function extractToc(filePath: string, ext: string): Promise<TocEntry[]> {
  try {
    switch (ext.toLowerCase()) {
      case '.epub':
        return await extractEpubToc(filePath);
      case '.txt':
        return extractTxtToc(filePath);
      case '.pdf':
        return await extractPdfToc(filePath);
      default:
        return [];
    }
  } catch (err) {
    console.error(`解析目录失败 [${filePath}]:`, err);
    return [];
  }
}

async function extractEpubToc(filePath: string): Promise<TocEntry[]> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) return [];
  const containerXml = await containerFile.async('string');
  const opfPath = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) return [];
  const opfFile = zip.file(opfPath);
  if (!opfFile) return [];
  const opf = await opfFile.async('string');

  // OPF 同目录为基准路径
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // 找 NCX
  const ncxId = /<item[^>]*media-type="application\/x-dtbncx+xml"[^>]*href="([^"]+)"/.exec(opf)?.[1]
    ?? /<item[^>]*href="([^"]+)"[^>]*media-type="application\/x-dtbncx+xml"/.exec(opf)?.[1];
  const entries: TocEntry[] = [];
  if (ncxId) {
    const ncxFile = zip.file(base + decodeXmlEntities(ncxId));
    if (ncxFile) {
      const ncx = await ncxFile.async('string');
      const navPoints = ncx.match(/<navPoint[\s\S]*?<\/navPoint>/g) ?? [];
      // 只取顶层 navPoint（简单起见按出现顺序去重href）
      const seen = new Set<string>();
      for (const np of navPoints) {
        const label = /<text>([^<]*)<\/text>/.exec(np)?.[1]?.trim();
        const src = /<content[^>]*src="([^"]+)"/.exec(np)?.[1];
        if (label && src && !seen.has(src)) {
          seen.add(src);
          entries.push({ label: decodeXmlEntities(label), href: src.split('#')[0] });
        }
      }
      if (entries.length > 0) return entries;
    }
  }
  // 回退：manifest 里 html 文件列表
  const items = [...opf.matchAll(/<item[^>]*media-type="application\/xhtml\+xml"[^>]*href="([^"]+)"/g)];
  return items.map((m, i) => ({
    label: `第 ${i + 1} 节`,
    href: decodeXmlEntities(m[1]),
  }));
}

/** TXT 章节行识别：第X章/节/回/卷/篇/集/部 + 序言楔子等 */
export function parseTxtChapters(text: string): TocEntry[] {
  const pattern =
    /^(第[一二三四五六七八九十百千万\d\s]+[章节回卷篇集部])\s*(.*)$|^(序言|楔子|引子|序章|终章|尾声|后记|番外.*|序)$/;
  const lines = text.split('\n');
  const entries: TocEntry[] = [];
  let charCount = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const m = pattern.exec(line);
    if (m && line.length <= 40) {
      entries.push({ label: line, href: '', page: Math.floor(charCount / 3000) });
    }
    charCount += raw.length + 1;
  }
  return entries;
}

function readTextHead(filePath: string, maxBytes = 65536): string {
  const buffer = fs.readFileSync(filePath);
  const head = buffer.slice(0, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(head);
  } catch {
    return new TextDecoder('gbk').decode(head);
  }
}

function extractTxtToc(filePath: string): TocEntry[] {
  // 目录识别只需头部 + 抽样：读全文(通常几MB内可接受），超大文件截断
  const stat = fs.statSync(filePath);
  const text = readTextHead(filePath, Math.min(stat.size, 4 * 1024 * 1024));
  return parseTxtChapters(text);
}

async function extractPdfToc(filePath: string): Promise<TocEntry[]> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer).slice().buffer as ArrayBuffer;
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline) return [];
    const entries: TocEntry[] = [];
    const walk = async (items: any[]) => {
      for (const item of items) {
        let page: number | undefined;
        try {
          const dest = item.dest;
          if (dest) {
            const resolved = await pdfDoc.getDestination(dest);
            if (resolved?.[0]) {
              const ref = resolved[0];
              page = (await pdfDoc.getPageIndex(ref as any)) + 1;
            }
          }
        } catch { /* 取不到页码则只保留标题 */ }
        entries.push({ label: String(item.title || '未命名'), href: '', page });
        if (item.items?.length) await walk(item.items);
      }
    };
    await walk(outline as any[]);
    return entries;
  } finally {
    await pdfDoc.destroy();
  }
}
