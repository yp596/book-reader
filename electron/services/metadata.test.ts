import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import {
  extractMetadata,
  extractToc,
  parseTxtChapters,
  docxToChapters,
  mdToChapters,
  mdToDocument,
  imageMediaType,
  collectMarkdownTags,
  collectMarkdownTasks,
  collectMarkdownLinks,
  parseFrontmatter,
  decodeTextAuto,
  isGenericChapterTitle,
} from './metadata';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-meta-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TXT 元数据', () => {
  it('首行当书名，识别作者行', async () => {
    const p = path.join(tmpDir, 'book.txt');
    fs.writeFileSync(p, '三体\n作者：刘慈欣\n\n第一章 科学边界\n', 'utf-8');
    expect(await extractMetadata(p, '.txt')).toEqual({ title: '三体', author: '刘慈欣' });
  });

  it('去书名号', () => {
    const p = path.join(tmpDir, 'book.txt');
    fs.writeFileSync(p, '《明朝那些事儿》\n', 'utf-8');
    return extractMetadata(p, '.txt').then(meta => {
      expect(meta?.title).toBe('明朝那些事儿');
    });
  });

  it('GBK 编码回退解码', async () => {
    const p = path.join(tmpDir, 'gbk.txt');
    // "测试\n" 的 GBK 字节（非法 UTF-8，触发回退）
    fs.writeFileSync(p, Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x0a]));
    expect(await extractMetadata(p, '.txt')).toEqual({ title: '测试', author: undefined });
  });

  it('空文件返回 null', async () => {
    const p = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(p, '');
    expect(await extractMetadata(p, '.txt')).toBeNull();
  });
});

describe('EPUB 元数据', () => {
  async function makeEpub(title?: string, author?: string): Promise<string> {
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      '<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    );
    const dcTitle = title ? `<dc:title>${title}</dc:title>` : '';
    const dcCreator = author ? `<dc:creator>${author}</dc:creator>` : '';
    zip.file(
      'OEBPS/content.opf',
      `<?xml version="1.0"?><package><metadata>${dcTitle}${dcCreator}</metadata></package>`,
    );
    const p = path.join(tmpDir, 'book.epub');
    fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));
    return p;
  }

  it('读取 OPF 书名作者', async () => {
    const p = await makeEpub('三体', '刘慈欣');
    expect(await extractMetadata(p, '.epub')).toEqual({ title: '三体', author: '刘慈欣' });
  });

  it('无书名返回 null', async () => {
    const p = await makeEpub(undefined, '刘慈欣');
    expect(await extractMetadata(p, '.epub')).toBeNull();
  });

  it('XML 转义字符反转义', async () => {
    const p = await makeEpub('A &amp; B', undefined);
    expect(await extractMetadata(p, '.epub')).toEqual({ title: 'A & B', author: undefined });
  });
});

describe('兜底', () => {  it('未知格式返回 null', async () => {
    const p = path.join(tmpDir, 'book.xyz');
    fs.writeFileSync(p, 'data');
    expect(await extractMetadata(p, '.xyz')).toBeNull();
  });

  it('不存在的文件返回 null（不抛异常）', async () => {
    expect(await extractMetadata(path.join(tmpDir, 'missing.txt'), '.txt')).toBeNull();
  });
});

describe('parseTxtChapters', () => {
  /** 章节之间的正文，长度超过命中间距阈值（1000 字符），模拟真实长篇 */
  const gap = '正文内容'.repeat(300);

  it('识别第X章标题', () => {
    const text = '三体\n\n第一章 科学边界\n' + gap + '\n第二章 台球\n更多正文';
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['第一章 科学边界', '第二章 台球']);
  });

  it('识别序言尾声番外', () => {
    const text = '序言\n' + gap + '\n第一章 开始\n' + gap + '\n尾声\n' + gap;
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['序言', '第一章 开始', '尾声']);
  });

  it('识别阿拉伯数字与分隔符标题', () => {
    const text = '1、这个就是标题\n' + gap + '\n02美好的明天\n' + gap;
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['1、这个就是标题', '02美好的明天']);
  });

  it('识别符号开头的标题', () => {
    const text = '☆、第一个标题\n' + gap + '\n☆、第二个标题\n' + gap;
    const toc = parseTxtChapters(text);
    expect(toc).toHaveLength(2);
    expect(toc[0].label).toContain('第一个标题');
  });

  it('前置目录页里密排的章节名不重复计入', () => {
    const tocPage = '目录\n第一章 开始\n第二章 继续\n第三章 结束\n';
    const body = '第一章 开始\n' + gap + '\n第二章 继续\n' + gap + '\n第三章 结束\n' + gap;
    const toc = parseTxtChapters(tocPage + body);
    // 不加间距守卫会同时命中目录页与正文，得到 6 条
    expect(toc.map(t => t.label)).toEqual(['第一章 开始', '第二章 继续', '第三章 结束']);
  });

  it('识别章回体与轻小说标题', () => {
    const hui = parseTxtChapters(
      '第一回 甄士隐梦幻识通灵\n' + gap + '\n第二回 贾夫人仙逝扬州城\n' + gap,
    );
    expect(hui.map(t => t.label)).toEqual(['第一回 甄士隐梦幻识通灵', '第二回 贾夫人仙逝扬州城']);

    const hua = parseTxtChapters('第一话 开始\n' + gap + '\n第二话 继续\n' + gap);
    expect(hua.map(t => t.label)).toEqual(['第一话 开始', '第二话 继续']);
  });

  it('正文行首出现「第一回」但不构成章节时不误报', () => {
    const text =
      '第一章 开始\n' + gap + '\n第一回见到他时，她还很年轻，想不到后面会发生这么多事。\n' + gap;
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['第一章 开始']);
  });

  it('短章书（每章数百字）不被间距守卫吃掉章节', () => {
    const chs = Array.from({ length: 30 }, (_, i) => `第${i + 1}章 标${i + 1}`);
    const text = chs.map(c => c + '\n' + '短短的一节内容。'.repeat(60) + '\n').join('');
    expect(parseTxtChapters(text)).toHaveLength(30);
  });

  it('前置目录页时首条位置落在正文首章，而非目录页', () => {
    const chs = Array.from({ length: 10 }, (_, i) => `第${i + 1}章 标题${i + 1}`);
    const head = '我的小说\n\n目录\n' + chs.join('\n') + '\n\n';
    const text = head + chs.map(c => c + '\n' + gap + '\n').join('');
    const toc = parseTxtChapters(text);
    expect(toc).toHaveLength(10);
    // 目录页占满 head 的全部行，首章必须落在其之后
    expect(toc[0].line).toBeGreaterThanOrEqual(head.split('\n').length - 1);
  });

  it('超长行不算章节', () => {
    const text = '第一章 ' + 'x'.repeat(50) + '\n普通内容';
    expect(parseTxtChapters(text)).toEqual([]);
  });

  it('无章节返回空数组', () => {
    expect(parseTxtChapters('普通正文\n换行继续')).toEqual([]);
  });

  it('页码随字数递增', () => {
    const text = '第一章\n' + 'x'.repeat(5000) + '\n第二章\n正文';
    const toc = parseTxtChapters(text);
    expect(toc[0].page).toBe(0);
    expect(toc[1].page).toBeGreaterThan(0);
  });

  it('记录章节所在段落行号', () => {
    const text = '书名\n\n第一章 开始\n' + gap + '\n第二章 继续\n正文';
    const lines = text.split('\n');
    const expected = ['第一章 开始', '第二章 继续'].map(l => lines.findIndex(x => x === l));
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.line)).toEqual(expected);
  });

  it('标题尾部 30 字以内识别，超过则不算章节', () => {
    const ok = parseTxtChapters('第一章 ' + '标'.repeat(30));
    expect(ok).toHaveLength(1);
    const tooLong = parseTxtChapters('第一章 ' + '标'.repeat(31));
    expect(tooLong).toEqual([]);
  });

  it('正文段落以「第X章」开头但过长，不误判为章节', () => {
    const text = '第三章的内容他早就忘得一干二净，可是命运偏偏又把它摆到了面前，让他不得不重新面对。';
    expect(parseTxtChapters(text)).toEqual([]);
  });
});

describe('TXT 目录解析配置', () => {
  const gap = '正文内容'.repeat(300);

  it('关键字方式：行首命中关键字即视为章节', () => {
    const text = 'Star 1 起点\n' + gap + '\nStar 2 继续\n' + gap;
    const toc = parseTxtChapters(text, { mode: 'keyword', keyword: 'Star' });
    expect(toc.map(t => t.label)).toEqual(['Star 1 起点', 'Star 2 继续']);
  });

  it('关键字支持 | 分隔多个', () => {
    const text = '甲 开头\n' + gap + '\n乙 开头\n' + gap;
    expect(parseTxtChapters(text, { mode: 'keyword', keyword: '甲|乙' })).toHaveLength(2);
  });

  it('关键字按字面量匹配，特殊字符不当作正则', () => {
    const text = '（一）开头\n' + gap + '\n（二）继续\n' + gap;
    expect(parseTxtChapters(text, { mode: 'keyword', keyword: '（一）|（二）' })).toHaveLength(2);
  });

  it('正则方式', () => {
    const text = '== 第一节 ==\n' + gap + '\n== 第二节 ==\n' + gap;
    const toc = parseTxtChapters(text, { mode: 'regex', regex: '^== .+ ==$' });
    expect(toc.map(t => t.label)).toEqual(['== 第一节 ==', '== 第二节 ==']);
  });

  it('指定内置规则名', () => {
    const text = '一、只有前面的数字有差别\n' + gap + '\n二、也差不多\n' + gap;
    const toc = parseTxtChapters(text, { ruleName: '大写数字 分隔符 标题名称' });
    expect(toc).toHaveLength(2);
  });

  it('正则非法时回退到默认择优', () => {
    const text = '第一章 开始\n' + gap + '\n第二章 继续\n' + gap;
    const toc = parseTxtChapters(text, { mode: 'regex', regex: '[' });
    expect(toc.map(t => t.label)).toEqual(['第一章 开始', '第二章 继续']);
  });

  it('规则名不存在时回退到默认择优', () => {
    const text = '第一章 开始\n' + gap + '\n第二章 继续\n' + gap;
    expect(parseTxtChapters(text, { ruleName: '不存在的规则' })).toHaveLength(2);
  });
});

describe('TXT 目录提取', () => {
  it('超过 4MB 的 UTF-8 文件全量识别章节（不截断、不误判编码）', async () => {
    const p = path.join(tmpDir, 'big.txt');
    let s = '';
    let i = 0;
    // 每章之间留足正文（超过 1000 字符的命中间距阈值），长度带变化以覆盖不同字节边界
    while (s.length < 5 * 1024 * 1024) {
      i++;
      s += '第' + i + '章 标题\n' + '字'.repeat(i % 37) + '正文内容'.repeat(300 + (i % 53)) + '\n';
    }
    // 末尾追加特征章节，验证中段与结尾的内容都被解析
    s += '第九九九九章 末尾章节\n正文\n';
    fs.writeFileSync(p, s, 'utf-8');
    const toc = await extractToc(p, '.txt');
    expect(toc.length).toBeGreaterThan(0);
    expect(toc[0].label).toContain('第1章');
    expect(toc[toc.length - 1].label).toContain('第九九九九章');
  });
});

describe('Markdown', () => {
  const write = (name: string, text: string) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, text, 'utf-8');
    return p;
  };

  it('按一级 / 二级标题分章', async () => {
    const p = write('a.md', '# 第一章 开始\n正文一\n\n## 第二节\n正文二\n');
    const chapters = await mdToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['第一章 开始', '第二节']);
    expect(chapters[0].html).toContain('正文一');
  });

  it('保留加粗与列表，空元素转为自闭合', async () => {
    const p = write('b.md', '# 章\n**粗体**\n\n- 项目一\n- 项目二\n\n换行<br>结束\n');
    const html = (await mdToChapters(p))[0].html;
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<li>项目一</li>');
    // EPUB 章节按 XML 解析，未闭合的 <br> 会让整章解析失败
    expect(html).toMatch(/<br\s*\/>/);
    expect(html).not.toMatch(/<br>/);
  });

  it('图片等空元素同样自闭合', async () => {
    const p = write('c.md', '# 章\n![图](a.png)\n');
    const html = (await mdToChapters(p))[0].html;
    expect(html).toMatch(/<img[^>]*\/>/);
  });

  it('无标题文档合成单章', async () => {
    const p = write('d.md', '只有正文，没有标题。\n');
    const chapters = await mdToChapters(p);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('正文');
  });

  it('空文件返回空数组', async () => {
    expect(await mdToChapters(write('e.md', ''))).toEqual([]);
  });

  it('元数据取首个一级标题（二级标题不算）', async () => {
    const p = write('f.md', '## 二级先出现\n# 真正的书名\n');
    expect(await extractMetadata(p, '.md')).toEqual({ title: '真正的书名', author: undefined });
  });

  it('GBK 编码的 .md 不乱码（记事本存出来的中文 Markdown 很常见）', async () => {
    const p = path.join(tmpDir, 'gbk.md');
    // "# 测试\n正文\n" 的 GBK 字节：非法 UTF-8，必须走回退解码
    fs.writeFileSync(
      p,
      Buffer.from([0x23, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x0a, 0xd5, 0xfd, 0xce, 0xc4, 0x0a]),
    );
    const chapters = await mdToChapters(p);
    expect(chapters[0].title).toBe('测试');
    expect(chapters[0].html).toContain('正文');
  });

  it('Obsidian 写法转成排版元素：高亮、wiki 链接、callout、标签', async () => {
    const p = write(
      'obsidian.md',
      [
        '# 章',
        '含 ==高亮== 与 #标签 与 [[另一篇笔记]] 与 [[目标笔记|别名]]。',
        '',
        '> [!note] 提示',
        '> 这是一段说明。',
        '',
        '- [ ] 待办',
      ].join('\n'),
    );
    const html = (await mdToChapters(p))[0].html;

    expect(html).toContain('<mark>高亮</mark>');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('别名');
    expect(html).toContain('class="tag"');
    expect(html).toContain('callout');
    expect(html).toContain('type="checkbox"');
    // 原样残留就说明没转换
    expect(html).not.toContain('==');
    expect(html).not.toContain('[[');
    expect(html).not.toContain('[!note]');
  });

  it('代码块里的 # 与 == 不被改写', async () => {
    const p = write('code.md', '# 章\n\n```bash\n# 注释不该变成标签，a == b 也不该变高亮\n```\n');
    const html = (await mdToChapters(p))[0].html;
    expect(html).toContain('# 注释不该变成标签');
    expect(html).toContain('a == b');
    expect(html).not.toContain('<mark>');
  });

  it('YAML frontmatter 作为信息块保留，不混进正文', async () => {
    const p = write('fm.md', '---\ntitle: 我的笔记\ntags: 读书\n---\n\n# 章\n正文\n');
    const html = (await mdToChapters(p))[0].html;
    expect(html).toContain('frontmatter');
    expect(html).toContain('title: 我的笔记');
    // 不能被当成一条水平线 + 一段普通文字
    expect(html).not.toContain('<hr/>\ntitle: 我的笔记');
  });
});

describe('DOCX', () => {
  const CONTENT_TYPES =
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

  async function makeDocx(opts?: { title?: string; author?: string; body?: string }): Promise<string> {
    const JSZipMod = (await import('jszip')).default;
    const zip = new JSZipMod();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    const paras = (opts?.body ?? '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p><w:p><w:r><w:t>正文内容</w:t></w:r></w:p>');
    zip.file(
      'word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`,
    );
    if (opts?.title || opts?.author) {
      zip.file(
        'docProps/core.xml',
        `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${opts.title ? `<dc:title>${opts.title}</dc:title>` : ''}${opts.author ? `<dc:creator>${opts.author}</dc:creator>` : ''}</cp:coreProperties>`,
      );
    }
    const p = path.join(tmpDir, `test-${Date.now()}.docx`);
    fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));
    return p;
  }

  it('读 core.xml 书名作者', async () => {
    const p = await makeDocx({ title: '文档标题', author: '作者名' });
    expect(await extractMetadata(p, '.docx')).toEqual({ title: '文档标题', author: '作者名' });
  });

  it('无 core.xml 回退首标题', async () => {
    const p = await makeDocx();
    expect(await extractMetadata(p, '.docx')).toEqual({ title: '第一章' });
  });

  it('通篇没有小标题时，不用合成的「正文」当书名', async () => {
    const p = await makeDocx({ body: '<w:p><w:r><w:t>只是一段正文，没有小标题</w:t></w:r></w:p>' });
    // 返回 null 让调用方回退到文件名，而不是把占位名当书名
    expect(await extractMetadata(p, '.docx')).toBeNull();
  });

  it('正文排在首个标题之前时，跳过「第 1 节」继续找真标题', async () => {
    const p = await makeDocx({
      body: '<w:p><w:r><w:t>前言部分</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>品牌管理模块最终汇报稿</w:t></w:r></w:p>',
    });
    expect(await extractMetadata(p, '.docx')).toEqual({ title: '品牌管理模块最终汇报稿' });
  });

  it('占位章节名识别', () => {
    expect(isGenericChapterTitle('正文')).toBe(true);
    expect(isGenericChapterTitle('第 3 节')).toBe(true);
    expect(isGenericChapterTitle('第3节')).toBe(true);
    // 真实标题不该被误判
    expect(isGenericChapterTitle('第一章')).toBe(false);
    expect(isGenericChapterTitle('正文之后')).toBe(false);
    expect(isGenericChapterTitle('第 3 节 概述')).toBe(false);
  });

  it('标题层级被识别为章节边界', async () => {
    // 两章都撑过合并阈值，才断言它们各自独立成章；
    // 否则短章会被并进后一章，测到的就不是「标题能不能切章」了
    const longText = (n: number) => '字'.repeat(n);
    const p = await makeDocx({
      body:
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>上篇</w:t></w:r></w:p><w:p><w:r><w:t>' + longText(1200) + '</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第一节</w:t></w:r></w:p><w:p><w:r><w:t>' + longText(1200) + '</w:t></w:r></w:p>',
    });
    const chapters = await docxToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['上篇', '第一节']);
    expect(chapters[0].content.startsWith('字')).toBe(true);
  });

  it('全篇正文都短于阈值时合并成一章，不产生碎章', async () => {
    // 实测那本 DOCX 合起来才 5.7 万字却切出 113 章，中位数只有 500 字，
    // 大半是「三、迭代体系合理性分析」这种几十字的标题章 —— 翻页按不动就是这么来的
    const p = await makeDocx({
      body: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>上篇</w:t></w:r></w:p><w:p><w:r><w:t>内容一</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第一节</w:t></w:r></w:p><w:p><w:r><w:t>内容二</w:t></w:r></w:p>',
    });
    const chapters = await docxToChapters(p);
    expect(chapters).toHaveLength(1);
    // 保留后一章的真实标题，前面的标题降级成正文首行
    expect(chapters[0].title).toBe('第一节');
    expect(chapters[0].content).toContain('上篇');
    expect(chapters[0].content).toContain('内容一');
    expect(chapters[0].content).toContain('内容二');
  });

  // 长正文用来把章撑过合并阈值，短正文用来触发合并
  const longText = (n: number) => '字'.repeat(n);
  const headBody = (title: string, text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

  it('纯标题章（正文为空）被丢弃', async () => {
    // 实测那本 DOCX 里「三、迭代体系合理性分析」这种纯标题章重复出现三次，
    // 每章在 EPUB 里都算作 1/1 页，翻页按不动
    const p = await makeDocx({
      body:
        headBody('第一章', longText(1200)) +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>空标题章</w:t></w:r></w:p>' +
        headBody('第二章', longText(1200)),
    });
    const chapters = await docxToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '第二章']);
  });

  it('末尾空章保留 —— 它可能是正文唯一的载体', async () => {
    // 正文全排在标题之前是 Word 常见形状，extractDocxMetadata 的书名回退
    // 正是靠这一章；如果按「空章一律丢」处理，书名就回退成文件名了
    const p = await makeDocx({
      body:
        headBody('第一章', longText(1200)) +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>品牌管理模块最终汇报稿</w:t></w:r></w:p>',
    });
    const chapters = await docxToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '品牌管理模块最终汇报稿']);
    expect(chapters[1].content).toBe('');
  });

  it('短章并入后一章，被并标题降级为正文首行', async () => {
    const p = await makeDocx({
      body: headBody('小节', '很短的一段正文') + headBody('第一章', longText(1200)),
    });
    const chapters = await docxToChapters(p);
    expect(chapters).toHaveLength(1);
    // 保留后一章的真实标题，短章的标题降级成正文
    expect(chapters[0].title).toBe('第一章');
    expect(chapters[0].content).toContain('小节');
    expect(chapters[0].content).toContain('很短的一段正文');
  });

  it('章节顺序在合并后仍与原文一致', async () => {
    const p = await makeDocx({
      body: headBody('第一章', longText(1200)) + headBody('第二章', longText(1200)),
    });
    const chapters = await docxToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '第二章']);
    // 后合并的实现容易把逆序栈顶写回原数组，顺序是最先崩的地方
    expect(chapters[0].content.startsWith('字')).toBe(true);
  });

  it('连续多个短章合并后不再是碎章', async () => {
    // 复现实测场景：一个长章打底，后面 20 个短要点一路并进最后一章，
    // 中间那些「要点 N」的标题降级成正文行，不再各自占一章
    const body =
      headBody('总纲', longText(1100)) +
      Array.from({ length: 20 }, (_, i) => headBody(`要点 ${i + 1}`, '一句话要点')).join('');
    const chapters = await docxToChapters(await makeDocx({ body }));
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('总纲');
    expect(chapters[1].title).toBe('要点 20');
    // 19 个短章的标题 + 正文全部并进来了，顺序保持原样
    const paras = chapters[1].content.split('\n');
    expect(paras).toHaveLength(39);
    expect(paras[0]).toBe('一句话要点');
    expect(paras[1]).toBe('要点 1');
    expect(paras[2]).toBe('一句话要点');
    expect(paras[3]).toBe('要点 2');
    expect(paras[38]).toBe('一句话要点');
    // 阈值之上的「总纲」没有被吃掉
    expect(chapters[0].content).toHaveLength(1100);
  });
});

describe('decodeTextAuto 编码判定', () => {
  it('合法 UTF-8 原样解出', () => {
    expect(decodeTextAuto(Buffer.from('中文标题测试', 'utf8'))).toBe('中文标题测试');
  });

  it('GBK 字节仍走 GBK 分支（D6D0 CEC4 = 「中文」）', () => {
    expect(decodeTextAuto(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
  });

  it('结尾缺半个字符时按 UTF-8 恢复，不误判成 GBK', () => {
    const buf = Buffer.from('还不起学贷的我只好兼职猎魔', 'utf8');
    expect(decodeTextAuto(buf.subarray(0, buf.length - 1))).toBe('还不起学贷的我只好兼职猎');
  });

  it('按固定字节数截断、切在汉字中间时，不整段回落 GBK', () => {
    // 前缀 6 字节 + 「字」×N（每字 3 字节），让第 4096 字节正好落在某个字中间
    const buf = Buffer.concat([Buffer.from('标题', 'utf8'), Buffer.from('字'.repeat(2000), 'utf8')]);
    const cut = buf.subarray(0, 4096);
    // 先确认这个切片确实会让严格解码失败（否则用例就没在测想测的场景）
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(cut)).toThrow();
    expect(decodeTextAuto(cut).startsWith('标题字字')).toBe(true);
  });

  it('extractMetadata 读 TXT 标题时不再被截断边界带偏', () => {
    const buf = Buffer.concat([Buffer.from('标题\n', 'utf8'), Buffer.from('字'.repeat(2000), 'utf8')]);
    // 头部 4096 字节切在汉字中间，正是曾经产出乱码书名的形状
    const file = path.join(tmpDir, 'title-boundary.txt');
    fs.writeFileSync(file, buf);
    return extractMetadata(file, '.txt').then(meta => {
      expect(meta?.title).toBe('标题');
    });
  });
});

describe('Markdown 标签与待办的收集', () => {
  const write = (name: string, text: string) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, text, 'utf-8');
    return p;
  };

  it('收集 #标签并去重', async () => {
    const p = write('tags.md', '# 章\n#读书 与 #读书 与 #待整理\n');
    const tags = collectMarkdownTags(await mdToChapters(p));
    expect(tags.sort()).toEqual(['待整理', '读书']);
  });

  it('代码块里的 # 不算标签', async () => {
    const p = write('tag-code.md', '# 章\n\n```sh\n# 这行注释不是标签\n```\n');
    expect(collectMarkdownTags(await mdToChapters(p))).toEqual([]);
  });

  it('只收未完成的任务，并记下所属章节与跳转目标', async () => {
    const p = write(
      'tasks.md',
      '# 第一章\n- [ ] 写提纲\n- [x] 已经做完的事\n\n## 第二章\n- [ ] 补数据\n',
    );
    const tasks = collectMarkdownTasks(await mdToChapters(p), i => `Text/ch${i + 1}.xhtml`);

    expect(tasks.map(t => t.text)).toEqual(['写提纲', '补数据']);
    expect(tasks[0].chapter).toBe('第一章');
    expect(tasks[1].chapter).toBe('第二章');
    expect(tasks[1].href).toBe('Text/ch2.xhtml');
  });

  it('任务里的行内格式被去掉，只留纯文本', async () => {
    const p = write('task-md.md', '# 章\n- [ ] 读 **这本书** 的下半部分\n');
    const tasks = collectMarkdownTasks(await mdToChapters(p), () => 'Text/ch1.xhtml');
    expect(tasks[0].text).toBe('读 这本书 的下半部分');
  });
});

describe('Markdown 图片随 EPUB 打包', () => {
  const tmpMd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'br-mdimg-'));

  it('相对路径的图片被收进包，并把引用改写成包内路径', async () => {
    const dir = tmpMd();
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), Buffer.from([0x89, 0x50]));
    const md = path.join(dir, 'note.md');
    fs.writeFileSync(md, '# 章\n\n![示意图](./images/pic.png)\n\n正文\n', 'utf-8');

    const doc = await mdToDocument(md);
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0].archiveName).toBe('Images/pic.png');
    expect(doc.chapters[0].html).toContain('src="../Images/pic.png"');
    expect(doc.chapters[0].html).not.toContain('./images/pic.png');
    expect(doc.missingImages).toBe(0);
  });

  it('外链与 data: 内联不动；找不到的图片计入 missingImages 并把原样引用留着', async () => {
    const dir = tmpMd();
    const md = path.join(dir, 'note.md');
    fs.writeFileSync(
      md,
      '# 章\n\n![外链](https://x.com/a.png)\n\n![内联](data:image/png;base64,AAA)\n\n![缺图](./nope.png)\n',
      'utf-8',
    );

    const doc = await mdToDocument(md);
    expect(doc.images).toHaveLength(0);
    expect(doc.missingImages).toBe(1);
    expect(doc.chapters[0].html).toContain('https://x.com/a.png');
    expect(doc.chapters[0].html).toContain('data:image/png;base64,AAA');
    expect(doc.chapters[0].html).toContain('./nope.png');
  });

  it('非图片后缀不会被塞进包里', async () => {
    const dir = tmpMd();
    fs.writeFileSync(path.join(dir, 'note.txt'), '不是图片');
    const md = path.join(dir, 'n.md');
    fs.writeFileSync(md, '# 章\n\n[附件](./note.txt)\n\n![伪装](./note.txt)\n', 'utf-8');

    const doc = await mdToDocument(md);
    expect(doc.images).toHaveLength(0);
  });

  it('不同目录下的同名图片不互相覆盖', async () => {
    const dir = tmpMd();
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a', 'pic.png'), Buffer.from([1]));
    fs.writeFileSync(path.join(dir, 'b', 'pic.png'), Buffer.from([2]));
    const md = path.join(dir, 'n.md');
    fs.writeFileSync(md, '# 章\n\n![一](a/pic.png)\n\n![二](b/pic.png)\n', 'utf-8');

    const doc = await mdToDocument(md);
    expect(doc.images).toHaveLength(2);
    expect(new Set(doc.images.map(i => i.archiveName)).size).toBe(2);
  });
});

describe('Markdown 图片：端到端（Markdown → EPUB → 取回）', () => {
  it('导入后图片确实在包里，且能被按字节取回', async () => {
    const { buildEpub } = await import('./epub-export');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-md-e2e-'));
    fs.mkdirSync(path.join(dir, 'images'));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    fs.writeFileSync(path.join(dir, 'images', 'shot.png'), pngBytes);
    const md = path.join(dir, '笔记.md');
    fs.writeFileSync(md, '# 我的笔记\n\n看这张图：\n\n![截图](./images/shot.png)\n', 'utf-8');

    // 与导入链路相同的两步：解析 → 组装 EPUB
    const doc = await mdToDocument(md);
    const buf = await buildEpub(
      '我的笔记',
      doc.chapters,
      doc.images.map(i => ({ ...i, mediaType: imageMediaType(i.sourcePath) })),
    );

    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file('OEBPS/Images/shot.png');
    expect(entry).toBeTruthy();
    expect(await entry!.async('nodebuffer')).toEqual(pngBytes);

    const chapter = await zip.file('OEBPS/Text/ch1.xhtml')!.async('string');
    expect(chapter).toContain('../Images/shot.png');

    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('href="Images/shot.png"');
  });
});

describe('Markdown wiki 链接目标的收集', () => {
  it('取出 [[目标]] 里的目标并去重，别名不参与', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mdlink-'));
    const md = path.join(dir, 'n.md');
    fs.writeFileSync(
      md,
      '# 章\n\n见 [[读书笔记]] 与 [[读书笔记|别名]] 与 [[另一篇]]。\n\n```\n[[代码块里的不算]]\n```\n',
      'utf-8',
    );

    const links = collectMarkdownLinks(await mdToChapters(md));
    expect([...links].sort()).toEqual(['另一篇', '读书笔记'].sort());
    expect(links).not.toContain('代码块里的不算');
    expect(links).not.toContain('别名');
  });
});

describe('frontmatter 属性解析', () => {
  it('取标量键值对', () => {
    expect(parseFrontmatter('---\ntitle: 我的笔记\nstatus: 待整理\n---\n\n正文\n')).toEqual({
      title: ['我的笔记'],
      status: ['待整理'],
    });
  });

  it('行内列表与逗号分隔都拆成多个值，引号去掉', () => {
    expect(parseFrontmatter('---\ntags: [读书, "科幻"]\nkeys: a, b\n---\n')).toEqual({
      tags: ['读书', '科幻'],
      keys: ['a', 'b'],
    });
  });

  it('没有 frontmatter 时返回空对象', () => {
    expect(parseFrontmatter('# 标题\n\n正文')).toEqual({});
    // 只出现在文件中间的不算（frontmatter 必须在开头）
    expect(parseFrontmatter('正文\n\n---\ntitle: x\n---\n')).toEqual({});
  });

  it('嵌套结构、缩进行、注释、空值一律跳过', () => {
    const text = '---\n# 注释\nlink: https://example.com\nauthor:\n  name: 张三\nlist:\n  - 一\n\n---\n';
    // 只认最朴素的 `键: 值`：拿不准的一律不解析，正文里的信息块仍保留原文
    expect(parseFrontmatter(text)).toEqual({ link: ['https://example.com'] });
  });

  it('mdToDocument 会把属性一并带出来', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fm-'));
    const md = path.join(dir, 'n.md');
    fs.writeFileSync(md, '---\nstatus: 已完成\nrating: 5\n---\n\n# 章\n正文\n', 'utf-8');
    const doc = await mdToDocument(md);
    expect(doc.props).toEqual({ status: ['已完成'], rating: ['5'] });
    // 正文里的信息块仍在（原文完整保留）
    expect(doc.chapters[0].html).toContain('frontmatter');
  });
});

describe('Markdown 公式与代码高亮', () => {
  const write = (name: string, text: string) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, text, 'utf-8');
    return p;
  };

  it('行内与块级公式都渲染成 MathML', async () => {
    const p = write('math.md', '# 章\n\n质能方程 $E = mc^2$ 的含义。\n\n$$\n\int_0^1 x\,dx\n$$\n');
    const html = (await mdToDocument(p)).chapters[0].html;

    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
    expect(html).not.toContain('$E = mc^2$');
    expect((html.match(/<math/g) ?? []).length).toBe(2);
  });

  it('价格里的美元符号不会被误判成公式', async () => {
    const p = write('price.md', '# 章\n\n这本书 $5 到 $10，符号 $ 单独出现也不算。\n');
    const html = (await mdToDocument(p)).chapters[0].html;

    expect(html).not.toContain('<math');
    expect(html).toContain('$5');
    expect(html).toContain('$10');
  });

  it('代码块里的 $ 不渲染成公式', async () => {
    const p = write('code-dollar.md', '# 章\n\n```sh\necho $x$ 只是 shell 变量\n```\n');
    const html = (await mdToDocument(p)).chapters[0].html;

    expect(html).not.toContain('<math');
    expect(html).toContain('$x$');
  });

  it('写了语言的代码块会高亮', async () => {
    const p = write('hl.md', '# 章\n\n```js\nconst a = 1;\n```\n');
    const html = (await mdToDocument(p)).chapters[0].html;

    expect(html).toContain('hljs-keyword');
    expect(html).toContain('const');
  });

  it('不认识的语言不高亮也不报错，代码原样留着', async () => {
    const p = write('hl-bad.md', '# 章\n\n```nosuchlang\nfoo bar\n```\n');
    const html = (await mdToDocument(p)).chapters[0].html;

    expect(html).toContain('foo bar');
    expect(html).not.toContain('hljs-keyword');
  });

  it('非法公式不抛错，退化成可见的错误提示而不是吃掉正文', async () => {
    const p = write('bad-math.md', '# 章\n\n$\bad{$ 之后还有正文。\n');
    const doc = await mdToDocument(p);
    expect(doc.chapters[0].html).toContain('katex-error');
    expect(doc.chapters[0].html).toContain('之后还有正文');
  });
});
