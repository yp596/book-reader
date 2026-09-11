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
}

/** 序列化阅读位置，存入 settings 表的 lastPos:<bookId> */
export const serializeSavedPosition = (pos: SavedPosition) => JSON.stringify(pos);

/** 解析阅读位置，损坏或空值返回 null */
export const parseSavedPosition = (raw: string | null | undefined): SavedPosition | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedPosition | null;
    const cfi = typeof parsed?.cfi === 'string' && parsed.cfi ? parsed.cfi : undefined;
    const page =
      typeof parsed?.page === 'number' && Number.isInteger(parsed.page) && parsed.page >= 0
        ? parsed.page
        : undefined;
    if (cfi === undefined && page === undefined) return null;
    return { ...(cfi !== undefined ? { cfi } : {}), ...(page !== undefined ? { page } : {}) };
  } catch {
    return null;
  }
};
