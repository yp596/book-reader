import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { naturalCompare, isComicPage, detectArchiveKind, listComicPages, readComicPage, clearComicCache } from './comic';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-comic-'));
});

afterEach(() => {
  clearComicCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('naturalCompare', () => {
  it('数字段按数值比较', () => {
    expect(naturalCompare('2.jpg', '10.jpg')).toBeLessThan(0);
    expect(naturalCompare('10.jpg', '2.jpg')).toBeGreaterThan(0);
  });

  it('数值相同时短者优先，保证顺序确定', () => {
    expect(naturalCompare('1.jpg', '01.jpg')).toBeLessThan(0);
    expect(naturalCompare('01.jpg', '1.jpg')).toBeGreaterThan(0);
  });

  it('相同字符串返回 0', () => {
    expect(naturalCompare('page-3.png', 'page-3.png')).toBe(0);
  });

  it('大小写不敏感', () => {
    expect(naturalCompare('Page1.jpg', 'page1.jpg')).toBe(0);
  });

  it('按整串顺序排好一列页名', () => {
    const names = ['p10.jpg', 'p2.jpg', 'p1.jpg', 'p20.jpg', 'p3.jpg'];
    expect([...names].sort(naturalCompare)).toEqual([
      'p1.jpg',
      'p2.jpg',
      'p3.jpg',
      'p10.jpg',
      'p20.jpg',
    ]);
  });

  it('目录层级参与比较', () => {
    const names = ['ch2/1.jpg', 'ch1/2.jpg', 'ch1/10.jpg', 'ch1/1.jpg'];
    expect([...names].sort(naturalCompare)).toEqual([
      'ch1/1.jpg',
      'ch1/2.jpg',
      'ch1/10.jpg',
      'ch2/1.jpg',
    ]);
  });
});

describe('isComicPage', () => {
  it('常见图片扩展名视为页面', () => {
    for (const n of ['1.jpg', '2.JPEG', 'a.png', 'b.webp', 'c.gif']) {
      expect(isComicPage(n)).toBe(true);
    }
  });

  it('排除非图片与隐藏文件', () => {
    expect(isComicPage('info.txt')).toBe(false);
    expect(isComicPage('.DS_Store')).toBe(false);
    expect(isComicPage('comic.xml')).toBe(false);
  });

  it('排除 macOS 打包残留', () => {
    expect(isComicPage('__MACOSX/._1.jpg')).toBe(false);
    expect(isComicPage('sub/__MACOSX/1.jpg')).toBe(false);
  });

  it('多层目录下的图片仍视为页面', () => {
    expect(isComicPage('第01卷/005.jpg')).toBe(true);
  });
});

describe('容器格式判定', () => {
  const head = (bytes: number[], tail = '') => {
    const buf = Buffer.alloc(512);
    Buffer.from(bytes).copy(buf);
    if (tail) buf.write(tail, 257, 'latin1');
    return buf;
  };

  it('按魔数识别 zip / rar / 7z / tar', () => {
    expect(detectArchiveKind(head([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(detectArchiveKind(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(detectArchiveKind(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(detectArchiveKind(head([], 'ustar'))).toBe('tar');
  });

  it('无法识别返回 unknown，交给上层按格式报错', () => {
    expect(detectArchiveKind(head([0x00, 0x01, 0x02]))).toBe('unknown');
    expect(detectArchiveKind(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('漫画包解析', () => {
  async function makeCbz(entries: Record<string, Buffer>): Promise<string> {
    const zip = new JSZip();
    for (const [name, buf] of Object.entries(entries)) zip.file(name, buf);
    const out = await zip.generateAsync({ type: 'nodebuffer' });
    const p = path.join(tmpDir, 'comic.cbz');
    fs.writeFileSync(p, out);
    return p;
  }

  it('按自然序列出页面并过滤非图片', async () => {
    const p = await makeCbz({
      'p10.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      'p2.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      'p1.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      'info.txt': Buffer.from('not an image'),
      '__MACOSX/._p1.jpg': Buffer.from([0x00]),
    });
    expect(await listComicPages(p)).toEqual(['p1.jpg', 'p2.jpg', 'p10.jpg']);
  });

  it('空包返回空列表', async () => {
    const p = await makeCbz({ 'readme.txt': Buffer.from('x') });
    expect(await listComicPages(p)).toEqual([]);
  });

  it('读回单页内容与 MIME', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const p = await makeCbz({ '1.png': png });
    const page = await readComicPage(p, '1.png');
    expect(page?.mime).toBe('image/png');
    expect(Buffer.from(page!.data, 'base64')).toEqual(png);
  });

  it('条目不存在返回 null', async () => {
    const p = await makeCbz({ '1.jpg': Buffer.from([0xff]) });
    expect(await readComicPage(p, 'missing.jpg')).toBeNull();
  });
});
