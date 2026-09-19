import { describe, it, expect } from 'vitest';
import {
  SHORTCUT_PRESETS,
  DEFAULT_SHORTCUT_PRESET,
  getPreset,
  normalizeKey,
  ACTION_LABELS,
  keyLabel,
  resolveAction,
  buildKeyMap,
  findKeyConflict,
  parseShortcutOverrides,
  keyForAction,
  toGlobalAccelerator,
  acceleratorLabel,
} from './shortcuts';

describe('normalizeKey', () => {
  it('单字符统一小写', () => {
    expect(normalizeKey({ key: 'H' })).toBe('h');
    expect(normalizeKey({ key: 'h' })).toBe('h');
  });

  it('特殊键保持原样', () => {
    expect(normalizeKey({ key: 'ArrowRight' })).toBe('ArrowRight');
    expect(normalizeKey({ key: 'F11' })).toBe('F11');
    expect(normalizeKey({ key: ' ' })).toBe(' ');
  });

  it('Ctrl/Alt 作为前缀，Mac 的 Cmd 也归为 Ctrl', () => {
    expect(normalizeKey({ key: 'f', ctrlKey: true })).toBe('Ctrl+f');
    expect(normalizeKey({ key: 'f', metaKey: true })).toBe('Ctrl+f');
    expect(normalizeKey({ key: 'f', altKey: true })).toBe('Alt+f');
    expect(normalizeKey({ key: 'f', ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+f');
  });

  it('Shift 不额外加前缀（已体现在字符本身）', () => {
    expect(normalizeKey({ key: '+' })).toBe('+');
  });
});

describe('预设完整性', () => {
  it('每套预设都保留翻页与首末页基础键', () => {
    for (const p of SHORTCUT_PRESETS) {
      expect(p.map.ArrowRight).toBe('next');
      expect(p.map.ArrowLeft).toBe('prev');
      expect(p.map.Home).toBe('first');
      expect(p.map.End).toBe('last');
    }
  });

  it('预设 key 唯一', () => {
    const keys = SHORTCUT_PRESETS.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('默认预设存在', () => {
    expect(SHORTCUT_PRESETS.some(p => p.key === DEFAULT_SHORTCUT_PRESET)).toBe(true);
  });

  it('三套方案各有侧重', () => {
    expect(getPreset('annotate').map.h).toBe('highlight');
    expect(getPreset('layout').map.d).toBe('toggleDualColumn');
    // 跨预设复用同一按键是允许的：预设互斥，同时只有一套生效。
    // 这里只校验每个预设自身没有"同键两义"（对象键天然唯一）。
    for (const p of SHORTCUT_PRESETS) {
      const keys = Object.keys(p.map);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('同一预设内不同按键不产生冲突绑定', () => {
    // 反向校验：同一动作可绑定多个键（如 + 与 =），但不应出现空动作名
    for (const p of SHORTCUT_PRESETS) {
      for (const [k, action] of Object.entries(p.map)) {
        expect(k.length).toBeGreaterThan(0);
        expect(typeof action).toBe('string');
        expect(action.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('getPreset', () => {
  it('按 key 取到对应预设', () => {
    expect(getPreset('annotate').name).toBe('批注模式');
  });

  it('未知 key 回退到首个预设（不崩）', () => {
    expect(getPreset('nope').key).toBe(SHORTCUT_PRESETS[0].key);
  });
});

describe('resolveAction', () => {
  const reading = getPreset('reading');
  const annotate = getPreset('annotate');

  it('阅读模式：方向键翻页', () => {
    expect(resolveAction(reading, { key: 'ArrowRight' })).toBe('next');
    expect(resolveAction(reading, { key: 'ArrowLeft' })).toBe('prev');
  });

  it('阅读模式不含批注键', () => {
    expect(resolveAction(reading, { key: 'h' })).toBeNull();
  });

  it('批注模式：h 触发高亮', () => {
    expect(resolveAction(annotate, { key: 'h' })).toBe('highlight');
    expect(resolveAction(annotate, { key: 'H' })).toBe('highlight');
  });

  it('批注模式仍可翻页', () => {
    expect(resolveAction(annotate, { key: 'ArrowRight' })).toBe('next');
  });

  it('带修饰键不误触', () => {
    expect(resolveAction(annotate, { key: 'h', ctrlKey: true })).toBeNull();
  });

  it('未绑定按键返回 null', () => {
    expect(resolveAction(reading, { key: 'z' })).toBeNull();
  });
});

describe('ACTION_LABELS / keyLabel', () => {
  it('每套预设里出现的动作都有中文名（否则界面会显示 undefined）', () => {
    for (const p of SHORTCUT_PRESETS) {
      for (const action of Object.values(p.map)) {
        expect(ACTION_LABELS[action]).toBeTruthy();
      }
    }
  });

  it('中文名非空且无重复遗漏项', () => {
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      expect(action.length).toBeGreaterThan(0);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('keyLabel 符号化常见按键', () => {
    expect(keyLabel(' ')).toBe('空格');
    expect(keyLabel('ArrowRight')).toBe('→');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('PageDown')).toBe('PgDn');
  });

  it('keyLabel 单字符转大写，其他原样', () => {
    expect(keyLabel('h')).toBe('H');
    expect(keyLabel('F11')).toBe('F11');
    expect(keyLabel('/')).toBe('/');
  });
});

describe('自定义键位', () => {
  it('自定义键生效，该动作在预设里的旧键让位', () => {
    const map = buildKeyMap(getPreset('reading'), { next: 'j' });
    expect(map['j']).toBe('next');
    // 一个动作在预设里可能绑了多个键（→ / PgDn / 空格），换键后都要让位
    expect(map['ArrowRight']).toBeUndefined();
    expect(map['PageDown']).toBeUndefined();
    expect(map[' ']).toBeUndefined();
    expect(map['ArrowLeft']).toBe('prev');
  });

  it('未被改动的动作不受影响', () => {
    const map = buildKeyMap(getPreset('annotate'), { highlight: 'm' });
    expect(map['m']).toBe('highlight');
    expect(map['h']).toBeUndefined();
    expect(map['n']).toBe('addNote');
    expect(map['ArrowRight']).toBe('next');
  });

  it('空串表示显式不绑定：预设里的旧键也不再生效', () => {
    const map = buildKeyMap(getPreset('reading'), { next: '' });
    expect(map['ArrowRight']).toBeUndefined();
    expect(map['PageDown']).toBeUndefined();
    expect(map['ArrowLeft']).toBe('prev');
  });

  it('冲突检测：挑出占用该键的动作，自己不算冲突', () => {
    const map = buildKeyMap(getPreset('reading'), {});
    expect(findKeyConflict(map, 'ArrowLeft', 'next')).toBe('prev');
    expect(findKeyConflict(map, 'ArrowLeft', 'prev')).toBeNull();
    expect(findKeyConflict(map, 'j', 'next')).toBeNull();
  });

  it('抢走别人的键之后，那一方在映射里确实不再拥有它', () => {
    // 把 prev 的键给 next：prev 显式不绑定，避免出现两个动作都认这个键
    const map = buildKeyMap(getPreset('reading'), { prev: '', next: 'ArrowLeft' });
    expect(map['ArrowLeft']).toBe('next');
    expect(Object.values(map).filter(a => a === 'prev')).toHaveLength(0);
  });

  it('取动作当前键：自定义优先，空串显示为未绑定', () => {
    const preset = getPreset('layout');
    expect(keyForAction(preset, {}, 'fontUp')).toBe('+');
    expect(keyForAction(preset, { fontUp: '=' }, 'fontUp')).toBe('=');
    expect(keyForAction(preset, { fontUp: '' }, 'fontUp')).toBeNull();
    expect(keyForAction(getPreset('reading'), {}, 'openToc')).toBeNull();
  });

  it('解析坏数据一律丢弃', () => {
    expect(parseShortcutOverrides('{ bad')).toEqual({});
    expect(parseShortcutOverrides(null)).toEqual({});
    expect(parseShortcutOverrides('123')).toEqual({});
    expect(parseShortcutOverrides(JSON.stringify({ 不存在的动作: 'x', next: 5 }))).toEqual({});
    expect(parseShortcutOverrides(JSON.stringify({ next: 'j', prev: '' }))).toEqual({ next: 'j', prev: '' });
  });
});

describe('全局热键的 accelerator 转换', () => {
  it('修饰键按 Electron 的写法输出，单字符转大写', () => {
    expect(toGlobalAccelerator({ key: 'h', ctrlKey: true, altKey: true })).toBe('Control+Alt+H');
    expect(toGlobalAccelerator({ key: '`', ctrlKey: true })).toBe('Control+`');
    expect(toGlobalAccelerator({ key: '7', ctrlKey: true })).toBe('Control+7');
  });

  it('Shift 必须显式保留，不能被折进字符里', () => {
    // 这是与 normalizeKey 的分界：那边把 Ctrl+Shift+H 归一成 'Ctrl+h'，
    // 全局热键若照搬就会把用户的 Ctrl+H 抢走，而自己设的键根本不生效
    expect(toGlobalAccelerator({ key: 'H', ctrlKey: true, shiftKey: true })).toBe('Control+Shift+H');
    expect(toGlobalAccelerator({ key: 'h', ctrlKey: true })).toBe('Control+H');
  });

  it('裸键拒绝：注册成全局热键等于把那个字符从所有软件里夺走', () => {
    expect(toGlobalAccelerator({ key: 'h' })).toBeNull();
    expect(toGlobalAccelerator({ key: 'F11' })).toBeNull();
    expect(toGlobalAccelerator({ key: '`' })).toBeNull();
  });

  it('特殊键按 Electron 的键码表映射（名字两套不一样，写错只会静默失败）', () => {
    expect(toGlobalAccelerator({ key: 'ArrowUp', ctrlKey: true })).toBe('Control+Up');
    expect(toGlobalAccelerator({ key: 'Escape', ctrlKey: true, altKey: true })).toBe('Control+Alt+Escape');
    expect(toGlobalAccelerator({ key: ' ', ctrlKey: true, altKey: true })).toBe('Control+Alt+Space');
    expect(toGlobalAccelerator({ key: 'F11', ctrlKey: true })).toBe('Control+F11');
    expect(toGlobalAccelerator({ key: 'F25', ctrlKey: true })).toBeNull();
  });

  it('Shift 改写过标点时拒绝，不给一个注册得进去却按不出来的假成功', () => {
    // Shift+1 的 e.key 已是 '!'，再拼一次 Shift 会得到没人认的组合
    expect(toGlobalAccelerator({ key: '!', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(toGlobalAccelerator({ key: '!', ctrlKey: true })).toBe('Control+!');
    expect(toGlobalAccelerator({ key: 'Dead', ctrlKey: true })).toBeNull();
  });

  it('Meta 走 Super，不冒充 Control', () => {
    expect(toGlobalAccelerator({ key: 'h', metaKey: true })).toBe('Super+H');
  });

  it('展示文案与快捷键列表写法一致', () => {
    expect(acceleratorLabel('Control+Alt+H')).toBe('Ctrl+Alt+H');
    expect(acceleratorLabel('')).toBe('');
  });
});
