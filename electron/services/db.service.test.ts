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

  it('updateNote 一次改正文与标签', () => {
    const target = db.getAllNotes().find((n: any) => n.note === '乙的另一条');
    db.updateNote(target.id, '改过的正文', '哲学');
    const after = db.getAllNotes().find((n: any) => n.id === target.id);
    expect(after.note).toBe('改过的正文');
    expect(after.tags).toBe('哲学');
  });

  it('updateNote 允许清空正文（改空白不等于没改）', () => {
    const target = db.getAllNotes().find((n: any) => n.note === '改过的正文');
    db.updateNote(target.id, '', '哲学');
    const after = db.getAllNotes().find((n: any) => n.id === target.id);
    expect(after.note).toBe('');
    expect(after.tags).toBe('哲学');
  });

  it('锁定的书籍拒绝改笔记正文', () => {
    const target = db.getAllNotes().find((n: any) => n.book_title === '笔记书甲');
    db.toggleBookLock(b1);
    expect(() => db.updateNote(target.id, '偷改', '')).toThrow(/已锁定/);
    db.toggleBookLock(b1);
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

describe('阅读状态与星级评分', () => {
  let sid: number;

  beforeAll(() => {
    sid = db.insertBook({ title: '状态测试书', file_path: '/tmp/status.epub', file_type: 'epub' });
  });

  it('默认状态为空（按进度推断）且未评分', () => {
    const b = db.getBookById(sid);
    expect(b.status ?? '').toBe('');
    expect(b.rating ?? 0).toBe(0);
  });

  it('设置阅读状态', () => {
    db.setBookStatus(sid, 'shelved');
    expect(db.getBookById(sid).status).toBe('shelved');
    db.setBookStatus(sid, 'reading');
    expect(db.getBookById(sid).status).toBe('reading');
  });

  it('非法状态值被归一化为空串（不写脏数据）', () => {
    db.setBookStatus(sid, '不存在的状态');
    expect(db.getBookById(sid).status).toBe('');
  });

  it('评分钳制在 0-5', () => {
    db.setBookRating(sid, 4);
    expect(db.getBookById(sid).rating).toBe(4);
    db.setBookRating(sid, 99);
    expect(db.getBookById(sid).rating).toBe(5);
    db.setBookRating(sid, -3);
    expect(db.getBookById(sid).rating).toBe(0);
  });

  it('评分支持小数（向下取整）与非数字', () => {
    db.setBookRating(sid, 3.7);
    expect(db.getBookById(sid).rating).toBe(3);
    db.setBookRating(sid, NaN as any);
    expect(db.getBookById(sid).rating).toBe(0);
  });

  it('锁定的书籍拒绝改状态与评分', () => {
    db.setBookLock(sid, true);
    expect(() => db.setBookStatus(sid, 'finished')).toThrow(/已锁定/);
    expect(() => db.setBookRating(sid, 5)).toThrow(/已锁定/);
    db.setBookLock(sid, false);
    expect(() => db.setBookStatus(sid, 'finished')).not.toThrow();
  });
});

describe('标注样式', () => {
  let bid: number;

  beforeAll(() => {
    bid = db.insertBook({ title: '标注样式书', file_path: '/tmp/mark.epub', file_type: 'epub' });
  });

  it('默认样式为高亮', () => {
    db.insertBookmark({ book_id: bid, position: 'p-default' });
    const b = db.getBookmarkByPosition(bid, 'p-default');
    expect(b.style).toBe('highlight');
  });

  it('可存下划线样式', () => {
    db.insertBookmark({ book_id: bid, position: 'p-under', style: 'underline' });
    expect(db.getBookmarkByPosition(bid, 'p-under').style).toBe('underline');
  });

  it('非法样式归一化为高亮（不写脏值）', () => {
    db.insertBookmark({ book_id: bid, position: 'p-bad', style: '波浪线' });
    expect(db.getBookmarkByPosition(bid, 'p-bad').style).toBe('highlight');
  });
});

describe('系列分组', () => {
  let a: number;
  let b: number;

  beforeAll(() => {
    a = db.insertBook({ title: '系列书甲', file_path: '/tmp/s1.epub', file_type: 'epub' });
    b = db.insertBook({ title: '系列书乙', file_path: '/tmp/s2.epub', file_type: 'epub' });
  });

  it('默认未分组', () => {
    expect(db.getBookById(a).series ?? '').toBe('');
  });

  it('设置与清除系列', () => {
    db.setBookSeries(a, '银河系漫游');
    expect(db.getBookById(a).series).toBe('银河系漫游');
    db.setBookSeries(a, '   ');
    expect(db.getBookById(a).series ?? '').toBe('');
  });

  it('系列列表去重且忽略空值', () => {
    db.setBookSeries(a, '三体三部曲');
    db.setBookSeries(b, '三体三部曲');
    const list = db.getSeriesList();
    expect(list.filter((s: string) => s === '三体三部曲')).toHaveLength(1);
    expect(list).not.toContain('');
  });

  it('锁定的书籍拒绝改系列', () => {
    db.setBookLock(a, true);
    expect(() => db.setBookSeries(a, 'x')).toThrow(/已锁定/);
    db.setBookLock(a, false);
  });
});

describe('导入冲突处理', () => {
  it('按书名查重忽略大小写与首尾空白', () => {
    const id = db.insertBook({ title: '  Night Flight  ', file_path: '/tmp/nf.epub', file_type: 'epub' });
    expect(db.findBookByTitle('night flight')?.id).toBe(id);
    expect(db.findBookByTitle('  Night Flight ')?.id).toBe(id);
    expect(db.findBookByTitle('查无此书')).toBeUndefined();
  });

  it('空书名不参与查重，避免一堆无名书互相判重', () => {
    expect(db.findBookByTitle('')).toBeUndefined();
    expect(db.findBookByTitle('   ')).toBeUndefined();
  });

  it('替换只改文件字段，id 不变——书签笔记挂在 id 上不能丢', () => {
    const id = db.insertBook({ title: '旧版', file_path: '/tmp/old.epub', file_type: 'epub', hash: 'h1' });
    db.insertBookmark({ book_id: id, position: 'cfi-1', text: '书签' });
    db.setBookLocations(id, JSON.stringify(['cfi-a']));

    db.replaceBookFile(id, {
      title: '新版',
      author: '作者',
      file_path: '/tmp/new.pdf',
      file_type: 'pdf',
      hash: 'h2',
    });

    const after = db.getBookById(id);
    expect(after.title).toBe('新版');
    expect(after.author).toBe('作者');
    expect(after.file_path).toBe('/tmp/new.pdf');
    expect(after.file_type).toBe('pdf');
    expect(after.hash).toBe('h2');
    expect(db.getBookmarksByBookId(id)).toHaveLength(1);
    // 换了文件，旧的位置索引必须作废，否则 CFI 会指向不存在的位置
    expect(after.locations ?? null).toBeNull();
  });

  it('锁定的书籍拒绝替换', () => {
    const id = db.insertBook({ title: '锁定替换', file_path: '/tmp/l.epub', file_type: 'epub' });
    db.setBookLock(id, true);
    expect(() =>
      db.replaceBookFile(id, { title: 't', file_path: '/tmp/n.epub', file_type: 'epub', hash: 'h' }),
    ).toThrow(/已锁定/);
  });
});

describe('崩溃恢复的会话标记', () => {
  it('清空之后不再被认为是异常退出', () => {
    db.setSetting('readingSession:4242', String(Date.now()));
    expect(db.findDanglingReadingSession()?.bookId).toBe(4242);
    db.clearReadingSessions();
    expect(db.findDanglingReadingSession()).toBeNull();
  });

  it('多本书都残留时取时间戳最新的那本', () => {
    db.clearReadingSessions();
    db.setSetting('readingSession:1', '100');
    db.setSetting('readingSession:2', '200');
    expect(db.findDanglingReadingSession()?.bookId).toBe(2);
    db.clearReadingSessions();
  });

  it('畸形 key 不会挡住后面正常的记录', () => {
    db.clearReadingSessions();
    db.setSetting('readingSession:abc', '999');
    db.setSetting('readingSession:7', '100');
    expect(db.findDanglingReadingSession()?.bookId).toBe(7);
    db.clearReadingSessions();
  });
});

describe('联网附加能力总开关', () => {
  const clearSwitch = () => {
    db.run("DELETE FROM settings WHERE key = 'onlineFeaturesEnabled'");
  };

  afterAll(() => {
    clearSwitch();
  });

  it('认 1 与历史遗留的 true，其余脏值一律当关闭', () => {
    // 'true' 是旧版设置页保存写入的编码，存量库里很常见，必须继续认得
    db.setSetting('onlineFeaturesEnabled', 'true');
    expect(db.isOnlineEnabled()).toBe(true);
    db.setSetting('onlineFeaturesEnabled', '1');
    expect(db.isOnlineEnabled()).toBe(true);
    db.setSetting('onlineFeaturesEnabled', '0');
    expect(db.isOnlineEnabled()).toBe(false);
    db.setSetting('onlineFeaturesEnabled', 'false');
    expect(db.isOnlineEnabled()).toBe(false);
    // 无法识别的值不放行，保持保守立场
    db.setSetting('onlineFeaturesEnabled', 'yes');
    expect(db.isOnlineEnabled()).toBe(false);
  });

  it('关闭时拦截出站操作，并在提示里指明去哪里开', () => {
    db.setSetting('onlineFeaturesEnabled', '0');
    expect(() => db.assertOnlineEnabled('在线书源')).toThrow(/在线书源/);
    expect(() => db.assertOnlineEnabled('在线书源')).toThrow(/设置/);
  });

  it('开启后放行', () => {
    db.setSetting('onlineFeaturesEnabled', '1');
    expect(() => db.assertOnlineEnabled('在线书源')).not.toThrow();
  });

  it('目标是本机服务时不受开关限制', () => {
    db.setSetting('onlineFeaturesEnabled', '0');
    // 默认配置里的向量服务与 AI 服务都指向本机，不该被联网开关拦住
    expect(() => db.assertOnlineEnabled('语义检索', 'http://localhost:8081')).not.toThrow();
    expect(() => db.assertOnlineEnabled('AI 阅读助手', 'http://127.0.0.1:11434')).not.toThrow();
    expect(() => db.assertOnlineEnabled('WebDAV 同步', 'http://[::1]:5005')).not.toThrow();
    // 外部地址照旧拦截
    expect(() => db.assertOnlineEnabled('语义检索', 'http://api.example.com')).toThrow(/需要联网/);
    // 局域网确实发生了网络请求，仍归开关管辖
    expect(() => db.assertOnlineEnabled('AI 阅读助手', 'http://192.168.1.5:11434')).toThrow(/需要联网/);
  });

  it('回环地址识别边界', async () => {
    const { isLoopbackUrl } = await import('./db.service');
    expect(isLoopbackUrl('http://localhost:8081')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1/webdav')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
    expect(isLoopbackUrl('http://example.com')).toBe(false);
    // 形似而非本机，不能被当成回环放行
    expect(isLoopbackUrl('http://localhost.evil.com')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackUrl('不是地址')).toBe(false);
  });

  it('新库初始化默认关闭', () => {
    clearSwitch();
    db.initOnlineSwitch();
    expect(db.getSetting('onlineFeaturesEnabled')).toBe('0');
  });

  it('已有书源的老库初始化视为已开启，不让既有配置变哑巴', () => {
    clearSwitch();
    db.insertSource({
      name: '测试源',
      url: 'https://example.com',
      search_url: 'https://example.com/s?q={{keyword}}',
      chapters_url: '',
      content_url: '',
    });
    db.initOnlineSwitch();
    expect(db.getSetting('onlineFeaturesEnabled')).toBe('1');
  });

  it('初始化不覆盖用户已做的选择', () => {
    db.setSetting('onlineFeaturesEnabled', '0');
    db.initOnlineSwitch();
    expect(db.getSetting('onlineFeaturesEnabled')).toBe('0');
  });
});
