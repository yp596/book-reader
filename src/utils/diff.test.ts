import { describe, it, expect } from 'vitest';
import { diffLines, diffStats } from './diff';

describe('diffLines', () => {
  it('完全相同的文本全部标记为未变', () => {
    const lines = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(lines.every(l => l.op === 'equal')).toBe(true);
    expect(lines.map(l => l.left)).toEqual([0, 1, 2]);
    expect(lines.map(l => l.right)).toEqual([0, 1, 2]);
  });

  it('末尾追加', () => {
    const lines = diffLines(['a', 'b'], ['a', 'b', 'c']);
    expect(lines.map(l => l.op)).toEqual(['equal', 'equal', 'add']);
    expect(lines[2]).toMatchObject({ op: 'add', left: null, right: 2, text: 'c' });
  });

  it('中间删除', () => {
    const lines = diffLines(['a', 'b', 'c'], ['a', 'c']);
    expect(lines.map(l => l.op)).toEqual(['equal', 'del', 'equal']);
    expect(lines[1]).toMatchObject({ op: 'del', left: 1, right: null, text: 'b' });
  });

  it('一行被改写：先删后增', () => {
    const lines = diffLines(['a', '旧', 'c'], ['a', '新', 'c']);
    expect(lines.map(l => l.op)).toEqual(['equal', 'del', 'add', 'equal']);
    expect(lines[1].text).toBe('旧');
    expect(lines[2].text).toBe('新');
  });

  it('左右行号各自独立计数', () => {
    const lines = diffLines(['a', 'b', 'c'], ['a', 'c']);
    const eq = lines.filter(l => l.op === 'equal');
    // 删除一行后，第三行的左右行号应当不同
    expect(eq[1]).toMatchObject({ left: 2, right: 1 });
  });

  it('空文档：一边为空时全为新增或删除', () => {
    expect(diffLines([], ['x', 'y']).map(l => l.op)).toEqual(['add', 'add']);
    expect(diffLines(['x', 'y'], []).map(l => l.op)).toEqual(['del', 'del']);
    expect(diffLines([], [])).toEqual([]);
  });

  it('公共前后缀被剪掉后仍能正确对齐中间段', () => {
    const a = ['头', '甲', '乙', '尾'];
    const b = ['头', '乙', '尾'];
    const lines = diffLines(a, b);
    expect(lines.map(l => l.op)).toEqual(['equal', 'del', 'equal', 'equal']);
    expect(lines.map(l => l.text)).toEqual(['头', '甲', '乙', '尾']);
  });

  it('规模超限时退化为整段替换，且不丢行', () => {
    // 1500 × 1500 = 2.25M 单元格，超过 1M 上限
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`);
    const lines = diffLines(a, b);
    expect(lines.filter(l => l.op === 'del')).toHaveLength(1500);
    expect(lines.filter(l => l.op === 'add')).toHaveLength(1500);
    // 每行左右行号必须能还原回来
    expect(lines.filter(l => l.op === 'del').map(l => l.left)).toEqual(a.map((_, i) => i));
    expect(lines.filter(l => l.op === 'add').map(l => l.right)).toEqual(b.map((_, i) => i));
  });
});

describe('diffStats', () => {
  it('分别统计新增、删除与未变', () => {
    const stats = diffStats(diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']));
    expect(stats.unchanged).toBe(2);
    expect(stats.removed).toBe(1);
    expect(stats.added).toBe(2);
  });
});
