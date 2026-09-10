import type { Bookmark, Note } from '../types';

/** 原文批注反查结果 */
export interface MarkHit {
  position: string;
  text?: string;
  note?: string;
  noteId?: number;
  markId?: number;
}

/**
 * 点击正文高亮时，反查该处的书签与笔记。
 *
 * 匹配规则：
 * - 书签优先按 markId 精确命中（EPUB 注解 data / TXT mark 的 data-id）
 * - markId 缺失或失效时退回按 position 匹配
 * - 笔记只按 position 匹配（笔记与高亮共用同一位置标识）
 * - 两者皆无返回 null，调用方不弹窗
 */
export function lookupMark(
  bookmarks: Bookmark[],
  notes: Note[],
  position: string,
  markId?: number,
): MarkHit | null {
  // markId 优先；失效（被删重建后 id 变了）则回退按位置匹配
  const mark =
    (markId != null ? bookmarks.find(b => b.id === markId) : undefined) ??
    bookmarks.find(b => b.position === position);
  const note = notes.find(n => n.position === position);
  const pos = mark?.position ?? note?.position;
  if (!pos) return null;
  return {
    position: pos,
    // 摘录优先取书签原文，其次笔记里存的选中文本
    text: mark?.text ?? note?.selected_text,
    note: note?.note,
    noteId: note?.id,
    markId: mark?.id,
  };
}

/**
 * 批注位置排序键。
 * TXT 的位置串形如 `txt:页:起:止`，按页码排（数字序，
 * 不能按字符串——否则第 10 页会排在第 2 页前面）；
 * EPUB 的 CFI 无页码，交给 compareCfi 逐段比较。
 */
export function posKey(position: string): [number, string] {
  if (position.startsWith('txt:')) {
    const page = Number(position.split(':')[1]);
    return [Number.isFinite(page) ? page : 0, position];
  }
  return [0, position];
}

/**
 * 把 CFI 拆成可比较片段：数字段转成数值，其余保留字符串。
 * 直接按字符串比会把 /6/12 排到 /6/4 前面——CFI 的路径段是十进制数，
 * 词法序与文档顺序不一致。
 */
export function cfiParts(cfi: string): (number | string)[] {
  const body = cfi.replace(/^epubcfi\(/, '').replace(/\)$/, '');
  return body
    .split(/(\d+)/)
    .filter(x => x !== '')
    .map(x => (/^\d+$/.test(x) ? Number(x) : x));
}

/** 逐段比较两个 CFI，近似文档顺序 */
export function compareCfi(a: string, b: string): number {
  const fa = cfiParts(a);
  const fb = cfiParts(b);
  const len = Math.max(fa.length, fb.length);
  for (let i = 0; i < len; i++) {
    const x = fa[i];
    const y = fb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** 按位置排序的通用比较器（时间排序由调用方保持原序） */
export function compareByPosition<T extends { position: string }>(a: T, b: T): number {
  const [pa, sa] = posKey(a.position);
  const [pb, sb] = posKey(b.position);
  if (pa !== pb) return pa - pb;
  return compareCfi(sa, sb);
}
