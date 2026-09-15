import fs from 'fs';
import JSZip from 'jszip';

export interface EpubChapterInput {
  title: string;
  paragraphs: string[];
}

/** XML 转义 */
export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 章节正文转 XHTML（段落化，空行丢弃） */
export const chapterToXhtml = (title: string, text: string): string => {
  const paras = text
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `    <p>${escapeXml(p)}</p>`)
    .join('\n');
  return wrapChapter(title, paras);
};

/**
 * 章节样式表（Typora 取向的阅读排版）。
 *
 * 只定义结构：标题层级、引用、列表、代码、表格、图片、高亮与 Obsidian 语义元素。
 * 刻意不设字号 / 行距 / 字体 / 正文颜色——那几项由阅读器的排版设置控制，
 * 写死会把用户的选择盖掉。
 */
export const READER_CSS = `body { margin: 0; padding: 0 2px; word-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.5em 0 0.6em; font-weight: 600; }
h1 { font-size: 1.65em; border-bottom: 1px solid rgba(128,128,128,0.35); padding-bottom: 0.3em; }
h2 { font-size: 1.4em; border-bottom: 1px solid rgba(128,128,128,0.22); padding-bottom: 0.25em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1.05em; }
p { margin: 0 0 1em; }
blockquote { margin: 0 0 1em; padding: 2px 0 2px 1em; border-left: 3px solid rgba(128,128,128,0.35); }
blockquote p:last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 1em; padding-left: 1.7em; }
li { margin: 0.25em 0; }
li > ul, li > ol { margin-bottom: 0; }
code { font-family: Consolas, "Courier New", monospace; font-size: 0.92em; padding: 0.12em 0.35em; border-radius: 4px; background: rgba(128,128,128,0.16); }
pre { margin: 0 0 1em; padding: 0.9em 1em; border-radius: 6px; background: rgba(128,128,128,0.14); overflow-x: auto; }
pre code { padding: 0; background: none; font-size: 0.9em; }
table { border-collapse: collapse; margin: 0 0 1em; width: 100%; }
th, td { border: 1px solid rgba(128,128,128,0.35); padding: 0.4em 0.6em; text-align: left; }
th { background: rgba(128,128,128,0.12); font-weight: 600; }
img { max-width: 100%; height: auto; display: block; margin: 0 auto 1em; }
hr { border: none; border-top: 1px solid rgba(128,128,128,0.35); margin: 1.8em 0; }
mark { background: rgba(255, 208, 0, 0.45); padding: 0 0.1em; }
a { text-decoration: none; border-bottom: 1px solid rgba(128,128,128,0.45); }
input[type="checkbox"] { margin-right: 0.4em; }
/* Obsidian 语义元素 */
.frontmatter { display: block; margin: 0 0 1.4em; padding: 0.7em 0.9em; border: 1px dashed rgba(128,128,128,0.45); border-radius: 6px; font-size: 0.9em; opacity: 0.85; }
.frontmatter .fm-item { display: block; margin: 0.15em 0; }
.callout { display: block; font-weight: 600; margin-bottom: 0.25em; }
.wikilink { border-bottom: 1px dashed rgba(128,128,128,0.6); cursor: pointer; }
.tag { padding: 0.05em 0.4em; margin: 0 0.1em; border-radius: 10px; background: rgba(128,128,128,0.18); font-size: 0.9em; }
/* 代码高亮：渲染色调到中等亮度，浅色与深色主题下都看得清（阅读器主题可切，这里不能写死背景色） */
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section { color: #9a5cd0; }
.hljs-string, .hljs-attr, .hljs-addition { color: #2f8a5b; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: #c07a1a; }
.hljs-comment, .hljs-quote { color: rgba(128,128,128,0.95); font-style: italic; }
.hljs-title, .hljs-name, .hljs-function .hljs-title { color: #2a76c4; }
.hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: #b8543d; }
.hljs-meta, .hljs-doctag, .hljs-tag { color: #6b7280; }
.hljs-deletion { color: #b91c1c; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
/* 公式：MathML 由 Chromium 原生渲染，这里只保证块级公式居中、长公式可横向滚动 */
math { font-size: 1.05em; }
p > math[display="block"], mtext { overflow-x: auto; }
`;

/**
 * 已是 XHTML 片段的章节正文直接包成文档。
 * 调用方负责片段的转义与合法性（EPUB 章节是 XML，未自闭合的空元素会导致解析失败）。
 */
export const htmlToChapterXhtml = (title: string, innerHtml: string): string =>
  wrapChapter(title, innerHtml);

const wrapChapter = (title: string, inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="../Styles/reader.css"/></head>\n<body>\n  <h2>${escapeXml(title)}</h2>\n${inner}\n</body>\n</html>\n`;

/**
 * OPF 元数据+清单+脊骨。
 * images 是随包带上的本地图片（Markdown 笔记里的插图），必须登记进清单，
 * 否则严格解析器会认为包里有多余资源，部分阅读器也不会加载它们。
 */
export const buildOpf = (
  bookTitle: string,
  chapterIds: string[],
  images: { name: string; mediaType: string }[] = [],
): string => {
  const manifest = chapterIds
    .map(id => `    <item id="${id}" href="Text/${id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const imageItems = images
    .map((img, i) => `    <item id="img${i + 1}" href="${img.name}" media-type="${img.mediaType}"/>`)
    .join('\n');
  const spine = chapterIds.map(id => `    <itemref idref="${id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(bookTitle)}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <dc:identifier id="bookid">book-reader-${Date.now()}</dc:identifier>\n  </metadata>\n  <manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n    <item id="css" href="Styles/reader.css" media-type="text/css"/>\n${manifest}\n${imageItems ? imageItems + '\n' : ''}  </manifest>\n  <spine toc="ncx">\n${spine}\n  </spine>\n</package>\n`;
};

/**
 * NCX 目录。
 * href 由调用方给出，可以是章节文件，也可以带锚点（`Text/ch1.xhtml#h-3`）——
 * Markdown 整篇不切章，目录靠标题锚点跳转。
 */
export const buildNcx = (bookTitle: string, entries: { title: string; href: string }[]): string => {
  const navMap = entries
    .map(
      (c, i) => `    <navPoint id="nav${i + 1}" playOrder="${i + 1}">\n      <navLabel><text>${escapeXml(c.title)}</text></navLabel>\n      <content src="${c.href}"/>\n    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="book-reader"/></head>\n  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>\n  <navMap>\n${navMap}\n  </navMap>\n</ncx>\n`;
};

const CONTAINER_XML =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

/** 组装完整 EPUB（返回 Buffer）。images 为随包带上的本地图片 */
export async function buildEpub(
  bookTitle: string,
  chapters: { title: string; content: string; html?: string }[],
  images: { archiveName: string; sourcePath: string; mediaType: string }[] = [],
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('OEBPS/Styles/reader.css', READER_CSS);
  for (const img of images) {
    try {
      // 图片多为已压缩格式，再压一遍收益小，原样存更快也更省内存
      zip.file(`OEBPS/${img.archiveName}`, fs.readFileSync(img.sourcePath), { compression: 'STORE' });
    } catch { /* 文件在解析后被移走：跳过，章节里会显示 alt 文本 */ }
  }
  const ids = chapters.map((_, i) => `ch${i + 1}`);
  chapters.forEach((ch, i) => {
    zip.file(
      `OEBPS/Text/${ids[i]}.xhtml`,
      ch.html != null ? htmlToChapterXhtml(ch.title, ch.html) : chapterToXhtml(ch.title, ch.content),
    );
  });
  zip.file(
    'OEBPS/content.opf',
    buildOpf(
      bookTitle,
      ids,
      images.map(img => ({ name: img.archiveName, mediaType: img.mediaType })),
    ),
  );
  zip.file(
    'OEBPS/toc.ncx',
    buildNcx(
      bookTitle,
      chapters.map((ch, i) => ({ title: ch.title, href: `Text/${ids[i]}.xhtml` })),
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
