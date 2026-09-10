import { describe, it, expect } from 'vitest';
import {
  buildBookListMarkdown,
  buildBookBackup,
  backupFileName,
  effectiveStatus,
  STATUS_LABELS,
  type BookLike,
} from './book-export';

const book = (over: Partial<BookLike> = {}): BookLike => ({
  title: '三体',
  author: '刘慈欣',
  file_type: 'epub',
  progress: 0,
  ...over,
});

describe('effectiveStatus', () => {
  it('显式状态优先', () => {
    expect(effectiveStatus(book({ status: 'shelved', progress: 1 }))).toBe('shelved');
  });

  it('未标记时按进度推断', () => {
    expect(effectiveStatus(book({ progress: 0 }))).toBe('');
    expect(effectiveStatus(book({ progress: 0.5 }))).toBe('reading');
    expect(effectiveStatus(book({ progress: 0.98 }))).toBe('finished');
  });

  it('每个可能的状态都有中文名（否则清单会出现 undefined）', () => {
    for (const s of ['', 'reading', 'finished', 'shelved']) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
  });
});

describe('buildBookListMarkdown', () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it('空书架给出明确提示而非空表', () => {
    const md = buildBookListMarkdown([], now);
    expect(md).toContain('（书架为空）');
    expect(md).not.toContain('| --- |');
  });

  it('含表头、分隔行与每本书一行', () => {
    const md = buildBookListMarkdown([book(), book({ title: '活着' })], now);
    const rows = md.split('\n').filter(l => l.startsWith('| '));
    // 表头 + 分隔 + 2 本书
    expect(rows).toHaveLength(4);
  });

  it('转义竖线与换行，避免破坏表格结构', () => {
    const md = buildBookListMarkdown([book({ title: 'A|B', author: 'X\nY' })], now);
    expect(md).toContain('A\\|B');
    expect(md).not.toContain('X\nY');
  });

  it('进度与评分按人类可读格式输出', () => {
    const md = buildBookListMarkdown([book({ progress: 0.42, rating: 4 })], now);
    expect(md).toContain('42%');
    expect(md).toContain('4/5');
  });

  it('未评分与未填作者有占位符', () => {
    const md = buildBookListMarkdown([book({ author: undefined, rating: 0 })], now);
    expect(md).toContain('未知');
    expect(md).toContain('—');
  });

  it('包含导出时间与总数', () => {
    const md = buildBookListMarkdown([book()], now);
    expect(md).toContain('共 1 本');
    expect(md).toContain('导出时间');
  });
});

describe('buildBookBackup', () => {
  const now = new Date(2026, 8, 10);

  it('打包书籍信息与三类阅读痕迹', () => {
    const bk = buildBookBackup(
      book({ progress: 0.5, rating: 5, status: 'reading' }),
      [{ position: 'cfi-1' }],
      [{ position: 'p1', note: '笔记' }],
      [{ position: 'cfi-9' }],
      now,
    );
    expect(bk.version).toBe(1);
    expect(bk.book.title).toBe('三体');
    expect(bk.book.rating).toBe(5);
    expect(bk.bookmarks).toHaveLength(1);
    expect(bk.notes).toHaveLength(1);
    expect(bk.positions).toHaveLength(1);
  });

  it('不含书籍文件路径（备份的是阅读痕迹，不是文件本身）', () => {
    const bk = buildBookBackup(book({} as any), [], [], [], now);
    expect(JSON.stringify(bk)).not.toContain('file_path');
  });
});

describe('backupFileName', () => {
  const now = new Date(2026, 8, 10);

  it('含书名与日期', () => {
    expect(backupFileName('三体', now)).toBe('三体-备份-2026-09-10.json');
  });

  it('替换文件系统非法字符', () => {
    const name = backupFileName('A/B:C*D?E"F<G>H|I', now);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith('.json')).toBe(true);
  });

  it('过长书名被截断', () => {
    const name = backupFileName('x'.repeat(200), now);
    expect(name.length).toBeLessThan(90);
  });

  it('空书名有兜底名', () => {
    expect(backupFileName('', now)).toContain('book');
  });
});
