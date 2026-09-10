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

describe('多进度断点', () => {
  let pid: number;

  beforeAll(() => {
    pid = db.insertBook({ title: '断点测试书', file_path: '/tmp/p.epub', file_type: 'epub' });
  });

  it('新增位置并回读', () => {
    const id = db.addReadingPosition({
      book_id: pid,
      position: 'epubcfi(/6/4!/2)',
      label: '第一章',
      progress: 0.1,
      source: 'manual',
    });
    const list = db.getReadingPositions(pid);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('第一章');
    expect(list[0].id).toBe(id);
  });

  it('同书同位置不堆叠，改为刷新', () => {
    db.addReadingPosition({ book_id: pid, position: 'epubcfi(/6/4!/2)', label: '改名了', progress: 0.2 });
    const list = db.getReadingPositions(pid);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('改名了');
    expect(list[0].progress).toBeCloseTo(0.2);
  });

  it('不同位置各存一条', () => {
    db.addReadingPosition({ book_id: pid, position: 'epubcfi(/6/8!/2)', label: '第二章', source: 'manual' });
    expect(db.getReadingPositions(pid)).toHaveLength(2);
  });

  it('删除单条', () => {
    const before = db.getReadingPositions(pid).length;
    const target = db.getReadingPositions(pid)[0];
    db.deleteReadingPosition(target.id);
    expect(db.getReadingPositions(pid)).toHaveLength(before - 1);
  });

  it('自动来源按上限裁剪，手动标记永不被裁', () => {
    // 手动标记 1 条
    db.addReadingPosition({ book_id: pid, position: 'manual-1', source: 'manual' });
    // 自动记录 8 条
    for (let i = 0; i < 8; i++) {
      db.addReadingPosition({ book_id: pid, position: `exit-${i}`, source: 'exit' });
    }
    db.pruneReadingPositions(pid, 3);

    const list = db.getReadingPositions(pid, 100);
    const auto = list.filter((r: any) => r.source === 'exit');
    const manual = list.filter((r: any) => r.source === 'manual');
    expect(auto).toHaveLength(3);
    expect(manual.some((r: any) => r.position === 'manual-1')).toBe(true);
  });

  it('fail: 裁剪不会误删手动标记', () => {
    const manual = db.getReadingPositions(pid, 100).filter((r: any) => r.source === 'manual');
    expect(manual.length).toBeGreaterThan(0);
  });

  it('书籍删除时级联清理位置', () => {
    const tmpId = db.insertBook({ title: '待删书', file_path: '/tmp/z.epub', file_type: 'epub' });
    db.addReadingPosition({ book_id: tmpId, position: 'x' });
    expect(db.getReadingPositions(tmpId)).toHaveLength(1);
    db.deleteBook(tmpId);
    expect(db.getReadingPositions(tmpId)).toHaveLength(0);
  });
});

describe('跨书籍笔记与标签', () => {
  let b1: number;
  let b2: number;

  beforeAll(() => {
    b1 = db.insertBook({ title: '笔记书甲', file_path: '/tmp/n1.epub', file_type: 'epub' });
    b2 = db.insertBook({ title: '笔记书乙', file_path: '/tmp/n2.epub', file_type: 'epub' });
    db.insertNote({ book_id: b1, position: 'p1', note: '甲的笔记', tags: '小说,科幻' });
    db.insertNote({ book_id: b2, position: 'p2', note: '乙的笔记', tags: '历史' });
    db.insertNote({ book_id: b2, position: 'p3', note: '乙的另一条' });
  });

  it('getAllNotes 跨书汇总并带书名', () => {
    const all = db.getAllNotes();
    const mine = all.filter((n: any) => n.book_title === '笔记书甲' || n.book_title === '笔记书乙');
    expect(mine).toHaveLength(3);
    const jia = mine.find((n: any) => n.note === '甲的笔记');
    expect(jia.book_title).toBe('笔记书甲');
    expect(jia.tags).toBe('小说,科幻');
  });

  it('未设标签的笔记 tags 为空串（不是 null）', () => {
    const all = db.getAllNotes();
    const noTag = all.find((n: any) => n.note === '乙的另一条');
    expect(noTag.tags).toBe('');
  });

  it('updateNoteTags 更新标签', () => {
    const all = db.getAllNotes();
    const target = all.find((n: any) => n.note === '乙的另一条');
    db.updateNoteTags(target.id, '历史,待整理');
    const after = db.getAllNotes().find((n: any) => n.id === target.id);
    expect(after.tags).toBe('历史,待整理');
  });

  it('锁定的书籍拒绝改标签', () => {
    const all = db.getAllNotes();
    const target = all.find((n: any) => n.book_title === '笔记书甲');
    db.toggleBookLock(b1); // 锁定
    expect(() => db.updateNoteTags(target.id, 'x')).toThrow(/已锁定/);
    db.toggleBookLock(b1); // 解锁
  });

  it('按书名筛选可用', () => {
    const all = db.getAllNotes();
    expect(all.filter((n: any) => n.book_title === '笔记书乙')).toHaveLength(2);
  });
});

describe('批量：显式设置锁定态', () => {
  it('setBookLock 幂等，重复设置同一值不翻转', () => {
    const id = db.insertBook({ title: '批量测试书', file_path: '/tmp/batch.epub', file_type: 'epub' });
    db.setBookLock(id, true);
    db.setBookLock(id, true); // 与 toggle 不同，不应翻转成未锁定
    expect(!!db.getBookById(id).locked).toBe(true);
    db.setBookLock(id, false);
    db.setBookLock(id, false);
    expect(!!db.getBookById(id).locked).toBe(false);
  });

  it('批量改分类对锁定书籍生效前会抛错（守卫仍在）', () => {
    const id = db.insertBook({ title: '批量锁定书', file_path: '/tmp/batch2.epub', file_type: 'epub' });
    db.setBookLock(id, true);
    expect(() => db.setCategory(id, '测试')).toThrow(/已锁定/);
    db.setBookLock(id, false);
    expect(() => db.setCategory(id, '测试')).not.toThrow();
  });
});

describe('导入查重（内容指纹）', () => {
  it('insertBook 存入指纹，findBookByHash 能命中', () => {
    const id = db.insertBook({
      title: '查重书A',
      file_path: '/tmp/hash-a.epub',
      file_type: 'epub',
      hash: 'hash-aaa',
    });
    const hit = db.findBookByHash('hash-aaa');
    expect(hit?.id).toBe(id);
    expect(hit?.title).toBe('查重书A');
  });

  it('未登记的指纹查不到', () => {
    expect(db.findBookByHash('hash-不存在')).toBeUndefined();
  });

  it('空指纹不参与查重（避免误判为一堆同库）', () => {
    db.insertBook({ title: '无指纹书', file_path: '/tmp/no-hash.epub', file_type: 'epub' });
    expect(db.findBookByHash('')).toBeUndefined();
  });

  it('setBookHash 可补写存量书籍的指纹', () => {
    const id = db.insertBook({ title: '补指纹书', file_path: '/tmp/late.epub', file_type: 'epub' });
    expect(db.findBookByHash('hash-late')).toBeUndefined();
    db.setBookHash(id, 'hash-late');
    expect(db.findBookByHash('hash-late')?.id).toBe(id);
  });
});
