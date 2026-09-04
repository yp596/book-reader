import { describe, it, expect } from 'vitest';
import { buildWeekSeries } from './stats';

describe('buildWeekSeries', () => {
  const today = new Date(2026, 8, 4); // 2026-09-04（周五）

  it('补齐 7 天，今天在末位', () => {
    const series = buildWeekSeries([], today);
    expect(series).toHaveLength(7);
    expect(series[6].fullDate).toBe('2026-09-04');
    expect(series[6].isToday).toBe(true);
    expect(series[0].fullDate).toBe('2026-08-29');
  });

  it('缺失日期补 0，已有按秒转分钟', () => {
    const series = buildWeekSeries(
      [{ date: '2026-09-04', duration: 3600 }],
      today,
    );
    expect(series[6].minutes).toBe(60);
    expect(series[5].minutes).toBe(0);
  });

  it('跨月日期正确', () => {
    const series = buildWeekSeries([], today);
    expect(series[0].date).toBe('08-29');
    expect(series[3].date).toBe('09-01');
  });
});
