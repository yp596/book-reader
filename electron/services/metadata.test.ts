import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractMetadata, extractToc, parseTxtChapters, docxToChapters } from './metadata';

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
  it('识别第X章标题', () => {
    const text = '三体\n\n第一章 科学边界\n正文正文\n\n第二章 台球\n更多正文';
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['第一章 科学边界', '第二章 台球']);
  });

  it('识别序言尾声番外', () => {
    const text = '序言\nxxx\n第一章 开始\nxxx\n尾声\nxxx';
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.label)).toEqual(['序言', '第一章 开始', '尾声']);
  });

  it('超长行不算章节', () => {
    const text = '第一章 ' + 'x'.repeat(50) + '\n正文';
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
    const text = '书名\n\n第一章 开始\n正文\n\n第二章 继续\n正文';
    const toc = parseTxtChapters(text);
    expect(toc.map(t => t.line)).toEqual([2, 5]);
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

describe('TXT 目录提取', () => {
  it('超过 4MB 的 UTF-8 文件全量识别章节（不截断、不误判编码）', async () => {
    const p = path.join(tmpDir, 'big.txt');
    let s = '';
    let i = 0;
    // 行长度递增变化，使原先的 4MB 截断点落在多字节字符中间
    while (s.length < 5 * 1024 * 1024) {
      i++;
      s += '第' + i + '章 标题' + '字'.repeat(i % 37) + '\n' + '正文内容'.repeat(1 + (i % 53)) + '\n';
    }
    // 末尾追加特征章节，验证 4MB 之后的内容同样被解析
    s += '第九九九九章 末尾章节\n正文\n';
    fs.writeFileSync(p, s, 'utf-8');
    const toc = await extractToc(p, '.txt');
    expect(toc.length).toBeGreaterThan(0);
    expect(toc[0].label).toContain('第1章');
    expect(toc[toc.length - 1].label).toContain('第九九九九章');
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
