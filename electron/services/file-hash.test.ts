import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { contentHash } from './file-hash';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-hash-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: Buffer | string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

describe('contentHash', () => {
  it('相同内容得到相同指纹', () => {
    const a = write('a.txt', '三体\n第一章');
    const b = write('b.txt', '三体\n第一章');
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('内容不同则指纹不同', () => {
    const a = write('a.txt', '三体');
    const b = write('b.txt', '活着');
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('文件名不同但内容相同视作同一份（用于查重）', () => {
    const a = write('三体.txt', '相同正文');
    const b = write('三体(1).txt', '相同正文');
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('仅大小不同也能区分', () => {
    const a = write('a.txt', 'ab');
    const b = write('b.txt', 'abc');
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('同大小但首部不同能区分', () => {
    const a = write('a.txt', '头A' + 'x'.repeat(50));
    const b = write('b.txt', '头B' + 'x'.repeat(50));
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('同大小但尾部不同能区分', () => {
    const a = write('a.txt', 'x'.repeat(50) + '尾A');
    const b = write('b.txt', 'x'.repeat(50) + '尾B');
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('超过 1MB 的大文件也能正确取指纹（走采样路径）', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const other = Buffer.alloc(3 * 1024 * 1024, 9);
    const a = write('big1.bin', big);
    const b = write('big2.bin', other);
    const c = write('big3.bin', big);
    expect(contentHash(a)).toBe(contentHash(c));
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('空文件不报错', () => {
    const p = write('empty.txt', '');
    expect(() => contentHash(p)).not.toThrow();
  });

  it('指纹为 64 位十六进制（sha256）', () => {
    const p = write('a.txt', 'x');
    expect(contentHash(p)).toMatch(/^[0-9a-f]{64}$/);
  });
});
