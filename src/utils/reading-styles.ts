/**
 * 阅读样式预设 + 自定义 CSS 校验。
 *
 * 作用范围：EPUB 正文。
 * TXT 渲染出来是纯文本、没有 h1/h2 这类结构标签，靠 CSS 做「一章一页」
 * 无从下手——TXT 的排版请用「排版自定义」面板里的字号/行距/边距。
 */

export interface StylePreset {
  key: string;
  name: string;
  desc: string;
  /** 注入到 EPUB 章节文档里的样式；空串表示不注入、走主题 */
  css: string;
}

/** 纸质小说：一页一章 + 米黄纸感 + 衬线正文 */
const PAPER_CSS = `
/* 页面底色与整体排版 */
body {
  background: #f5efe1 !important;
  color: #3a3630 !important;
  font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif !important;
  font-size: 18px !important;
  line-height: 1.6 !important;
  padding: 5% 8% !important;
  text-align: justify;
}

/* 正文段落 */
p {
  margin: 0 0 0.85em !important;
  text-indent: 2em !important;
  line-height: 1.6 !important;
  orphans: 2;
  widows: 2;
}
blockquote p, li p, td p { text-indent: 0 !important; }

/* 章节标题：强制另起一页，且不与正文分离 */
h1, h2 {
  break-before: column;      /* Koodo 式多列分页下生效 */
  page-break-before: always; /* 兼容分页媒体与旧引擎 */
  break-after: avoid;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
  font-size: 1.6em !important;
  font-weight: 700 !important;
  line-height: 1.35 !important;
  letter-spacing: 0.02em;
  color: #2f2b26 !important;
  text-indent: 0 !important;
  text-align: left !important;
  margin: 0 0 1.5em !important;
}

/* 小节标题只防分割，不强制分页——否则一章会被拆得七零八落 */
h3, h4, h5, h6 {
  break-after: avoid;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
  text-indent: 0 !important;
  margin: 1.4em 0 0.8em !important;
  color: #2f2b26 !important;
}

img, figure, hr {
  break-inside: avoid;
  page-break-inside: avoid;
  max-width: 100% !important;
  height: auto !important;
}

a { color: #8a6d3b !important; text-decoration: none; border-bottom: 1px dotted #c8b48a; }
`.trim();

/** 护眼绿：低对比、偏暗背景，长时间阅读负担小 */
const EYECARE_CSS = `
body {
  background: #cce8cf !important;
  color: #2f3a2f !important;
  font-size: 18px !important;
  line-height: 1.75 !important;
  padding: 5% 8% !important;
  text-align: justify;
}
p { margin: 0 0 0.9em !important; text-indent: 2em !important; orphans: 2; widows: 2; }
h1, h2 {
  break-before: column;
  page-break-before: always;
  break-after: avoid;
  page-break-after: avoid;
  font-size: 1.5em !important;
  color: #23301f !important;
  text-indent: 0 !important;
  margin: 0 0 1.4em !important;
}
`.trim();

/** 极简：无缩进、紧凑、无色块干扰 */
const MINIMAL_CSS = `
body {
  background: #fbfbfb !important;
  color: #333333 !important;
  line-height: 1.55 !important;
  padding: 4% 7% !important;
}
p { margin: 0 0 0.6em !important; text-indent: 0 !important; }
h1, h2 {
  break-before: column;
  page-break-before: always;
  break-after: avoid;
  page-break-after: avoid;
  font-size: 1.45em !important;
  font-weight: 600 !important;
  margin: 0 0 1.1em !important;
  text-indent: 0 !important;
}
`.trim();

export const STYLE_PRESETS: StylePreset[] = [
  { key: 'none', name: '跟随主题', desc: '不注入额外样式，使用上方主题与字体设置', css: '' },
  { key: 'paper', name: '纸质小说', desc: '米黄纸感、衬线正文、一章另起一页', css: PAPER_CSS },
  { key: 'eyecare', name: '护眼绿', desc: '低对比绿底，长时间阅读负担小', css: EYECARE_CSS },
  { key: 'minimal', name: '极简', desc: '无缩进、紧凑排版，信息密度高', css: MINIMAL_CSS },
];

export function getStylePreset(key: string): StylePreset {
  return STYLE_PRESETS.find(p => p.key === key) ?? STYLE_PRESETS[0];
}

/** 自定义 CSS 长度上限：留足空间，同时挡住误贴整个文件 */
export const MAX_CSS_LEN = 20000;

export interface CssCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验自定义 CSS。
 * 除了长度，主要挡两类会破坏「纯离线」承诺的写法——
 * 它们会让阅读区在你不察觉时发起网络请求。
 */
export function validateCustomCss(css: string): CssCheck {
  if (typeof css !== 'string') return { ok: true };
  if (css.length > MAX_CSS_LEN) {
    return { ok: false, reason: `自定义样式过长（上限 ${MAX_CSS_LEN} 字符）` };
  }
  if (/@import/i.test(css)) {
    return { ok: false, reason: '不支持 @import——它会引入外部样式请求' };
  }
  if (/url\(\s*['"]?https?:/i.test(css)) {
    return { ok: false, reason: '不支持 http(s) 图片地址——会发起网络请求' };
  }
  return { ok: true };
}

/** 解析出最终要注入的 CSS：自定义非空则优先，否则用预设 */
export function resolveCustomCss(customCss: string, presetKey: string): string {
  const custom = (customCss || '').trim();
  if (custom && validateCustomCss(custom).ok) return custom;
  return getStylePreset(presetKey).css;
}
