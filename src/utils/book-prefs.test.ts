import { describe, it, expect } from 'vitest';
import {
  parseBookPrefs,
  mergePrefs,
  hasBookPrefs,
  bookPrefsKey,
  DEFAULT_READER_PREFS,
  type ReaderPrefs,
} from './book-prefs';

describe('parseBookPrefs', () => {
  it('完整对象原样解析', () => {
    const prefs: ReaderPrefs = {
      theme: 'sepia',
      fontSize: 22,
      lineHeight: 2,
      fontFamily: 'serif',
      dualColumn: true,
      flowMode: 'scrolled',
      pdfScale: 2,
      comicSpread: true,
      comicRtl: true,
      vertical: true,
      readingStyle: 'none',
      bgColor: '#1a1a2e',
      textColor: '#eaeaea',
      pagePadding: 72,
      paraSpacing: 1.2,
      pageGap: 40,
      hideMarks: true,
    };
    expect(parseBookPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  it('漫画开关须为布尔值，非布尔一律丢弃', () => {
    expect(parseBookPrefs(JSON.stringify({ comicSpread: 'yes', comicRtl: 1, vertical: 'on' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ comicSpread: false, comicRtl: true, vertical: true }))).toEqual({
      comicSpread: false,
      comicRtl: true,
      vertical: true,
    });
  });

  it('批注显隐开关须为布尔值，非布尔一律丢弃', () => {
    expect(parseBookPrefs(JSON.stringify({ hideMarks: 1 }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ hideMarks: true }))).toEqual({ hideMarks: true });
    expect(parseBookPrefs(JSON.stringify({ hideMarks: false }))).toEqual({ hideMarks: false });
  });

  it('空值 / 坏 JSON 返回空对象', () => {
    expect(parseBookPrefs(null)).toEqual({});
    expect(parseBookPrefs('')).toEqual({});
    expect(parseBookPrefs('{ bad')).toEqual({});
    expect(parseBookPrefs('null')).toEqual({});
    expect(parseBookPrefs('123')).toEqual({});
  });

  it('丢弃非法枚举值', () => {
    expect(parseBookPrefs(JSON.stringify({ theme: 'neon', flowMode: 'zigzag' }))).toEqual({});
    // 阅读样式预设须在 reading-styles 的白名单内：脏值会让面板下拉出现空白项
    expect(parseBookPrefs(JSON.stringify({ readingStyle: 'neon' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ readingStyle: 'paper' }))).toEqual({ readingStyle: 'paper' });
  });

  it('丢弃越界数值', () => {
    expect(parseBookPrefs(JSON.stringify({ fontSize: 99, lineHeight: 0.1, pdfScale: 9 }))).toEqual({});
  });

  it('部分字段合法时只保留合法项', () => {
    const out = parseBookPrefs(JSON.stringify({ theme: 'light', fontSize: 999, dualColumn: true }));
    expect(out).toEqual({ theme: 'light', dualColumn: true });
  });

  it('空字符串字体名被丢弃', () => {
    expect(parseBookPrefs(JSON.stringify({ fontFamily: '' }))).toEqual({});
  });
});

describe('mergePrefs', () => {
  it('书籍偏好覆盖全局默认', () => {
    const merged = mergePrefs(DEFAULT_READER_PREFS, { theme: 'sepia', fontSize: 24 });
    expect(merged.theme).toBe('sepia');
    expect(merged.fontSize).toBe(24);
    expect(merged.fontFamily).toBe(DEFAULT_READER_PREFS.fontFamily);
  });

  it('空覆盖时等于全局默认', () => {
    expect(mergePrefs(DEFAULT_READER_PREFS, {})).toEqual(DEFAULT_READER_PREFS);
  });
});

describe('hasBookPrefs', () => {
  it('有有效字段为 true', () => {
    expect(hasBookPrefs(JSON.stringify({ theme: 'light' }))).toBe(true);
  });

  it('无有效字段为 false', () => {
    expect(hasBookPrefs(null)).toBe(false);
    expect(hasBookPrefs('{}')).toBe(false);
    expect(hasBookPrefs(JSON.stringify({ theme: 'neon' }))).toBe(false);
  });
});

describe('bookPrefsKey', () => {
  it('按书 id 隔离', () => {
    expect(bookPrefsKey(1)).toBe('bookPrefs:1');
    expect(bookPrefsKey(2)).not.toBe(bookPrefsKey(1));
  });
});

describe('排版自定义字段校验', () => {
  it('合法十六进制颜色保留（3 位与 6 位都接受）', () => {
    expect(parseBookPrefs(JSON.stringify({ bgColor: '#fff' }))).toEqual({ bgColor: '#fff' });
    expect(parseBookPrefs(JSON.stringify({ textColor: '#1A1A2E' }))).toEqual({ textColor: '#1A1A2E' });
  });

  it('非法颜色一律丢弃（脏值会把阅读区搞花，宁可回退主题）', () => {
    expect(parseBookPrefs(JSON.stringify({ bgColor: 'red' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ bgColor: 'rgb(1,2,3)' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ bgColor: '#12' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ bgColor: 'url(x)' }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ bgColor: '' }))).toEqual({});
  });

  it('页面边距钳制在 0-200', () => {
    expect(parseBookPrefs(JSON.stringify({ pagePadding: 80 }))).toEqual({ pagePadding: 80 });
    expect(parseBookPrefs(JSON.stringify({ pagePadding: -5 }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ pagePadding: 999 }))).toEqual({});
  });

  it('段落间距钳制在 0-3', () => {
    expect(parseBookPrefs(JSON.stringify({ paraSpacing: 0.8 }))).toEqual({ paraSpacing: 0.8 });
    expect(parseBookPrefs(JSON.stringify({ paraSpacing: 0 }))).toEqual({ paraSpacing: 0 });
    expect(parseBookPrefs(JSON.stringify({ paraSpacing: 9 }))).toEqual({});
  });

  it('页面间距钳制在 0-200，且 0 是合法值（等于只用默认留白）', () => {
    expect(parseBookPrefs(JSON.stringify({ pageGap: 60 }))).toEqual({ pageGap: 60 });
    expect(parseBookPrefs(JSON.stringify({ pageGap: 0 }))).toEqual({ pageGap: 0 });
    expect(parseBookPrefs(JSON.stringify({ pageGap: -1 }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ pageGap: 500 }))).toEqual({});
  });
});
