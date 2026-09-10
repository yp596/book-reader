import { BrowserWindow } from 'electron';
import path from 'path';

/**
 * 把渲染页面载入窗口；带 bookId 时该窗口启动即打开这本书（多窗口并行阅读）。
 * 开发环境走 dev server 的查询串，打包后走 loadFile 的 query——两条路径都要带参数。
 */
export function loadRenderer(win: BrowserWindow, bookId?: number) {
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
