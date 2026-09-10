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
