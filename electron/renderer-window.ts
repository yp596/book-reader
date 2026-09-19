import { BrowserWindow } from 'electron';
import path from 'path';

/**
 * 把渲染页面载入窗口；带 bookId 时该窗口启动即打开这本书（多窗口并行阅读）。
 * 开发环境走 dev server 的查询串，打包后走 loadFile 的 query——两条路径都要带参数。
 */
export function loadRenderer(win: BrowserWindow, bookId?: number) {
  // 页面自带 <title>（index.html 写死「阅读书架」），载入完成时会把窗口标题盖回去，
  // 于是任务栏悬停看到的永远是那四个字、分不出开的是哪本书。这里拦掉，
  // 标题统一由 `window:setTitle` 一个出口设——渲染进程才知道当前是哪本书。
  win.on('page-title-updated', event => event.preventDefault());
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(bookId == null ? devUrl : `${devUrl}?book=${bookId}`);
    return;
  }
  const indexFile = path.join(__dirname, '../dist/index.html');
  if (bookId == null) {
    void win.loadFile(indexFile);
  } else {
    void win.loadFile(indexFile, { query: { book: String(bookId) } });
  }
}
