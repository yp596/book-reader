import type { ThemeName } from './reader-options';
import { STYLE_PRESETS } from './reading-styles';

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
  /** 漫画：双页合并显示（跨页大图并排） */
  comicSpread: boolean;
  /** 漫画：右向左翻页（日漫阅读方向） */
  comicRtl: boolean;
  /** 竖排阅读（古籍从右向左），只对文字类格式有效 */
  vertical: boolean;
  /** 自定义背景色（空串=跟随主题） */
  bgColor: string;
  /** 自定义文字色（空串=跟随主题） */
  textColor: string;
  /** 页面左右边距（像素） */
  pagePadding: number;
  /** 段落间距（em） */
  paraSpacing: number;
  /** 页面上下留白（像素，叠加在默认留白之上；0=只用默认） */
  pageGap: number;
  /** 阅读样式预设（EPUB 正文），值取自 reading-styles 的预设名 */
  readingStyle: string;
  /** 隐藏批注标记（只隐藏，不删除） */
  hideMarks: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'dark',
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'system',
  dualColumn: false,
  flowMode: 'paginated',
  pdfScale: 1.5,
  comicSpread: false,
  comicRtl: false,
  vertical: false,
  bgColor: '',
  textColor: '',
  pagePadding: 56,
  paraSpacing: 0,
  pageGap: 0,
  readingStyle: 'none',
  hideMarks: false,
};

/** 每本书的偏好存这个 key 下 */
export const bookPrefsKey = (bookId: number) => `bookPrefs:${bookId}`;

const isTheme = (v: unknown): v is ThemeName =>
  v === 'dark' || v === 'light' || v === 'sepia';

const numIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** 颜色白名单：只接受 3 位或 6 位十六进制 */
export const isHexColor = (v: unknown): v is string =>
  typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

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
  if (typeof parsed.comicSpread === 'boolean') out.comicSpread = parsed.comicSpread;
  if (typeof parsed.comicRtl === 'boolean') out.comicRtl = parsed.comicRtl;
  if (typeof parsed.vertical === 'boolean') out.vertical = parsed.vertical;
  // 颜色只接受 #rgb / #rrggbb：脏值会直接把阅读区搞花，宁可丢弃回退主题
  if (isHexColor(parsed.bgColor)) out.bgColor = parsed.bgColor;
  if (isHexColor(parsed.textColor)) out.textColor = parsed.textColor;
  if (numIn(parsed.pagePadding, 0, 200)) out.pagePadding = parsed.pagePadding;
  if (numIn(parsed.paraSpacing, 0, 3)) out.paraSpacing = parsed.paraSpacing;
  if (numIn(parsed.pageGap, 0, 200)) out.pageGap = parsed.pageGap;
  // 预设名要在白名单里：脏值会让面板下拉显示空白项
  if (typeof parsed.readingStyle === 'string' && STYLE_PRESETS.some(p => p.key === parsed.readingStyle)) {
    out.readingStyle = parsed.readingStyle;
  }
  if (typeof parsed.hideMarks === 'boolean') out.hideMarks = parsed.hideMarks;
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
