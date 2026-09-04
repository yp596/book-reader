import { describe, it, expect } from 'vitest';
import { splitText, cosine } from './rag';

describe('splitText', () => {
  const sec = { label: '第一章', target: '{}', text: '' };

  it('短文本不切分', () => {
    const out = splitText({ ...sec, text: '短文本' });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('短文本');
  });

  it('长文本按尺寸切分并重叠', () => {
    const out = splitText({ ...sec, text: 'x'.repeat(1200) }, 500, 100);
    expect(out.length).toBeGreaterThanOrEqual(3);
    // 重叠：第二块开头 == 第一块第400字起
    expect(out[1].text.slice(0, 100)).toBe(out[0].text.slice(400));
  });

  it('空白压缩', () => {
    const out = splitText({ ...sec, text: 'a\n\n  b\tc' });
    expect(out[0].text).toBe('a b c');
  });

  it('空文本返回空数组', () => {
    expect(splitText({ ...sec, text: '   ' })).toEqual([]);
  });
});

describe('cosine', () => {
  it('相同向量为 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('正交向量为 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('零向量为 0（不 NaN）', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });

  it('反向为 -1', () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
});
