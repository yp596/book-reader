import { app, BrowserWindow, globalShortcut, clipboard } from 'electron';
import path from 'path';
import { DatabaseService } from './services/db.service';
import { ModelService } from './services/model-service';
import { disposeEngine } from './services/llama-engine';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const db = DatabaseService.getInstance();
  const bounds = db.getWindowBounds();

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1200,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('close', () => {
    if (mainWindow) {
      db.setSetting('windowBounds', JSON.stringify(mainWindow.getBounds()));
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

// 先异步初始化数据库，再创建窗口
app.whenReady().then(async () => {
  await DatabaseService.create();
  createWindow();
  registerIpcHandlers();
  registerShortcuts();
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 隐私模式：退出时清掉临时数据（章节缓存与剪贴板），不含用户笔记/书签
  try {
    const db = DatabaseService.getInstance();
    if (db.getSetting('privacyAutoClear') === 'true') {
      db.clearChapterCache();
      clipboard.clear();
    }
  } catch { /* 忽略 */ }
  try { ModelService.getInstance().stopAll(); } catch {}
  try { void disposeEngine(); } catch {}
  try { DatabaseService.getInstance().close(); } catch {}
});
