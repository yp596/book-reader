/**
 * 笔记标签：以逗号分隔的字符串存储（无需额外建表），
 * 这里集中处理清洗、去重与筛选，避免各处实现漂移。
 */

/** 中英文逗号、分号、空白都算分隔符 */
const SEPARATOR = /[,，;；\s]+/;

/** 标签长度上限（防止误贴一整段文字） */
const MAX_TAG_LEN = 24;

/**
 * 归一化标签串：去空白、去重（保序）、丢弃超长项。
 * 返回逗号分隔的规范形式，可直接入库。
 */
export function normalizeTags(raw?: string | null): string {
  if (!raw) return '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(SEPARATOR)) {
    const t = part.trim();
    if (!t || t.length > MAX_TAG_LEN) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(',');
}

/** 解析为数组 */
export function parseTags(raw?: string | null): string[] {
  const n = normalizeTags(raw);
  return n ? n.split(',') : [];
}

/**
 * 标签筛选：选中的标签需全部命中（交集语义）。
 * 未选任何标签时视为不过滤。
 */
export function matchesTags(noteTags: string | string[] | null | undefined, selected: string[]): boolean {
  if (!selected || selected.length === 0) return true;
  const list = Array.isArray(noteTags) ? noteTags : parseTags(noteTags);
  return selected.every(t => list.includes(t));
}

/** 统计标签使用频次，按频次降序、同频按字典序 */
export function countTags(rawList: (string | null | undefined)[]): { tag: string; count: number }[] {
  const counter = new Map<string, number>();
  for (const raw of rawList) {
    for (const t of parseTags(raw)) {
      counter.set(t, (counter.get(t) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
