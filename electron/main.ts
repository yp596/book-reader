import { app, BrowserWindow, clipboard, globalShortcut, protocol, net, ipcMain, Tray, Menu, nativeImage, screen } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseService } from './services/db.service';
import { ModelService } from './services/model-service';
import { disposeEngine } from './services/llama-engine';
import { registerIpcHandlers } from './ipc';
import { folderWatcher } from './services/watch-folder';
import { applyAutoLaunch } from './services/auto-launch';
import { loadRenderer } from './renderer-window';
import { LOCAL_FILE_SCHEME, filePathFromUrl, isInsideAllowedDir } from './services/local-file';

// 必须在 app ready 之前声明为特权协议，否则渲染进程的 CSP 与跨源策略会拦掉封面请求
protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 区分「用户关窗口」与「真正要退出」：前者在开启托盘驻留时只隐藏 */
let quitting = false;

// 便携版：数据目录跟着 exe 走，U 盘拷走也能带着书库。
// electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_DIR，安装版没有这个变量。
// 必须在 app ready 之前设置，之后 userData 才会指向它。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir) {
  app.setPath('userData', path.join(portableDir, 'book-reader-data'));
}

/** 可被系统关联打开的书：与 electron-builder.yml 的 fileAssociations 保持一致 */
const ASSOCIATED_EXTS = ['.epub', '.txt', '.md', '.pdf'];

/** 冷启动双击文件拿到的路径：渲染进程挂载后主动来取，避免和 React 挂载抢时序 */
let pendingOpenPath: string | null = null;

// 双击关联文件会再起一个进程：拿不到锁的那个立刻退出，由 second-instance 把路径交给
// 已在运行的窗口，免得两个窗口各自打开同一个数据库。
// 开发态不加锁——vite 重启进程时旧进程可能还没退干净，加锁会让新窗口静默起不来。
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  // 拿不到锁说明已有实例在跑，本进程要立刻退干净。
  // 用 quit() 会继续往下执行到 ready，可能与第一个实例同时初始化数据库与窗口。
  app.exit(0);
}

/**
 * 从命令行里挑出要打开的书。
 * 双击文件启动时路径混在 argv 里，开发态还夹着 electron 与项目目录，装好的应用另有
 * --no-sandbox 之类的开关，所以按「后缀符合 + 确实是文件」筛，不按位置硬取。
 */
function bookPathFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    if (!ASSOCIATED_EXTS.includes(path.extname(arg).toLowerCase())) continue;
    try {
      if (fs.statSync(arg).isFile()) return arg;
    } catch { /* 不是有效路径，看下一个 */ }
  }
  return null;
}

/**
 * 把主窗口唤回前台。
 * 开启「关闭到托盘」后窗口是 hide() 过的，只调 focus() 唤不出来——用户双击一本书
 * 会以为没反应，所以这里必须先 show()。
 */
function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** 把文件交给渲染进程，走既有的导入/入库流程 */
function openBookFile(filePath: string) {
  if (!mainWindow) return;
  showMainWindow();
  mainWindow.webContents.send('menu:open-file', filePath);
}

/**
 * 隐藏 / 显示主窗口：窗口正显示着就收起，否则唤回前台。
 * 一个键承担「叫出来 / 收起来」两件事——「隐藏窗口」之后本来就得靠同一个键找回来，
 * 分成两个键反而会出现「收起来了但没有键能叫回」。
 */
function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

/** 当前生效的全局热键（Electron accelerator 写法），空串表示未设 */
let globalHotkey = '';

/**
 * 注册 / 改绑 / 注销全局热键，返回是否真的生效。
 *
 * 与 Ctrl+O 那类应用内快捷键**故意不同**：那一类不做成全局的，因为做成全局就会
 * 把别的软件里的 Ctrl+O 抢过来（见 registerShortcuts 的注释）。这里反过来——
 * 「失焦时也能一键把阅读器叫到面前」本来就只有全局热键能做，是它的正经用法；
 * 键位由用户自己录，默认不设，所以不存在替谁做主的问题。
 *
 * `globalShortcut.register` 遇到已被别的软件占用的键**只返回 false，不抛错**，
 * 所以这里必须把返回值一路透到界面：只有真的注册成功才算数，不让用户拿到一个
 * 按不出来的「已设置」。
 */
function applyGlobalHotkey(accel: string): boolean {
  const next = (accel || '').trim();
  // 改绑前先摘掉旧的：同一个键重复注册会直接失败，不先注销就会卡在「换不动」的状态
  if (globalHotkey) {
    try { globalShortcut.unregister(globalHotkey); } catch { /* 已注销则忽略 */ }
    globalHotkey = '';
  }
  if (!next) return true;
  // 无头验收模式不开窗口，注册一个抢不到窗口的全局键只会去抢真实桌面的按键
  if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') return false;
  try {
    if (globalShortcut.register(next, toggleMainWindow)) {
      globalHotkey = next;
      return true;
    }
  } catch { /* 键位串不合法时按注册失败处理 */ }
  return false;
}

app.on('second-instance', (_event, argv) => {
  const filePath = bookPathFromArgv(argv);
  if (filePath) {
    openBookFile(filePath);
  } else {
    showMainWindow();
  }
});

/** 处理本机文件请求：只放行书库目录内的文件，不把整个磁盘暴露给渲染进程 */
function registerLocalFileProtocol() {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const filePath = filePathFromUrl(request.url);
    if (!isInsideAllowedDir(filePath) || !fs.existsSync(filePath)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

/**
 * 上次的窗口位置可能来自已拔掉的显示器，或另一台缩放率不同的屏（4K/200% 与 1080p 混用很常见）。
 * 钳到当前显示器的工作区内，免得窗口开在屏幕外点不到。
 */
function restoreWindowBounds(saved: { x?: number; y?: number; width: number; height: number } | null) {
  if (!saved) return { width: 1200, height: 800, x: undefined, y: undefined };
  const box = { x: saved.x ?? 0, y: saved.y ?? 0, width: saved.width, height: saved.height };
  const area = screen.getDisplayMatching(box).workArea;
  const width = Math.min(box.width, area.width);
  const height = Math.min(box.height, area.height);
  // 没有坐标就交给系统居中
  if (saved.x === undefined || saved.y === undefined) return { width, height, x: undefined, y: undefined };
  return {
    width,
    height,
    x: Math.min(Math.max(box.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(box.y, area.y), area.y + area.height - height),
  };
}

function createWindow() {
  const db = DatabaseService.getInstance();
  // 无头验收模式：只建库与 IPC，不开窗口、不建托盘（见 docs 验收脚本说明）
  if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') return;
  const bounds = restoreWindowBounds(db.getWindowBounds());

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    // 任务栏悬停看到的就是这个标题；页面自带 <title> 已被 loadRenderer 拦掉，
    // 之后由渲染进程按当前书覆盖（见 window:setTitle）
    title: '阅读书架',
    backgroundColor: '#1a1a2e',
  });

  loadRenderer(mainWindow);

  mainWindow.on('close', (event) => {
    if (mainWindow) {
      db.setSetting('windowBounds', JSON.stringify(mainWindow.getBounds()));
    }
    // 托盘驻留：关窗口只隐藏，应用仍在后台（从托盘菜单退出才是真退出）
    if (!quitting && db.isSettingOn('closeToTray')) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Ctrl+O 打开文件、Ctrl+W 关闭当前文档：都只在本应用窗口内响应。
 * 早先用 globalShortcut 注册成系统级热键，只要本应用在运行（含托盘驻留、窗口失焦）
 * 就会把别的软件里的 Ctrl+O 抢过来，还会在隐藏窗口上弹出文件框。
 *
 * Ctrl+W 必须在这里拦、不能交给渲染层的 window 监听：EPUB 正文渲染在 iframe 里，
 * 焦点落在正文上时按键事件只在那个文档内冒泡，外层 window 根本收不到。
 */
function registerShortcuts() {
  if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') return;
  mainWindow?.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.control || input.meta) || input.alt || input.shift) return;
    const key = input.key.toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      mainWindow?.webContents.send('menu:open-file');
      return;
    }
    if (key === 'w') {
      // 关哪个标签由渲染层定（主进程不知道标签状态），这里只负责把键拦下来
      event.preventDefault();
      mainWindow?.webContents.send('menu:close-tab');
    }
  });
}

/** 托盘：常驻入口，关窗口后仍能唤回 */
function createTray() {
  if (tray) return;
  if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') return;
  const iconPath = path.join(__dirname, '../build/tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Book Reader');
  const show = () => showMainWindow();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: show },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', show);
}

// 先异步初始化数据库，再创建窗口
app.whenReady().then(async () => {
  await DatabaseService.create();
  registerLocalFileProtocol();
  // 系统「打开方式」拉起的文件：先记下来。挂载时序由 React 决定，
  // 主进程直接 send 会在页面挂好监听之前丢掉，所以让渲染进程来取。
  pendingOpenPath = bookPathFromArgv(process.argv);
  ipcMain.handle('app:takeOpenFile', () => {
    const filePath = pendingOpenPath;
    pendingOpenPath = null;
    return filePath;
  });
  // 全局热键改绑要立即生效（不能等下次启动），所以与开机自启同套路：
  // 值由设置页存进 settings 库，这里只管注册，返回值即「到底注册上没有」
  ipcMain.handle('app:setGlobalHotkey', (_event, accel: string) =>
    applyGlobalHotkey(String(accel ?? '')),
  );
  createWindow();
  registerIpcHandlers();
  // 恢复上次的目录监视（须在 registerIpcHandlers 之后——回调在那里注册）
  try {
    const watchDir = DatabaseService.getInstance().getSetting('watchDir');
    if (watchDir && fs.existsSync(watchDir)) folderWatcher().start(watchDir);
  } catch { /* 目录已不存在则忽略 */ }
  registerShortcuts();
  createTray();
  // 恢复全局热键：上次启动时可能被别的软件占用而没注册上，每次启动都按当前值重试一次
  try {
    const saved = DatabaseService.getInstance().getSetting('globalHotkey') || '';
    if (saved && !applyGlobalHotkey(saved)) {
      console.warn(`[global-hotkey] 注册失败，已被其它程序占用？${saved}`);
    }
  } catch { /* 忽略 */ }
  // 恢复防截屏设置：设置页改过之后重启也要继续生效
  try {
    if (DatabaseService.getInstance().isSettingOn('screenProtection')) {
      for (const win of BrowserWindow.getAllWindows()) win.setContentProtection(true);
    }
  } catch { /* 忽略 */ }
  // 恢复开机自启设置：用户改过安装目录、升级重装、或在注册表里手动删过，
  // 每次启动都按当前 exe 路径重新对齐一次（与上面两处同构：失败静默忽略）
  try {
    applyAutoLaunch(DatabaseService.getInstance().isSettingOn('autoLaunch'));
  } catch { /* 忽略 */ }
  // 推理走进程内引擎（懒加载，首次 AI 调用时载入模型）；
  // 边车仅作手动回退，不再开机自启，避免模型双份占内存
  if (mainWindow) {
    ModelService.getInstance().setWindow(mainWindow);
    mainWindow.on('closed', () => {
      ModelService.getInstance().setWindow(null);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 真退出（菜单/托盘/系统）时放行 close，否则托盘驻留会把退出也拦下来
app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  // 全局热键必须在退出前主动摘掉：否则应用都没了，这个键还被占着不响应任何人
  try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
  try { folderWatcher().stop(); } catch { /* 忽略 */ }
  // 隐私模式：退出时清掉剪贴板，不含用户笔记/书签与调用方的复制内容以外数据。
  // 与下面的会话标记分开 try：隐私清理失败不该连累会话标记，否则正常退出也会
  // 残留 readingSession，下次启动误报「上次没有正常退出」。
  try {
    const db = DatabaseService.getInstance();
    if (db.isSettingOn('privacyAutoClear')) {
      clipboard.clear();
    }
  } catch { /* 忽略 */ }
  try {
    // 会话标记一律清掉：走到这里说明是正常退出，下次启动不该提示「异常退出」
    DatabaseService.getInstance().clearReadingSessions();
  } catch { /* 忽略 */ }
  try { ModelService.getInstance().stopAll(); } catch {}
  try { void disposeEngine(); } catch {}
  try { DatabaseService.getInstance().close(); } catch {}
});
