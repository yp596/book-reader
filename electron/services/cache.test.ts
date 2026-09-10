import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dirSize, clearSnapshots } from './cache';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dirSize', () => {
  it('统计嵌套目录的总字节数', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'y'.repeat(200));
    expect(dirSize(dir)).toBe(300);
  });

  it('空目录为 0', () => {
    expect(dirSize(dir)).toBe(0);
  });

  it('不存在的目录返回 0（不抛错）', () => {
    expect(dirSize(path.join(dir, '不存在'))).toBe(0);
    expect(dirSize('')).toBe(0);
  });

  it('子目录再深一层也能统计', () => {
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'deep.bin'), 'z'.repeat(50));
    expect(dirSize(dir)).toBe(50);
  });
});

describe('clearSnapshots', () => {
  it('只删快照文件，其他文件保留', () => {
    fs.writeFileSync(path.join(dir, 'snapshot-1.json'), '{}');
    fs.writeFileSync(path.join(dir, 'snapshot-2.json'), '{}');
    fs.writeFileSync(path.join(dir, 'book-reader.db'), 'data');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    expect(clearSnapshots(dir)).toBe(2);
    const rest = fs.readdirSync(dir).sort();
    expect(rest).toEqual(['book-reader.db', 'notes.txt']);
  });

  it('无快照时返回 0', () => {
    expect(clearSnapshots(dir)).toBe(0);
  });

  it('目录不存在返回 0（不抛错）', () => {
    expect(clearSnapshots(path.join(dir, '不存在'))).toBe(0);
    expect(clearSnapshots('')).toBe(0);
  });

  it('名字相似但不是快照的文件不动', () => {
    fs.writeFileSync(path.join(dir, 'snapshot-.json'), '{}');   // 前缀对但没有序号
    fs.writeFileSync(path.join(dir, 'my-snapshot-1.json'), '{}'); // 前缀不对
    expect(clearSnapshots(dir)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['my-snapshot-1.json']);
  });
});
