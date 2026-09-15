import { describe, it, expect } from 'vitest';
import { layoutEgoGraph, EGO_MAX_PER_SIDE } from './BookDetail';

/**
 * 本地图谱的排布是纯函数，值得单独测：
 * 图好不好看没法在测试里判断，但「节点跑到画布外」「角度全挤在一侧」「超过上限还全画出来」
 * 这类问题能锁住。
 */
describe('本地图谱节点排布', () => {
  const book = (id: number, title = `书${id}`) => ({ id, title });

  it('没有引用关系时不产出节点', () => {
    expect(layoutEgoGraph([], [])).toEqual([]);
  });

  it('一侧只有一个时落在该侧正中间', () => {
    const [out] = layoutEgoGraph([book(1)], []);
    expect(out.x).toBeCloseTo(270, 1);
    expect(out.y).toBeCloseTo(100, 1);
    expect(out.side).toBe('out');

    const [, inc] = [null, layoutEgoGraph([], [book(2)])[0]];
    expect(inc.x).toBeCloseTo(130, 1);
    expect(inc.y).toBeCloseTo(100, 1);
    expect(inc.side).toBe('in');
  });

  it('引用的在右弧、被引用的在左弧，且按输入顺序均分扇面', () => {
    const nodes = layoutEgoGraph([book(1), book(2), book(3)], [book(4)]);
    const out = nodes.filter(n => n.side === 'out');
    const inc = nodes.filter(n => n.side === 'in');

    expect(out.map(n => n.id)).toEqual([1, 2, 3]);
    // 三节点均分 ±30°：上、中、下
    expect(out[0].y).toBeLessThan(100);
    expect(out[1].y).toBeCloseTo(100, 1);
    expect(out[2].y).toBeGreaterThan(100);
    // 左右不混
    expect(out.every(n => n.x > 200)).toBe(true);
    expect(inc.every(n => n.x < 200)).toBe(true);
  });

  it('超过每侧上限时只取前几个（多出来的由界面另外交代）', () => {
    const many = Array.from({ length: 10 }, (_, i) => book(i + 1));
    const nodes = layoutEgoGraph(many, many);
    expect(nodes.filter(n => n.side === 'out')).toHaveLength(EGO_MAX_PER_SIDE);
    expect(nodes.filter(n => n.side === 'in')).toHaveLength(EGO_MAX_PER_SIDE);
  });

  it('所有节点都落在画布内且没有 NaN（固定 400x200 视框）', () => {
    const many = Array.from({ length: 6 }, (_, i) => book(i + 1));
    for (const n of layoutEgoGraph(many, many)) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(400);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(200);
    }
  });

  it('同一份数据画出的图完全一致（不依赖随机与容器尺寸）', () => {
    const a = layoutEgoGraph([book(1), book(2)], [book(3)]);
    const b = layoutEgoGraph([book(1), book(2)], [book(3)]);
    expect(a).toEqual(b);
  });

  it('标签沿半径朝外摆，不会压在连线上、也不会贴到中心', () => {
    const nodes = layoutEgoGraph([book(1), book(2), book(3)], [book(4), book(5)]);
    const cx = 200;
    const cy = 100;
    const dist = (x: number, y: number) => Math.hypot(x - cx, y - cy);

    for (const n of nodes) {
      // 标签比节点离中心更远——放在两者之间就会压住那根连线
      expect(dist(n.labelX, n.labelY)).toBeGreaterThan(dist(n.x, n.y));
      if (n.side === 'out') {
        expect(n.labelX).toBeGreaterThan(n.x);
      } else {
        expect(n.labelX).toBeLessThan(n.x);
      }
    }
  });

  it('标签对齐方式跟着所在侧走，避免文字反向压到节点上', () => {
    const nodes = layoutEgoGraph([book(1), book(2), book(3)], [book(4)]);
    for (const n of nodes) {
      if (n.side === 'out') expect(n.labelAnchor).toBe('start');
      else expect(n.labelAnchor).toBe('end');
    }
    // 只有正好在中心正上/正下（cos 接近 0）时才居中——左右两侧的节点角度在 ±45° 内，不该出现
    expect(nodes.every(n => n.labelAnchor !== 'middle')).toBe(true);
  });

  it('标签也落在画布内（长标题已由界面截断，这里只管坐标）', () => {
    const many = Array.from({ length: 6 }, (_, i) => book(i + 1));
    for (const n of layoutEgoGraph(many, many)) {
      expect(n.labelX).toBeGreaterThan(0);
      expect(n.labelX).toBeLessThan(400);
      expect(n.labelY).toBeGreaterThan(0);
      expect(n.labelY).toBeLessThan(200);
    }
  });
});
