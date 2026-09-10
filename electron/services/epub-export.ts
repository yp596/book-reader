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
 * 已是 XHTML 片段的章节正文直接包成文档。
 * 调用方负责片段的转义与合法性（EPUB 章节是 XML，未自闭合的空元素会导致解析失败）。
 */
export const htmlToChapterXhtml = (title: string, innerHtml: string): string =>
  wrapChapter(title, innerHtml);

const wrapChapter = (title: string, inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(title)}</title></head>\n<body>\n  <h2>${escapeXml(title)}</h2>\n${inner}\n</body>\n</html>\n`;

/** OPF 元数据+清单+脊骨 */
export const buildOpf = (bookTitle: string, chapterIds: string[]): string => {
  const manifest = chapterIds
    .map(id => `    <item id="${id}" href="Text/${id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spine = chapterIds.map(id => `    <itemref idref="${id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.opf.org/2007/opf" version="2.0" unique-identifier="bookid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(bookTitle)}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <dc:identifier id="bookid">book-reader-${Date.now()}</dc:identifier>\n  </metadata>\n  <manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n${manifest}\n  </manifest>\n  <spine toc="ncx">\n${spine}\n  </spine>\n</package>\n`;
};

/** NCX 目录 */
export const buildNcx = (bookTitle: string, chapters: { id: string; title: string }[]): string => {
  const navMap = chapters
    .map(
      (c, i) => `    <navPoint id="nav${i + 1}" playOrder="${i + 1}">\n      <navLabel><text>${escapeXml(c.title)}</text></navLabel>\n      <content src="Text/${c.id}.xhtml"/>\n    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="book-reader"/></head>\n  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>\n  <navMap>\n${navMap}\n  </navMap>\n</ncx>\n`;
};

const CONTAINER_XML =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

/** 组装完整 EPUB（返回 Buffer） */
export async function buildEpub(
  bookTitle: string,
  chapters: { title: string; content: string; html?: string }[],
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  const ids = chapters.map((_, i) => `ch${i + 1}`);
  chapters.forEach((ch, i) => {
    zip.file(
      `OEBPS/Text/${ids[i]}.xhtml`,
      ch.html ? htmlToChapterXhtml(ch.title, ch.html) : chapterToXhtml(ch.title, ch.content),
    );
  });
  zip.file(
    'OEBPS/content.opf',
    buildOpf(bookTitle, ids),
  );
  zip.file(
    'OEBPS/toc.ncx',
    buildNcx(
      bookTitle,
      chapters.map((ch, i) => ({ id: ids[i], title: ch.title })),
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
