import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  excerptAround,
  formatMinutes,
  formatFileSize,
  clampPage,
  lineToPageIndex,
  serializeSavedPosition,
  parseSavedPosition,
} from './text';

describe('escapeHtml', () => {
  it('转义尖括号和 &', () => {
    expect(escapeHtml('<mark>a&b</mark>')).toBe('&lt;mark&gt;a&amp;b&lt;/mark&gt;');
  });

  it('普通文本原样返回', () => {
    expect(escapeHtml('三体第一章')).toBe('三体第一章');
  });
});

describe('excerptAround', () => {
  it('截取关键词前后各 40 字', () => {
    const text = '前言' + 'x'.repeat(100) + '关键词' + 'y'.repeat(100);
    const result = excerptAround(text, '关键词');
    expect(result).toContain('关键词');
    expect(result.length).toBeLessThanOrEqual(40 + 3 + 40 + 10);
  });

  it('找不到返回空串', () => {
    expect(excerptAround('hello world', '不存在')).toBe('');
  });

  it('大小写不敏感', () => {
    expect(excerptAround('Hello World', 'hello')).toContain('Hello');
  });
});

describe('formatMinutes', () => {
  it('不足一小时显示分钟', () => {
    expect(formatMinutes(30 * 60)).toBe('30 分钟');
  });

  it('超一小时显示小时+分钟', () => {
    expect(formatMinutes(90 * 60)).toBe('1 小时 30 分');
  });

  it('零秒显示 0 分钟', () => {
    expect(formatMinutes(0)).toBe('0 分钟');
  });
});

describe('formatFileSize', () => {
  it('B / KB / MB 进制正确', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('GB 保留两位小数', () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });
});

describe('clampPage', () => {
  it('范围内原样返回', () => {
    expect(clampPage(3, 10)).toBe(3);
  });

  it('越界钳制到两端', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
  });

  it('非法输入回退第 1 页', () => {
    expect(clampPage(NaN, 10)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('lineToPageIndex', () => {
  const starts = [0, 10, 20, 30];

  it('行号落在页起始行上，取该页', () => {
    expect(lineToPageIndex(starts, 0)).toBe(0);
    expect(lineToPageIndex(starts, 10)).toBe(1);
    expect(lineToPageIndex(starts, 30)).toBe(3);
  });

  it('行号落在页中间，取所属页', () => {
    expect(lineToPageIndex(starts, 5)).toBe(0);
    expect(lineToPageIndex(starts, 19)).toBe(1);
    expect(lineToPageIndex(starts, 29)).toBe(2);
  });

  it('行号超出范围，钳到末页', () => {
    expect(lineToPageIndex(starts, 9999)).toBe(3);
  });

  it('行号为负，取首页', () => {
    expect(lineToPageIndex(starts, -1)).toBe(0);
  });

  it('空页表返回 0', () => {
    expect(lineToPageIndex([], 5)).toBe(0);
  });
});

describe('阅读位置序列化', () => {
  it('CFI 往返一致', () => {
    const pos = { cfi: 'epubcfi(/6/12!/4/2/2)' };
    expect(parseSavedPosition(serializeSavedPosition(pos))).toEqual(pos);
  });

  it('页码往返一致', () => {
    const pos = { page: 42 };
    expect(parseSavedPosition(serializeSavedPosition(pos))).toEqual(pos);
  });

  it('空值与坏数据返回 null', () => {
    expect(parseSavedPosition(null)).toBeNull();
    expect(parseSavedPosition('')).toBeNull();
    expect(parseSavedPosition('{ bad json')).toBeNull();
    expect(parseSavedPosition('{}')).toBeNull();
  });

  it('丢弃非法字段', () => {
    expect(parseSavedPosition(JSON.stringify({ cfi: '', page: -3 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ cfi: 123, page: 1.5 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ cfi: 'epubcfi(/6/4!)', page: -1 }))).toEqual({
      cfi: 'epubcfi(/6/4!)',
    });
  });
});
