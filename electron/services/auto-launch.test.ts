import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

// vi.mock 的工厂会被提升到模块顶部执行，不能引用文件作用域的普通变量，
// 必须用 vi.hoisted 声明测试内共享的状态。
const state = vi.hoisted(() => {
  const logged: Array<{ openAtLogin: boolean; path?: string; args?: string[] }> = [];
  return { logged };
});

// 模拟 Electron：默认视为开发态（isPackaged=false），每个用例按需改。
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => path.join(os.tmpdir(), 'book-reader-autolaunch-test'),
    setLoginItemSettings: (opts: { openAtLogin: boolean; path?: string; args?: string[] }) => {
      state.logged.push(opts);
    },
    getLoginItemSettings: () => ({
      openAtLogin: state.logged.length > 0 ? state.logged[state.logged.length - 1].openAtLogin : false,
    }),
  },
}));

import { app } from 'electron';
import { applyAutoLaunch, isAutoLaunchEnabled, isPortable } from './auto-launch';

// 模块顶层读取 process.env；env 变量由 beforeEach/afterEach 还原
const ORIG = {
  portable: process.env.PORTABLE_EXECUTABLE_DIR,
  headless: process.env.BOOKREADER_HEADLESS_ACCEPTANCE as string | undefined,
};

beforeEach(() => {
  state.logged.length = 0;
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  delete process.env.BOOKREADER_HEADLESS_ACCEPTANCE;
  app.isPackaged = false;
});

afterEach(() => {
  if (ORIG.portable === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
  else process.env.PORTABLE_EXECUTABLE_DIR = ORIG.portable;
  if (ORIG.headless === undefined) delete process.env.BOOKREADER_HEADLESS_ACCEPTANCE;
  else process.env.BOOKREADER_HEADLESS_ACCEPTANCE = ORIG.headless;
});

describe('auto-launch', () => {
  it('开发态（未打包）不写注册表', () => {
    applyAutoLaunch(true);
    expect(state.logged).toHaveLength(0);
  });

  it('便携版不写注册表', () => {
    app.isPackaged = true;
    process.env.PORTABLE_EXECUTABLE_DIR = 'F:';
    applyAutoLaunch(true);
    expect(state.logged).toHaveLength(0);
    expect(isPortable()).toBe(true);
  });

  it('无头验收不写真实注册表', () => {
    app.isPackaged = true;
    process.env.BOOKREADER_HEADLESS_ACCEPTANCE = '1';
    applyAutoLaunch(true);
    expect(state.logged).toHaveLength(0);
  });

  it('正常态开启写入 openAtLogin=true 与当前 exe 路径', () => {
    app.isPackaged = true;
    applyAutoLaunch(true);
    expect(state.logged).toHaveLength(1);
    expect(state.logged[0].openAtLogin).toBe(true);
    expect(state.logged[0].path).toBe(app.getPath('exe'));
    expect(state.logged[0].args).toEqual([]);
    expect(isAutoLaunchEnabled()).toBe(true);
  });

  it('业务路径写入失败时把错误抛给调用方（由 main.ts / ipc 的 try/catch 兜底）', () => {
    app.isPackaged = true;
    const orig = app.setLoginItemSettings;
    app.setLoginItemSettings = () => {
      throw new Error('boom');
    };
    expect(() => applyAutoLaunch(false)).toThrow('boom');
    app.setLoginItemSettings = orig;
  });
});