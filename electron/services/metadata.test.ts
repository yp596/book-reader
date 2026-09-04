import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractMetadata } from './metadata';

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

describe('兜底', () => {
  it('未知格式返回 null', async () => {
    const p = path.join(tmpDir, 'book.xyz');
    fs.writeFileSync(p, 'data');
    expect(await extractMetadata(p, '.xyz')).toBeNull();
  });

  it('不存在的文件返回 null（不抛异常）', async () => {
    expect(await extractMetadata(path.join(tmpDir, 'missing.txt'), '.txt')).toBeNull();
  });
});
