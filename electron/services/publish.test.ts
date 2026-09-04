import { describe, it, expect } from 'vitest';
import { applyTextFilters } from './book-source';
import { escapeXml, chapterToXhtml, buildOpf, buildNcx, buildEpub } from './epub-export';
import JSZip from 'jszip';

describe('applyTextFilters', () => {
  it('按顺序应用多条替换', () => {
    const out = applyTextFilters('欢迎访问XXX小说网，本章完', [
      { pattern: 'XXX小说网', replacement: '' },
      { pattern: '本章完', replacement: '' },
    ]);
    expect(out).toBe('欢迎访问，');
  });

  it('非法正则跳过不中断', () => {
    const out = applyTextFilters('abc', [
      { pattern: '([', replacement: '' },
      { pattern: 'b', replacement: 'B' },
    ]);
    expect(out).toBe('aBc');
  });

  it('空规则原样返回', () => {
    expect(applyTextFilters('abc', [])).toBe('abc');
  });
});

describe('epub builders', () => {
  it('escapeXml 转义特殊字符', () => {
    expect(escapeXml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
  });

  it('chapterToXhtml 段落化并丢弃空行', () => {
    const xhtml = chapterToXhtml('第一章', '第一段\n\n第二段');
    expect(xhtml).toContain('<h2>第一章</h2>');
    expect(xhtml).toContain('<p>第一段</p>');
    expect(xhtml).toContain('<p>第二段</p>');
    expect(xhtml.match(/<p>/g)?.length).toBe(2);
  });

  it('buildOpf 清单与脊骨数量一致', () => {
    const opf = buildOpf('测试书', ['ch1', 'ch2']);
    expect(opf).toContain('<dc:title>测试书</dc:title>');
    expect(opf.match(/<itemref/g)?.length).toBe(2);
  });

  it('buildNcx 目录顺序正确', () => {
    const ncx = buildNcx('测试书', [
      { id: 'ch1', title: '第一章' },
      { id: 'ch2', title: '第二章' },
    ]);
    expect(ncx.indexOf('第一章')).toBeLessThan(ncx.indexOf('第二章'));
    expect(ncx).toContain('playOrder="2"');
  });

  it('buildEpub 生成可解包的标准结构', async () => {
    const buf = await buildEpub('测试书', [
      { title: '第一章', content: '正文一' },
      { title: '第二章', content: '正文二' },
    ]);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('META-INF/container.xml')).not.toBeNull();
    expect(zip.file('OEBPS/content.opf')).not.toBeNull();
    expect(zip.file('OEBPS/toc.ncx')).not.toBeNull();
    expect(zip.file('OEBPS/Text/ch1.xhtml')).not.toBeNull();
    expect(zip.file('OEBPS/Text/ch2.xhtml')).not.toBeNull();
    const ch1 = await zip.file('OEBPS/Text/ch1.xhtml')!.async('string');
    expect(ch1).toContain('正文一');
  });
});
