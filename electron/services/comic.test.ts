import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { naturalCompare, isComicPage, detectArchiveKind, readTarEntries, listComicPages, readComicPage, clearComicCache, releaseComicCacheFor } from './comic';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-comic-'));
});

afterEach(() => {
  clearComicCache();
  vi.restoreAllMocks();
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

  it('识别 zip 与 tar', () => {
    expect(detectArchiveKind(head([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(detectArchiveKind(head([], 'ustar'))).toBe('tar');
  });

  it('识别 rar 与 7z（这两种走随包的 7z.exe 解）', () => {
    expect(detectArchiveKind(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))).toBe('rar');
    expect(detectArchiveKind(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
  });

  it('空数据返回 unknown', () => {
    expect(detectArchiveKind(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('tar 归档读取', () => {
  /** 按 tar 规范拼一个最小归档：512 字节定长头 + 内容 + 补齐 */
  const makeTar = (files: { name: string; data: Buffer }[]): Buffer => {
    const blocks: Buffer[] = [];
    for (const f of files) {
      const header = Buffer.alloc(512);
      header.write(f.name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'latin1');
      header.write('0000000\0', 108, 8, 'latin1');
      header.write('0000000\0', 116, 8, 'latin1');
      header.write(f.data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
      header.write('00000000000\0', 136, 12, 'latin1');
      header.write('        ', 148, 8, 'latin1');
      header.write('0', 156, 1, 'latin1');
      header.write('ustar\0', 257, 6, 'latin1');
      header.write('00', 263, 2, 'latin1');
      blocks.push(header, f.data);
      const pad = (512 - (f.data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
    blocks.push(Buffer.alloc(1024)); // 归档结束：两个全零块
    return Buffer.concat(blocks);
  };

  it('解析条目偏移与长度', () => {
    const data = Buffer.from('hello tar');
    const tar = makeTar([
      { name: 'a/1.png', data },
      { name: 'a/2.png', data: Buffer.alloc(600, 7) },
    ]);
    const entries = readTarEntries(tar);
    expect(entries.map(e => e.name)).toEqual(['a/1.png', 'a/2.png']);
    expect(entries[0].size).toBe(data.length);
    // 偏移必须能直接切出内容
    expect(tar.subarray(entries[0].offset, entries[0].offset + entries[0].size)).toEqual(data);
    // 第二个条目要跨过第一块内容的补齐
    expect(entries[1].offset).toBe(512 + 512 + 512);
  });

  it('忽略目录条目，遇全零块停止', () => {
    const tar = makeTar([{ name: '1.png', data: Buffer.from([1]) }]);
    expect(readTarEntries(tar)).toHaveLength(1);
    expect(readTarEntries(Buffer.alloc(1024))).toEqual([]);
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

describe('漫画包缓存释放', () => {
  async function makeCbzAt(fileName: string, pages: string[]): Promise<string> {
    const zip = new JSZip();
    for (const name of pages) zip.file(name, Buffer.from([0xff, 0xd8, 0xff]));
    const p = path.join(tmpDir, fileName);
    fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));
    return p;
  }

  /**
   * 缓存命中与未命中的返回结果完全一样，没法靠结果判断。
   * 改看「有没有读盘」：命中缓存的路径在读盘之前就返回了，所以 readFileSync 不会被调用。
   */
  it('释放后整包重新读盘，未释放则一直命中缓存', async () => {
    const p = await makeCbzAt('a.cbz', ['1.jpg']);
    await listComicPages(p); // 首次必然读盘，把包放进缓存

    const spy = vi.spyOn(fs, 'readFileSync');
    await listComicPages(p);
    expect(spy).not.toHaveBeenCalled(); // 命中缓存，不读盘

    releaseComicCacheFor(p);
    await listComicPages(p);
    expect(spy).toHaveBeenCalled(); // 已释放，必须重新读
  });

  it('路径不匹配时不释放，避免误伤另一窗口正在读的书', async () => {
    const a = await makeCbzAt('a.cbz', ['1.jpg']);
    const b = await makeCbzAt('b.cbz', ['2.jpg']);
    await listComicPages(a);

    releaseComicCacheFor(b); // 释放的是另一个包，不该动 a 的缓存

    const spy = vi.spyOn(fs, 'readFileSync');
    await listComicPages(a);
    expect(spy).not.toHaveBeenCalled(); // a 的缓存仍在
  });
});
