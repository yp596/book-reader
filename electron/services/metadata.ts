import fs from 'fs';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio/slim';
import { marked } from 'marked';
import { TXT_TOC_RULES, type TxtTocRule } from './txt-toc-rules';

export interface BookMetadata {
  title: string;
  author?: string;
}

export interface TocEntry {
  label: string;
  /** EPUB 为 href；TXT/PDF 不使用 */
  href: string;
  /** PDF 为跳转页码（1 起）；TXT 为按字符数估算的页码，仅作 line 缺失时的兜底 */
  page?: number;
  /** TXT 章节所在段落行号（0 起），阅读器据此换算真实页码，优先于 page */
  line?: number;
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
      case '.docx':
        return await extractDocxMetadata(filePath);
      case '.md':
        return extractMdMetadata(filePath);
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
export async function extractToc(
  filePath: string,
  ext: string,
  txtOptions?: TxtTocOptions,
): Promise<TocEntry[]> {
  try {
    switch (ext.toLowerCase()) {
      case '.epub':
        return await extractEpubToc(filePath);
      case '.txt':
        return extractTxtToc(filePath, txtOptions);
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

/**
 * 相邻两次命中至少间隔该字符数才计为新章节。
 * 取值只需大于书籍前置目录页里章节名的行距（通常几十字符），
 * 取值过大会把「每章几百字」的短章书按章吃掉一半（实测 1000 时 800 字/章的书只剩一半章节）。
 */
const TOC_HIT_MIN_GAP = 300;

/**
 * 编译规则正则。规则自带的行内标志（如 (?im)）在 JS 中不合法，提取为编译标志；
 * 非法正则返回 null，由调用方跳过，不影响其他规则。
 */
function compileTocRule(pattern: string): RegExp | null {
  try {
    const inline = /^\(\?([gimsuy]+)\)/.exec(pattern);
    const flags = 'gm' + (inline ? inline[1].replace(/[gm]/g, '') : '');
    return new RegExp(inline ? pattern.slice(inline[0].length) : pattern, flags);
  } catch {
    return null;
  }
}

/**
 * 统计有效章节命中数。
 * 与上一次命中的间隔不足 TOC_HIT_MIN_GAP 的命中不计入：书籍前置目录页里章节名密排，
 * 间距远小于正文，借此过滤；未计入的命中不推进参照位置。
 */
function countTocHits(text: string, re: RegExp): number {
  let count = 0;
  let lastEnd = -1;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (lastEnd < 0 || m.index - lastEnd > TOC_HIT_MIN_GAP) {
      count++;
      lastEnd = m.index + m[0].length;
    }
  }
  return count;
}

/**
 * 择优选择目录规则：启用的规则各跑一遍，取有效命中数最多者。
 * 命中数相同时靠前的规则胜出（与 Legado 一致：倒序遍历配合 >=）。
 */
function selectTocRule(text: string): TxtTocRule | null {
  const rules = TXT_TOC_RULES.filter(r => r.enable);
  let best: TxtTocRule | null = null;
  let bestCount = 1;
  for (let i = rules.length - 1; i >= 0; i--) {
    const re = compileTocRule(rules[i].chapterRule);
    if (!re) continue;
    const count = countTocHits(text, re);
    if (count >= bestCount) {
      bestCount = count;
      best = rules[i];
    }
  }
  return best;
}

/** TXT 目录解析配置：默认走内置规则择优，也可指定关键字或自定义正则 */
export interface TxtTocOptions {
  /** 解析方式：default 内置规则择优 / keyword 关键字 / regex 自定义正则 */
  mode?: 'default' | 'keyword' | 'regex';
  /** 关键字，多个用换行或 | 分隔（仅 mode=keyword 生效） */
  keyword?: string;
  /** 自定义正则（仅 mode=regex 生效） */
  regex?: string;
  /** 指定内置规则名，优先级高于 mode；未匹配到则回退择优 */
  ruleName?: string;
}

/** 正则元字符转义，用于把用户输入的关键字安全拼进正则 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 内置规则名列表，供设置页与书籍详情页展示 */
export const TXT_TOC_RULE_NAMES = TXT_TOC_RULES.map(r => r.name);

/**
 * 按配置解析出本次使用的规则。
 * 未指定配置、或指定的规则不存在 / 非法时，回退到内置规则择优。
 */
function resolveTocRule(text: string, options?: TxtTocOptions): TxtTocRule | null {
  if (options?.ruleName) {
    const named = TXT_TOC_RULES.find(r => r.name === options.ruleName);
    if (named) return named;
  }
  if (options?.mode === 'regex' && options.regex?.trim()) {
    const pattern = options.regex.trim();
    if (compileTocRule(pattern)) return { name: '自定义正则', chapterRule: pattern, enable: true };
  }
  if (options?.mode === 'keyword' && options.keyword?.trim()) {
    const words = options.keyword
      .split(/[\n|]/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(escapeRegExp);
    if (words.length > 0) {
      // 行首命中任一关键字即视为章节标题，尾部长度沿用内置规则的 30 字约束
      return {
        name: '自定义关键字',
        chapterRule: `^[ 　\\t]{0,4}(?:${words.join('|')}).{0,30}$`,
        enable: true,
      };
    }
  }
  return selectTocRule(text);
}

/**
 * TXT 章节识别：先按配置定出规则（默认择优选出最贴合本书的一条），再逐条抽出章节。
 * 规则表见 electron/services/txt-toc-rules.ts；标题尾部长度由各规则自身的 {0,30} 约束，
 * 超出即视为正文段落误命中。
 */
export function parseTxtChapters(text: string, options?: TxtTocOptions): TocEntry[] {
  const rule = resolveTocRule(text, options);
  if (!rule) return [];
  const re = compileTocRule(rule.chapterRule);
  if (!re) return [];

  const entries: TocEntry[] = [];
  /** 开头密排段（通常是书籍前置目录页）里最后一个命中，用于修正首章位置 */
  let leadingRunLast: TocEntry | null = null;
  let lastEnd = -1;
  let line = 0; // 当前扫描位置所在的行号
  let cursor = 0; // 已统计过换行的扫描位置

  /** 推进到指定偏移，累计途经的换行得到行号（行号供阅读器换算真实页码） */
  const advanceTo = (offset: number) => {
    let nl = text.indexOf('\n', cursor);
    while (nl >= 0 && nl < offset) {
      line++;
      cursor = nl + 1;
      nl = text.indexOf('\n', cursor);
    }
  };

  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const label = m[0].trim();
    if (!label) continue;
    advanceTo(m.index);
    // page 为字符数估算值，会与真实分页产生累积偏差，仅作行号缺失时的兜底
    const entry: TocEntry = { label, href: '', page: Math.floor(m.index / 3000), line };
    if (lastEnd >= 0 && m.index - lastEnd <= TOC_HIT_MIN_GAP) {
      // 密排命中：前置目录页里章节名挤在一起，该段最后一个命中才是正文首章
      if (entries.length === 1) leadingRunLast = entry;
      continue;
    }
    lastEnd = m.index + m[0].length;
    if (leadingRunLast) {
      entries[0] = leadingRunLast;
      leadingRunLast = null;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 文本解码，自动识别 UTF-8 / GBK。
 * 读取头部时截断点可能落在多字节字符中间，此时 UTF-8 严格解码会抛错；
 * 需先回退最多 3 字节再判定，否则正常 UTF-8 文件会被误判为 GBK，全文变乱码。
 */
function decodeTextAuto(buffer: Buffer): string {
  for (let drop = 0; drop <= 3 && drop < buffer.length; drop++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, buffer.length - drop));
    } catch {
      // 截断处字符不完整，回退一字节重试
    }
  }
  return new TextDecoder('gbk').decode(buffer);
}

function readTextHead(filePath: string, maxBytes = 65536): string {
  const buffer = fs.readFileSync(filePath);
  return decodeTextAuto(buffer.subarray(0, maxBytes));
}

function extractTxtToc(filePath: string, options?: TxtTocOptions): TocEntry[] {
  // 全量读取：章节可能出现在文件任意位置，按头部截断会让后半本书没有目录。
  // 实测 140MB 中文 TXT 解析耗时约 0.5s，且仅导入时执行一次，无需分块。
  const buffer = fs.readFileSync(filePath);
  return parseTxtChapters(decodeTextAuto(buffer), options);
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

// ============ DOCX ============
/** DOCX：读 core.xml 的标题作者 */
async function extractDocxMetadata(filePath: string): Promise<BookMetadata | null> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const coreFile = zip.file('docProps/core.xml');
  if (coreFile) {
    const core = await coreFile.async('string');
    const title = /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1]?.trim();
    const author = /<dc:creator>([^<]*)<\/dc:creator>/.exec(core)?.[1]?.trim();
    if (title) return { title: decodeXmlEntities(title), author: author || undefined };
  }
  // 回退：首个标题
  const chapters = await docxToChapters(filePath);
  const firstTitle = chapters.find(c => c.title)?.title;
  return firstTitle ? { title: firstTitle } : null;
}

/** DOCX 转章节：mammoth 转 HTML，按 h1/h2 切章，正文转纯文本段落 */
export async function docxToChapters(
  filePath: string,
): Promise<{ title: string; content: string }[]> {
  const buffer = fs.readFileSync(filePath);
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const $ = cheerio.load(html);
  const chapters: { title: string; paras: string[] }[] = [];
  let current: { title: string; paras: string[] } = { title: '', paras: [] };

  const flush = () => {
    if (current.title || current.paras.length > 0) chapters.push(current);
    current = { title: '', paras: [] };
  };

  // slim 的 load 不包 body，用文档序选择器并跳过嵌套元素
  $('h1, h2, p, li').each((_, el) => {
    if ($(el).parents('h1, h2, p, li').length > 0) return;
    const tag = (el as any).tagName?.toLowerCase() ?? '';
    const text = $(el).text().trim();
    if (!text) return;
    if (tag === 'h1' || tag === 'h2') {
      flush();
      current = { title: text.slice(0, 100), paras: [] };
    } else {
      current.paras.push(text);
    }
  });
  flush();

  if (chapters.length === 0) return [];
  // 无标题文档：合成单章
  if (chapters.length === 1 && !chapters[0].title) {
    return [{ title: '正文', content: chapters[0].paras.join('\n') }];
  }
  return chapters.map((c, i) => ({
    title: c.title || `第 ${i + 1} 节`,
    content: c.paras.join('\n'),
  }));
}

/** Markdown 里的空元素必须自闭合：EPUB 章节按 XML 解析，`<br>` / `<img>` 未闭合会整章解析失败 */
const VOID_TAGS = ['br', 'hr', 'img', 'input', 'col', 'meta', 'link', 'source'];
const toXhtmlFragment = (html: string) =>
  html.replace(
    new RegExp(`<(${VOID_TAGS.join('|')})((?:[^>"']|"[^"]*"|'[^']*')*?)\\s*/?>`, 'gi'),
    (_m, tag: string, attrs: string) => `<${tag}${attrs.trimEnd()}/>`,
  );

/**
 * Markdown 转章节：一级 / 二级标题另起一章，其余内容保留为 HTML，
 * 以留住加粗、列表、代码块等排版。转出的 EPUB 走与 DOCX 相同的后续链路。
 */
export async function mdToChapters(
  filePath: string,
): Promise<{ title: string; content: string; html: string }[]> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const tokens = marked.lexer(text);
  const chapters: { title: string; html: string[] }[] = [];
  let current: { title: string; html: string[] } = { title: '', html: [] };
  const flush = () => {
    if (current.title || current.html.length > 0) chapters.push(current);
    current = { title: '', html: [] };
  };

  for (const token of tokens) {
    if (token.type === 'heading' && (token.depth === 1 || token.depth === 2)) {
      flush();
      current = { title: token.text.trim().slice(0, 100), html: [] };
    } else {
      current.html.push(marked.parser([token]));
    }
  }
  flush();

  if (chapters.length === 0) return [];
  // 无标题文档：合成单章
  if (chapters.length === 1 && !chapters[0].title) {
    return [{ title: '正文', content: text, html: toXhtmlFragment(chapters[0].html.join('')) }];
  }
  return chapters.map((c, i) => ({
    title: c.title || `第 ${i + 1} 节`,
    content: '',
    html: toXhtmlFragment(c.html.join('')),
  }));
}

/** Markdown 元数据：取首个一级标题当书名，没有则返回 null 交给调用方回退文件名 */
function extractMdMetadata(filePath: string): BookMetadata | null {
  const head = readTextHead(filePath, 65536);
  const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim();
  return title ? { title } : null;
}

// ============ 全文抽取（RAG 索引用，带跳转目标） ============

export interface BookSection {
  label: string;
  /** 跳转目标：EPUB {href}，TXT/PDF {page}（TXT 页从0起，PDF 从1起） */
  target: string;
  text: string;
}

export async function extractBookSections(
  filePath: string,
  ext: string,
  tocJson?: string,
): Promise<BookSection[]> {
  switch (ext.toLowerCase()) {
    case '.epub':
      return extractEpubSections(filePath, tocJson);
    case '.txt':
      return extractTxtSections(filePath);
    case '.pdf':
      return extractPdfSections(filePath);
    default:
      return [];
  }
}

async function extractEpubSections(filePath: string, tocJson?: string): Promise<BookSection[]> {
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
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // toc 匹配章节名
  let toc: { label: string; href: string }[] = [];
  try {
    toc = tocJson ? JSON.parse(tocJson) : [];
  } catch { /* 忽略 */ }

  const spine = [
    ...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g),
  ].map(m => m[1]);
  const manifest = new Map(
    [...opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map(m => [m[1], decodeXmlEntities(m[2])]),
  );

  const sections: BookSection[] = [];
  for (const idref of spine) {
    const href = manifest.get(idref);
    if (!href) continue;
    const file = zip.file(base + href);
    if (!file) continue;
    const html = await file.async('string');
    const $ = cheerio.load(html);
    $('script, style').remove();
    const text = ($('body').length ? $('body').text() : $.root().text())
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const label =
      toc.find(t => t.href === href || href.endsWith(t.href) || t.href.endsWith(href))?.label ?? '';
    sections.push({ label, target: JSON.stringify({ href }), text });
  }
  return sections;
}

function extractTxtSections(filePath: string): BookSection[] {
  const stat = fs.statSync(filePath);
  const text = readTextHead(filePath, Math.min(stat.size, 8 * 1024 * 1024));
  const toc = parseTxtChapters(text);
  if (toc.length === 0) {
    return [{ label: '', target: JSON.stringify({ page: 0 }), text }];
  }
  // 按章节行切分正文
  const lines = text.split('\n');
  const sections: BookSection[] = [];
  let current = { label: '', paras: [] as string[] };
  const isTitle = (line: string) => toc.some(t => t.label === line.trim());
  for (const raw of lines) {
    const line = raw.trim();
    if (line && isTitle(line)) {
      if (current.label || current.paras.length > 0) {
        sections.push({
          label: current.label,
          target: JSON.stringify({ page: Math.floor(sections.join(' ').length / 3000) }),
          text: current.paras.join('\n'),
        });
      }
      current = { label: line, paras: [] };
    } else {
      current.paras.push(raw);
    }
  }
  if (current.label || current.paras.length > 0) {
    sections.push({
      label: current.label,
      target: JSON.stringify({ page: Math.floor(sections.join(' ').length / 3000) }),
      text: current.paras.join('\n'),
    });
  }
  return sections.filter(s => s.text.trim());
}

async function extractPdfSections(filePath: string): Promise<BookSection[]> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer).slice().buffer as ArrayBuffer;
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const sections: BookSection[] = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const tc = await page.getTextContent();
      const text = (tc.items as any[]).map(it => it.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) sections.push({ label: `第 ${i} 页`, target: JSON.stringify({ page: i }), text });
    }
    return sections;
  } finally {
    await pdfDoc.destroy();
  }
}
