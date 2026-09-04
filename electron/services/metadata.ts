import fs from 'fs';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';

export interface BookMetadata {
  title: string;
  author?: string;
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
