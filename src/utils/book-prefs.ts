import type { ThemeName } from './reader-options';

/** 单本书的阅读排版偏好（缺项回退全局默认） */
export interface ReaderPrefs {
  theme: ThemeName;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  /** 双栏（TXT 分栏 / EPUB spread） */
  dualColumn: boolean;
  /** EPUB 版式：分页 / 滚动 */
  flowMode: 'paginated' | 'scrolled';
  /** PDF 缩放倍率 */
  pdfScale: number;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'dark',
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'system',
  dualColumn: false,
  flowMode: 'paginated',
  pdfScale: 1.5,
};

/** 每本书的偏好存这个 key 下 */
export const bookPrefsKey = (bookId: number) => `bookPrefs:${bookId}`;

const isTheme = (v: unknown): v is ThemeName =>
  v === 'dark' || v === 'light' || v === 'sepia';

const numIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * 解析书籍专属偏好。坏数据 / 越界值一律丢弃，
 * 只保留可靠字段，避免脏值污染阅读视图。
 */
export function parseBookPrefs(raw: string | null | undefined): Partial<ReaderPrefs> {
  if (!raw) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const out: Partial<ReaderPrefs> = {};
  if (isTheme(parsed.theme)) out.theme = parsed.theme;
  if (numIn(parsed.fontSize, 12, 32)) out.fontSize = parsed.fontSize;
  if (numIn(parsed.lineHeight, 1, 3)) out.lineHeight = parsed.lineHeight;
  if (typeof parsed.fontFamily === 'string' && parsed.fontFamily) out.fontFamily = parsed.fontFamily;
  if (typeof parsed.dualColumn === 'boolean') out.dualColumn = parsed.dualColumn;
  if (parsed.flowMode === 'paginated' || parsed.flowMode === 'scrolled') out.flowMode = parsed.flowMode;
  if (numIn(parsed.pdfScale, 0.5, 3)) out.pdfScale = parsed.pdfScale;
  return out;
}

/** 书籍专属覆盖全局默认 */
export function mergePrefs(base: ReaderPrefs, override: Partial<ReaderPrefs>): ReaderPrefs {
  return { ...base, ...override };
}

/** 是否为有效偏好对象（用于「该书是否记住过布局」判断） */
export function hasBookPrefs(raw: string | null | undefined): boolean {
  return Object.keys(parseBookPrefs(raw)).length > 0;
}
