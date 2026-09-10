import { describe, it, expect } from 'vitest';
import { isDaytime, resolveThemeByClock, DEFAULT_AUTO_THEME, type AutoThemeConfig } from './auto-theme';

describe('isDaytime · 常规区间', () => {
  it('区间内为日间', () => {
    expect(isDaytime(7, 7, 19)).toBe(true);
    expect(isDaytime(12, 7, 19)).toBe(true);
    expect(isDaytime(18, 7, 19)).toBe(true);
  });

  it('区间外为夜间', () => {
    expect(isDaytime(19, 7, 19)).toBe(false);
    expect(isDaytime(23, 7, 19)).toBe(false);
    expect(isDaytime(3, 7, 19)).toBe(false);
    expect(isDaytime(6, 7, 19)).toBe(false);
  });
});

describe('isDaytime · 跨午夜作息', () => {
  it('夜行配置：日晚 20 点起，早 6 点止', () => {
    expect(isDaytime(20, 20, 6)).toBe(true);
    expect(isDaytime(23, 20, 6)).toBe(true);
    expect(isDaytime(2, 20, 6)).toBe(true);
    expect(isDaytime(5, 20, 6)).toBe(true);
    expect(isDaytime(6, 20, 6)).toBe(false);
    expect(isDaytime(12, 20, 6)).toBe(false);
  });
});

describe('isDaytime · 边界与异常输入', () => {
  it('起止相同视为全天日间（避免空区间）', () => {
    expect(isDaytime(0, 8, 8)).toBe(true);
    expect(isDaytime(15, 8, 8)).toBe(true);
  });

  it('越界小时规范化为 [0,24)', () => {
    expect(isDaytime(25, 7, 19)).toBe(isDaytime(1, 7, 19));
    expect(isDaytime(-1, 7, 19)).toBe(isDaytime(23, 7, 19));
  });

  it('小数小时向下取整', () => {
    expect(isDaytime(6.9, 7, 19)).toBe(false);
    expect(isDaytime(7.1, 7, 19)).toBe(true);
  });
});

describe('resolveThemeByClock', () => {
  const cfg: AutoThemeConfig = { ...DEFAULT_AUTO_THEME, enabled: true };

  it('日间返回日间主题', () => {
    expect(resolveThemeByClock(new Date(2026, 8, 10, 10, 0), cfg)).toBe('light');
  });

  it('夜间返回夜间主题', () => {
    expect(resolveThemeByClock(new Date(2026, 8, 10, 22, 0), cfg)).toBe('dark');
    expect(resolveThemeByClock(new Date(2026, 8, 10, 3, 0), cfg)).toBe('dark');
  });

  it('自定义日间主题生效', () => {
    const custom: AutoThemeConfig = { ...cfg, dayTheme: 'sepia' };
    expect(resolveThemeByClock(new Date(2026, 8, 10, 10, 0), custom)).toBe('sepia');
  });
});

describe('DEFAULT_AUTO_THEME', () => {
  it('默认关闭，避免影响既有用户', () => {
    expect(DEFAULT_AUTO_THEME.enabled).toBe(false);
  });
});
