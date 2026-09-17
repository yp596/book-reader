import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { localFileUrl } from './local-file';
import {
  collectBackup,
  buildBackupFile,
  mergeBackup,
  writeBackupArchive,
  archiveEntryName,
  collectBookFileEntries,
  extractBackupFiles,
  readBackup,
  type BackupFile,
} from './local-backup';

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
    // 恢复归档时要用到的写入接口：建书 + 回填书架元信息
    insertBook: (b: any) => {
      const id = ++idc;
      state.books.push({ id, progress: 0, ...b });
      return id;
    },
    setBookStatus: (id: number, v: string) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.status = v;
    },
    setBookRating: (id: number, v: number) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.rating = v;
    },
    setCategory: (id: number, v: string) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.category = v;
    },
    setBookSeries: (id: number, v: string) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.series = v;
    },
    setFavorite: (id: number, v: boolean) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.favorite = v ? 1 : 0;
    },
    setBookLock: (id: number, v: boolean) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.locked = v ? 1 : 0;
    },
    setBookToc: (id: number, json: string) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.toc = json;
    },
    setBookLocations: (id: number, json: string) => {
      const b = state.books.find(x => x.id === id);
      if (b) b.locations = json;
    },
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
    expect(mergeBackup(db, payload).changed).toBe(1);
    expect(mergeBackup(db, payload).changed).toBe(0); // 幂等
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
    expect(mergeBackup(db, payload).changed).toBe(1);
    expect(state.settings.get('theme')).toBe('light');
    expect(mergeBackup(db, payload).changed).toBe(0);
  });

  it('找不到对应书籍的书签被跳过', () => {
    const { db, state } = makeFakeDb();
    const r = mergeBackup(db, wrap({ bookmarks: [{ book_title: '不存在的书', position: 'x' }] }));
    expect(r.changed).toBe(0);
    expect(r.dropped.bookmarks).toBe(1);
    expect(state.bookmarks).toHaveLength(0);
  });

  it('空 payload 不报错', () => {
    const { db } = makeFakeDb();
    const r = mergeBackup(db, wrap({}));
    expect(r.changed).toBe(0);
    expect(r.dropped).toEqual({ books: 0, bookmarks: 0, notes: 0 });
  });
});

describe('备份携带书名（书签/笔记的归属依据）', () => {
  it('导出的书签与笔记带上所属书名', () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 7, title: '三体', file_path: '/tmp/a.epub', file_type: 'epub', progress: 0 });
    state.bookmarks.push({ id: 1, book_id: 7, position: 'p1', text: '标记' });
    state.notes.push({ id: 2, book_id: 7, position: 'p2', note: '想法' });

    const payload = buildBackupFile(db, null);
    expect(payload.data.bookmarks?.[0].book_title).toBe('三体');
    expect(payload.data.notes?.[0].book_title).toBe('三体');
  });

  it('书已不在书库时书名为空串，恢复时跳过而不是挂到别的书上', () => {
    const { db, state } = makeFakeDb();
    state.bookmarks.push({ id: 1, book_id: 999, position: 'p1' });
    const payload = buildBackupFile(db, null);
    expect(payload.data.bookmarks?.[0].book_title).toBe('');
  });

  it('书籍 ID 变了也能按书名挂回正确的书（跨设备/重导入后恢复）', () => {
    const src = makeFakeDb();
    src.state.books.push({ id: 7, title: '三体', file_path: '/tmp/a.epub', file_type: 'epub', progress: 0.5 });
    src.state.bookmarks.push({ id: 1, book_id: 7, position: 'p1', text: '标记' });
    const payload = buildBackupFile(src.db, null);

    // 另一套库：同一本书的自增 ID 不同
    const dst = makeFakeDb();
    dst.state.books.push({ id: 42, title: '三体', file_path: '/tmp/b.epub', file_type: 'epub', progress: 0 });

    mergeBackup(dst.db, payload);
    expect(dst.state.bookmarks.some((m: any) => m.book_id === 42 && m.position === 'p1')).toBe(true);
  });
});

describe('备份归档（zip 容器，连书籍文件一起带走）', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'br-backup-'));

  it('写出的归档能被读回，数据部分完整', async () => {
    const { db, state } = makeFakeDb();
    state.books.push({ id: 7, title: '三体', file_path: '/tmp/a.epub', file_type: 'epub', progress: 0.3 });
    const payload = buildBackupFile(db, null);
    const zipPath = path.join(tmp(), 'full.zip');

    await writeBackupArchive(zipPath, payload, []);
    const back = await readBackup(zipPath);

    expect(back.version).toBe(2);
    expect(back.kind).toBe('full');
    expect(back.data.books?.[0].title).toBe('三体');
  });

  it('旧版 JSON 备份仍能读（向后兼容）', async () => {
    const jsonPath = path.join(tmp(), 'legacy.json');
    const payload: BackupFile = {
      version: 2,
      kind: 'full',
      createdAt: '2026-09-01T00:00:00.000Z',
      since: null,
      data: { books: [{ id: 1, title: '旧备份里的书' }] },
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf-8');

    const back = await readBackup(jsonPath);
    expect(back.data.books?.[0].title).toBe('旧备份里的书');
  });

  it('归档里的书籍文件与封面能还原到书库目录，封面写成渲染层可用的地址', async () => {
    const src = tmp();
    const bookSrc = path.join(src, '三体.epub');
    const coverSrc = path.join(src, 'cover.jpg');
    fs.writeFileSync(bookSrc, 'book-bytes');
    fs.writeFileSync(coverSrc, 'cover-bytes');

    const zipPath = path.join(src, 'full.zip');
    const payload: BackupFile = {
      version: 2,
      kind: 'full',
      createdAt: '2026-09-12T00:00:00.000Z',
      since: null,
      data: { books: [{ id: 7, title: '三体' }] },
    };
    await writeBackupArchive(zipPath, payload, [
      { archiveName: archiveEntryName('book', 7, bookSrc), sourcePath: bookSrc },
      { archiveName: archiveEntryName('cover', 7, coverSrc), sourcePath: coverSrc },
    ]);

    const out = tmp();
    const map = await extractBackupFiles(zipPath, out);
    const entry = map.get(7);

    expect(entry?.filePath).toBeTruthy();
    expect(fs.readFileSync(entry!.filePath, 'utf-8')).toBe('book-bytes');
    expect(entry?.coverPath?.startsWith('bookfile://')).toBe(true);
  });

  it('带着还原文件的恢复会把书重建出来，并把批注挂回这本新书', async () => {
    const src = makeFakeDb();
    src.state.books.push({ id: 7, title: '三体', file_path: '/tmp/a.epub', file_type: 'epub', progress: 0.5 });
    src.state.bookmarks.push({ id: 1, book_id: 7, position: 'p1', text: '标记' });
    const payload = buildBackupFile(src.db, null);

    // 目标库是空的：模拟换台机器恢复
    const dst = makeFakeDb();
    const files = new Map([[7, { filePath: '/tmp/restored-7.epub' }]]);

    mergeBackup(dst.db, payload, files);

    const restoredBook = dst.state.books.find((b: any) => b.title === '三体');
    expect(restoredBook).toBeTruthy();
    expect(restoredBook.file_path).toBe('/tmp/restored-7.epub');
    expect(restoredBook.progress).toBe(0.5);
    expect(dst.state.bookmarks.some((m: any) => m.book_id === restoredBook.id)).toBe(true);
  });

  it('没有还原文件时不凭空造一条打不开的书籍记录', () => {
    const src = makeFakeDb();
    src.state.books.push({ id: 7, title: '三体', file_path: '/tmp/a.epub', file_type: 'epub' });
    const payload = buildBackupFile(src.db, null);

    const dst = makeFakeDb();
    mergeBackup(dst.db, payload);

    expect(dst.state.books).toHaveLength(0);
  });
});

describe('collectBookFileEntries（挑出随全量备份打包的文件）', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'br-collect-'));

  it('正文与封面都在时各带一条', () => {
    const dir = tmp();
    const bookPath = path.join(dir, 'a.epub');
    const coverPath = path.join(dir, 'a.jpg');
    fs.writeFileSync(bookPath, 'b');
    fs.writeFileSync(coverPath, 'c');

    const { files, skipped } = collectBookFileEntries([
      { id: 3, title: 'A', file_path: bookPath, cover_path: localFileUrl(coverPath) },
    ]);

    expect(skipped).toBe(0);
    expect(files.map(f => f.archiveName)).toEqual([
      `books/3__a.epub`,
      `covers/3__a.jpg`,
    ]);
  });

  it('源文件已不在本机的书计入 skipped，不塞进归档', () => {
    const { files, skipped } = collectBookFileEntries([
      { id: 4, title: 'B', file_path: path.join(os.tmpdir(), 'definitely-missing.epub') },
      { id: 5, title: 'C' },
    ]);

    expect(files).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it('封面地址非法或文件不存在时只带正文，不影响整份备份', () => {
    const dir = tmp();
    const bookPath = path.join(dir, 'd.txt');
    fs.writeFileSync(bookPath, 'x');

    const { files, skipped } = collectBookFileEntries([
      { id: 6, title: 'D', file_path: bookPath, cover_path: '不是合法地址' },
      { id: 7, title: 'E', file_path: bookPath, cover_path: localFileUrl(path.join(dir, 'missing.jpg')) },
    ]);

    expect(skipped).toBe(0);
    expect(files.map(f => f.archiveName)).toEqual(['books/6__d.txt', 'books/7__d.txt']);
  });
});
