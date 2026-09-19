import { app } from 'electron';

/**
 * 开机自启。
 *
 * 两处会用到：设置页切换开关时（ipc/index.ts 的 app:setAutoLaunch），
 * 以及每次启动时按当前 exe 路径重新对齐（main.ts）——后者不是冗余，
 * 用户改过安装目录或升级重装后，注册表里存的还是旧路径。
 */

/**
 * 把开机自启对齐到指定状态。
 *
 * 三种情况下直接跳过，都不往外抛错：
 * - 便携版：exe 在 U 盘上，注册表项要么指向会被拔走的盘符、要么指向解包用的临时目录，
 *   下次开机必然弹出「找不到 xxx.exe」。便携模式的卖点是不写注册表、拔了就走，
 *   自启与它本就不相容，UI 那边也会置灰。
 * - 开发态：写进去的是 electron.exe，重启会弹出一个光秃秃的空壳。
 * - 无头验收：验收脚本会真实调用这个函数，不该污染运行机器的注册表。
 *
 * 打包成正式安装版后，Windows 可能把新写入的自启项标为「已阻止」，
 * 用户需在「设置 → 应用 → 启动」里允许一次——这是 Windows 对自启项的既有策略，
 * 应用侧没有绕过的手段，与代码正确性无关。
 */
export function applyAutoLaunch(enabled: boolean) {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;
  if (!app.isPackaged) return;
  if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // 显式给路径：默认取 process.execPath，安装版下虽正确，但写明白更稳
    path: app.getPath('exe'),
    // 不带参数——自启就是冷启动，没有待打开的文件
    args: [],
  });
}

/** 读取注册表里的真实状态（判断开关是否真的生效，而不是只看设置库） */
export function isAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

/** 便携版判断：渲染进程拿不到 process.env，经 app:info 透出去给设置页用 */
export function isPortable(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}