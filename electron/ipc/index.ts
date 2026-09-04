import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../services/db.service';
import { extractMetadata, extractToc } from '../services/metadata';
import { buildCrawlerFromRow } from '../services/book-source';
import { AiService } from '../services/ai-service';

/** 单文件导入复用逻辑（对话框/拖拽共用） */
async function importOneFile(db: DatabaseService, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.epub', '.txt', '.pdf'].includes(ext)) {
    throw new Error(`不支持的格式：${ext || '(无后缀)'}`);
  }
  const fileName = path.basename(filePath, path.extname(filePath));
  const booksDir = path.join(app.getPath('userData'), 'books');
  if (!fs.existsSync(booksDir)) {
    fs.mkdirSync(booksDir, { recursive: true });
  }
  const destPath = path.join(booksDir, `${Date.now()}-${path.basename(filePath)}`);
  fs.copyFileSync(filePath, destPath);

  const meta = await extractMetadata(destPath, ext);
  const id = db.insertBook({
    title: meta?.title ?? fileName,
    author: meta?.author,
    file_path: destPath,
    file_type: ext.slice(1),
  });
  // 提取目录并缓存
  try {
    const toc = await extractToc(destPath, ext);
    if (toc.length > 0) db.setBookToc(Number(id), JSON.stringify(toc));
  } catch { /* 目录失败不阻塞导入 */ }
  return { id: Number(id), path: destPath };
}

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

    const imported = [];
    for (const filePath of result.filePaths) {
      try {
        imported.push(await importOneFile(db, filePath));
      } catch (err) {
        console.error(`导入失败 [${filePath}]:`, err);
      }
    }

    return imported;
  });

  // 拖拽导入（渲染进程传真实路径）
  ipcMain.handle('books:importPaths', async (_event, filePaths: string[]) => {
    const imported = [];
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          imported.push(await importOneFile(db, filePath));
        }
      } catch (err) {
        console.error(`导入失败 [${filePath}]:`, err);
      }
    }
    return imported;
  });

  // 已入库书籍：从内容重新识别书名作者
  ipcMain.handle('books:refreshMetadata', async (_event, id: number) => {
    const book = db.getBookById(id) as
      | { file_path: string; file_type: string }
      | undefined;
    if (!book) throw new Error('书籍不存在');
    const meta = await extractMetadata(book.file_path, '.' + book.file_type);
    if (!meta) throw new Error('未能从内容中识别出书名');
    db.updateBookInfo(id, meta.title, meta.author ?? null);
    return meta;
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

  // 文件属性（名称/大小/修改时间/类型）
  ipcMain.handle('books:fileInfo', (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    const stat = fs.existsSync(book.file_path) ? fs.statSync(book.file_path) : null;
    return {
      title: book.title,
      author: book.author || '未知作者',
      fileName: path.basename(book.file_path),
      fileType: book.file_type,
      size: stat ? stat.size : 0,
      mtime: stat ? stat.mtime.toLocaleString() : '文件已丢失',
      progress: book.progress ?? 0,
    };
  });

  // 在文件管理器中显示
  ipcMain.handle('books:reveal', (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.file_path)) throw new Error('书籍文件已丢失');
    shell.showItemInFolder(book.file_path);
  });

  // 清除全部阅读记录
  ipcMain.handle('books:clearHistory', () => {
    db.clearReadingHistory();
  });

  // 重命名 / 收藏 / 分类
  ipcMain.handle('books:rename', (_event, id: number, title: string) => {
    if (!title?.trim()) throw new Error('书名不能为空');
    db.renameBook(id, title);
  });

  ipcMain.handle('books:toggleFavorite', (_event, id: number) => {
    return db.toggleFavorite(id);
  });

  ipcMain.handle('books:setCategory', (_event, id: number, category: string) => {
    db.setCategory(id, category);
  });

  ipcMain.handle('books:categories', () => {
    return db.getCategories();
  });

  // 书籍目录（读导入时缓存，无缓存则实时解析）
  ipcMain.handle('books:toc', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (book.toc) {
      try {
        const cached = JSON.parse(book.toc);
        if (Array.isArray(cached) && cached.length > 0) return cached;
      } catch { /* 缓存损坏则重新解析 */ }
    }
    const toc = await extractToc(book.file_path, '.' + book.file_type);
    if (toc.length > 0) db.setBookToc(id, JSON.stringify(toc));
    return toc;
  });

  // 全屏切换
  ipcMain.handle('window:toggleFullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });

  // 按 id 读取书籍文件内容（base64），渲染进程无文件访问权限，必须经主进程
  ipcMain.handle('books:getFileData', (_event, id: number) => {
    const book = db.getBookById(id) as { file_path: string } | undefined;
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.file_path)) throw new Error('书籍文件已丢失：' + book.file_path);
    const buffer = fs.readFileSync(book.file_path);
    return buffer.toString('base64');
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

  ipcMain.handle('sources:search', async (_event, sourceId: number, keyword: string) => {
    const source = db.getSourceById(sourceId) as any;
    if (!source) throw new Error('书源不存在');
    const crawler = buildCrawlerFromRow(source);
    if (!crawler) throw new Error('该书源缺少抓取规则，请编辑补充选择器');
    return crawler.search(keyword);
  });

  ipcMain.handle('sources:chapters', async (_event, sourceId: number, detailUrl: string) => {
    const source = db.getSourceById(sourceId) as any;
    if (!source) throw new Error('书源不存在');
    const crawler = buildCrawlerFromRow(source);
    if (!crawler) throw new Error('该书源缺少抓取规则，请编辑补充选择器');
    return crawler.getChapters(detailUrl);
  });

  ipcMain.handle(
    'sources:content',
    async (
      _event,
      sourceId: number,
      book: { url: string; title: string },
      chapter: { url: string; title: string; idx: number },
    ) => {
      // 先读缓存
      const cached = db.getCachedChapter(chapter.url) as { content: string } | undefined;
      if (cached?.content) return cached.content;

      const source = db.getSourceById(sourceId) as any;
      if (!source) throw new Error('书源不存在');
      const crawler = buildCrawlerFromRow(source);
      if (!crawler) throw new Error('该书源缺少抓取规则，请编辑补充选择器');
      const content = await crawler.getContent(chapter.url);
      if (content) {
        db.saveCachedChapter({
          source_id: sourceId,
          book_url: book.url,
          chapter_url: chapter.url,
          title: chapter.title,
          content,
          idx: chapter.idx,
        });
      }
      return content;
    },
  );

  // 整本缓存并导出 TXT
  ipcMain.handle(
    'sources:exportTxt',
    async (event, sourceId: number, book: { url: string; title: string }, chapters: { name: string; url: string }[]) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: '导出 TXT',
        defaultPath: `${book.title.replace(/[\\/:*?"<>|]/g, '_')}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return null;

      const source = db.getSourceById(sourceId) as any;
      if (!source) throw new Error('书源不存在');
      const crawler = buildCrawlerFromRow(source);
      if (!crawler) throw new Error('该书源缺少抓取规则，请编辑补充选择器');

      const parts: string[] = [book.title, ''];
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        let content = (db.getCachedChapter(ch.url) as any)?.content as string | undefined;
        if (!content) {
          content = await crawler.getContent(ch.url);
          if (content) {
            db.saveCachedChapter({
              source_id: sourceId,
              book_url: book.url,
              chapter_url: ch.url,
              title: ch.name,
              content,
              idx: i,
            });
          }
        }
        parts.push(`\n${ch.name}\n\n${content || '（本章获取失败）'}\n`);
      }
      fs.writeFileSync(filePath, parts.join('\n'), 'utf-8');
      return filePath;
    },
  );

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

  // 笔记+书签导出 Markdown（不传 bookId 则导出全部书）
  ipcMain.handle('notes:export', async (event, bookId?: number) => {
    const books = (
      bookId ? [db.getBookById(bookId)] : db.getAllBooks()
    ).filter(Boolean) as any[];
    if (books.length === 0) throw new Error('没有可导出的书籍');

    const lines: string[] = [`# 阅读笔记导出`, `> 导出时间：${new Date().toLocaleString()}`, ''];
    for (const b of books) {
      const notes = db.getNotesByBookId(b.id) as any[];
      const marks = db.getBookmarksByBookId(b.id) as any[];
      if (notes.length === 0 && marks.length === 0) continue;
      lines.push(`## 《${b.title}》${b.author ? ` —— ${b.author}` : ''}`, '');
      for (const n of notes) {
        if (n.selected_text) lines.push(`> ${n.selected_text}`, '');
        if (n.note) lines.push(n.note, '');
        lines.push(`- ${n.created_at}`, '');
      }
      for (const m of marks) {
        if (m.text) lines.push(`- 📌 ${m.text}`, '');
      }
      lines.push('---', '');
    }
    if (lines.length <= 3) throw new Error('所选书籍暂无笔记或书签');

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出笔记',
      defaultPath: bookId ? '我的笔记.md' : '全部笔记.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  });

  // ============ 阅读计时 ============

  ipcMain.handle('stats:recordTime', (_event, bookId: number, seconds: number) => {
    db.recordReadingTime(bookId, seconds);
  });

  ipcMain.handle('stats:readingTime', () => {
    return db.getReadingTimeStats();
  });

  // ============ AI 阅读助手 ============
  // 配置来自设置页（aiBaseUrl/aiModel/aiApiKey），支持 Ollama / OpenAI / 兼容接口

  function getAiService(): AiService {
    const baseUrl = (db.getSetting('aiBaseUrl') || 'http://localhost:11434').replace(/\/$/, '');
    const model = db.getSetting('aiModel') || 'minicpm5-1b';
    const apiKey = db.getSetting('aiApiKey') || undefined;
    return new AiService({ provider: 'custom', baseUrl, model, apiKey });
  }

  ipcMain.handle('ai:summarize', async (_event, text: string) => {
    if (!text?.trim()) throw new Error('没有可总结的内容');
    return getAiService().summarize(text.slice(0, 8000));
  });

  ipcMain.handle('ai:explain', async (_event, text: string, question: string) => {
    if (!text?.trim()) throw new Error('没有可解读的内容');
    if (!question?.trim()) throw new Error('请输入问题');
    return getAiService().explain(text.slice(0, 8000), question.trim());
  });

  ipcMain.handle('ai:translate', async (_event, text: string) => {
    if (!text?.trim()) throw new Error('没有可翻译的内容');
    return getAiService().translate(text.slice(0, 4000));
  });

  // ============ WebDAV 同步 ============
  // 同步内容：进度、书签、笔记、书源、设置（不含书籍文件，跨设备需各自导入同名书籍）

  function getSyncClient() {
    const url = db.getSetting('webdavUrl');
    const user = db.getSetting('webdavUser');
    const pass = db.getSetting('webdavPass');
    if (!url) throw new Error('请先在设置页配置 WebDAV 服务器地址');
    // webdav 包为 ESM，用动态导入兼容 CJS 主进程
    return { url, user: user || '', pass: pass || '' };
  }

  ipcMain.handle('sync:backup', async () => {
    const { url, user, pass } = getSyncClient();
    const { createClient } = await import('webdav');
    const client = createClient(url, { username: user, password: pass });

    const books = db.getAllBooks() as any[];
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      books: books.map(b => ({
        title: b.title,
        author: b.author,
        file_type: b.file_type,
        progress: b.progress,
        last_read_at: b.last_read_at,
      })),
      bookmarks: books.flatMap(b =>
        (db.getBookmarksByBookId(b.id) as any[]).map(m => ({ book: b.title, position: m.position, text: m.text })),
      ),
      notes: books.flatMap(b =>
        (db.getNotesByBookId(b.id) as any[]).map(n => ({
          book: b.title,
          position: n.position,
          selected_text: n.selected_text,
          note: n.note,
        })),
      ),
      sources: db.getAllSources(),
      settings: ['fontSize', 'lineHeight', 'theme', 'aiProvider', 'aiBaseUrl', 'aiModel'].map(k => ({
        key: k,
        value: db.getSetting(k),
      })),
    };
    await client.putFileContents('/book-reader-backup.json', JSON.stringify(payload, null, 2), {
      overwrite: true,
    });
    db.setSetting('lastSyncAt', new Date().toLocaleString());
    return true;
  });

  ipcMain.handle('sync:restore', async () => {
    const { url, user, pass } = getSyncClient();
    const { createClient } = await import('webdav');
    const client = createClient(url, { username: user, password: pass });

    const raw = (await client.getFileContents('/book-reader-backup.json', { format: 'text' })) as string;
    const data = JSON.parse(raw as string);
    if (!data || data.version !== 1) throw new Error('备份文件格式不正确');

    const localBooks = db.getAllBooks() as any[];
    const findLocal = (title: string) => localBooks.find(b => b.title === title);
    let restored = 0;

    // 进度：远端更新则覆盖
    for (const rb of data.books || []) {
      const local = findLocal(rb.title);
      if (!local) continue;
      if ((rb.last_read_at || '') > (local.last_read_at || '')) {
        db.updateBookProgress(local.id, rb.progress ?? 0);
        restored++;
      }
    }
    // 书签笔记：按书名匹配、position 去重插入
    for (const m of data.bookmarks || []) {
      const local = findLocal(m.book);
      if (!local) continue;
      const exists = (db.getBookmarksByBookId(local.id) as any[]).some(x => x.position === m.position);
      if (!exists) {
        db.insertBookmark({ book_id: local.id, position: m.position, text: m.text });
        restored++;
      }
    }
    for (const n of data.notes || []) {
      const local = findLocal(n.book);
      if (!local) continue;
      const exists = (db.getNotesByBookId(local.id) as any[]).some(
        x => x.position === n.position && x.note === n.note,
      );
      if (!exists) {
        db.insertNote({ book_id: local.id, position: n.position, selected_text: n.selected_text, note: n.note });
        restored++;
      }
    }
    // 书源：按 name+url 去重
    const localSources = db.getAllSources() as any[];
    for (const s of data.sources || []) {
      if (!localSources.some(x => x.name === s.name && x.url === s.url)) {
        db.insertSource({
          name: s.name,
          url: s.url,
          search_url: s.search_url || '',
          chapters_url: s.chapters_url || '',
          content_url: s.content_url || '',
          rules: s.rules || '',
        });
        restored++;
      }
    }
    // 阅读偏好设置
    for (const s of data.settings || []) {
      if (s.value != null) db.setSetting(s.key, String(s.value));
    }
    db.setSetting('lastSyncAt', new Date().toLocaleString());
    return restored;
  });

  // ============ Settings ============

  ipcMain.handle('settings:get', (_event, key: string) => {
    return db.getSetting(key);
  });

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.setSetting(key, value);
  });
}
