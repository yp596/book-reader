import { describe, it, expect } from 'vitest';
import { collectBackup, buildBackupFile, mergeBackup, type BackupFile } from './local-backup';

/** 最小可用假库：只实现 local-backup 用到的接口 */
function makeFakeDb() {
  const state = {
    settings: new Map<string, string>(),
    books: [] as any[],
    bookmarks: [] as any[],
    notes: [] as any[],
    words: [] as any[],
    sources: [] as any[],
  };
  let idc = 100;
  const db: any = {
    exportRowsSince: (t: string, since: string | null) => {
      const rows =
        t === 'books' ? state.books
        : t === 'bookmarks' ? state.bookmarks
        : t === 'notes' ? state.notes
        : t === 'words' ? state.words
        : state.sources;
      if (!since) return [...rows];
      return rows.filter(r => (r.updated_at ?? r.created_at ?? '') > since);
    },
    getSetting: (k: string) => state.settings.get(k) ?? null,
    setSetting: (k: string, v: string) => void state.settings.set(k, v),
    getAllBooks: () => state.books,
    updateBookProgress: (id: number, p: number) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.progress = p;
    },
    getBookmarksByBookId: (id: number) => state.bookmarks.filter(x => x.book_id === id),
    insertBookmark: (m: any) => {
      state.bookmarks.push({ id: ++idc, ...m });
      return idc;
    },
    getNotesByBookId: (id: number) => state.notes.filter(x => x.book_id === id),
    insertNote: (n: any) => {
      state.notes.push({ id: ++idc, ...n });
      return idc;
    },
    getAllWords: () => state.words,
    insertWord: (w: any) => {
      state.words.push({ id: ++idc, ...w });
      return idc;
    },
    getAllSources: () => state.sources,
    insertSource: (s: any) => {
      state.sources.push({ id: ++idc, ...s });
      return idc;
    },
  };
  return { db, state };
}

const wrap = (data: any): BackupFile => ({
  version: 2,
  kind: 'full',
  createdAt: '2026-09-10T00:00:00.000Z',
  since: null,
  data,
});

describe('collectBackup', () => {
  it('全量：since 为 null 时带上全部表', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '三体' });
    const data = collectBackup(db, null);
    expect(data.books).toHaveLength(1);
  });

  it('增量：since 透传给底层过滤', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '旧', created_at: '2026-01-01 00:00:00' });
    state.books.push({ id: 2, title: '新', created_at: '2026-09-01 00:00:00' });
    const data = collectBackup(db, '2026-06-01 00:00:00');
    expect(data.books?.map((b: any) => b.title)).toEqual(['新']);
  });

  it('空表不进 payload', () => {
    const { db } = makeFakeDb();
    const data = collectBackup(db, null);
    expect(data.books).toBeUndefined();
    expect(data.bookmarks).toBeUndefined();
  });

  it('设置只带白名单项', () => {
    const { db, state } = makeFakeDb();
    state.settings.set('theme', 'light');
    state.settings.set('windowBounds', '{"x":1}');
    const data = collectBackup(db, null);
    expect(data.settings?.map(s => s.key)).toEqual(['theme']);
  });
});

describe('buildBackupFile', () => {
  it('since 为 null 标记全量', () => {
    const { db } = makeFakeDb();
    expect(buildBackupFile(db, null).kind).toBe('full');
  });

  it('有 since 标记增量', () => {
    const { db } = makeFakeDb();
    expect(buildBackupFile(db, '2026-01-01').kind).toBe('incremental');
  });
});

describe('mergeBackup · 合并与去重', () => {
  it('进度：备份更新时覆盖本地', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '三体', progress: 0.1, last_read_at: '2026-01-01' });
    mergeBackup(db, wrap({ books: [{ title: '三体', progress: 0.8, last_read_at: '2026-09-01' }] }));
    expect(state.books[0].progress).toBe(0.8);
  });

  it('进度：备份更旧时不回退', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '三体', progress: 0.8, last_read_at: '2026-09-01' });
    mergeBackup(db, wrap({ books: [{ title: '三体', progress: 0.1, last_read_at: '2026-01-01' }] }));
    expect(state.books[0].progress).toBe(0.8);
  });

  it('书签：按位置去重，重复恢复不产生副本', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '三体' });
    const payload = wrap({
      bookmarks: [{ book_id: 1, book_title: '三体', position: 'cfi-1', text: 'x' }],
    });
    expect(mergeBackup(db, payload)).toBe(1);
    expect(mergeBackup(db, payload)).toBe(0); // 幂等
    expect(state.bookmarks).toHaveLength(1);
  });

  it('笔记：同位置不同正文视为两条', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 1, title: '三体' });
    mergeBackup(db, wrap({ notes: [{ book_id: 1, book_title: '三体', position: 'p1', note: '想法A' }] }));
    mergeBackup(db, wrap({ notes: [{ book_id: 1, book_title: '三体', position: 'p1', note: '想法B' }] }));
    expect(state.notes).toHaveLength(2);
  });

  it('生词：按词条去重', () => {
    const { db, state } = makeFakeDb();
    mergeBackup(db, wrap({ words: [{ word: 'ephemeral', definition: '短暂的' }] }));
    mergeBackup(db, wrap({ words: [{ word: 'ephemeral', definition: '短暂的（改）' }] }));
    expect(state.words).toHaveLength(1);
  });

  it('书源：同名不同址视为两条', () => {
    const { db, state } = makeFakeDb();
    mergeBackup(db, wrap({ sources: [{ name: '站A', url: 'https://a.com' }] }));
    mergeBackup(db, wrap({ sources: [{ name: '站A', url: 'https://b.com' }] }));
    expect(state.sources).toHaveLength(2);
  });

  it('设置：不同值才计入变更数', () => {
    const { db, state } = makeFakeDb();
    const payload = wrap({ settings: [{ key: 'theme', value: 'light' }] });
    expect(mergeBackup(db, payload)).toBe(1);
    expect(state.settings.get('theme')).toBe('light');
    expect(mergeBackup(db, payload)).toBe(0);
  });

  it('找不到对应书籍的书签被跳过', () => {
    const { db, state } = makeFakeDb();
    const n = mergeBackup(db, wrap({ bookmarks: [{ book_title: '不存在的书', position: 'x' }] }));
    expect(n).toBe(0);
    expect(state.bookmarks).toHaveLength(0);
  });

  it('空 payload 不报错', () => {
    const { db } = makeFakeDb();
    expect(mergeBackup(db, wrap({}))).toBe(0);
  });
});
