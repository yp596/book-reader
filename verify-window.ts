/**
 * 临时验证脚本（跑完即删）：验证多窗口的书籍参数传递。
 * 覆盖：loadRenderer 带 bookId 时，渲染进程能读到 ?book=N。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRenderer } from './electron/renderer-window';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'verify-window-')));

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  loadRenderer(win, 42);
  await new Promise<void>(resolve => {
    win.webContents.once('did-finish-load', () => resolve());
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error('[失败] 载入出错', code, desc);
      resolve();
    });
  });
  const url = win.webContents.getURL();
  const search = await win.webContents.executeJavaScript('window.location.search');
  console.log('[1] 窗口 URL      :', url.slice(-48));
  console.log('[2] location.search:', JSON.stringify(search));
  console.log('[3] 参数解析正确  :', new URLSearchParams(search).get('book') === '42');

  // 无 bookId 时不带查询串
  const plain = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  loadRenderer(plain);
  await new Promise<void>(resolve => {
    plain.webContents.once('did-finish-load', () => resolve());
    plain.webContents.once('did-fail-load', () => resolve());
  });
  const plainSearch = await plain.webContents.executeJavaScript('window.location.search');
  console.log('[4] 无参数窗口 search:', JSON.stringify(plainSearch));

  win.destroy();
  plain.destroy();
  app.exit(0);
}

app
  .whenReady()
  .then(main)
  .catch(err => {
    console.error('[失败]', err);
    app.exit(1);
  });
