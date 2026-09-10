/**
 * 快捷键预设：三套方案一键切换。
 * 每套都包含「翻页/首末页」基础键——预设只改变侧重，
 * 不能出现"切过去之后翻不了页"这种残缺键位。
 */

export type ShortcutAction =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'toggleTheme'
  | 'fontUp'
  | 'fontDown'
  | 'openToc'
  | 'openSearch'
  | 'openNotes'
  | 'openPositions'
  | 'highlight'
  | 'addNote'
  | 'toggleDualColumn'
  | 'toggleFullscreen';

export interface ShortcutPreset {
  key: string;
  name: string;
  desc: string;
  /** 归一化按键 → 动作 */
  map: Record<string, ShortcutAction>;
}

/** 所有预设都保留的基础键位 */
const BASE_MAP: Record<string, ShortcutAction> = {
  ArrowRight: 'next',
  ArrowLeft: 'prev',
  PageDown: 'next',
  PageUp: 'prev',
  ' ': 'next',
  Home: 'first',
  End: 'last',
  F11: 'toggleFullscreen',
};

export const SHORTCUT_PRESETS: ShortcutPreset[] = [
  {
    key: 'reading',
    name: '阅读模式',
    desc: '方向键翻页、首末页跳转，最简键位',
    map: { ...BASE_MAP },
  },
  {
    key: 'annotate',
    name: '批注模式',
    desc: '保留翻页，字母键做标记与检索',
    map: {
      ...BASE_MAP,
      h: 'highlight',
      n: 'addNote',
      b: 'openNotes',
      '/': 'openSearch',
      t: 'openToc',
      p: 'openPositions',
    },
  },
  {
    key: 'layout',
    name: '排版模式',
    desc: '保留翻页，专注字号/主题/版式调节',
    map: {
      ...BASE_MAP,
      '+': 'fontUp',
      '=': 'fontUp',
      '-': 'fontDown',
      t: 'toggleTheme',
      d: 'toggleDualColumn',
    },
  },
];

export const DEFAULT_SHORTCUT_PRESET = 'reading';

export function getPreset(key: string): ShortcutPreset {
  return SHORTCUT_PRESETS.find(p => p.key === key) ?? SHORTCUT_PRESETS[0];
}

/** 键盘事件的可归一化子集（便于单测，无需真实 KeyboardEvent） */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * 归一化为预设表里的键名。
 * 单字符统一小写（Shift 已体现在字符本身，不再额外加前缀）；
 * Ctrl/Alt 作为前缀保留，避免与单键冲突。
 */
export function normalizeKey(e: KeyLike): string {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  parts.push(k);
  return parts.join('+');
}

/** 解析按键对应的动作；未命中返回 null */
export function resolveAction(preset: ShortcutPreset, e: KeyLike): ShortcutAction | null {
  return preset.map[normalizeKey(e)] ?? null;
}
