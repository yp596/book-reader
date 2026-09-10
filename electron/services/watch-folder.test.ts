import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isImportableFile, isSkippableFile, FolderWatcher, IMPORTABLE_EXTS } from './watch-folder';

describe('isImportableFile', () => {
  it('支持导入对话框里的全部格式', () => {
    for (const ext of IMPORTABLE_EXTS) {
      expect(isImportableFile(`三体${ext}`)).toBe(true);
    }
  });

  it('大小写不敏感', () => {
    expect(isImportableFile('BOOK.EPUB')).toBe(true);
    expect(isImportableFile('book.Txt')).toBe(true);
  });

  it('不支持的格式被拒', () => {
    expect(isImportableFile('cover.jpg')).toBe(false);
    expect(isImportableFile('readme.md')).toBe(false);
    expect(isImportableFile('无后缀')).toBe(false);
  });
});

describe('isSkippableFile', () => {
  it('隐藏文件跳过', () => {
    expect(isSkippableFile('.DS_Store')).toBe(true);
    expect(isSkippableFile('.hidden.epub')).toBe(true);
  });

  it('下载与同步的中间态跳过（否则会导入半截文件）', () => {
    expect(isSkippableFile('三体.epub.part')).toBe(true);
    expect(isSkippableFile('三体.epub.crdownload')).toBe(true);
    expect(isSkippableFile('三体.tmp')).toBe(true);
    expect(isSkippableFile('三体.download')).toBe(true);
  });

  it('正常文件不跳过', () => {
    expect(isSkippableFile('三体.epub')).toBe(false);
    expect(isSkippableFile('我的书.txt')).toBe(false);
  });

  it('空名跳过', () => {
    expect(isSkippableFile('')).toBe(true);
  });
});

describe('FolderWatcher'.concat('（真实目录）'), () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-watch-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('目录不存在时报错而非静默失败', () => {
    const w = new FolderWatcher();
    expect(() => w.start(path.join(dir, '不存在'))).toThrow(/目录不存在/);
  });

  it('start 后可查询监视状态，stop 后复位', () => {
    const w = new FolderWatcher();
    w.start(dir);
    expect(w.isWatching()).toBe(true);
    expect(w.watchingDir()).toBe(dir);
    w.stop();
    expect(w.isWatching()).toBe(false);
    expect(w.watchingDir()).toBe('');
  });

  it('新出现的可导入文件在稳定后被回调', async () => {
    const got: string[] = [];
    const w = new FolderWatcher(120);
    w.onReady = p => got.push(path.basename(p));
    w.start(dir);
    fs.writeFileSync(path.join(dir, '新书.epub'), 'x'.repeat(200));
    await new Promise(r => setTimeout(r, 900));
    w.stop();
    expect(got).toContain('新书.epub');
  });

  it('非目标格式不触发回调', async () => {
    const got: string[] = [];
    const w = new FolderWatcher(120);
    w.onReady = p => got.push(p);
    w.start(dir);
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x'.repeat(200));
    await new Promise(r => setTimeout(r, 600));
    w.stop();
    expect(got).toHaveLength(0);
  });

  it('中间态文件不触发回调', async () => {
    const got: string[] = [];
    const w = new FolderWatcher(120);
    w.onReady = p => got.push(p);
    w.start(dir);
    fs.writeFileSync(path.join(dir, '三体.epub.part'), 'x'.repeat(200));
    await new Promise(r => setTimeout(r, 600));
    w.stop();
    expect(got).toHaveLength(0);
  });
});
