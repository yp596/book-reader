import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio/slim';
import { marked } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
// 按需注册语言：全量 highlight.js 会把主进程产物撑大近 1MB，这里只带常用的一批
import langJavascript from 'highlight.js/lib/languages/javascript';
import langTypescript from 'highlight.js/lib/languages/typescript';
import langPython from 'highlight.js/lib/languages/python';
import langJava from 'highlight.js/lib/languages/java';
import langC from 'highlight.js/lib/languages/c';
import langCpp from 'highlight.js/lib/languages/cpp';
import langCsharp from 'highlight.js/lib/languages/csharp';
import langGo from 'highlight.js/lib/languages/go';
import langRust from 'highlight.js/lib/languages/rust';
import langPhp from 'highlight.js/lib/languages/php';
import langRuby from 'highlight.js/lib/languages/ruby';
import langBash from 'highlight.js/lib/languages/bash';
import langJson from 'highlight.js/lib/languages/json';
import langYaml from 'highlight.js/lib/languages/yaml';
import langXml from 'highlight.js/lib/languages/xml';
import langCss from 'highlight.js/lib/languages/css';
import langSql from 'highlight.js/lib/languages/sql';
import langMarkdown from 'highlight.js/lib/languages/markdown';
import { TXT_TOC_RULES, type TxtTocRule } from './txt-toc-rules';

for (const [name, lang] of [
  ['javascript', langJavascript],
  ['typescript', langTypescript],
  ['python', langPython],
  ['java', langJava],
  ['c', langC],
  ['cpp', langCpp],
  ['csharp', langCsharp],
  ['go', langGo],
  ['rust', langRust],
  ['php', langPhp],
  ['ruby', langRuby],
  ['bash', langBash],
  ['json', langJson],
  ['yaml', langYaml],
  ['xml', langXml],
  ['css', langCss],
  ['sql', langSql],
  ['markdown', langMarkdown],
] as const) {
  hljs.registerLanguage(name, lang as never);
}

/**
 * pdfjs 在 Node 环境下不走真 worker，而是「fake worker」——内部直接 `await import(workerSrc)`。
 * 因此 workerSrc **必须是合法的 URL**：裸 Windows 路径（`D:\...`）会被 ESM loader 当成
 * 协议名 "D:" 拒绝（ERR_UNSUPPORTED_ESM_URL_SCHEME），而 pdfjs 会把失败包一层后返回空结果，
 * 不崩、不抛到界面，只表现为「PDF 书名回落成文件名、目录恒为空」——极难从现象反推。
 *
 * 候选按「构建产物 → 源码树」排列，取第一个存在的：打包运行时命中前者
 * （vite 构建时拷过去的，见 vite.config.ts 的 copyPdfWorker），
 * 直接跑源码或单元测试时命中后者。
 */
function resolvePdfWorkerSrc(): string {
  const candidates = [
    path.join(__dirname, 'pdf.worker.mjs'),
    path.resolve(__dirname, '../../node_modules/pdfjs-dist/build/pdf.worker.mjs'),
  ];
  const hit = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
  return pathToFileURL(hit).href;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = resolvePdfWorkerSrc();

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

/** PDF 权限位的展示名。数字取自 pdfjs 内部的 PermissionFlag，含义是「该位为 1 即允许」 */
const PDF_PERMISSION_LABELS: ReadonlyArray<readonly [number, string]> = [
  [0x04, '打印'],
  [0x08, '修改内容'],
  [0x10, '复制内容'],
  [0x20, '添加批注'],
  [0x100, '填写表单'],
  [0x200, '辅助功能读取'],
  [0x400, '页面拼装'],
  [0x800, '高质量打印'],
];

/** 权限位补集：pdfjs 只回「被允许」的项，用户更需要知道「被禁止」哪些 */
export function deniedFromAllowed(allowed: number[]): string[] {
  return PDF_PERMISSION_LABELS.filter(([bit]) => !allowed.includes(bit)).map(([, label]) => label);
}

export interface PdfFileInfo {
  /** 总页数；需要密码等读不出的情况为 null */
  pageCount: number | null;
  /**
   * 被禁止的权限项；空数组＝无限制，null＝读不出（非 PDF 也走这条路，界面显示「—」）。
   * 注意别把 pdfjs 的两种 null 当一回事：它返回 null 表示「文件里没有权限信息」，
   * 也就是未设限制，那是空数组该表示的意思。
   */
  deniedPermissions: string[] | null;
}

/**
 * 读 PDF 的页数与文档权限，供「文件信息」展示。
 * 权限位来自加密字典的 /P：pdfjs 只回「被允许」的项，这里取补集转成「被禁止」——
 * 对用户来说「禁止打印」比「允许打印」更能说明问题。
 */
export async function readPdfFileInfo(filePath: string): Promise<PdfFileInfo> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer).slice().buffer as ArrayBuffer;
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  try {
    let deniedPermissions: string[] | null = null;
    try {
      const allowed = await pdfDoc.getPermissions();
      // null = 全文没有权限信息（pdfjs 的文档口径，即未设限制）→ 空数组；只有抛异常才算读不出
      deniedPermissions = allowed ? deniedFromAllowed(allowed) : [];
    } catch {
      // 权限是附属信息，读不出就留 null，不因为一项把页数一起拖没
      deniedPermissions = null;
    }
    return { pageCount: pdfDoc.numPages, deniedPermissions };
  } finally {
    await pdfDoc.destroy();
  }
}

/** 书名号 / 双尖括号 / 方头括号，左 ↔ 右 */
const TITLE_BRACKETS: ReadonlyArray<readonly [string, string]> = [
  ['《', '》'],
  ['〈', '〉'],
  ['【', '】'],
];

/**
 * 剥掉包住整行的书名号。
 *
 * 不能「首字符是左书名号就删、末字符是右书名号就删」——两边各判各的、不配对，
 * 会把「《书名》后接正文」削成「书名》后接正文」：半截括号比不剥更糟，
 * 用户从书名上根本看不出原文长什么样。规则分三种：
 *   1. 两端成对且配对（且剥完非空）→ 一起剥，这是 `《三体》` 这种正常情况；
 *   2. 只有左边、整行都没有对应右括号 → 剥（首行被截断，留一个孤零零的左书名号没意义）；
 *   3. 只有右边、整行都没有对应左括号 → 剥，与 2 对称。
 * 其余一律原样返回。
 */
function stripTitleBrackets(raw: string): string {
  for (const [open, close] of TITLE_BRACKETS) {
    const hasClose = raw.includes(close);
    if (raw.startsWith(open) && hasClose && raw.endsWith(close) && raw.length > open.length + close.length) {
      return raw.slice(open.length, raw.length - close.length).trim();
    }
    if (raw.startsWith(open) && !hasClose) return raw.slice(open.length).trim();
    if (raw.endsWith(close) && !raw.includes(open)) return raw.slice(0, raw.length - close.length).trim();
  }
  return raw;
}

/** TXT：取首个非空行当书名，匹配「作者：XXX」 */
function extractTxtMetadata(filePath: string): BookMetadata | null {
  const buffer = fs.readFileSync(filePath);
  // 必须走 decodeTextAuto：这里只取文件头部，切片位置很可能落在某个汉字的中间，
  // 直接 fatal 解码会抛错并整段回落 GBK，把一本 UTF-8 书的书名变成乱码。
  const head = decodeTextAuto(buffer.subarray(0, 4096));
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
  const clean = stripTitleBrackets(title).trim();
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
      // Markdown / DOCX 的目录都是标题列表：走与阅读侧同一套渲染取锚点，
      // 两边编号规则一致，目录点下去才能落在正确的标题上
      case '.md':
        return (await mdRender(filePath)).toc;
      case '.docx':
        return (await docxRender(filePath)).toc;
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
/**
 * 文本编码自动判定：先按 UTF-8 严格解码，容忍结尾被截断的半个字符（最多 3 字节）；
 * 仍失败才退回 GBK——中文 txt 基本只有这两种来源。
 *
 * 注意：这里只容忍「结尾」，不容忍文件中间的非法字节。整份都要严格通过，
 * 是为了不让一个坏字节把整本书从 UTF-8 误判成 GBK。
 */
export function decodeTextAuto(buffer: Buffer | Uint8Array): string {
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

/** 读取整份文本文件，自动判编码。供文档比较等需要原文的场景使用 */
export function readPlainTextFile(filePath: string): string {
  return decodeTextAuto(fs.readFileSync(filePath));
}

/**
 * 把整份 TXT 按目录规则切成分章正文，供「导出为 EPUB」这类需要章节结构的场景使用。
 *
 * 与 `extractTxtSections` 的区别只在读取范围：那个为做目录只读文件前 8MB，大文件会被
 * 静默截断（够画目录，不够导出），所以这里配 `readPlainTextFile` 全量读取。切分规则两者
 * 一致——一行文本若与某个目录项的名字完全相同，就视为章节起头。
 */
export function splitTxtChapters(
  text: string,
  options?: TxtTocOptions,
): { title: string; text: string }[] {
  const toc = parseTxtChapters(text, options);
  if (toc.length === 0) return [{ title: '', text }];

  const titles = new Set(toc.map(t => t.label.trim()).filter(Boolean));
  const chapters: { title: string; text: string }[] = [];
  let current = { title: '', lines: [] as string[] };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line && titles.has(line)) {
      if (current.title || current.lines.length > 0) {
        chapters.push({ title: current.title, text: current.lines.join('\n') });
      }
      current = { title: line, lines: [] };
    } else {
      current.lines.push(raw);
    }
  }
  if (current.title || current.lines.length > 0) {
    chapters.push({ title: current.title, text: current.lines.join('\n') });
  }
  // 丢弃没有正文的碎块。这条同时解决了「前置目录页」：目录页里密排的章节名会各成一个
  // 标题、正文为空，正文里真正的同名章节才留下——与 extractTxtSections 的取舍一致。
  return chapters.filter(c => c.text.trim());
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

/**
 * 文档没有小标题时合成的占位章节名。
 *
 * 它们只是为了让目录有个条目，绝不能反过来当成书名——「正文」「第 1 节」做了书名，
 * 文件名里真正有用的信息（如「品牌管理模块最终汇报稿」）就白白丢了。
 * 生成与识别共用同一组定义，避免两边各写各的又对不上。
 */
const SINGLE_CHAPTER_NAME = '正文';
const untitledChapterName = (index: number) => `第 ${index + 1} 节`;
const GENERIC_CHAPTER_TITLE = /^(正文|第\s*\d+\s*节)$/;

/** 是否是合成出来的占位章节名（而非文档里真实存在的小标题） */
export function isGenericChapterTitle(title: string): boolean {
  return GENERIC_CHAPTER_TITLE.test((title ?? '').trim());
}

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
  // 回退：首个真实标题。占位名（正文 / 第 N 节）不能当书名——这种情况下返回 null，
  // 由调用方回退到文件名，那通常才是用户认得出的名字。
  const chapters = await docxToChapters(filePath);
  const firstTitle = chapters.find(c => c.title && !isGenericChapterTitle(c.title))?.title;
  return firstTitle ? { title: firstTitle } : null;
}

/**
 * 一个章节短于这个字数时并入相邻章。
 *
 * 为什么需要：Word 文档里「标题直接跟下一个标题」是常见写法（目录式罗列、
 * 分节页），mammoth 会为每个标题单独开一章，产出大量纯标题、正文为空的章。
 * 在 EPUB 里每章独立成篇，这类空章算出来就是「1/1 页」，翻页按不动。
 *
 * 1000 字约是一屏到两屏的正文量，低于它的章并进邻章既不会丢内容，
 * 也不会把作者有意分节的长章节揉在一起。
 */
const DOCX_MIN_CHAPTER_CHARS = 1000;

/**
 * 一个段落最多多少字，才有资格被当成伪标题。
 *
 * 中文小标题极少超过这个长度；放宽了正文短句会被大量误判成章，收紧了两级标题
 * （「2.1 核心阅读体验模块｜【用户感知最强、留存最高】」这种）又会被漏掉。
 */
const DOCX_PSEUDO_TITLE_MAX_CHARS = 40;

/** 伪标题的排版特征：整段加粗，或整段居中 / 大字号。 */
function looksLikeHeadingParagraph($: cheerio.CheerioAPI, el: any): boolean {
  const $el = $(el);
  // 整段加粗：文档里「问题」「答案」「一、没逻辑是什么样子？」都是这么排的
  const inner = $el.html() ?? '';
  const strongWrapped = /^\s*<(?:strong|b)\b[^>]*>[\s\S]*<\/(?:strong|b)>\s*$/i.test(inner);
  if (strongWrapped) return true;
  // 整段居中：Word 里居中排的小标题很常见
  if (/\btext-align\s*:\s*center/i.test($el.attr('style') ?? '')) return true;
  return false;
}

/**
 * 伪标题的文本特征：编号式开头，或独立成段的提示词。
 *
 * 只认「行首编号」，不认正文里出现的编号——「二、有逻辑的说话核心 3 件事」是标题，
 * 「用「第一、第二、第三」串联」不是，前者编号在行首、后者在引号里。
 */
const DOCX_PSEUDO_TITLE_PATTERNS: RegExp[] = [
  /^第\s*[0-9一二三四五六七八九十百]+\s*[章节讲节篇部]/,
  /^[一二三四五六七八九十]+\s*[、.．]/,
  /^[（(]\s*[一二三四五六七八九十0-9]+\s*[）)]/,
  /^\d+(?:\.\d+){0,3}\s*[、.．]?\s+\S/,
  /^\d+(?:\.\d+){1,3}\s*[、.．]?\s*$/,
  /^(?:问题|答案|结论|小结|总结|要点|注意|提示|附|附录|前言|序言|后记|附录)\s*[:：]?\s*$/,
];

/**
 * 段落能否当章节边界。
 *
 * 为什么需要：Word 文档里只有一部分小标题用了「标题 1/2」样式，mammoth 转成
 * h1/h2；其余用「标题 3/4」的转成 h3/h4，更多的干脆是加粗的普通段落。
 * 只看 h1/h2 会让这类文档要么一章切不出来（合出占位名「正文」），
 * 要么只抓到零星几个真标题（书名回退成「原文」这种半吊子）。
 */
function isPseudoTitle($: cheerio.CheerioAPI, el: any, text: string): boolean {
  if (text.length === 0 || text.length > DOCX_PSEUDO_TITLE_MAX_CHARS) return false;
  // 长段落哪怕加粗也不是标题——正文首句加粗做强调的情况太常见
  if (!looksLikeHeadingParagraph($, el)) return false;
  return DOCX_PSEUDO_TITLE_PATTERNS.some(re => re.test(text));
}

/**
 * DOCX 转章节：mammoth 转 HTML，按 h1~h4 与伪标题切章，正文转纯文本段落。
 *
 * 切完还要做一遍收敛，否则 Word 那种「一个标题一个标题往下排」的写法会切出
 * 上百个碎章（实测某 11 万字节文档切出 113 章，过半是纯标题）。
 *
 * 收敛从后往前扫，方向很关键：只有「后面还存在有正文的章」时，当前空章才可以丢。
 * 无条件丢弃会误伤两种形状——
 *   ① 文档以空章收尾（末尾那个标题是全书最后一条信息）
 *   ② 正文全部排在标题之前（此时非空章在前、空标题章在后，正是书名回退
 *      `extractDocxMetadata` 依赖的形状，丢了它书名就没了）
 * 从后往前也顺带让「正文排在首个标题之前」那一段能并进后面的真标题章，
 * 不会孤零零留一个「第 1 节」。
 *
 * 合并时被并章的标题降级成正文首行，信息来源不丢；空章的标题只作标题，
 * 不再重复写进正文。
 */
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
  $('h1, h2, h3, h4, p, li').each((_, el) => {
    if ($(el).parents('h1, h2, h3, h4, p, li').length > 0) return;
    const tag = (el as any).tagName?.toLowerCase() ?? '';
    const text = $(el).text().trim();
    if (!text) return;
    const isRealHeading = tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4';
    if (isRealHeading || isPseudoTitle($, el, text)) {
      flush();
      current = { title: text.slice(0, 100), paras: [] };
    } else {
      current.paras.push(text);
    }
  });
  flush();

  if (chapters.length === 0) return [];
  // 无标题文档：合成单章（单章没有可合并对象，直接返回）
  if (chapters.length === 1 && !chapters[0].title) {
    return [{ title: SINGLE_CHAPTER_NAME, content: chapters[0].paras.join('\n') }];
  }

  // 倒序扫描用的栈元素：hasBody 标记「这一章是否已经有正文」，
  // 后面前一章要据此决定能不能并进来（空标题章也能当合并对象）
  const merged: { title: string; paras: string[]; hasBody: boolean }[] = [];
  // 从后往前：seenBody 表示「后方已存在有正文的章」，空章只有在这种情况下才敢丢
  let seenBody = false;
  for (let i = chapters.length - 1; i >= 0; i--) {
    const c = chapters[i];
    if (c.paras.length === 0) {
      if (!seenBody) merged.push({ title: c.title, paras: [], hasBody: false }); // 末尾空章保留，它是唯一的信息载体
      continue;
    }
    seenBody = true;
    const chars = c.paras.join('').length;
    const next = merged[0]; // merged 是逆序栈，栈顶即原文档顺序里的「下一章」
    // 短章并入后一章：保留后一章的真实标题，标题层级不至于塌掉。
    // 判据要看「后一章是否已有正文」：连续短章要一路并到最后一个非空章上，
    // 中间那些单纯标题只是被一起带过去，不另外落脚。
    // 反过来若不加这个判断，20 个要点会全部堆进最后一章，「总纲」被跳过。
    if (chars < DOCX_MIN_CHAPTER_CHARS && next?.hasBody) {
      if (c.title && next.title) next.paras.unshift(c.title);
      next.paras.unshift(...c.paras);
      next.hasBody = true;
      continue;
    }
    merged.unshift({ title: c.title, paras: [...c.paras], hasBody: true });
  }

  if (merged.length === 0) return [];

  return merged.map((c, i) => ({
    title: c.title || untitledChapterName(i),
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

/** Obsidian / Typora 的 callout 类型 → 中文标题（用户没写标题时用它兜底） */
const CALLOUT_LABELS: Record<string, string> = {
  note: '提示',
  info: '说明',
  tip: '技巧',
  hint: '技巧',
  warning: '注意',
  caution: '注意',
  danger: '警告',
  error: '错误',
  success: '完成',
  question: '疑问',
  quote: '引用',
  example: '示例',
  important: '重点',
};

/**
 * 把 Obsidian / Typora 常见写法转成标准 Markdown，再交给 marked 渲染。
 *
 * 代码块与行内代码先切出来原样保留——否则代码里的 `# 注释` 会被当成标签、
 * `a == b` 会被当成高亮，这类误伤比不转换更糟。
 */
export function preprocessObsidianMarkdown(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return segments.map((seg, i) => (i % 2 === 1 ? seg : transformObsidianText(seg))).join('');
}

function transformObsidianText(seg: string): string {
  // 公式先渲染：TeX 里可能含 # 或 ==，先换成 HTML 就不会被后面的标签/高亮规则误伤
  let out = renderMath(seg);

  // YAML frontmatter：包成信息块。不处理的话 marked 会把它当成一条水平线加一段正文
  out = out.replace(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/, (_m, body: string) => {
    const items = String(body)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 30)
      .map(l => `<span class="fm-item">${l.replace(/[<>&]/g, '')}</span>`)
      .join('');
    return items ? `<div class="frontmatter">${items}</div>\n\n` : '';
  });

  // callout：> [!note] 标题 → 引用块里的加粗标题，正文各行仍留在引用块内
  out = out.replace(
    /^([ \t]*)>[ \t]*\[!(\w+)\][+-]?[ \t]*(.*)$/gm,
    (_m, indent: string, kind: string, title: string) => {
      const label = title.trim() || CALLOUT_LABELS[kind.toLowerCase()] || kind;
      return `${indent}> <span class="callout callout-${kind.toLowerCase()}">${label}</span>`;
    },
  );

  // 内嵌 ![[图片.png]] → 图片语法
  out = out.replace(/!\[\[([^\]]+)\]\]/g, (_m, target: string) => `![](${target.trim()})`);

  // wiki 链接 [[目标]] / [[目标|别名]]：带 data-target，便于以后做「点击跳转同一书库的笔记」
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const shown = (alias ?? target).trim();
    const dataTarget = target.trim().replace(/"/g, '');
    return `<span class="wikilink" data-target="${dataTarget}">${shown}</span>`;
  });

  // 高亮 ==文本== → <mark>
  out = out.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

  // 行内 #标签。标题是「# + 空格」，不会命中；标签后面紧跟标点也算结束
  out = out.replace(
    /(^|[\s(（])#([^\s#<>.,;:!?，。；：！？（）()]+)/g,
    '$1<span class="tag">#$2</span>',
  );

  return out;
}

/** 图片扩展名 → 媒体类型；顺带当作白名单：只收这些后缀，别把别的文件塞进包里 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

export const imageMediaType = (filePath: string): string =>
  IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

/** 单张图片的体积上限：笔记里塞了超大图时不至于把内存吃爆 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Markdown 整篇渲染结果（阅读侧按连续滚动显示时用） */
export interface MarkdownRender {
  /** 整篇 HTML：标题带 id 锚点，本地图片已换成本机可读的 URL */
  html: string;
  /** 目录：href 是 `#` + 标题锚点，阅读侧据此滚动定位 */
  toc: TocEntry[];
  /** 正文引用到的本地图片：src 是正文里的引用原文，absPath 是解析出的绝对路径 */
  images: { src: string; absPath: string }[];
  /** 引用了但本机找不到的图片数（原样保留引用，阅读器会显示 alt） */
  missingImages: number;
  /** frontmatter 里的属性（键 → 值数组），供书架按属性筛选 */
  props: Record<string, string[]>;
}

/**
 * 标题锚点前缀，Markdown 与 DOCX 共用（两者都走「整篇渲染 + 目录锚点跳转」这条路）。
 * 前缀短且带连字符，与正文里已有的 id 不容易撞。
 */
const DOC_HEADING_PREFIX = 'dh-';

/**
 * 给渲染结果里的标题编锚点、顺手取出目录。
 *
 * 编号必须在这里一次编完、且按标题在**渲染结果里出现的先后**编：
 * 按源文件里的先后编会错位——引用块、列表里的标题在渲染后位置未必与源文一致，
 * 目录点下去就会落到别的标题上。
 */
function anchorHeadings(html: string): { html: string; toc: TocEntry[] } {
  let seq = 0;
  const anchored = html.replace(
    /<h([1-6])(\s[^>]*)?>/g,
    (_m, level: string, attrs = '') => `<h${level} id="${DOC_HEADING_PREFIX}${seq++}"${attrs}>`,
  );
  // 编号已定好，这一遍只取标题文本，不再改动 HTML
  const toc: TocEntry[] = [];
  for (const m of anchored.matchAll(
    new RegExp(`<h([1-6])\\s+id="(${DOC_HEADING_PREFIX}\\d+)"[^>]*>([\\s\\S]*?)</h\\1>`, 'g'),
  )) {
    const label = m[3].replace(/<[^>]*>/g, '').trim();
    if (label) toc.push({ label: label.slice(0, 100), href: `#${m[2]}` });
  }
  return { html: anchored, toc };
}

/**
 * 读 Markdown 源文件：编码判断 + Obsidian 语法转换都在这一步，
 * 得到可直接交给 marked 的 token 流，同时留下解码后的原文（frontmatter 要按原文解析）。
 */
function readMarkdown(filePath: string): { tokens: ReturnType<typeof marked.lexer>; raw: string } {
  // 与 TXT 同一套编码判断：Windows 记事本存出来的 GBK Markdown 很常见，
  // 直接按 utf-8 读会整篇变成替换字符，且不可逆
  const raw = decodeTextAuto(fs.readFileSync(filePath));
  return { tokens: marked.lexer(preprocessObsidianMarkdown(raw)), raw };
}

/**
 * 把 Markdown 正文里引用的本地图片换成本机可读的 URL。
 *
 * 相对路径的图片在渲染出来之后是找不到的：`./images/pic.png` 会被当成相对阅读器
 * 页面解析。这里按 Markdown 文件所在目录解析成绝对路径，交给 resolveImage 换成
 * 可读 URL（导入时会把图片一起搬进书库，换的就是搬过去之后的地址）。
 * 外链与 data: 内联不动——前者本来就要联网，后者已经自带内容。
 * 没提供 resolveImage 时只做登记，HTML 原样不动。
 */
function rewriteMarkdownImages(
  html: string,
  baseDir: string,
  resolveImage?: (absPath: string, src: string) => string | null,
): { html: string; images: { src: string; absPath: string }[]; missing: number } {
  const images: { src: string; absPath: string }[] = [];
  let missing = 0;

  const out = html.replace(/<img\b[^>]*>/g, tag => {
    const srcMatch = /src="([^"]*)"/.exec(tag);
    if (!srcMatch) return tag;
    const src = srcMatch[1];
    if (!src || /^(https?:|data:|bookfile:|\/\/)/i.test(src)) return tag;

    const abs = path.resolve(baseDir, decodeURI(src.replace(/^\.\//, '')));
    let ok = false;
    try {
      const st = fs.statSync(abs);
      ok = st.isFile() && st.size > 0 && st.size <= MAX_IMAGE_BYTES;
    } catch { /* 文件不在 */ }
    if (!ok) {
      missing++;
      return tag;
    }
    // 非图片后缀不认：避免把任意本地文件都读出来暴露给页面
    if (!IMAGE_MIME[path.extname(abs).toLowerCase()]) return tag;

    images.push({ src, absPath: abs });
    const url = resolveImage?.(abs, src);
    return url ? tag.replace(/src="[^"]*"/, `src="${url}"`) : tag;
  });

  return { html: out, images, missing };
}

/**
 * 按导入时记下的映射换掉正文里的图片引用。
 *
 * 阅读时不能像导入那样按相对路径去解析：书库里的 .md 与图片不在同一棵目录树下
 * （图片统一收在 md-assets/ 里），那个位置的相对路径必然找不到。所以映射按**引用
 * 原文**索引直接替换，也不受用户原来那个目录后来怎么变的影响。
 */
export function applyMarkdownImageMap(html: string, map: Record<string, string>): string {
  if (Object.keys(map).length === 0) return html;
  return html.replace(/<img\b[^>]*>/g, tag => {
    const m = /src="([^"]*)"/.exec(tag);
    const url = m ? map[m[1]] : undefined;
    return url ? tag.replace(/src="[^"]*"/, `src="${url}"`) : tag;
  });
}

/**
 * Markdown 整篇渲染：阅读侧按连续滚动显示，不切章、不分页。
 *
 * 与 mdToChapters 的区别是渲染目标。那边按 h1/h2 切章是为了塞进 EPUB 的 spine
 * （epubjs 不支持片段锚点，合章会让目录全部跳到章首），这里整篇是一个 DOM，
 * 标题带 id、目录直接指锚点——恰是 EPUB 那条路做不到的事。
 *
 * 锚点在**渲染完成后**按出现顺序编号，而不是按 token 数：标题也可能出现在引用块
 * 或列表里，按 token 数编会与真实 DOM 对不上，目录就会跳错位置。
 */
export async function mdRender(
  filePath: string,
  resolveImage?: (absPath: string, src: string) => string | null,
): Promise<MarkdownRender> {
  const { tokens, raw } = readMarkdown(filePath);

  const { html, toc } = anchorHeadings(marked.parser(tokens));

  const { html: withImages, images, missing } = rewriteMarkdownImages(
    html,
    path.dirname(filePath),
    resolveImage,
  );
  // 代码高亮放在最后：它只往 <pre><code> 里加 span，不影响前面几步的结果
  const highlighted = highlightCodeBlocks(withImages);

  // 属性要从未经改写的原文里读：预处理阶段会把 frontmatter 变成信息块
  let props: Record<string, string[]> = {};
  try {
    props = parseFrontmatter(raw);
  } catch { /* 读不出来就当没有属性 */ }

  return { html: highlighted, toc, images, missingImages: missing, props };
}

/** DOCX 整篇渲染结果（阅读侧同样按连续滚动显示） */
export interface DocxRender {
  /** 整篇 HTML：标题带 id 锚点，图片是随 HTML 内联的 data: 地址 */
  html: string;
  /** 目录：href 是 `#` + 标题锚点 */
  toc: TocEntry[];
}

/**
 * DOCX 整篇渲染。
 *
 * 走 mammoth 的 HTML 输出，不再转 EPUB：转 EPUB 是为了复用 epubjs 那条阅读链路，
 * 而 epubjs 不支持片段锚点（`spine.get` 会丢掉 `#` 之后的部分），代价是目录只能按章
 * 跳转。既然 Markdown 已经改走原生渲染，DOCX 也一起过来——两者在阅读侧本就是同一套：
 * 连续滚动、按顶层块记位置、按标题锚点跳转。
 *
 * 图片由 mammoth 直接内联成 data: 地址，所以不必像 Markdown 那样把图片搬进书库、
 * 再按引用原文建映射表——整篇 HTML 自带内容，拷到哪都完整。
 */
export async function docxRender(filePath: string): Promise<DocxRender> {
  const { value: html } = await mammoth.convertToHtml({ buffer: fs.readFileSync(filePath) });
  return anchorHeadings(html);
}

/**
 * Markdown 按标题切章：一级 / 二级标题另起一章，其余内容保留为 HTML。
 *
 * 阅读侧已经改走 mdRender 的整篇渲染（不切章、不分页），这里现在只服务于元数据汇总
 * ——#标签、未完成任务、wiki 链接都是按章组织的，切章后每项才好标出它属于哪一节。
 */
export async function mdToChapters(
  filePath: string,
): Promise<{ title: string; content: string; html: string }[]> {
  const { tokens, raw } = readMarkdown(filePath);
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
    return [{ title: SINGLE_CHAPTER_NAME, content: raw, html: toXhtmlFragment(chapters[0].html.join('')) }];
  }
  return chapters.map((c, i) => ({
    title: c.title || untitledChapterName(i),
    content: '',
    html: toXhtmlFragment(c.html.join('')),
  }));
}

/**
 * 把 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 渲染成 MathML。
 *
 * 选 MathML 而不是 KaTeX 的 HTML 输出，是因为 HTML 版要靠 KaTeX 自己的字体与样式表才好看，
 * 而那套东西得连字体一起塞进每本书里（约 1MB）并在阅读器的 iframe 里挂上；
 * MathML 是 Chromium 原生支持的，零依赖、零额外体积，正合适（本应用只跑在 Electron 里）。
 */
function renderMath(seg: string): string {
  const render = (tex: string, display: boolean) => {
    try {
      return katex.renderToString(tex, { output: 'mathml', throwOnError: false, displayMode: display });
    } catch {
      // 真出意外就原样留着：宁可显示原始 TeX，也不能把正文吃掉
      return display ? `$$${tex}$$` : `$${tex}$`;
    }
  };
  let out = seg;
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => render(tex.trim(), true));
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => render(tex.trim(), true));
  // 行内公式：开头 $ 后不能是空白、结尾 $ 前不能是空白，且内容里不能再有 $。
  // 这几条约束是为了别把「价格 $5 到 $10」这类正文误判成公式。
  out = out.replace(
    /(?<![\w$\\])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g,
    (_m, tex: string) => render(tex, false),
  );
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => render(tex.trim(), false));
  return out;
}

/** 反转义实体：高亮要拿回纯文本再交给 highlight.js，它自己会重新转义 */
const unescapeHtml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * 代码块高亮。
 * marked 已经把代码放进 `<pre><code class="language-x">` 并做了转义，这里只替换里面的内容。
 * 没写语言时用自动识别兜底；识别不出来或语言不认识就原样留着——highlight.js 对未知语言是抛错的。
 */
function highlightCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (whole, attrs: string, code: string) => {
      const lang = /class="language-([\w+#.-]+)"/.exec(attrs)?.[1];
      const text = unescapeHtml(code);
      let highlighted: { value: string } | null = null;
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true });
        } else if (!lang && text.trim() && text.length <= 20000) {
          // 只有没写语言时才猜：写了不认识的语言就老实不高亮，免得猜错反而误导
          highlighted = hljs.highlightAuto(text);
        }
      } catch {
        highlighted = null;
      }
      if (!highlighted) return whole;
      return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted.value}</code></pre>`;
    },
  );
}

/** 从 Markdown 渲染结果里收集 #标签（渲染阶段已排除代码块，这里只需认标记本身） */
export function collectMarkdownTags(chapters: unknown[]): string[] {
  const tags = new Set<string>();
  for (const ch of chapters) {
    const html = (ch as { html?: unknown } | null)?.html;
    if (typeof html !== 'string') continue;
    for (const m of html.matchAll(/<span class="tag">#([^<]+)<\/span>/g)) {
      const t = m[1].trim();
      if (t) tags.add(t);
    }
  }
  return [...tags];
}

/**
 * 解析 YAML frontmatter 里的 `键: 值` 对。
 *
 * 只认最朴素的写法：标量、以及 `[a, b]` / `a, b` 这种行内列表（标签常用）。
 * 嵌套结构、多行块、锚点这类一律跳过——把它们猜错比不解析更糟，
 * 正文里的信息块本来就完整保留了原文。
 */
export function parseFrontmatter(text: string): Record<string, string[]> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    // 缩进行属于嵌套结构，直接跳过。必须在 trim 之前判断——先 trim 就把缩进信息丢了，
    // 嵌套的 `name: 张三` 会被当成顶层属性。
    if (/^\s/.test(line)) continue;
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const kv = /^([^:]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1].trim();
    if (!key) continue;
    const value = kv[2].trim();
    if (!value) continue;
    // 行内列表：[a, b] 或 a, b
    const inline = /^\[(.*)\]$/.exec(value);
    const parts = (inline ? inline[1] : value)
      .split(',')
      .map(v => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (parts.length > 0) out[key] = parts.slice(0, 20);
  }
  return out;
}

/**
 * 从 Markdown 渲染结果里收集 wiki 链接的目标（`[[目标]]` 里的「目标」）。
 * 与标签一样先存下来，之后算「谁引用了谁」时不必回扫正文。
 */
export function collectMarkdownLinks(chapters: unknown[]): string[] {
  const targets = new Set<string>();
  for (const ch of chapters) {
    const html = (ch as { html?: unknown } | null)?.html;
    if (typeof html !== 'string') continue;
    for (const m of html.matchAll(/<span class="wikilink"[^>]*data-target="([^"]*)"/g)) {
      const t = m[1].trim();
      if (t) targets.add(t);
    }
  }
  return [...targets];
}

/**
 * 从 Markdown 渲染结果里收集未完成任务（`- [ ]`）。
 * marked 会把任务清单渲染成带 checkbox 的 `<li>`，已勾选的带 checked 属性，据此区分。
 * 同时记下所属章节与它的跳转目标，点任务就能跳到对应位置。
 */
export function collectMarkdownTasks(
  chapters: unknown[],
  hrefOf: (index: number) => string,
): { text: string; chapter: string; href: string }[] {
  const tasks: { text: string; chapter: string; href: string }[] = [];
  chapters.forEach((ch, i) => {
    const rec = ch as { html?: unknown; title?: unknown } | null;
    const html = rec?.html;
    if (typeof html !== 'string') return;
    const chapter = typeof rec?.title === 'string' ? rec.title : '';
    // 否定预查必须放在标签开头：checked 属性出现在 type 之前，
    // 放在 type 后面看不到它，已勾选的任务会被一并收进来
    for (const m of html.matchAll(/<li><input(?![^>]*\bchecked)[^>]*type="checkbox"[^>]*>([\s\S]*?)<\/li>/g)) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      // 上限只是防病态文档把设置项撑爆
      if (text && tasks.length < 500) tasks.push({ text, chapter, href: hrefOf(i) });
    }
  });
  return tasks;
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
    // Markdown / DOCX 不转 EPUB，索引也要跟着走原生渲染这条路：
    // 走不了的话「语义检索」会对这类书直接报「未能提取正文」
    case '.md':
      return sectionsFromRenderedHtml((await mdRender(filePath)).html);
    case '.docx':
      return sectionsFromRenderedHtml((await docxRender(filePath)).html);
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

/**
 * 整篇 HTML（Markdown / DOCX 的渲染结果）→ 检索段落。
 *
 * 切点取标题锚点：那是与目录同一批 `dh-N` 编号，命中后能直接跳回那一节。
 * 没有标题的文档会退化成整篇一段——至少正文进得了索引，不至于一本书都建不了索引。
 */
function sectionsFromRenderedHtml(html: string): BookSection[] {
  const $ = cheerio.load(html);
  $('script, style').remove();

  const sections: BookSection[] = [];
  let label = '';
  let href = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').replace(/[ \t]+/g, ' ').trim();
    if (text) sections.push({ label, target: JSON.stringify({ href }), text });
    buf = [];
  };

  $.root().children().each((_i, el) => {
    const $el = $(el);
    const id = $el.attr('id') ?? '';
    if (/^h[1-6]$/i.test(el.tagName ?? '') && id.startsWith(DOC_HEADING_PREFIX)) {
      flush();
      label = $el.text().trim().slice(0, 100);
      href = `#${id}`;
    }
    buf.push($el.text());
  });
  flush();
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
