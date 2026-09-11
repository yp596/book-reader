import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractMetadata, extractToc, parseTxtChapters, docxToChapters, mdToChapters, decodeTextAuto } from './metadata';

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

  it('按标题切章', async () => {
    const p = await makeDocx({
      body: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>上篇</w:t></w:r></w:p><w:p><w:r><w:t>内容一</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第一节</w:t></w:r></w:p><w:p><w:r><w:t>内容二</w:t></w:r></w:p>',
    });
    const chapters = await docxToChapters(p);
    expect(chapters.map(c => c.title)).toEqual(['上篇', '第一节']);
    expect(chapters[0].content).toContain('内容一');
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
