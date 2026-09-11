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

/** 动作的中文名：设置页与帮助中心共用，避免两处各写一份而漂移 */
export const ACTION_LABELS: Record<ShortcutAction, string> = {
  next: '下一页', prev: '上一页', first: '跳到首页', last: '跳到末页',
  toggleTheme: '切换主题', fontUp: '放大字号', fontDown: '缩小字号',
  openToc: '打开目录', openSearch: '书内检索', openNotes: '我的笔记', openPositions: '阅读位置',
  highlight: '高亮选中文字', addNote: '为选中文字写笔记',
  toggleDualColumn: '单双栏切换', toggleFullscreen: '全屏切换',
};

/** 按键的展示名（空格、方向键等符号化） */
const KEY_LABELS: Record<string, string> = {
  ' ': '空格', ArrowRight: '→', ArrowLeft: '←', PageDown: 'PgDn', PageUp: 'PgUp',
};

export const keyLabel = (k: string) => KEY_LABELS[k] ?? (k.length === 1 ? k.toUpperCase() : k);

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

// ---------- 自定义键位 ----------

/**
 * 动作 → 归一化按键，只存动过的动作。
 * 值为空串表示「显式不绑定」——被别的动作抢走键之后就是这个状态，
 * 否则那条动作会显示成预设里已经不生效的旧键。
 */
export type ShortcutOverrides = Partial<Record<ShortcutAction, string>>;

const ALL_ACTIONS = Object.keys(ACTION_LABELS) as ShortcutAction[];

/**
 * 把自定义键位叠到预设上。
 * 动过的动作会先让出它在预设里的全部旧键，再挂上自定义键——
 * 不这样做会出现「旧键还生效」，看着像改了没生效。
 */
export function buildKeyMap(
  preset: ShortcutPreset,
  overrides: ShortcutOverrides = {},
): Record<string, ShortcutAction> {
  const touched = new Set(Object.keys(overrides) as ShortcutAction[]);
  const map: Record<string, ShortcutAction> = {};
  for (const [key, action] of Object.entries(preset.map)) {
    if (!touched.has(action)) map[key] = action;
  }
  for (const action of touched) {
    const key = overrides[action];
    if (key) map[key] = action;
  }
  return map;
}

/** 该键当前被哪个动作占用（排除自己）；没冲突返回 null */
export function findKeyConflict(
  map: Record<string, ShortcutAction>,
  key: string,
  self: ShortcutAction,
): ShortcutAction | null {
  const owner = map[key];
  return owner && owner !== self ? owner : null;
}

/** 解析存下来的自定义键位；坏数据一律丢弃，不让脏值把键位搞乱 */
export function parseShortcutOverrides(raw: string | null | undefined): ShortcutOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: ShortcutOverrides = {};
  for (const [action, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (ALL_ACTIONS.includes(action as ShortcutAction) && typeof key === 'string') {
      out[action as ShortcutAction] = key;
    }
  }
  return out;
}

/** 某个动作当前生效的键：自定义优先，其次预设里的第一个；没有则 null */
export function keyForAction(
  preset: ShortcutPreset,
  overrides: ShortcutOverrides,
  action: ShortcutAction,
): string | null {
  const custom = overrides[action];
  if (custom !== undefined) return custom || null;
  const hit = Object.entries(preset.map).find(([, a]) => a === action);
  return hit ? hit[0] : null;
}
