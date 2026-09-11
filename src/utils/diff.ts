/**
 * 行级差异：用于「文档比较」。
 * 对齐思路是先剪掉公共前后缀，再对中间段做 LCS；规模过大时退化为整段替换，
 * 避免在大部头上吃掉几百 MB 内存。
 */

export type DiffOp = 'equal' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  /** 左文档行号（0 起）；新增行没有左行号 */
  left: number | null;
  /** 右文档行号（0 起）；删除行没有右行号 */
  right: number | null;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/** LCS 表规模上限（单元格数）：超过就退化，避免大文档把内存打满 */
const MAX_LCS_CELLS = 1_000_000;

function lcsLengths(a: string[], b: string[]): Int32Array {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  return table;
}

/**
 * 比较两个行数组，返回按阅读顺序排列的差异序列。
 * 左右文档行号各自独立计数，便于两侧并排显示。
 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];

  // 公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  // 公共后缀
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) {
    out.push({ op: 'equal', left: i, right: i, text: a[i] });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= MAX_LCS_CELLS) {
    const cols = midB.length + 1;
    const table = lcsLengths(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ op: 'equal', left: start + i, right: start + j, text: midA[i] });
        i++;
        j++;
      } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
        out.push({ op: 'del', left: start + i, right: null, text: midA[i] });
        i++;
      } else {
        out.push({ op: 'add', left: null, right: start + j, text: midB[j] });
        j++;
      }
    }
    for (; i < midA.length; i++) out.push({ op: 'del', left: start + i, right: null, text: midA[i] });
    for (; j < midB.length; j++) out.push({ op: 'add', left: null, right: start + j, text: midB[j] });
  } else {
    // 规模过大：不做逐行对齐，整段记为删除 + 新增
    for (let i = 0; i < midA.length; i++) {
      out.push({ op: 'del', left: start + i, right: null, text: midA[i] });
    }
    for (let j = 0; j < midB.length; j++) {
      out.push({ op: 'add', left: null, right: start + j, text: midB[j] });
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ op: 'equal', left: endA + k, right: endB + k, text: a[endA + k] });
  }
  return out;
}

/** 统计差异规模，供概览显示 */
export function diffStats(lines: DiffLine[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const line of lines) {
    if (line.op === 'add') stats.added++;
    else if (line.op === 'del') stats.removed++;
    else stats.unchanged++;
  }
  return stats;
}
