import { describe, it, expect } from 'vitest';
import { lookupMark } from './mark-lookup';
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
