import fs from 'fs';
import path from 'path';

/**
 * 递归统计目录占用字节数。
 * 目录不存在或个别文件读不到时按 0 计，不抛错——统计失败
 * 不该让设置页整页打不开。
 */
export function dirSize(dir: string): number {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full);
      else if (e.isFile()) total += fs.statSync(full).size;
    } catch {
      /* 单文件失败跳过 */
    }
  }
  return total;
}

export interface CacheStats {
  /** 在线书源章节缓存条数 */
  chapterCount: number;
  /** 本地快照份数与占用 */
  snapshotCount: number;
  snapshotBytes: number;
  /** 书籍文件占用 */
  booksBytes: number;
}

/** 清理本地快照，返回删除份数 */
export function clearSnapshots(dir: string): number {
  if (!dir || !fs.existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('snapshot-') || !f.endsWith('.json')) continue;
      try {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return removed;
}
