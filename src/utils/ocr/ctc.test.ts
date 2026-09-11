import { describe, it, expect } from 'vitest';
import { ctcGreedyDecode } from './ctc';

/** 造一个 [T, C] 的 one-hot 概率，方便构造用例 */
function oneHot(steps: number[], classes: number): Float32Array {
  const probs = new Float32Array(steps.length * classes);
  steps.forEach((cls, t) => {
    for (let c = 0; c < classes; c++) probs[t * classes + c] = 0.01;
    probs[t * classes + cls] = 0.9;
  });
  return probs;
}

const DICT = ['a', 'b', 'c'];

describe('ctcGreedyDecode', () => {
  it('逐帧解码成文本（下标 0 是空白符，字典从下标 1 开始）', () => {
    // 1=a, 2=b, 3=c
    const probs = oneHot([1, 2, 3], 4);
    expect(ctcGreedyDecode(probs, 3, 4, DICT).text).toBe('abc');
  });

  it('跳过空白符', () => {
    const probs = oneHot([0, 1, 0, 2, 0], 4);
    expect(ctcGreedyDecode(probs, 5, 4, DICT).text).toBe('ab');
  });

  it('相邻重复只保留一个', () => {
    const probs = oneHot([1, 1, 1], 4);
    expect(ctcGreedyDecode(probs, 3, 4, DICT).text).toBe('a');
  });

  it('重复字符之间夹空白则视为两个字符', () => {
    const probs = oneHot([1, 0, 1], 4);
    expect(ctcGreedyDecode(probs, 3, 4, DICT).text).toBe('aa');
  });

  it('置信度只统计真正产出字符的帧', () => {
    const probs = oneHot([1, 2], 4);
    const result = ctcGreedyDecode(probs, 2, 4, DICT);
    expect(result.score).toBeCloseTo(0.9, 5);
  });

  it('全是空白时返回空串且置信度为 0', () => {
    const probs = oneHot([0, 0], 4);
    const result = ctcGreedyDecode(probs, 2, 4, DICT);
    expect(result.text).toBe('');
    expect(result.score).toBe(0);
  });

  it('字典缺项时按空串跳过，不抛错', () => {
    const probs = oneHot([1, 3], 4); // 下标 3 → 字典第 2 项不存在
    expect(() => ctcGreedyDecode(probs, 2, 4, ['a'])).not.toThrow();
    expect(ctcGreedyDecode(probs, 2, 4, ['a']).text).toBe('a');
  });
});
