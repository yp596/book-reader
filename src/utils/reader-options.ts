/** 阅读主题：深色 / 浅色 / 护眼纸质 */
export const THEMES = [
  { key: 'dark', label: '深色' },
  { key: 'light', label: '浅色' },
  { key: 'sepia', label: '护眼' },
] as const;

export type ThemeName = (typeof THEMES)[number]['key'];

/** 阅读字体选项 */
export const FONT_OPTIONS = [
  { key: 'system', label: '系统默认', stack: '' },
  { key: 'serif', label: '宋体', stack: "'Noto Serif SC','Songti SC','SimSun',serif" },
  { key: 'sans', label: '黑体', stack: "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif" },
  { key: 'kai', label: '楷体', stack: "'Kaiti SC','KaiTi','STKaiti',serif" },
  { key: 'mono', label: '等宽', stack: "'JetBrains Mono',Consolas,'Noto Sans Mono',monospace" },
] as const;

export type FontKey = (typeof FONT_OPTIONS)[number]['key'];

export const fontStackOf = (key: string): string =>
  FONT_OPTIONS.find(f => f.key === key)?.stack ?? '';

/**
 * 高亮颜色三套取值：
 * - css：TXT 高亮底色（半透明）
 * - solid：下划线用（半透明描边会看不清，必须用实色）
 * - epubFill：EPUB 注解填充
 */
export const HIGHLIGHT_COLORS = [
  { key: 'yellow', label: '黄', css: 'rgba(255,235,59,.45)', solid: '#f5c518', epubFill: '#ffeb3b' },
  { key: 'green', label: '绿', css: 'rgba(105,240,174,.45)', solid: '#2ec27e', epubFill: '#69f0ae' },
  { key: 'blue', label: '蓝', css: 'rgba(128,216,255,.45)', solid: '#3aa0e0', epubFill: '#80d8ff' },
  { key: 'red', label: '红', css: 'rgba(255,138,128,.45)', solid: '#e74c3c', epubFill: '#ff8a80' },
] as const;

export type HighlightColorKey = (typeof HIGHLIGHT_COLORS)[number]['key'];

export const highlightColorOf = (key: string) =>
  HIGHLIGHT_COLORS.find(c => c.key === key) ?? HIGHLIGHT_COLORS[0];
