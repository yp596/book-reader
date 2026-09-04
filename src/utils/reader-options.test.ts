import { describe, it, expect } from 'vitest';
import { FONT_OPTIONS, fontStackOf, HIGHLIGHT_COLORS, highlightColorOf } from './reader-options';

describe('FONT_OPTIONS', () => {
  it('system 为空栈（继承默认）', () => {
    expect(fontStackOf('system')).toBe('');
  });

  it('未知 key 回退空串', () => {
    expect(fontStackOf('nope')).toBe('');
  });

  it('每个选项都有中文名和字栈', () => {
    for (const f of FONT_OPTIONS) {
      expect(f.label.length).toBeGreaterThan(0);
    }
    expect(fontStackOf('serif')).toContain('SimSun');
  });
});

describe('HIGHLIGHT_COLORS', () => {
  it('四色齐全，含 TXT 与 EPUB 两套值', () => {
    expect(HIGHLIGHT_COLORS.map(c => c.key)).toEqual(['yellow', 'green', 'blue', 'red']);
    for (const c of HIGHLIGHT_COLORS) {
      expect(c.css).toMatch(/^rgba\(/);
      expect(c.epubFill).toMatch(/^#/);
    }
  });

  it('未知 key 回退黄色', () => {
    expect(highlightColorOf('nope').key).toBe('yellow');
  });
});
