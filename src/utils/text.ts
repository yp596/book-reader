/** HTML 转义（配合 dangerouslySetInnerHTML 使用） */
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 取关键词前后摘要（检索结果用） */
export const excerptAround = (text: string, keyword: string, radius = 40) => {
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return '';
  const clean = text.replace(/\s+/g, ' ');
  return clean.slice(Math.max(0, idx - radius), idx + keyword.length + radius);
};

/** 检索高级选项 */
export interface KeywordOptions {
  /** 区分大小写 */
  caseSensitive?: boolean;
  /** 全词匹配：只在完整的英文/数字单词上命中（中文没有词边界，不受影响） */
  wholeWord?: boolean;
}

/**
 * 关键词 → 匹配用正则。
 * 不用 /g：exec 在同一实例上会带着 lastIndex 跨次调用串味，
 * 而这里的正则会被复用到每个文本节点上。
 */
export const buildKeywordRegex = (keyword: string, opts: KeywordOptions = {}) => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = opts.wholeWord ? `(?<!\\w)${escaped}(?!\\w)` : escaped;
  return new RegExp(body, opts.caseSensitive ? '' : 'i');
};

/** 在文本里找关键词；命中返回位置与命中的原文，未命中返回 null */
export const findKeyword = (text: string, keyword: string, opts: KeywordOptions = {}) => {
  const m = buildKeywordRegex(keyword, opts).exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
};

/**
 * 纯文本 → 把命中词包成 <mark> 的 HTML。
 * 给「没有 DOM 可以下手」的渲染路径用：PDF 重排块就是直接渲染字符串的。
 * 先转义再匹配——标记只能插在转义过的文本上，否则原文里一个 < 就成了标签。
 * 没命中返回空串，调用方据此走原来的纯文本路径。
 */
export const markKeywordHtml = (text: string, keyword: string, opts: KeywordOptions = {}) => {
  const kw = keyword.trim();
  if (!kw) return '';
  const escaped = escapeHtml(text);
  const base = buildKeywordRegex(escapeHtml(kw), opts);
  // 另起一个带 g 的实例：复用同一个正则，exec 的 lastIndex 会跨次调用串味
  const re = new RegExp(base.source, base.flags + 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(escaped)) !== null) {
    // 空匹配会让 lastIndex 原地打转，直接跳出
    if (m[0].length === 0) break;
    out += escaped.slice(last, m.index) + `<mark class="search-mark">${m[0]}</mark>`;
    last = m.index + m[0].length;
    re.lastIndex = last;
  }
  return last === 0 ? '' : out + escaped.slice(last);
};

/**
 * 取 epub.js 某一章的正文文本。
 *
 * epub.js 的 Section.load() resolve 出来的是 xml.documentElement（即 <html> 元素），
 * 不是 Document——所以这里不能写 `doc.body`：body 是 Document 才有的属性，在 <html>
 * 元素上取到的是 undefined，文本会变成空串，检索就「不报错但永远 0 命中」。
 * 取 body 的子文本而不是整个 <html>，是为了不把 <head> 里的 CSS 和 <title> 搜进去。
 * 兼容 Document 是给缓存路径留的余量：那时拿到的可能是 document 本身。
 */
export function epubSectionText(node: unknown): string {
  const anyNode = node as any;
  if (!anyNode) return '';
  const root = anyNode.nodeType === 9 ? anyNode.documentElement : anyNode;
  const body = root?.querySelector?.('body');
  return (body?.textContent ?? root?.textContent ?? '') as string;
}

/** 秒数转中文时长 */
export const formatMinutes = (seconds: number) => {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};

/** 字节数转可读大小 */
export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** 页码钳制到 [1, total] */
export const clampPage = (page: number, total: number) => {
  if (total <= 0) return 1;
  if (Number.isNaN(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), total);
};

/**
 * 章节段落行号 → 页码下标（0 起）。
 * pageStartLines 为每页起始段落行号（递增），取起始行号不超过 line 的最后一页。
 */
export const lineToPageIndex = (pageStartLines: number[], line: number) => {
  if (pageStartLines.length === 0) return 0;
  let lo = 0;
  let hi = pageStartLines.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageStartLines[mid] <= line) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
};

/** 上次阅读位置：EPUB 记 CFI，TXT/PDF 记页码（0 起） */
export interface SavedPosition {
  cfi?: string;
  page?: number;
  /**
   * PDF 重排模式下的屏号。
   * 重排屏是按字数重新切的，跨原始页边界，与 PDF 页序不互相换算。所以同一处位置
   * 两套坐标都记：切回原始版式用 page，重排时用 reflow。
   */
  reflow?: number;
  /**
   * 文档型格式（Markdown / DOCX）的块序号（顶层块，0 起）。
   * 它们是一整篇连续滚动，没有页可分，能指望的稳定锚点就是「第几个顶层块」
   * ——块结构不随字号、窗口宽度变化，重新打开时把那一块滚回顶端即可。
   * 早期只有 Markdown 时这个键叫 mdBlock，读的时候一并认，免得旧进度丢失。
   */
  docBlock?: number;
}

/** 序列化阅读位置，存入 settings 表的 lastPos:<bookId> */
export const serializeSavedPosition = (pos: SavedPosition) => JSON.stringify(pos);

/** 解析阅读位置，损坏或空值返回 null */
export const parseSavedPosition = (raw: string | null | undefined): SavedPosition | null => {
  if (!raw) return null;
  const nonNegInt = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  try {
    const parsed = JSON.parse(raw) as SavedPosition | null;
    const cfi = typeof parsed?.cfi === 'string' && parsed.cfi ? parsed.cfi : undefined;
    const page = nonNegInt(parsed?.page);
    const reflow = nonNegInt(parsed?.reflow);
    // 旧键 mdBlock 一并认：这批位置是早先按下标存的，丢了用户就得重新找位置
    const docBlock = nonNegInt(parsed?.docBlock) ?? nonNegInt((parsed as { mdBlock?: unknown })?.mdBlock);
    if (cfi === undefined && page === undefined && reflow === undefined && docBlock === undefined) {
      return null;
    }
    return {
      ...(cfi !== undefined ? { cfi } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(reflow !== undefined ? { reflow } : {}),
      ...(docBlock !== undefined ? { docBlock } : {}),
    };
  } catch {
    return null;
  }
};

/** 每页目标字数（达到即收页，再按章界另起） */
export const TXT_PAGE_CHARS = 3000;

export interface TextPagination {
  pages: string[];
  /** 每页起始段落行号，用于把目录里的章节行号换算成真实页码 */
  startLines: number[];
}

/**
 * 把长文本切成阅读页。
 *
 * 两个切页条件：
 * 1. 字数达到阈值——保证单页负荷可控；
 * 2. 命中章节标题——标题必须落在页首。缺了这条，一页里会同时出现上一章的
 *    结尾与下一章的开头，标题直接插在上文段落中间（实测一本书 147 页里
 *    有 125 页如此）。
 *
 * 标题按**文本**而非行号匹配：一键规整会删空行、行号跟着错位，
 * 而目录里存的 label 就是标题行原文，对规整与否都成立。
 */
export function paginateText(
  text: string,
  chapterLabels: Iterable<string> = [],
  charsPerPage: number = TXT_PAGE_CHARS,
): TextPagination {
  const headings = new Set<string>();
  for (const label of chapterLabels) {
    const trimmed = label.trim();
    if (trimmed) headings.add(trimmed);
  }

  const paragraphs = text.split('\n');
  const pages: string[] = [];
  const startLines: number[] = [];
  let current = '';

  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i];
    const trimmed = line.trim();
    // 章界另起：当前页有内容，且这一行是章节标题，先把上一页收掉
    if (current !== '' && trimmed && headings.has(trimmed)) {
      pages.push(current);
      current = '';
    }
    if (current === '') startLines.push(i);
    current += line + '\n';
    if (current.length >= charsPerPage) {
      pages.push(current);
      current = '';
    }
  }
  if (current) pages.push(current);
  return { pages, startLines };
}
