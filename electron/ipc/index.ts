import { ipcMain, dialog, BrowserWindow, app, shell, Notification, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../services/db.service';
import { extractMetadata, extractToc, docxToChapters, mdToChapters, extractBookSections, readPlainTextFile, TXT_TOC_RULE_NAMES, type TxtTocOptions } from '../services/metadata';
import { buildCrawlerFromRow, applyTextFilters } from '../services/book-source';
import { splitText, cosine, embedTexts } from '../services/rag';
import { buildEpub } from '../services/epub-export';
import { AiService } from '../services/ai-service';
import {
  buildBackupFile,
  writeBackup,
  readBackup,
  mergeBackup,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
} from '../services/local-backup';
import { ModelService } from '../services/model-service';
import { listComicPages, readComicPage } from '../services/comic';
import { extractCover } from '../services/cover';
import { contentHash } from '../services/file-hash';
import { dirSize, clearSnapshots } from '../services/cache';
import { folderWatcher } from '../services/watch-folder';
import { loadRenderer } from '../renderer-window';
import { fontsDir, localFileUrl } from '../services/local-file';
import {
  mergePdfs,
  extractPages,
  deletePages,
  rotatePages,
  cropPages,
  addWatermark,
  addPageNumbers,
} from '../services/pdf-edit';
import { buildBookListMarkdown, buildBookBackup, backupFileName, localDateStamp } from '../services/book-export';

/**
 * 补全缺失的封面：封面提取是后加的，此前入库的书都没有封面。
 * 逐个处理、单本失败跳过，不影响其它书与界面。
 */
async function backfillCovers(db: DatabaseService) {
  for (const book of db.getBooksWithoutCover()) {
    try {
      const hash = book.hash || contentHash(book.file_path);
      const cover = await extractCover(book.file_path, '.' + book.file_type, hash);
      if (cover) db.setBookCover(book.id, cover);
    } catch { /* 跳过这本 */ }
  }
}

const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

/** 列出用户导入的本地字体；family 取文件名，渲染进程据此声明 @font-face */
function listLocalFonts(): { name: string; family: string; url: string }[] {
  const dir = fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => /\.(ttf|otf|woff2?|ttc)$/i.test(f))
    .sort()
    .map(f => ({
      name: f,
      family: path.basename(f, path.extname(f)),
      url: localFileUrl(path.join(dir, f)),
    }));
}

/** 章节内容统一入口：缓存 → 抓取 → 净化 → 回写缓存 */
async function fetchChapterContent(
  db: DatabaseService,
  sourceId: number,
  book: { url: string; title: string },
  chapter: { url: string; title: string; idx: number },
): Promise<string> {
  const cached = db.getCachedChapter(chapter.url) as { content: string } | undefined;
  // 缓存也过一遍当前规则（后加的规则对旧缓存生效）
  if (cached?.content) return applyTextFilters(cached.content, db.getEnabledFilters());

  const source = db.getSourceById(sourceId) as any;
  if (!source) throw new Error('书源不存在');
  const crawler = buildCrawlerFromRow(source);
  if (!crawler) throw new Error('该书源缺少抓取规则，请编辑补充选择器');
  let content = await crawler.getContent(chapter.url);
  if (content) {
    // 全局净化规则
    content = applyTextFilters(content, db.getEnabledFilters());
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
}

/** 导入冲突处理策略：skip=跳过 / keep=各留一本 / replace=覆盖已有记录 */
type ImportConflictPolicy = 'skip' | 'keep' | 'replace';

/** 单文件导入复用逻辑（对话框/拖拽共用） */
async function importOneFile(db: DatabaseService, filePath: string, policyOverride?: ImportConflictPolicy) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.epub', '.txt', '.pdf', '.docx', '.cbz', '.cbt', '.md'].includes(ext)) {
    throw new Error(`不支持的格式：${ext || '(无后缀)'}`);
  }
  const fileName = path.basename(filePath, path.extname(filePath));
  const hash = contentHash(filePath);
  const booksDir = path.join(app.getPath('userData'), 'books');
  if (!fs.existsSync(booksDir)) {
    fs.mkdirSync(booksDir, { recursive: true });
  }

  // 元数据先取：冲突检测要用书名，落盘也得用同一个标题
  const meta = await extractMetadata(filePath, ext);
  const title = meta?.title ?? fileName;
  // 冲突有两种：指纹相同=内容一模一样；同名=同一本书的另一个版本或格式
  const conflict = (db.findBookByHash(hash) ?? db.findBookByTitle(title)) as
    | { id: number; title?: string }
    | undefined;
  const policy: ImportConflictPolicy =
    policyOverride ??
    (() => {
      // 设置里读到脏值就按最保守的「跳过」处理
      const stored = db.getSetting('importConflictPolicy');
      return stored === 'keep' || stored === 'replace' ? stored : 'skip';
    })();
  if (conflict && policy === 'skip') {
    // 默认策略沿用旧的「直接跳过」，但把书名和改法说清楚
    throw new Error(`与《${conflict.title ?? title}》重复，已跳过（可在设置里改为保留或替换）`);
  }
  if (conflict && policy === 'replace' && (db.getBookById(conflict.id) as { locked?: number })?.locked) {
    // 提前拦下：锁定书不许替换，也免得白拷一份文件再失败
    throw new Error(`《${conflict.title ?? title}》已锁定，无法替换。请先在书架右键解锁。`);
  }

  // DOCX / Markdown：导入时转 EPUB 落盘，后续全按 EPUB 走（阅读/目录/检索零改动）
  const convertible = ext === '.docx' || ext === '.md';
  let storePath = filePath;
  let storeExt = ext;
  let convertedToc: { label: string; href: string }[] | null = null;
  if (convertible) {
    const label = ext === '.docx' ? 'DOCX' : 'Markdown';
    const chapters = ext === '.docx' ? await docxToChapters(filePath) : await mdToChapters(filePath);
    if (chapters.length === 0) throw new Error(`${label} 内容为空或解析失败`);
    const { buildEpub } = await import('../services/epub-export');
    const buf = await buildEpub(title, chapters);
    storePath = path.join(booksDir, `${Date.now()}-${fileName}.epub`);
    fs.writeFileSync(storePath, buf);
    storeExt = '.epub';
    convertedToc = chapters.map((c, i) => ({ label: c.title, href: `Text/ch${i + 1}.xhtml` }));
  } else {
    const destPath = path.join(booksDir, `${Date.now()}-${path.basename(filePath)}`);
    fs.copyFileSync(filePath, destPath);
    storePath = destPath;
  }

  // 封面提取失败不阻塞导入，书架会退回格式占位块
  let coverUrl: string | null = null;
  try {
    coverUrl = await extractCover(storePath, storeExt, hash);
  } catch { /* 忽略 */ }
  const fields = {
    title,
    author: meta?.author,
    cover_path: coverUrl ?? undefined,
    file_path: storePath,
    file_type: storeExt.slice(1),
    hash,
  };
  // 提取目录（转格式的书用转换时的章节，EPUB 读 NCX）
  let tocJson = '';
  try {
    const toc = convertedToc ?? (await extractToc(storePath, storeExt));
    if (toc.length > 0) tocJson = JSON.stringify(toc);
  } catch { /* 目录失败不阻塞导入 */ }

  // 替换：覆盖已有记录，id 不变，书签/笔记/进度都留着
  if (conflict && policy === 'replace') {
    const before = db.getBookById(conflict.id) as { file_path?: string } | undefined;
    db.replaceBookFile(conflict.id, fields);
    if (tocJson) db.setBookToc(conflict.id, tocJson);
    // 旧副本还在书库目录里且已不被引用，顺手删掉免得白占空间
    const oldPath = before?.file_path;
    if (oldPath && oldPath !== storePath && oldPath.startsWith(booksDir)) {
      try {
        fs.unlinkSync(oldPath);
      } catch { /* 删不掉就留着，不影响阅读 */ }
    }
    return { id: conflict.id, path: storePath };
  }

  // 无冲突，或策略是「保留」：按新书入库
  const id = db.insertBook(fields);
  if (tocJson) db.setBookToc(Number(id), tocJson);
  return { id: Number(id), path: storePath };
}

/** 文档比较：单侧最多取这么多行，超出部分截断并在界面提示 */
const COMPARE_MAX_LINES = 20000;

/** 取一本书的文本行用于比较；不支持的格式返回 null */
async function bookTextLines(book: any): Promise<string[] | null> {
  const ext = ('.' + book.file_type) as string;
  try {
    if (ext === '.txt') {
      return readPlainTextFile(book.file_path).split('\n');
    }
    if (ext === '.epub') {
      const sections = await extractBookSections(book.file_path, ext, book.toc ?? '');
      return sections.map((s: any) => s.text).join('\n').split('\n');
    }
  } catch { /* 解析失败按不可比处理 */ }
  return null;
}

export function registerIpcHandlers() {
  const db = DatabaseService.getInstance();

  /**
   * 汇总某本书的 TXT 目录解析配置。
   * 本书指定的规则优先；否则取设置页的全局三档配置（默认 / 关键字 / 正则）。
   */
  const txtTocOptionsFor = (bookId: number): TxtTocOptions => {
    const ruleName = db.getBookTocRule(bookId);
    if (ruleName) return { ruleName };
    return {
      mode: (db.getSetting('txtTocMode') as TxtTocOptions['mode']) || 'default',
      keyword: db.getSetting('txtTocKeyword') ?? '',
      regex: db.getSetting('txtTocRegex') ?? '',
    };
  };

  // 启动后异步补全缺失的封面，不阻塞界面
  setTimeout(() => { void backfillCovers(db); }, 3000);

  // ============ Books ============

  ipcMain.handle('books:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: '导入书籍',
      filters: [
        { name: '电子书', extensions: ['epub', 'txt', 'pdf', 'docx', 'cbz', 'cbt', 'md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled) return [];

    const imported = [];
    const failed: { name: string; reason: string }[] = [];
    for (const filePath of result.filePaths) {
      try {
        imported.push(await importOneFile(db, filePath));
      } catch (err) {
        failed.push({
          name: path.basename(filePath),
          reason: err instanceof Error ? err.message : '导入失败',
        });
      }
    }

    return { imported, failed };
  });

  // 拖拽导入（渲染进程传真实路径）
  ipcMain.handle('books:importPaths', async (_event, filePaths: string[]) => {
    const imported = [];
    const failed: { name: string; reason: string }[] = [];
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          imported.push(await importOneFile(db, filePath));
        }
      } catch (err) {
        failed.push({
          name: path.basename(filePath),
          reason: err instanceof Error ? err.message : '导入失败',
        });
      }
    }
    return { imported, failed };
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

  // 书籍锁定：防误删误改（仅保留阅读）
  ipcMain.handle('books:toggleLock', (_event, id: number) => {
    return db.toggleBookLock(id);
  });

  // 导出书籍清单（Markdown）
  ipcMain.handle('books:exportList', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const books = db.getAllBooks() as any[];
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出书籍清单',
      defaultPath: `书籍清单-${localDateStamp()}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, buildBookListMarkdown(books), 'utf-8');
    return { filePath, count: books.length };
  });

  // 单本书备份：带走阅读痕迹（不含书籍文件）
  ipcMain.handle('books:exportOne', async (event, id: number) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出书籍备份',
      defaultPath: backupFileName(book.title),
      filters: [{ name: '备份文件', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    const payload = buildBookBackup(
      book,
      db.getBookmarksByBookId(id),
      db.getNotesByBookId(id),
      db.getReadingPositions(id, 100),
    );
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    const n = payload.bookmarks.length + payload.notes.length + payload.positions.length;
    return { filePath, count: n };
  });

  // 批量场景：显式设置（不做 toggle）
  ipcMain.handle('books:setLock', (_event, id: number, locked: boolean) => {
    db.setBookLock(id, locked);
  });

  // 系列分组
  ipcMain.handle('books:setSeries', (_event, id: number, series: string) => {
    db.setBookSeries(id, series);
  });

  ipcMain.handle('books:seriesList', () => {
    return db.getSeriesList();
  });

  // 阅读状态与星级评分
  ipcMain.handle('books:setStatus', (_event, id: number, status: string) => {
    db.setBookStatus(id, status);
  });

  ipcMain.handle('books:setRating', (_event, id: number, rating: number) => {
    db.setBookRating(id, rating);
  });

  // ============ 多进度断点 ============

  ipcMain.handle('positions:list', (_event, bookId: number) => {
    return db.getReadingPositions(bookId);
  });

  ipcMain.handle('positions:add', (_event, p: any) => {
    const id = db.addReadingPosition(p);
    // 自动来源定期裁剪，手动标记永久保留
    if (p?.source === 'exit' || p?.source === 'crash') {
      db.pruneReadingPositions(p.book_id, 5);
    }
    return id;
  });

  ipcMain.handle('positions:delete', (_event, id: number) => {
    db.deleteReadingPosition(id);
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
    const toc = await extractToc(book.file_path, '.' + book.file_type, txtTocOptionsFor(id));
    if (toc.length > 0) db.setBookToc(id, JSON.stringify(toc));
    return toc;
  });

  // 可选的目录规则名 + 本书当前指定（空串为自动择优）+ 当前目录来源
  ipcMain.handle('books:tocRules', (_event, id: number) => ({
    rules: TXT_TOC_RULE_NAMES,
    current: db.getBookTocRule(id),
    source: db.getBookTocSource(id),
  }));

  // 按当前配置重新解析目录；传入 ruleName 则先切换本书规则（空串=恢复自动）
  ipcMain.handle('books:reparseToc', async (_event, id: number, ruleName?: string) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (ruleName !== undefined) db.setBookTocRule(id, ruleName);
    const toc = await extractToc(book.file_path, '.' + book.file_type, txtTocOptionsFor(id));
    db.setBookToc(id, JSON.stringify(toc));
    return toc;
  });

  // 保存手动编辑后的目录
  ipcMain.handle('books:saveToc', (_event, id: number, entries: unknown[]) => {
    db.setBookToc(id, JSON.stringify(Array.isArray(entries) ? entries : []), 'manual');
  });

  // 在新窗口打开书籍（多文档并行阅读）
  ipcMain.handle('window:openReader', (_event, bookId: number) => {
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    loadRenderer(win, bookId);
    if (db.getSetting('screenProtection') === 'true') win.setContentProtection(true);
  });

  // 打印预览：把渲染进程生成的打印页开在独立窗口里，由该窗口的「打印」按钮调用系统打印
  ipcMain.handle('books:printPreview', async (_event, html: string, title: string) => {
    // 走临时文件而非 data: URL——正文可能很大，data: URL 在部分导航场景会被截断
    const tmpFile = path.join(app.getPath('temp'), `book-reader-print-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, 'utf-8');
    const win = new BrowserWindow({
      width: 900,
      height: 760,
      title: title || '打印预览',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.on('closed', () => {
      try { fs.unlinkSync(tmpFile); } catch { /* 已删除则忽略 */ }
    });
    await win.loadFile(tmpFile);
    return true;
  });

  // 阅读截图：直接截窗口可见区域，TXT / EPUB / PDF / 漫画一套逻辑通用。
  // 高分屏下 capturePage 按显示器缩放率出图，导出的 PNG 是原始像素而非拉大的。
  ipcMain.handle(
    'reader:exportImage',
    async (event, rect: { x: number; y: number; width: number; height: number }, title: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('窗口已关闭');
      const image = await win.webContents.capturePage(rect);
      // 书名里的 : * ? 等在 Windows 上是非法文件名字符，先替掉
      const safe = (title || '阅读截图').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || '阅读截图';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出当前页为图片',
        defaultPath: `${safe}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (canceled || !filePath) return null;
      fs.writeFileSync(filePath, image.toPNG());
      return filePath;
    },
  );

  // 漫画包页面清单（按自然序）
  ipcMain.handle('books:comicPages', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    return listComicPages(book.file_path);
  });

  // 漫画单页数据：{ data: base64, mime }，条目不存在返回 null
  ipcMain.handle('books:comicPage', async (_event, id: number, name: string) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    return readComicPage(book.file_path, name);
  });

  // 全屏切换
  ipcMain.handle('window:toggleFullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });

  // 窗口置顶
  ipcMain.handle('window:setAlwaysOnTop', (event, flag: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.setAlwaysOnTop(!!flag);
    return win.isAlwaysOnTop();
  });

  // 防截屏：窗口内容在截图/录屏中不显示（Windows 由系统合成器屏蔽）。
  // 只做截屏防护——复制与打印是本阅读器的正经功能，全局屏蔽会把它自己砍掉。
  ipcMain.handle('window:setContentProtection', (_event, flag: boolean) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setContentProtection(!!flag);
    }
    return !!flag;
  });

  // EPUB 位置索引缓存
  ipcMain.handle('books:setLocations', (_event, id: number, locationsJson: string) => {
    db.setBookLocations(id, locationsJson);
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
      return fetchChapterContent(db, sourceId, book, chapter);
    },
  );

  // 整本缓存并导出 TXT
  ipcMain.handle(
    'sources:exportTxt',
    async (event, sourceId: number, book: { url: string; title: string }, chapters: { name: string; url: string }[]) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: '导出 TXT',
        defaultPath: `${sanitizeFileName(book.title)}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return null;

      const parts: string[] = [book.title, ''];
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        const content = await fetchChapterContent(db, sourceId, book, {
          url: ch.url,
          title: ch.name,
          idx: i,
        });
        parts.push(`\n${ch.name}\n\n${content || '（本章获取失败）'}\n`);
      }
      fs.writeFileSync(filePath, parts.join('\n'), 'utf-8');
      return filePath;
    },
  );

  // 整本缓存并导出 EPUB
  ipcMain.handle(
    'sources:exportEpub',
    async (event, sourceId: number, book: { url: string; title: string }, chapters: { name: string; url: string }[]) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: '导出 EPUB',
        defaultPath: `${sanitizeFileName(book.title)}.epub`,
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      });
      if (canceled || !filePath) return null;

      const contents: { title: string; content: string }[] = [];
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        const content = await fetchChapterContent(db, sourceId, book, {
          url: ch.url,
          title: ch.name,
          idx: i,
        });
        contents.push({ title: ch.name, content: content || '（本章获取失败）' });
      }
      const buf = await buildEpub(book.title, contents);
      fs.writeFileSync(filePath, buf);
      return filePath;
    },
  );

  // ============ 文本净化规则 ============

  ipcMain.handle('filters:list', () => {
    return db.getAllFilters();
  });

  ipcMain.handle('filters:add', (_event, filter: any) => {
    try {
      return db.insertFilter(filter);
    } catch {
      throw new Error('正则表达式非法，请检查');
    }
  });

  ipcMain.handle('filters:toggle', (_event, id: number, enabled: number) => {
    db.toggleFilter(id, enabled);
  });

  ipcMain.handle('filters:delete', (_event, id: number) => {
    db.deleteFilter(id);
  });

  // ============ 追更订阅 ============

  ipcMain.handle('follows:list', () => {
    return db.getFollowedBooks();
  });

  ipcMain.handle('follows:add', (_event, follow: any) => {
    db.followBook(follow);
  });

  ipcMain.handle('follows:remove', (_event, id: number) => {
    db.unfollowBook(id);
  });

  ipcMain.handle('follows:clearUpdate', (_event, id: number) => {
    db.clearFollowUpdate(id);
  });

  // 检查指定/全部订阅更新，有新章节弹系统通知
  ipcMain.handle('follows:check', async (_event, ids?: number[]) => {
    const all = db.getFollowedBooks() as any[];
    const targets = ids?.length ? all.filter(f => ids.includes(f.id)) : all;
    const updated: { id: string | number; title: string; newCount: number }[] = [];
    for (const f of targets) {
      try {
        const source = db.getSourceById(f.source_id) as any;
        if (!source) continue;
        const crawler = buildCrawlerFromRow(source);
        if (!crawler) continue;
        const chapters = await crawler.getChapters(f.book_url);
        if (chapters.length === 0) continue;
        const lastName = chapters[chapters.length - 1].name;
        const isNew =
          chapters.length > (f.last_count ?? 0) || (lastName && lastName !== (f.last_chapter ?? ''));
        db.updateFollowResult(f.id, lastName, chapters.length, !!isNew);
        if (isNew) updated.push({ id: f.id, title: f.title, newCount: chapters.length });
      } catch (err) {
        console.error(`检查更新失败 [${f.title}]:`, err);
      }
    }
    if (updated.length > 0 && Notification.isSupported()) {
      new Notification({
        title: '追更提醒',
        body: updated.map(u => `《${u.title}》有更新（共 ${u.newCount} 章）`).join('\n'),
      }).show();
    }
    return updated;
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

  // 跨书籍笔记汇总（带书名）与标签更新
  ipcMain.handle('notes:getAll', () => {
    return db.getAllNotes();
  });

  ipcMain.handle('notes:updateTags', (_event, id: number, tags: string) => {
    db.updateNoteTags(id, tags);
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

  ipcMain.handle('stats:weekly', (_event, days: number) => {
    return db.getDailyDurations(Math.min(Math.max(days || 7, 1), 30));
  });

  // ============ 生词本 ============

  ipcMain.handle('words:list', () => {
    return db.getAllWords();
  });

  ipcMain.handle('words:add', (_event, word: any) => {
    if (!word?.word?.trim()) throw new Error('词语不能为空');
    return db.insertWord(word);
  });

  ipcMain.handle('words:delete', (_event, id: number) => {
    db.deleteWord(id);
  });

  // 书签改名
  ipcMain.handle('bookmarks:update', (_event, id: number, text: string) => {
    if (!text?.trim()) throw new Error('书签内容不能为空');
    db.updateBookmarkText(id, text);
  });

  // ============ RAG 语义检索 ============

  function getEmbedBaseUrl(): string {
    return db.getSetting('aiEmbedUrl') || 'http://localhost:8081';
  }

  ipcMain.handle('rag:status', () => {
    return db.getVectorStats();
  });

  // 为一本书建索引（全量重建）：抽文本 → 切分 → embedding → 入库
  ipcMain.handle('rag:build', async (_event, bookId: number) => {
    const book = db.getBookById(bookId) as any;
    if (!book) throw new Error('书籍不存在');
    const sections = await extractBookSections(book.file_path, '.' + book.file_type, book.toc);
    const chunks = sections.flatMap(s => splitText({ label: s.label, target: s.target, text: s.text }));
    if (chunks.length === 0) throw new Error('未能提取正文，无法建索引');
    const vectors = await embedTexts(
      chunks.map(c => c.text),
      getEmbedBaseUrl(),
    );
    db.clearBookVectors(bookId);
    db.saveVectors(
      chunks.map((c, i) => ({
        book_id: bookId,
        chunk_idx: i,
        chapter: c.label,
        target: c.target,
        text: c.text,
        embedding: JSON.stringify(vectors[i]),
      })),
    );
    return { chunks: chunks.length };
  });

  ipcMain.handle('rag:clear', (_event, bookId: number) => {
    db.clearBookVectors(bookId);
  });

  // 语义检索：问题向量化 → 余弦 TopK
  ipcMain.handle('rag:search', async (_event, query: string, topK: number, bookId?: number) => {
    if (!query?.trim()) throw new Error('请输入问题');
    const all = db.getAllVectors() as any[];
    const rows = bookId ? all.filter(v => v.book_id === bookId) : all;
    if (rows.length === 0) throw new Error('还没有建立索引，先去语义检索页为书籍建索引');
    const [qvec] = await embedTexts([query.trim().slice(0, 1000)], getEmbedBaseUrl());
    const books = db.getAllBooks() as any[];
    const titleOf = (id: number) => books.find(b => b.id === id)?.title ?? '';
    return rows
      .map(r => {
        let embedding: number[] = [];
        try {
          embedding = JSON.parse(r.embedding);
        } catch { /* 跳过坏向量 */ }
        return {
          book_id: r.book_id,
          bookTitle: titleOf(r.book_id),
          chapter: r.chapter,
          target: r.target,
          excerpt: r.text.slice(0, 300),
          score: cosine(qvec, embedding),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(topK || 8, 1), 20));
  });

  // ============ 本地模型管理 ============

  ipcMain.handle('models:status', () => {
    return ModelService.getInstance().status();
  });

  ipcMain.handle('models:download', async (_event, id: string) => {
    await ModelService.getInstance().downloadModel(id);
    return true;
  });

  ipcMain.handle('models:start', async (_event, id: string) => {
    await ModelService.getInstance().start(id);
    return true;
  });

  ipcMain.handle('models:stop', (_event, id: string) => {
    ModelService.getInstance().stop(id);
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

  ipcMain.handle('ai:mindmap', async (_event, text: string) => {
    if (!text?.trim()) throw new Error('没有可生成导图的内容');
    return getAiService().generateMindmap(text.slice(0, 6000));
  });

  // ============ AI 流式输出 ============
  // 单通道 + per-request 事件：ai:token:${reqId} / ai:done:${reqId} / ai:error:${reqId}
  // 进程内走逐 token 回调；回退 HTTP 时整包到达（一次性 done，无中间 token）

  const aiAbortControllers = new Map<string, AbortController>();

  type AiStreamKind = 'summarize' | 'explain' | 'translate' | 'mindmap';
  const AI_STREAM_SLICE: Record<AiStreamKind, number> = {
    summarize: 8000,
    explain: 8000,
    translate: 4000,
    mindmap: 6000,
  };

  ipcMain.handle(
    'ai:stream',
    async (
      event,
      payload: { reqId: string; kind: AiStreamKind; text: string; question?: string },
    ) => {
      const { reqId, kind, text, question } = payload;
      if (!reqId || !AI_STREAM_SLICE[kind]) throw new Error('非法流式请求');
      if (!text?.trim()) throw new Error('没有可处理的内容');
      if (kind === 'explain' && !question?.trim()) throw new Error('请输入问题');
      const sender = event.sender;
      const send = (channel: string, data: unknown) => {
        try {
          if (!sender.isDestroyed()) sender.send(channel, data);
        } catch { /* 窗口已关则忽略 */ }
      };
      const controller = new AbortController();
      aiAbortControllers.set(reqId, controller);
      const onToken = (chunk: string) => send(`ai:token:${reqId}`, chunk);
      try {
        const svc = getAiService();
        const input = text.slice(0, AI_STREAM_SLICE[kind]);
        let full = '';
        if (kind === 'summarize') full = await svc.summarize(input, onToken, controller.signal);
        else if (kind === 'explain') full = await svc.explain(input, question!.trim(), onToken, controller.signal);
        else if (kind === 'translate') full = await svc.translate(input, 'zh-CN', onToken, controller.signal);
        else full = await svc.generateMindmap(input, onToken, controller.signal);
        send(`ai:done:${reqId}`, full);
        return full;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI 调用失败';
        // 主动中断不算错误静默收尾（已输出部分保留）
        if (controller.signal.aborted) {
          send(`ai:done:${reqId}`, '');
          return '';
        }
        send(`ai:error:${reqId}`, message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        aiAbortControllers.delete(reqId);
      }
    },
  );

  ipcMain.handle('ai:abort', (_event, reqId: string) => {
    aiAbortControllers.get(reqId)?.abort();
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
      settings: ['fontSize', 'lineHeight', 'theme', 'fontFamily', 'ttsRate', 'aiProvider', 'aiBaseUrl', 'aiModel', 'aiEmbedUrl'].map(k => ({
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

  // 外部链接：交给系统浏览器打开（仅放行 http/https）
  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接');
    await shell.openExternal(url);
  });

  // ============ 应用信息（静态只读，不联网） ============

  // ============ 本地字体 ============

  ipcMain.handle('fonts:list', () => listLocalFonts());

  // 导入本地字体：拷进用户字体目录，之后按文件名当 family 用（无需解析字体内部元数据）
  ipcMain.handle('fonts:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: '导入字体',
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return listLocalFonts();
    const dir = fontsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const filePath of result.filePaths) {
      // 用原文件名落盘，重名直接覆盖
      fs.copyFileSync(filePath, path.join(dir, sanitizeFileName(path.basename(filePath))));
    }
    return listLocalFonts();
  });

  ipcMain.handle('fonts:remove', (_event, name: string) => {
    const dir = fontsDir();
    // 只接受文件名，挡掉 ../ 之类的路径穿越
    const target = path.join(dir, path.basename(name));
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return listLocalFonts();
  });

  // ============ PDF 编辑 ============

  /** 输出文件名的中文后缀 */
  const PDF_OP_LABEL: Record<string, string> = {
    merge: '合并',
    extract: '抽取',
    deletePages: '删页',
    rotate: '旋转',
    crop: '裁剪',
    watermark: '水印',
    pageNumbers: '页码',
  };

  ipcMain.handle('pdf:run', async (_event, payload: any) => {
    const op = String(payload?.op ?? '');
    const ids: number[] = Array.isArray(payload?.sourceIds) ? payload.sourceIds : [];
    if (ids.length === 0) throw new Error('请先选择文件');
    const books = ids.map(id => db.getBookById(id) as any).filter(Boolean);
    if (books.length === 0) throw new Error('文件不存在');
    if (books.some(b => b.file_type !== 'pdf')) throw new Error('PDF 工具只支持 PDF 文件');

    // 输出位置交给用户选，避免直接改到书库里的原件
    const win = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showSaveDialog(win!, {
      title: '选择输出位置',
      defaultPath: op === 'merge'
        ? `合并结果-${localDateStamp()}.pdf`
        : `${books[0].title}-${PDF_OP_LABEL[op] ?? '输出'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (picked.canceled || !picked.filePath) return null;

    const out = picked.filePath;
    const paths = books.map(b => b.file_path);
    let pages = 0;
    switch (op) {
      case 'merge':
        pages = await mergePdfs(paths, out);
        break;
      case 'extract':
        pages = await extractPages(paths[0], payload.pages ?? '', out);
        break;
      case 'deletePages':
        pages = await deletePages(paths[0], payload.pages ?? '', out);
        break;
      case 'rotate':
        pages = await rotatePages(paths[0], payload.pages ?? '', Number(payload.angle) || 90, out);
        break;
      case 'crop':
        pages = await cropPages(paths[0], payload.pages ?? '', Number(payload.marginPercent) || 5, out);
        break;
      case 'watermark':
        pages = await addWatermark(paths[0], String(payload.text ?? ''), out);
        break;
      case 'pageNumbers':
        pages = await addPageNumbers(paths[0], out);
        break;
      default:
        throw new Error(`未知的操作：${op}`);
    }
    return { filePath: out, pages };
  });

  // 文档比较：一次取两本书的文本行，差异在渲染进程算（纯函数，可单测）
  ipcMain.handle('compare:load', async (_event, idA: number, idB: number) => {
    const a = db.getBookById(idA) as any;
    const b = db.getBookById(idB) as any;
    if (!a || !b) throw new Error('书籍不存在');
    const [left, right] = await Promise.all([bookTextLines(a), bookTextLines(b)]);
    if (!left || !right) throw new Error('该格式暂不支持比较（目前支持 TXT / EPUB）');
    const clip = (lines: string[]) => ({
      lines: lines.slice(0, COMPARE_MAX_LINES),
      total: lines.length,
      truncated: lines.length > COMPARE_MAX_LINES,
    });
    return {
      left: { title: a.title, ...clip(left) },
      right: { title: b.title, ...clip(right) },
    };
  });

  ipcMain.handle('app:info', () => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      dataDir: app.getPath('userData'),
      booksDir: path.join(app.getPath('userData'), 'books'),
    };
  });

  // ============ 文件夹监视（自动入库） ============

  const watcher = folderWatcher();
  watcher.onReady = async (filePath: string) => {
    try {
      // 监视入库固定「跳过」：同一个文件被改动就会再触发一次，
      // 用保留/替换策略会不断往书架上堆副本
      await importOneFile(db, filePath, 'skip');
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send('watch:imported', path.basename(filePath));
    } catch (err) {
      // 目录里本来就有已入库的书，重复跳过属常态，不打扰用户
      console.warn(`监视入库跳过 [${filePath}]:`, err instanceof Error ? err.message : err);
    }
  };

  ipcMain.handle('watch:start', async (event, dir: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    watcher.start(dir);
    db.setSetting('watchDir', dir);
    return { dir: watcher.watchingDir(), ok: true, _win: !!win };
  });

  ipcMain.handle('watch:stop', () => {
    watcher.stop();
    db.setSetting('watchDir', '');
    return true;
  });

  ipcMain.handle('watch:status', () => {
    // 未在监视但设置里有目录 → 说明重启后还没恢复，交给调用方决定是否恢复
    const saved = db.getSetting('watchDir') || '';
    return {
      watching: watcher.isWatching(),
      dir: watcher.watchingDir(),
      savedDir: saved,
    };
  });

  ipcMain.handle('watch:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择要监视的文件夹',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  // ============ 缓存管理（纯本地） ============

  ipcMain.handle('cache:stats', () => {
    const snapDir = path.join(app.getPath('userData'), 'snapshots');
    const booksDir = path.join(app.getPath('userData'), 'books');
    return {
      chapterCount: db.countCachedChapters(),
      snapshotBytes: dirSize(snapDir),
      booksBytes: dirSize(booksDir),
    };
  });

  ipcMain.handle('cache:clear', (_event, opts: { snapshots?: boolean; chapterCache?: boolean }) => {
    const result: Record<string, number> = {};
    if (opts?.snapshots) {
      result.snapshots = clearSnapshots(path.join(app.getPath('userData'), 'snapshots'));
    }
    if (opts?.chapterCache) {
      result.chapterCache = db.clearChapterCache();
    }
    return result;
  });

  // ============ 隐私清理（纯本地） ============

  ipcMain.handle(
    'privacy:clear',
    (
      _event,
      opts: { positions?: boolean; chapterCache?: boolean; timestamps?: boolean; clipboard?: boolean },
    ) => {
      const result: Record<string, number | boolean> = {};
      if (opts?.positions) result.positions = db.clearAutoPositions();
      if (opts?.chapterCache) result.chapterCache = db.clearChapterCache();
      if (opts?.timestamps) result.timestamps = db.clearReadingTimestamps();
      if (opts?.clipboard) {
        clipboard.clear();
        result.clipboard = true;
      }
      return result;
    },
  );

  // ============ 本地备份（纯离线，不联网） ============

  // 导出：默认增量（自上次导出后的变更），可显式要求全量
  ipcMain.handle('backup:export', async (event, full = false) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const stamp = localDateStamp();
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出备份',
      defaultPath: `book-reader-backup-${stamp}.json`,
      filters: [{ name: '备份文件', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;

    const since = full ? null : db.getSetting('lastLocalBackupAt');
    const payload = buildBackupFile(db, since);
    writeBackup(filePath, payload);
    // 仅在成功后推进增量基线，避免失败后丢变更
    db.setSetting('lastLocalBackupAt', payload.createdAt);
    const count =
      (payload.data.books?.length ?? 0) +
      (payload.data.bookmarks?.length ?? 0) +
      (payload.data.notes?.length ?? 0) +
      (payload.data.words?.length ?? 0) +
      (payload.data.sources?.length ?? 0);
    return { filePath, kind: payload.kind, count };
  });

  // 从备份文件恢复（幂等合并）
  ipcMain.handle('backup:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择备份文件',
      filters: [{ name: '备份文件', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return null;
    const payload = readBackup(filePaths[0]);
    const restored = mergeBackup(db, payload);
    return { restored, createdAt: payload.createdAt, kind: payload.kind };
  });

  // 本地快照：手动生成一份全量快照
  ipcMain.handle('backup:snapshot', () => {
    const file = createSnapshot(db);
    const pruned = pruneSnapshots(14);
    return { file, pruned };
  });

  ipcMain.handle('backup:snapshots', () => listSnapshots());

  // 从快照回退
  ipcMain.handle('backup:restoreSnapshot', (_event, file: string) => {
    const payload = readBackup(file);
    const restored = mergeBackup(db, payload);
    return { restored, createdAt: payload.createdAt };
  });

  // ============ Settings ============

  ipcMain.handle('settings:get', (_event, key: string) => {
    return db.getSetting(key);
  });

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.setSetting(key, value);
  });
}
