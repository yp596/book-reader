import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// DatabaseService 的构造函数依赖 electron.app.getPath，测试里指到临时目录
vi.mock('electron', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  const fsMod = await import('fs');
  const dir = pathMod.join(osMod.tmpdir(), 'book-reader-db-test');
  fsMod.mkdirSync(dir, { recursive: true });
  return { app: { getPath: () => dir } };
});

let db: any;
let bookId: number;

beforeAll(async () => {
  // 每次跑测试用干净库，避免上一轮残留
  const dir = path.join(os.tmpdir(), 'book-reader-db-test');
  const file = path.join(dir, 'book-reader.db');
  if (fs.existsSync(file)) fs.unlinkSync(file);

  const { DatabaseService } = await import('./db.service');
  db = await DatabaseService.create();
});

afterAll(() => {
  try {
    db?.close();
  } catch { /* 忽略 */ }
});

describe('书籍锁定', () => {
  it('新建书籍默认未锁定', () => {
    bookId = db.insertBook({ title: '锁定测试书', file_path: '/tmp/x.epub', file_type: 'epub' });
    const book = db.getBookById(bookId);
    expect(!!book.locked).toBe(false);
  });

  it('toggleBookLock 切换状态并返回新值', () => {
    expect(db.toggleBookLock(bookId)).toBe(1);
    expect(!!db.getBookById(bookId).locked).toBe(true);
    expect(db.toggleBookLock(bookId)).toBe(0);
    expect(!!db.getBookById(bookId).locked).toBe(false);
  });

  it('不存在的书籍报错', () => {
    expect(() => db.toggleBookLock(999999)).toThrow('书籍不存在');
  });
});

/** 显式设置锁定态，避免依赖 toggle 的当前值（测试顺序无关） */
function setLocked(locked: boolean) {
  if (!!db.getBookById(bookId).locked !== locked) db.toggleBookLock(bookId);
}

describe('锁定后的写操作守卫', () => {
  beforeAll(() => setLocked(true));

  it('拒绝重命名', () => {
    expect(() => db.renameBook(bookId, '新名字')).toThrow(/已锁定/);
  });

  it('拒绝改分类', () => {
    expect(() => db.setCategory(bookId, '小说')).toThrow(/已锁定/);
  });

  it('拒绝切换收藏', () => {
    expect(() => db.toggleFavorite(bookId)).toThrow(/已锁定/);
  });

  it('拒绝修改书籍信息', () => {
    expect(() => db.updateBookInfo(bookId, '改', '改')).toThrow(/已锁定/);
  });

  it('拒绝删除', () => {
    expect(() => db.deleteBook(bookId)).toThrow(/已锁定/);
    expect(db.getBookById(bookId)).toBeTruthy();
  });

  it('拒绝新增书签与笔记', () => {
    expect(() => db.insertBookmark({ book_id: bookId, position: 'cfi-1' })).toThrow(/已锁定/);
    expect(() => db.insertNote({ book_id: bookId, position: 'p1', note: 'x' })).toThrow(/已锁定/);
  });

  it('阅读进度仍可保存（锁定只挡编辑，不挡阅读）', () => {
    expect(() => db.updateBookProgress(bookId, 0.42)).not.toThrow();
    expect(db.getBookById(bookId).progress).toBeCloseTo(0.42);
  });
});

describe('解锁后恢复可写', () => {
  it('重命名成功', () => {
    setLocked(false);
    expect(() => db.renameBook(bookId, '解锁后的名字')).not.toThrow();
    expect(db.getBookById(bookId).title).toBe('解锁后的名字');
  });
});
