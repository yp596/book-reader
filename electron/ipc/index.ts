import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../services/db.service';

export function registerIpcHandlers() {
  const db = DatabaseService.getInstance();

  // ============ Books ============

  ipcMain.handle('books:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: '导入书籍',
      filters: [
        { name: '电子书', extensions: ['epub', 'txt', 'pdf'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled) return [];

    const booksDir = path.join(app.getPath('userData'), 'books');
    if (!fs.existsSync(booksDir)) {
      fs.mkdirSync(booksDir, { recursive: true });
    }

    const imported = [];
    for (const filePath of result.filePaths) {
      const ext = path.extname(filePath);
      const fileName = path.basename(filePath, ext);
      const destPath = path.join(booksDir, `${Date.now()}-${path.basename(filePath)}`);

      fs.copyFileSync(filePath, destPath);

      const id = db.insertBook({
        title: fileName,
        file_path: destPath,
        file_type: ext.slice(1),
      });

      imported.push({ id: Number(id), path: destPath });
    }

    return imported;
  });

  ipcMain.handle('books:getAll', () => {
    return db.getAllBooks();
  });

  ipcMain.handle('books:getById', (_event, id: number) => {
    return db.getBookById(id);
  });

  ipcMain.handle('books:delete', (_event, id: number) => {
    db.deleteBook(id);
  });

  ipcMain.handle('books:updateProgress', (_event, id: number, progress: number) => {
    db.updateBookProgress(id, progress);
  });

  // ============ Sources ============

  ipcMain.handle('sources:getAll', () => {
    return db.getAllSources();
  });

  ipcMain.handle('sources:add', (_event, source: any) => {
    return db.insertSource(source);
  });

  ipcMain.handle('sources:delete', (_event, id: number) => {
    db.deleteSource(id);
  });

  ipcMain.handle('sources:search', async (_event, sourceId: number, _keyword: string) => {
    const source = db.getSourceById(sourceId) as any;
    if (!source) return [];
    // TODO: 实现书源搜索
    return [];
  });

  ipcMain.handle('sources:chapters', async (_event, sourceId: number, _url: string) => {
    const source = db.getSourceById(sourceId) as any;
    if (!source) return [];
    // TODO: 实现章节列表获取
    return [];
  });

  ipcMain.handle('sources:content', async (_event, sourceId: number, _url: string) => {
    const source = db.getSourceById(sourceId) as any;
    if (!source) return '';
    // TODO: 实现章节内容获取
    return '';
  });

  // ============ Bookmarks ============

  ipcMain.handle('bookmarks:get', (_event, bookId: number) => {
    return db.getBookmarksByBookId(bookId);
  });

  ipcMain.handle('bookmarks:add', (_event, bookmark: any) => {
    return db.insertBookmark(bookmark);
  });

  ipcMain.handle('bookmarks:delete', (_event, id: number) => {
    db.deleteBookmark(id);
  });

  // ============ Notes ============

  ipcMain.handle('notes:get', (_event, bookId: number) => {
    return db.getNotesByBookId(bookId);
  });

  ipcMain.handle('notes:add', (_event, note: any) => {
    return db.insertNote(note);
  });

  ipcMain.handle('notes:delete', (_event, id: number) => {
    db.deleteNote(id);
  });

  // ============ Settings ============

  ipcMain.handle('settings:get', (_event, key: string) => {
    return db.getSetting(key);
  });

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.setSetting(key, value);
  });
}
