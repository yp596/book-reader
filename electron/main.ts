import { app, BrowserWindow, globalShortcut, clipboard, protocol, net, ipcMain, Tray, Menu, nativeImage, screen } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseService } from './services/db.service';
import { ModelService } from './services/model-service';
import { disposeEngine } from './services/llama-engine';
import { registerIpcHandlers } from './ipc';
import { folderWatcher } from './services/watch-folder';
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
  app.quit();
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

/** 把文件交给渲染进程，走既有的导入/入库流程 */
function openBookFile(filePath: string) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('menu:open-file', filePath);
}

app.on('second-instance', (_event, argv) => {
  const filePath = bookPathFromArgv(argv);
  if (filePath) {
    openBookFile(filePath);
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+O', () => {
    mainWindow?.webContents.send('menu:open-file');
  });
}

/** 托盘：常驻入口，关窗口后仍能唤回 */
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '../build/tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Book Reader');
  const show = () => {
    if (!mainWindow) return;
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  };
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
  createWindow();
  registerIpcHandlers();
  // 恢复上次的目录监视（须在 registerIpcHandlers 之后——回调在那里注册）
  try {
    const watchDir = DatabaseService.getInstance().getSetting('watchDir');
    if (watchDir && fs.existsSync(watchDir)) folderWatcher().start(watchDir);
  } catch { /* 目录已不存在则忽略 */ }
  registerShortcuts();
  createTray();
  // 恢复防截屏设置：设置页改过之后重启也要继续生效
  try {
    if (DatabaseService.getInstance().isSettingOn('screenProtection')) {
      for (const win of BrowserWindow.getAllWindows()) win.setContentProtection(true);
    }
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
  globalShortcut.unregisterAll();
  try { folderWatcher().stop(); } catch { /* 忽略 */ }
  // 隐私模式：退出时清掉临时数据（章节缓存与剪贴板），不含用户笔记/书签
  try {
    const db = DatabaseService.getInstance();
    if (db.isSettingOn('privacyAutoClear')) {
      db.clearChapterCache();
      clipboard.clear();
    }
    // 会话标记一律清掉：走到这里说明是正常退出，下次启动不该提示「异常退出」
    db.clearReadingSessions();
  } catch { /* 忽略 */ }
  try { ModelService.getInstance().stopAll(); } catch {}
  try { void disposeEngine(); } catch {}
  try { DatabaseService.getInstance().close(); } catch {}
});
