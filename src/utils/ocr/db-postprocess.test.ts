import { describe, it, expect } from 'vitest';
import { boxesFromProbabilityMap, sortBoxes, type TextBox } from './db-postprocess';

/** 造一张概率图，并把指定矩形区域涂成高置信度 */
function makeMap(w: number, h: number, blobs: { x0: number; y0: number; x1: number; y1: number; v: number }[]) {
  const prob = new Float32Array(w * h);
  for (const b of blobs) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) prob[y * w + x] = b.v;
    }
  }
  return prob;
}

describe('boxesFromProbabilityMap', () => {
  it('全背景返回空', () => {
    expect(boxesFromProbabilityMap(new Float32Array(20 * 20), 20, 20)).toEqual([]);
  });

  it('一个文字块提取成一个框，并带外扩', () => {
    const prob = makeMap(40, 40, [{ x0: 10, y0: 10, x1: 29, y1: 19, v: 0.9 }]);
    const boxes = boxesFromProbabilityMap(prob, 40, 40);
    expect(boxes).toHaveLength(1);
    const b = boxes[0];
    // 原始块是 20×10，短边 10，按 0.4 外扩 → 左右各 4、上下各 4
    expect(b.x0).toBe(6);
    expect(b.x1).toBe(33);
    expect(b.y0).toBe(6);
    expect(b.y1).toBe(23);
    expect(b.score).toBeCloseTo(0.9, 5);
  });

  it('外扩不会超出图边界', () => {
    const prob = makeMap(20, 20, [{ x0: 0, y0: 0, x1: 9, y1: 5, v: 0.9 }]);
    const b = boxesFromProbabilityMap(prob, 20, 20)[0];
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
  });

  it('低于阈值的区域不算文字', () => {
    const prob = makeMap(20, 20, [{ x0: 2, y0: 2, x1: 10, y1: 10, v: 0.2 }]);
    expect(boxesFromProbabilityMap(prob, 20, 20)).toEqual([]);
  });

  it('噪点被最小面积滤掉', () => {
    const prob = makeMap(40, 40, [
      { x0: 5, y0: 5, x1: 25, y1: 15, v: 0.9 }, // 正常文字块
      { x0: 35, y0: 35, x1: 35, y1: 35, v: 0.9 }, // 1 像素噪点
    ]);
    expect(boxesFromProbabilityMap(prob, 40, 40)).toHaveLength(1);
  });

  it('斜向相连的笔画算同一块（8 邻域）', () => {
    const prob = new Float32Array(10 * 10);
    prob[3 * 10 + 3] = 0.9;
    prob[4 * 10 + 4] = 0.9; // 仅对角相邻
    const boxes = boxesFromProbabilityMap(prob, 10, 10, { minArea: 1, minSide: 1 });
    expect(boxes).toHaveLength(1);
  });

  it('概率图长度不足时返回空而不是越界', () => {
    expect(boxesFromProbabilityMap(new Float32Array(10), 20, 20)).toEqual([]);
  });
});

describe('sortBoxes', () => {
  const box = (x0: number, y0: number, x1: number, y1: number): TextBox => ({ x0, y0, x1, y1, score: 1 });

  it('先按行自上而下，行内自左向右', () => {
    const boxes = [
      box(100, 50, 140, 64), // 第二行右
      box(10, 10, 50, 24),   // 第一行左
      box(60, 12, 90, 26),   // 第一行右
      box(10, 52, 60, 66),   // 第二行左
    ];
    expect(sortBoxes(boxes).map(b => b.x0)).toEqual([10, 60, 10, 100]);
  });

  it('纵向重叠过半才归为同一行', () => {
    const a = box(0, 0, 40, 20);
    const b = box(50, 16, 90, 36); // 与 a 重叠 4px（行高 20 的一半是 10）→ 应分到下一行
    expect(sortBoxes([b, a])).toEqual([a, b]);
  });

  it('空数组与单元素原样返回', () => {
    expect(sortBoxes([])).toEqual([]);
    const one = box(1, 1, 2, 2);
    expect(sortBoxes([one])).toEqual([one]);
  });
});
