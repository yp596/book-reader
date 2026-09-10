import { describe, it, expect } from 'vitest';
import { lookupMark, posKey, compareByPosition, compareCfi } from './mark-lookup';
import type { Bookmark, Note } from '../types';

const bm = (id: number, position: string, text?: string): Bookmark => ({
  id,
  book_id: 1,
  position,
  text,
  created_at: '2026-09-10 00:00:00',
});

const nt = (id: number, position: string, note?: string, selected?: string): Note => ({
  id,
  book_id: 1,
  position,
  note,
  selected_text: selected,
  created_at: '2026-09-10 00:00:00',
});

describe('lookupMark', () => {
  const bookmarks = [bm(1, 'cfi-a', '摘录A'), bm(2, 'cfi-b', '摘录B')];
  const notes = [nt(10, 'cfi-a', '笔记A'), nt(11, 'cfi-c', '笔记C')];

  it('markId 精确命中书签', () => {
    const hit = lookupMark(bookmarks, notes, '随便', 2);
    expect(hit?.markId).toBe(2);
    expect(hit?.position).toBe('cfi-b');
    expect(hit?.text).toBe('摘录B');
  });

  it('markId 失效时回退按位置匹配', () => {
    const hit = lookupMark(bookmarks, notes, 'cfi-b', 999);
    // 999 不存在 → 回退 position 命中 cfi-b
    expect(hit?.markId).toBe(2);
    expect(hit?.position).toBe('cfi-b');
  });

  it('同位置同时有书签与笔记时两者都带出', () => {
    const hit = lookupMark(bookmarks, notes, 'cfi-a', 1);
    expect(hit?.markId).toBe(1);
    expect(hit?.noteId).toBe(10);
    expect(hit?.note).toBe('笔记A');
    expect(hit?.text).toBe('摘录A');
  });

  it('只有笔记（无高亮）也能命中', () => {
    const hit = lookupMark(bookmarks, notes, 'cfi-c');
    expect(hit?.markId).toBeUndefined();
    expect(hit?.noteId).toBe(11);
    expect(hit?.position).toBe('cfi-c');
  });

  it('摘录缺失时回退笔记里的选中文本', () => {
    const hit = lookupMark(bookmarks, [nt(12, 'cfi-d', '笔记D', '选中文本D')], 'cfi-d');
    expect(hit?.text).toBe('选中文本D');
  });

  it('两者皆无返回 null', () => {
    expect(lookupMark(bookmarks, notes, '不存在的位置')).toBeNull();
    expect(lookupMark([], [], 'cfi-a', 1)).toBeNull();
  });

  it('markId 指向的书签与传入位置不一致时，以书签为准', () => {
    const hit = lookupMark(bookmarks, notes, 'cfi-a', 2);
    expect(hit?.position).toBe('cfi-b');
    // 笔记按传入位置匹配到 cfi-a
    expect(hit?.noteId).toBe(10);
  });
});

describe('批注位置排序', () => {
  it('TXT 按页码排序，而非字符串顺序（否则第 10 页会排在第 2 页前）', () => {
    const list = [
      { position: 'txt:10:0:5' },
      { position: 'txt:2:0:5' },
      { position: 'txt:1:0:5' },
    ];
    list.sort(compareByPosition);
    expect(list.map(x => x.position)).toEqual(['txt:1:0:5', 'txt:2:0:5', 'txt:10:0:5']);
  });

  it('TXT 页码非法时回退到字符串比较而不抛错', () => {
    const list = [{ position: 'txt:x:0:5' }, { position: 'txt:1:0:5' }];
    expect(() => list.sort(compareByPosition)).not.toThrow();
  });

  it('EPUB 的 CFI 按路径数字比较（字典序会把 /6/12 排到 /6/4 前）', () => {
    const list = [
      { position: 'epubcfi(/6/8!/4/2)' },
      { position: 'epubcfi(/6/4!/4/2)' },
      { position: 'epubcfi(/6/12!/4/2)' },
    ];
    list.sort(compareByPosition);
    expect(list[0].position).toBe('epubcfi(/6/4!/4/2)');
    expect(list[2].position).toBe('epubcfi(/6/12!/4/2)');
  });

  it('posKey 对空串安全', () => {
    expect(() => posKey('')).not.toThrow();
  });
});

describe('compareCfi', () => {
  it('路径段按数值而非字符串比较', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2)', 'epubcfi(/6/12!/4/2)')).toBeLessThan(0);
  });

  it('相同 CFI 返回 0', () => {
    expect(compareCfi('epubcfi(/6/4!/4)', 'epubcfi(/6/4!/4)')).toBe(0);
  });

  it('前缀更短的排前面', () => {
    expect(compareCfi('epubcfi(/6/4)', 'epubcfi(/6/4/2)')).toBeLessThan(0);
  });

  it('空串不抛错', () => {
    expect(() => compareCfi('', 'epubcfi(/6/4)')).not.toThrow();
  });
});
