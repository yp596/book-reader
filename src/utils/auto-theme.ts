/**
 * 自动护眼：按本机时钟在日间/夜间主题间自动切换。
 * 纯本地判定，无联网授时、无外部依赖。
 */

import type { ThemeName } from './reader-options';

export type { ThemeName };

export interface AutoThemeConfig {
  enabled: boolean;
  /** 日间开始时刻（0-23 整点） */
  dayStart: number;
  /** 夜间开始时刻（0-23 整点） */
  nightStart: number;
  /** 日间使用的主题 */
  dayTheme: ThemeName;
  /** 夜间使用的主题 */
  nightTheme: ThemeName;
}

export const DEFAULT_AUTO_THEME: AutoThemeConfig = {
  enabled: false,
  dayStart: 7,
  nightStart: 19,
  dayTheme: 'light',
  nightTheme: 'dark',
};

/** 规范化到 [0,24) 的整点 */
const normHour = (h: number) => (((Math.floor(h) % 24) + 24) % 24);

/**
 * 判断给定小时是否处于日间时段。
 * 支持跨午夜配置（如 dayStart=20, nightStart=6 表示夜行作息）。
 */
export function isDaytime(hour: number, dayStart: number, nightStart: number): boolean {
  const h = normHour(hour);
  const d = normHour(dayStart);
  const n = normHour(nightStart);
  // 起止相同：视为全天日间，避免区间为空
  if (d === n) return true;
  if (d < n) return h >= d && h < n;
  // 跨午夜：日间为 [d, 24) ∪ [0, n)
  return h >= d || h < n;
}

/** 按当前本地时间解析应使用的主题 */
export function resolveThemeByClock(now: Date, cfg: AutoThemeConfig): ThemeName {
  return isDaytime(now.getHours(), cfg.dayStart, cfg.nightStart) ? cfg.dayTheme : cfg.nightTheme;
}
