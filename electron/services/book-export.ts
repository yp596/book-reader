/**
 * 导出用的书籍最小结构。
 * 刻意不在主进程里 import 渲染层的 @/types——跨进程边界引用会让
 * 打包与类型解析都变脆，这里只声明实际用到的字段。
 */
export interface BookLike {
  title: string;
  author?: string;
  file_type?: string;
  progress?: number;
  category?: string;
  status?: string;
  rating?: number;
  favorite?: number;
  last_read_at?: string;
}

/** 阅读状态的中文名（与书架筛选保持一致） */
export const STATUS_LABELS: Record<string, string> = {
  '': '未标记',
  reading: '在读',
  finished: '已读完',
  shelved: '搁置',
};

/** 状态展示：未显式标记时按进度推断，与书架筛选口径一致 */
export function effectiveStatus(book: BookLike): string {
  if (book.status) return book.status;
  if ((book.progress ?? 0) >= 0.95) return 'finished';
  if ((book.progress ?? 0) > 0) return 'reading';
  return '';
}

const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * 生成书籍清单 Markdown。
 * 纯函数：输入书籍数组，输出可直接保存的文本，便于单测。
 */
export function buildBookListMarkdown(books: BookLike[], now: Date = new Date()): string {
  const lines: string[] = [
    '# 书籍清单',
    '',
    `> 导出时间：${now.toLocaleString()}　共 ${books.length} 本`,
    '',
  ];
  if (books.length === 0) {
    lines.push('（书架为空）');
    return lines.join('\n');
  }
  lines.push('| 书名 | 作者 | 格式 | 分类 | 状态 | 评分 | 进度 | 最近阅读 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const b of books) {
    const status = STATUS_LABELS[effectiveStatus(b)] ?? '未标记';
    const rating = b.rating ? `${b.rating}/5` : '—';
    const progress = `${Math.round((b.progress ?? 0) * 100)}%`;
    const lastRead = b.last_read_at ? new Date(b.last_read_at).toLocaleDateString() : '—';
    lines.push(
      `| ${esc(b.title)} | ${esc(b.author || '未知')} | ${esc((b.file_type || '').toUpperCase())} | ` +
      `${esc(b.category || '—')} | ${status} | ${rating} | ${progress} | ${lastRead} |`,
    );
  }
  return lines.join('\n');
}

/** 单本书的备份载荷（含批注、笔记、阅读位置） */
export interface BookBackup {
  version: 1;
  exportedAt: string;
  book: Partial<BookLike>;
  bookmarks: unknown[];
  notes: unknown[];
  positions: unknown[];
}

/**
 * 组装单本书备份。
 * 不包含书籍文件本身——文件可能很大，且这份备份的用途是
 * 「带走阅读痕迹」，重新导入同一本书即可对接上。
 */
export function buildBookBackup(
  book: BookLike,
  bookmarks: unknown[],
  notes: unknown[],
  positions: unknown[],
  now: Date = new Date(),
): BookBackup {
  return {
    version: 1,
    exportedAt: now.toISOString(),
    book: {
      title: book.title,
      author: book.author,
      file_type: book.file_type,
      progress: book.progress,
      category: book.category,
      status: book.status,
      rating: book.rating,
      favorite: book.favorite,
    },
    bookmarks,
    notes,
    positions,
  };
}

/**
 * 本地日期戳 YYYY-MM-DD。
 * 不能用 toISOString——那是 UTC，东八区凌晨 0-8 点会算成前一天，
 * 用户看到的文件名日期会比当天早一天。
 */
export function localDateStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 生成备份文件名（去掉文件系统非法字符） */
export function backupFileName(title: string, now: Date = new Date()): string {
  const safe = String(title || "book").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  return `${safe}-备份-${localDateStamp(now)}.json`;
}