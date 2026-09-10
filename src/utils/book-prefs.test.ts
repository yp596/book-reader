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
    };
    expect(parseBookPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  it('漫画开关须为布尔值，非布尔一律丢弃', () => {
    expect(parseBookPrefs(JSON.stringify({ comicSpread: 'yes', comicRtl: 1 }))).toEqual({});
    expect(parseBookPrefs(JSON.stringify({ comicSpread: false, comicRtl: true }))).toEqual({
      comicSpread: false,
      comicRtl: true,
    });
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
