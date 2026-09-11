import { describe, it, expect } from 'vitest';
import {
  buildBookListMarkdown,
  buildBookBackup,
  buildPlainText,
  parseBookBackup,
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

describe('parseBookBackup', () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it('导出结果能被原样解析回来（导出→恢复闭环）', () => {
    const backup = buildBookBackup(
      book({ progress: 0.4, rating: 4, favorite: 1, category: '科幻', status: 'reading' }),
      [{ position: 'epubcfi(/6/4)', text: '摘录', color: 'yellow', style: 'highlight' }],
      [{ position: 'epubcfi(/6/6)', note: '想法', tags: '待整理' }],
      [{ position: 'epubcfi(/6/8)', label: '断点', progress: 0.4, source: 'manual' }],
      now,
    );
    const parsed = parseBookBackup(JSON.stringify(backup));
    expect(parsed.book.title).toBe('三体');
    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.positions).toHaveLength(1);
  });

  it('不是 JSON 时报错而不是静默返回空备份', () => {
    expect(() => parseBookBackup('这不是 json')).toThrow(/JSON/);
  });

  it('版本不认识时拒绝，避免旧格式写脏新库', () => {
    expect(() => parseBookBackup(JSON.stringify({ version: 99, book: { title: 'x' } }))).toThrow(/版本/);
  });

  it('缺少书名时拒绝：没有书名无从匹配要恢复哪本书', () => {
    expect(() => parseBookBackup(JSON.stringify({ version: 1, book: {} }))).toThrow(/书籍信息/);
  });

  it('三个列表字段缺失或不是数组时归一化为空数组', () => {
    const parsed = parseBookBackup(
      JSON.stringify({ version: 1, book: { title: '三体' }, bookmarks: null, notes: 'oops' }),
    );
    expect(parsed.bookmarks).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.positions).toEqual([]);
  });
});

describe('buildPlainText', () => {
  const sec = (label: string, text: string) => ({ label, text });

  it('章节名单独成行，章节之间空行分隔', () => {
    const out = buildPlainText([sec('第一章', '正文甲'), sec('第二章', '正文乙')]);
    expect(out).toBe('第一章\n\n正文甲\n\n\n第二章\n\n正文乙\n');
  });

  it('withHeadings=false 时不插章节名（PDF 按页切，页标题会把正文割碎）', () => {
    const out = buildPlainText([sec('第 1 页', '甲'), sec('第 2 页', '乙')], false);
    expect(out).toBe('甲\n\n\n乙\n');
  });

  it('无标题的章节只留正文，不产生空行开头的碎块', () => {
    expect(buildPlainText([sec('', '裸正文')])).toBe('裸正文\n');
  });

  it('正文为空的章节被跳过', () => {
    expect(buildPlainText([sec('空章', '   '), sec('实章', '有内容')])).toBe('实章\n\n有内容\n');
  });

  it('全空返回空串，交给调用方报错而不是写一个空文件', () => {
    expect(buildPlainText([])).toBe('');
    expect(buildPlainText([sec('', '')])).toBe('');
  });

  it('结尾有换行，避免部分编辑器显示最后一行挤在一起', () => {
    expect(buildPlainText([sec('', 'x')]).endsWith('\n')).toBe(true);
  });
});
