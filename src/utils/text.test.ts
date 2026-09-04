import { describe, it, expect } from 'vitest';
import { escapeHtml, excerptAround, formatMinutes } from './text';

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
