import { ipcMain, dialog, BrowserWindow, app, shell, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../services/db.service';
import { extractMetadata, extractToc, docxRender, mdRender, mdToChapters, applyMarkdownImageMap, collectMarkdownTags, collectMarkdownTasks, collectMarkdownLinks, extractBookSections, readPlainTextFile, splitTxtChapters, TXT_TOC_RULE_NAMES, type TxtTocOptions } from '../services/metadata';
import { splitText, cosine, embedTexts } from '../services/rag';
import { AiService } from '../services/ai-service';
import {
  buildBackupFile,
  writeBackupArchive,
  collectBookFileEntries,
  extractBackupFiles,
  readBackup,
  mergeBackup,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
} from '../services/local-backup';
import { ModelService } from '../services/model-service';
import { listComicPages, readComicPage, releaseComicCacheFor } from '../services/comic';
import { extractCover, openBookImages } from '../services/cover';
import { contentHash, classifySource, readSourceSnapshot, type SourceSnapshot } from '../services/file-hash';
import { dirSize, clearSnapshots } from '../services/cache';
import { folderWatcher } from '../services/watch-folder';
import { loadRenderer } from '../renderer-window';
import { filePathFromUrl, booksDir, fontsDir, isInsideBooksDir, localFileUrl, resourcesDir } from '../services/local-file';
import {
  mergePdfs,
  extractPages,
  deletePages,
  rotatePages,
  cropPages,
  addWatermark,
  addPageNumbers,
} from '../services/pdf-edit';
import { buildBookListMarkdown, buildBookBackup, buildPlainText, parseBookBackup, backupFileName, localDateStamp, uniqueExportName } from '../services/book-export';
import { buildEpub } from '../services/epub-export';
import { applyAutoLaunch, isAutoLaunchEnabled } from '../services/auto-launch';

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

/**
 * 源文件信息按书存键，沿用 bookPrefs 那套「按书存键值」的做法，不占表结构。
 * 导入是把文件复制进书库的，源文件后来被改动或移走，书库这边无从感知——
 * 记下它导入时的大小与时间，才能在下一次打开书架时给出提示。
 */
const sourceKey = (id: number) => `sourceInfo:${id}`;

function readSourceInfo(db: DatabaseService, id: number): SourceSnapshot | null {
  const raw = db.getSetting(sourceKey(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SourceSnapshot;
    return typeof parsed?.path === 'string' && typeof parsed.size === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** 记下源文件此刻的快照；源文件已经取不到就清掉记录，免得留着一条永远判不了的旧账 */
function writeSourceInfo(db: DatabaseService, id: number, sourcePath: string) {
  const snapshot = readSourceSnapshot(sourcePath);
  db.setSetting(sourceKey(id), snapshot ? JSON.stringify(snapshot) : '');
}

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

/** 导入冲突处理策略：skip=跳过 / keep=各留一本 / replace=覆盖已有记录 */
type ImportConflictPolicy = 'skip' | 'keep' | 'replace';

/**
 * 把导入来源落成一份书库内的文件——**一律原样入库，不做格式转换**。
 *
 * 转换过一次（DOCX→EPUB）是为了复用 epubjs，但代价是原文结构被改写：标题降级成章、
 * 锚点全丢、代码块与表格走样。用户看到的就不再是自己写的那份文档。现在 Markdown 与
 * DOCX 都由阅读器直接渲染，各自保留各自的排版。
 *
 * 只有 Markdown 需要额外动作：把正文引用的本地图片一起搬进书库（见下）。
 * 导入与「从原文件更新」共用这一条，免得逻辑写两份。
 */
async function materializeIntoLibrary(filePath: string, ext: string, hash: string) {
  const booksDir = path.join(app.getPath('userData'), 'books');
  if (!fs.existsSync(booksDir)) fs.mkdirSync(booksDir, { recursive: true });
  const fileName = path.basename(filePath, path.extname(filePath));

  if (ext === '.md') {
    // 正文里引用的本地图片必须一起搬进书库：只搬 .md 的话相对路径仍指向用户
    // 原来那个目录，源目录一改名或换机就全是破图，离线阅读也就无从谈起。
    // 落盘名统一成 img-<序号>，不同目录下的同名图片不会互相覆盖。
    const assetsDir = path.join(booksDir, 'md-assets', hash);
    const copied: { absPath: string; name: string; src: string; url: string }[] = [];
    const doc = await mdRender(filePath, (abs, src) => {
      const name = `img-${copied.length + 1}${path.extname(abs).toLowerCase()}`;
      const url = localFileUrl(path.join(assetsDir, name));
      copied.push({ absPath: abs, name, src, url });
      return url;
    });

    // 先清掉上一次留下的图片目录：同一份内容重新导入时，已删掉的图不该还留在库里
    fs.rmSync(assetsDir, { recursive: true, force: true });
    if (copied.length > 0) {
      fs.mkdirSync(assetsDir, { recursive: true });
      for (const img of copied) {
        try {
          fs.copyFileSync(img.absPath, path.join(assetsDir, img.name));
        } catch { /* 个别图拷不动就留破图，不因此把整次导入打回去 */ }
      }
    }

    // 阅读时按「引用原文 → 搬好之后的地址」查表替换，不再依赖路径解析
    const imageMap: Record<string, string> = {};
    for (const img of copied) imageMap[img.src] = img.url;

    const storePath = path.join(booksDir, `${Date.now()}-${fileName}.md`);
    fs.copyFileSync(filePath, storePath);

    // 章节目录只用于汇总元数据：待办、标签、引用关系都按章组织
    const chapters = await mdToChapters(filePath);
    // 任务跳转要落到带上它的那个标题上。标题锚点是渲染时才编的号，
    // 这里按标题文本回查；对不上（标题被截断等）就留空，卡片退化成只打开这本书。
    const anchorOf = (t: string) => doc.toc.find(entry => entry.label === t)?.href ?? '';
    return {
      storePath,
      storeExt: '.md',
      convertedToc: doc.toc,
      // 顺手收下正文里的 #标签 与未完成任务，书架/统计页据此做筛选与汇总
      tags: collectMarkdownTags(chapters),
      tasks: collectMarkdownTasks(chapters, i => anchorOf(chapters[i]?.title ?? '')),
      // wiki 链接目标：用来算「谁引用了谁」
      links: collectMarkdownLinks(chapters),
      // frontmatter 属性：书架据此按属性筛书
      props: doc.props,
      images: imageMap,
    };
  }

  if (ext === '.docx') {
    // 与 Markdown 一样原样入库、由阅读器直接渲染，不再转 EPUB。
    // 转 EPUB 是为了复用 epubjs，代价是标题降级成章、锚点全丢（epubjs 的
    // display 会截掉 `#` 之后的部分），目录只能跳到章首。原样入库后目录能精确到标题，
    // 划词、位置记录也与 Markdown 走同一套。
    //
    // 图片不必另做搬运：mammoth 默认把图内联成 data: 地址，HTML 自带内容，
    // 库文件拷到哪都完整（阅读页没有配 CSP，data: 图能直接显示）。
    const doc = await docxRender(filePath);
    if (!doc.html.trim()) throw new Error('DOCX 内容为空或解析失败');
    const storePath = path.join(booksDir, `${Date.now()}-${fileName}.docx`);
    fs.copyFileSync(filePath, storePath);
    return {
      storePath,
      storeExt: '.docx',
      convertedToc: doc.toc,
      tags: undefined,
      tasks: undefined,
      links: undefined,
      props: undefined,
    };
  }

  const destPath = path.join(booksDir, `${Date.now()}-${path.basename(filePath)}`);
  fs.copyFileSync(filePath, destPath);
  return { storePath: destPath, storeExt: ext, convertedToc: null };
}

/** 单文件导入复用逻辑（对话框/拖拽共用） */
async function importOneFile(db: DatabaseService, filePath: string, policyOverride?: ImportConflictPolicy) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.epub', '.txt', '.pdf', '.docx', '.cbz', '.cbr', '.cbt', '.cb7', '.md'].includes(ext)) {
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

  // 原样复制进书库；Markdown 额外把正文引用的图片一起搬过去
  const { storePath, storeExt, convertedToc, tags, tasks, links, props, images } = await materializeIntoLibrary(filePath, ext, hash);

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
    writeSourceInfo(db, conflict.id, filePath);
    if (ext === '.md') {
      db.setSetting(`mdSource:${conflict.id}`, '1');
      if (tags) db.setSetting(`bookTags:${conflict.id}`, JSON.stringify(tags));
      db.setSetting(`mdTasks:${conflict.id}`, JSON.stringify(tasks ?? []));
      db.setSetting(`mdLinks:${conflict.id}`, JSON.stringify(links ?? []));
      db.setSetting(`mdProps:${conflict.id}`, JSON.stringify(props ?? {}));
      db.setSetting(`mdImages:${conflict.id}`, JSON.stringify(images ?? {}));
    }
    return { id: conflict.id, path: storePath };
  }

  // 无冲突，或策略是「保留」：按新书入库
  const id = db.insertBook(fields);
  if (tocJson) db.setBookToc(Number(id), tocJson);
  if (ext === '.md') {
    db.setSetting(`mdSource:${Number(id)}`, '1');
    if (tags) db.setSetting(`bookTags:${Number(id)}`, JSON.stringify(tags));
    db.setSetting(`mdTasks:${Number(id)}`, JSON.stringify(tasks ?? []));
    db.setSetting(`mdLinks:${Number(id)}`, JSON.stringify(links ?? []));
    db.setSetting(`mdProps:${Number(id)}`, JSON.stringify(props ?? {}));
    db.setSetting(`mdImages:${Number(id)}`, JSON.stringify(images ?? {}));
  }
  writeSourceInfo(db, Number(id), filePath);
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
    // EPUB / Markdown / DOCX 都走同一套按段抽文，段落之间用换行分行
    if (ext === '.epub' || ext === '.md' || ext === '.docx') {
      const sections = await extractBookSections(book.file_path, ext, book.toc ?? '');
      return sections.map((s: any) => s.text).join('\n').split('\n');
    }
  } catch { /* 解析失败按不可比处理 */ }
  return null;
}

export function registerIpcHandlers() {
  const db = DatabaseService.getInstance();

  // 联网总开关的初值：新装默认关闭
  db.initOnlineSwitch();

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
        { name: '电子书', extensions: ['epub', 'txt', 'pdf', 'docx', 'cbz', 'cbr', 'cbt', 'cb7', 'md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });

    // 取消要和「一个都没导进来」区分开：返回形状与尾部一致（{imported, failed}），
    // 调用方才能只写一条解析路径，不用先判断拿到的是数组还是对象
    if (result.canceled) return { imported: [], failed: [] };

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
      // 目录与不存在的路径不能静默跳过：调用方要靠 failed 列出「哪些没进来」，
      // 悄悄吞掉会让用户拖完文件夹后看到「点了没反应」而毫无解释
      if (!fs.existsSync(filePath)) {
        failed.push({ name: path.basename(filePath), reason: '文件不存在，可能已被移动或删除' });
        continue;
      }
      if (!fs.statSync(filePath).isFile()) {
        failed.push({ name: path.basename(filePath), reason: '这是一个文件夹，请拖入电子书文件本身' });
        continue;
      }
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

  /**
   * 源文件现状体检：导入是复制，源文件后来被改动或移走，书库这边原本无从感知。
   * 只比对「大小 + 修改时间」，几百本书就是几百次 stat；只有时间变了而大小没变，
   * 才多算一次指纹，避免「只是被 touch 过」的误报。
   */
  ipcMain.handle('books:checkSources', () => {
    const books = db.getAllBooks() as any[];
    const affected: { id: number; title: string; status: 'changed' | 'missing'; sourcePath: string }[] = [];
    for (const book of books) {
      const recorded = readSourceInfo(db, book.id);
      if (!recorded) continue; // 早于该功能导入的书没记录，无从判断
      const status = classifySource(readSourceSnapshot(recorded.path), recorded);
      if (status === 'ok') continue;
      if (status === 'changed' && book.hash) {
        try {
          if (contentHash(recorded.path) === book.hash) continue; // 内容没变，只是时间戳动了
        } catch { /* 读不了就按改动处理 */ }
      }
      affected.push({ id: book.id, title: book.title, status, sourcePath: recorded.path });
    }
    return affected;
  });

  /** 用源文件的当前版本更新书库副本：只换内容，书名作者保持用户改过的样子 */
  ipcMain.handle('books:refreshFromSource', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (book.locked) throw new Error('这本书已锁定，请先解锁再更新');
    const recorded = readSourceInfo(db, id);
    if (!recorded) throw new Error('这本书没有记录源文件位置，请手动重新导入');
    if (!fs.existsSync(recorded.path)) throw new Error('源文件已不在原位置，请手动重新导入');

    const ext = path.extname(recorded.path).toLowerCase();
    const hash = contentHash(recorded.path);
    const { storePath, storeExt, tags, tasks, links, props, images } = await materializeIntoLibrary(
      recorded.path,
      ext,
      hash,
    );

    // 封面失败就留用旧的，不因为封面把整次更新打回去
    let coverPath = book.cover_path ?? undefined;
    try {
      coverPath = (await extractCover(storePath, storeExt, hash)) ?? coverPath;
    } catch { /* 保留旧封面 */ }

    db.replaceBookFile(id, {
      title: book.title,
      author: book.author ?? undefined,
      cover_path: coverPath,
      file_path: storePath,
      file_type: storeExt.slice(1),
      hash,
    });
    try {
      const toc = await extractToc(storePath, storeExt);
      if (toc.length > 0) db.setBookToc(id, JSON.stringify(toc));
    } catch { /* 目录失败不阻塞更新 */ }

    // Markdown 的标签 / 待办 / 引用 / 属性都是从正文里现算的，源文件改了它们也会变，
    // 不跟着刷新的话统计页会一直显示改之前的旧内容
    if (ext === '.md') {
      if (tags) db.setSetting(`bookTags:${id}`, JSON.stringify(tags));
      db.setSetting(`mdTasks:${id}`, JSON.stringify(tasks ?? []));
      db.setSetting(`mdLinks:${id}`, JSON.stringify(links ?? []));
      db.setSetting(`mdProps:${id}`, JSON.stringify(props ?? {}));
      db.setSetting(`mdImages:${id}`, JSON.stringify(images ?? {}));
    }

    const booksDirPath = path.join(app.getPath('userData'), 'books');
    if (book.file_path && book.file_path !== storePath && String(book.file_path).startsWith(booksDirPath)) {
      try {
        fs.unlinkSync(book.file_path);
      } catch { /* 删不掉就留着，不影响阅读 */ }
    }
    writeSourceInfo(db, id, recorded.path);
    return { id, title: book.title, sourcePath: recorded.path, fileType: storeExt.slice(1) };
  });

  ipcMain.handle('books:getAll', () => {
    return db.getAllBooks();
  });

  ipcMain.handle('books:getById', (_event, id: number) => {
    return db.getBookById(id);
  });

  // 删除书籍：连同书库内的副本与封面一起回收。
  // 导入时文件是拷进 userData/books 的，只删数据库行会把副本永久留在磁盘上。
  // 先删文件再删记录——文件被占用时能报错中止，不至于记录没了、文件还在。
  // 但锁定判断必须在删文件之前：db.deleteBook 开头就会拦锁定书，若放到后面，
  // 会出现「文件已被删掉、记录却还在」的不可逆损坏。
  ipcMain.handle('books:delete', (_event, id: number) => {
    const book = db.getBookById(id) as
      | { id: number; file_path?: string; cover_path?: string; locked?: number; hash?: string }
      | undefined;
    if (!book) return;
    if (book.locked) {
      throw new Error('该书籍已锁定，无法删除。可在书架右键「解锁书籍」后再删。');
    }
    const targets = [book.file_path, book.cover_path ? filePathFromUrl(book.cover_path) : null];
    for (const target of targets) {
      if (!target || !isInsideBooksDir(target)) continue;
      try {
        fs.unlinkSync(target);
      } catch (err) {
        // 文件本来就不在（书库目录被手工清理过）不算失败，其余情况要让用户知道
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('无法删除书库文件，请先关闭正在使用该文件的程序再重试。');
        }
      }
    }
    // Markdown 的图片收在 md-assets/<hash> 下。同一份内容可能被存成好几本
    // （导入冲突策略选「各留一本」时），还有别的书在用就不能跟着删。
    const hash = book.hash;
    if (hash) {
      const shared = (db.getAllBooks() as { id: number; hash?: string }[]).some(
        b => b.id !== id && b.hash === hash,
      );
      if (!shared) {
        try {
          fs.rmSync(path.join(booksDir(), 'md-assets', hash), { recursive: true, force: true });
        } catch { /* 图片目录删不掉，不至于把「书已删掉」这件事也回滚 */ }
      }
    }
    db.deleteBook(id);
  });

  ipcMain.handle('books:updateProgress', (_event, id: number, progress: number) => {
    db.updateBookProgress(id, progress);
  });

  /**
   * 测试 AI 服务连通性。
   * 外接大模型时地址、密钥、模型名任一项填错都会失败，让用户先在这里当场试出来，
   * 而不是等点「总结本页」才发现。
   */
  ipcMain.handle(
    'ai:test',
    async (_event, cfg: { baseUrl: string; model: string; apiKey?: string }) => {
      const svc = new AiService(
        { provider: 'custom', baseUrl: cfg?.baseUrl ?? '', model: cfg?.model ?? '', apiKey: cfg?.apiKey },
        () => db.assertOnlineEnabled('AI 服务'),
      );
      try {
        const reply = await svc.chat([{ role: 'user', content: '只回复两个字：连通' }]);
        return { ok: true, message: (reply || '').trim().slice(0, 60) || '服务已响应' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : '连接失败，请检查地址与密钥' };
      }
    },
  );

  // Markdown 的 [[目标]] 跳转：按书名或原文件名找同一书库里的另一本书
  ipcMain.handle('books:findByWikilink', (_event, target: string) => {
    const found = db.findBookByWikilink(target, id => {
      const info = readSourceInfo(db, id);
      return info?.path ? path.basename(info.path, path.extname(info.path)) : null;
    });
    return found ?? null;
  });

  /**
   * 书库标签汇总：把各本书正文里的 #标签 收集起来供书架筛选。
   * 目前只收 Markdown 导入的书（导入时已解析并存下），其它格式不回扫正文。
   */
  ipcMain.handle('books:getAllTags', () => {
    const byTag = new Map<string, number[]>();
    for (const b of db.getAllBooks() as { id: number }[]) {
      const raw = db.getSetting(`bookTags:${b.id}`);
      if (!raw) continue;
      try {
        const list = JSON.parse(raw) as unknown;
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (typeof t !== 'string' || !t) continue;
          const ids = byTag.get(t) ?? [];
          ids.push(b.id);
          byTag.set(t, ids);
        }
      } catch { /* 脏值忽略 */ }
    }
    return [...byTag.entries()]
      .map(([tag, bookIds]) => ({ tag, bookIds, count: bookIds.length }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });

  /**
   * 未完成任务汇总：把各本书里 `- [ ]` 的项目收集起来。
   * 与标签一样，目前只覆盖 Markdown 导入的书。
   */
  ipcMain.handle('books:getAllTasks', () => {
    const out: { bookId: number; bookTitle: string; text: string; chapter: string; href: string }[] = [];
    for (const b of db.getAllBooks() as { id: number; title: string }[]) {
      const raw = db.getSetting(`mdTasks:${b.id}`);
      if (!raw) continue;
      try {
        const list = JSON.parse(raw) as unknown;
        if (!Array.isArray(list)) continue;
        for (const t of list as { text?: unknown; chapter?: unknown; href?: unknown }[]) {
          if (typeof t?.text !== 'string' || !t.text) continue;
          out.push({
            bookId: b.id,
            bookTitle: b.title,
            text: t.text,
            chapter: typeof t.chapter === 'string' ? t.chapter : '',
            href: typeof t.href === 'string' ? t.href : '',
          });
        }
      } catch { /* 脏值忽略 */ }
    }
    return out;
  });

  /** frontmatter 属性汇总：书架据此按属性筛书 */
  ipcMain.handle('books:getAllProps', () => db.getAllBookProps());

  /**
   * 引用关系：本书引用了哪些笔记、又被哪些笔记引用（Markdown 的 [[目标]]）。
   * 与标签、待办一样，只覆盖 Markdown 导入的书。
   */
  ipcMain.handle('books:getLinks', (_event, bookId: number) => {
    const sourceNameOf = (id: number) => {
      const info = readSourceInfo(db, id);
      return info?.path ? path.basename(info.path, path.extname(info.path)) : null;
    };
    return db.getBookLinks(bookId, sourceNameOf);
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

  /**
   * 本进程的启动时刻。会话标记的 value 就是写入时刻，两个一比就能分清
   * 「这条标记是本进程里某个窗口刚写下的」与「上一个进程崩溃留下的」。
   * 模块加载即进程启动，所以在这里取一次即可。
   */
  const APP_STARTED_AT = Date.now();

  // 崩溃恢复：把上次异常退出时正在读的书捞回来（取走即清标记，只提示一次）
  ipcMain.handle('app:takeCrashedSession', () => {
    const session = db.findDanglingReadingSession();
    if (!session) return null;
    // 标记比本进程还新 ⇒ 是本进程里某个还活着的窗口写下的，不是崩溃残留，**碰都别碰**。
    // 多窗口下「标记存在」并不等于「上次异常退出」：少了这一判，新开一扇窗、或重载页面，
    // 都会把隔壁窗口正在读的那本书当成崩溃现场，弹一个假的恢复提示。
    if (session.at >= APP_STARTED_AT) return null;
    const book = db.getBookById(session.bookId) as { id: number; title?: string } | undefined;
    // 书已经被删掉：顺手清掉标记，免得每次启动都白查一遍
    db.setSetting(`readingSession:${session.bookId}`, '');
    if (!book) return null;
    return { bookId: book.id, title: book.title ?? '未命名' };
  });

  // 分享/发送文件：Windows 没有通用分享面板，实用的两步是复制路径与交给默认程序
  ipcMain.handle('books:copyPath', (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.file_path)) throw new Error('书籍文件已丢失');
    clipboard.writeText(book.file_path);
    return book.file_path;
  });

  ipcMain.handle('books:openWithSystem', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.file_path)) throw new Error('书籍文件已丢失');
    // openPath 不抛异常，失败时把原因当字符串返回
    const err = await shell.openPath(book.file_path);
    if (err) throw new Error(err);
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

  // 另存为副本：把书库里的文件原样复制到用户选的位置。
  // 阅读器本身不改原文件，「想把它拿出去」是这个只读模型下真正缺的一环。
  ipcMain.handle('books:saveAs', async (event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.file_path)) throw new Error('书库文件已丢失，请重新导入');
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '另存为',
      defaultPath: `${sanitizeFileName(book.title)}.${book.file_type}`,
      filters: [{ name: book.file_type.toUpperCase(), extensions: [book.file_type] }],
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(book.file_path, filePath);
    return { filePath };
  });

  /**
   * 取出这本书可导出的纯文本；取不出来就抛错说明原因。
   *
   * 抽成函数是为了让单本导出与批量导出走同一条判定——否则同一本书被批量跳过时给出的
   * 理由会和单本不一致（一边说「格式不支持」、另一边说「可能是扫描版」）。
   */
  const exportableText = async (book: any): Promise<string> => {
    if (!fs.existsSync(book.file_path)) throw new Error('书库文件已丢失，请重新导入');
    let text = '';
    if (book.file_type === 'txt') {
      // 直接读整份原文：TXT 自带章节标题，再插一层反而重复。
      // 注意不能用 extractBookSections——它为做目录只读前 8MB，会静默截断大文件。
      text = readPlainTextFile(book.file_path);
    } else if (book.file_type === 'epub') {
      text = buildPlainText(await extractBookSections(book.file_path, '.epub', book.toc ?? ''), true);
    } else if (book.file_type === 'pdf') {
      text = buildPlainText(await extractBookSections(book.file_path, '.pdf', book.toc ?? ''), false);
    } else if (book.file_type === 'md' || book.file_type === 'docx') {
      // 文档型格式的段名就是正文里的标题，插回去正是原文的层次
      text = buildPlainText(
        await extractBookSections(book.file_path, '.' + book.file_type, book.toc ?? ''),
        true,
      );
    } else {
      throw new Error('这种格式没有可导出的文字，漫画请用「另存为副本」');
    }
    if (!text.trim()) throw new Error('没有提取到文字，可能是扫描版，可先用阅读页的「识别」取字');
    return text;
  };

  /** 把书按章节切出来供打包 EPUB；切不出正文就抛错。判定与「导出正文为 TXT」同源。 */
  const exportableChapters = async (book: any): Promise<{ title: string; text: string }[]> => {
    if (!fs.existsSync(book.file_path)) throw new Error('书库文件已丢失，请重新导入');
    const type = book.file_type as string;
    let chapters: { title: string; text: string }[];
    if (type === 'txt') {
      // 必须全量读取：extractTxtSections 为做目录只读前 8MB，拿它导出会把后半本静默丢掉。
      // 目录规则沿用用户为本书/全局配的那套，导出的分章与阅读页看到的目录一致。
      chapters = splitTxtChapters(readPlainTextFile(book.file_path), txtTocOptionsFor(book.id));
    } else if (type === 'pdf' || type === 'md' || type === 'docx') {
      chapters = (await extractBookSections(book.file_path, '.' + type, book.toc ?? '')).map(s => ({
        title: s.label,
        text: s.text,
      }));
    } else if (type === 'epub') {
      throw new Error('这本书本身就是 EPUB，无需再导出为 EPUB');
    } else {
      throw new Error('这种格式导不出 EPUB，漫画请用「另存为副本」');
    }
    if (!chapters.some(c => c.text.trim())) {
      throw new Error('没有提取到文字，可能是扫描版，可先用阅读页的「识别」取字');
    }
    return chapters;
  };

  // 导出正文为 TXT：把书里的文字取出来另存，便于引用、校对或喂给别的工具
  ipcMain.handle('books:exportText', async (event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    const text = await exportableText(book);

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出正文为 TXT',
      defaultPath: `${sanitizeFileName(book.title)}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, text, 'utf-8');
    return { filePath, chars: text.length };
  });

  // 导出为 EPUB：把正文按章节重新打包成一本干净的书。
  // 定位是「清理 / 转换」而不是备份，所以有三类要挡在前面说清楚，而不是导出一个空壳：
  // 原书本就是 EPUB（没有意义）、漫画（没有文字章节）、抽不出文字的扫描版。
  ipcMain.handle('books:exportEpub', async (event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');
    const chapters = await exportableChapters(book);

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出为 EPUB',
      defaultPath: `${sanitizeFileName(book.title)}.epub`,
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    });
    if (canceled || !filePath) return null;
    // 无章节名的（整篇一章或前言散段）用书名兜底，免得生成一个没有标题的空 <h2>
    const buffer = await buildEpub(
      book.title,
      chapters.map(c => ({ title: c.title || book.title, content: c.text })),
    );
    fs.writeFileSync(filePath, buffer);
    return { filePath, chapters: chapters.length, bytes: buffer.length };
  });

  // 批量导出为 TXT / EPUB：只让用户选一次目录，然后逐本写进去。
  // 之所以单独开一个 handler 而不是让前端循环调上面两个——那两个每次都会弹一次保存框，
  // 批量就会弹 N 次，等于不可用。
  // 三处刻意的取舍：
  // ① 单本失败只跳过并记下原因，不中断整批——一本扫描版不该毁掉另外几十本已经能导的；
  // ② 不排除锁定书：锁定的语义是「不能被删除或批量修改」（见书架 batchTargets 注释），
  //    导出是纯读操作，锁它没有意义；
  // ③ 重名只按开头那一次目录快照来排，不逐本 existsSync——同批里先写出的名字即时入集合，
  //    批内重名同样避开，判重逻辑见 uniqueExportName。
  ipcMain.handle('books:exportBatch', async (event, ids: number[], format: 'txt' | 'epub') => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: format === 'epub' ? '选择 EPUB 的导出目录' : '选择 TXT 的导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths?.[0]) return null;
    const dir = filePaths[0];
    // Windows 文件系统不区分大小写，集合统一存小写（uniqueExportName 按小写查）
    const used = new Set(fs.readdirSync(dir).map(n => n.toLowerCase()));

    let done = 0;
    const skipped: { title: string; reason: string }[] = [];
    for (const id of ids) {
      const book = db.getBookById(id) as any;
      if (!book) {
        skipped.push({ title: `#${id}`, reason: '书籍不存在' });
        continue;
      }
      try {
        const name = uniqueExportName(
          used,
          sanitizeFileName(book.title),
          format === 'epub' ? '.epub' : '.txt',
          id,
        );
        if (format === 'epub') {
          const chapters = await exportableChapters(book);
          // 无章节名的（整篇一章或前言散段）用书名兜底，免得生成一个没有标题的空 <h2>
          const buffer = await buildEpub(
            book.title,
            chapters.map(c => ({ title: c.title || book.title, content: c.text })),
          );
          fs.writeFileSync(path.join(dir, name), buffer);
        } else {
          fs.writeFileSync(path.join(dir, name), await exportableText(book), 'utf-8');
        }
        used.add(name.toLowerCase());
        done++;
      } catch (e) {
        skipped.push({ title: book.title, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { dir, done, skipped };
  });

  // 批量提取内嵌图片：选一次目录，每本书在里面建一个子目录放它的图。
  // 取舍与上面的批量导出同源：单本失败只跳过并记原因、不中断整批；不排除锁定书（纯读操作）。
  // 另外两处是抽图特有的：
  // ① **每本书一个子目录**——几十本书的图混在一个目录里既分不清来源，同名图还会互相覆盖；
  // ② **每本处理完就释放漫画归档缓存**——comic.ts 的缓存原本只在关书时释放，批量抽图会
  //    连着把几十个包全留在内存里（§ 42 记过「关书后整包缓存常驻」这条）。
  ipcMain.handle('books:extractImages', async (event, ids: number[]) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择图片的存放目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths?.[0]) return null;
    const dir = filePaths[0];
    const usedDirs = new Set(fs.readdirSync(dir).map(n => n.toLowerCase()));

    let books = 0;
    let images = 0;
    const skipped: { title: string; reason: string }[] = [];
    for (const id of ids) {
      const book = db.getBookById(id) as any;
      if (!book) {
        skipped.push({ title: `#${id}`, reason: '书籍不存在' });
        continue;
      }
      try {
        if (!fs.existsSync(book.file_path)) throw new Error('书库文件已丢失，请重新导入');
        // 先分「格式不支持」与「这本书里没图」——openBookImages 两种情况都返回 null，
        // 混成一句话就会对着一本 EPUB 说「只有 EPUB 与漫画有图」，读起来是错的
        const type = String(book.file_type ?? '').toLowerCase().replace(/^\./, '');
        if (!['epub', 'cbz', 'cbr', 'cbt', 'cb7'].includes(type)) {
          throw new Error('这种格式没有内嵌图片（只有 EPUB 与漫画有）');
        }
        const handle = await openBookImages(book.file_path, type);
        if (!handle) throw new Error('这本书里没有内嵌图片');

        const sub = uniqueExportName(usedDirs, sanitizeFileName(book.title), '', id);
        usedDirs.add(sub.toLowerCase());
        const subDir = path.join(dir, sub);
        fs.mkdirSync(subDir, { recursive: true });

        // 子目录内部各自判重：包里不同目录下的同名图（a/1.jpg 与 b/1.jpg）都要留下
        const usedFiles = new Set<string>();
        let got = 0;
        for (const [i, name] of handle.names.entries()) {
          const data = await handle.read(name);
          if (!data) continue;
          const base = path.basename(name, path.extname(name));
          const file = uniqueExportName(usedFiles, base, path.extname(name), i + 1);
          fs.writeFileSync(path.join(subDir, file), data);
          usedFiles.add(file.toLowerCase());
          got++;
        }
        if (got === 0) {
          fs.rmdirSync(subDir); // 一张都没写出来，别在用户那儿留个空壳
          throw new Error('包里没有读出任何图片');
        }
        books++;
        images += got;
      } catch (e) {
        skipped.push({ title: book.title, reason: e instanceof Error ? e.message : String(e) });
      } finally {
        // 无论成败都放掉这个包的缓存，否则连着抽几十本会把内存吃满
        releaseComicCacheFor(book.file_path);
      }
    }
    return { dir, books, images, skipped };
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

  // 恢复单书备份：把导出的批注 / 笔记 / 阅读位置写回同名书籍
  ipcMain.handle('books:importOne', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择单书备份文件',
      filters: [{ name: '备份文件', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return null;
    const payload = parseBookBackup(fs.readFileSync(filePaths[0], 'utf-8'));

    const title = payload.book.title!.trim();
    const target = db.findBookByTitle(title) as { id: number; locked?: number; progress?: number } | undefined;
    if (!target) {
      throw new Error(`书架里没有《${title}》。请先把这本书导入书架，再恢复它的批注与笔记。`);
    }
    if (target.locked) {
      throw new Error(`《${title}》已锁定，无法写入。请先在书架右键解锁。`);
    }

    // 同一位置只保留一条，重复恢复不会堆出多份
    const seenBookmarks = new Set(
      (db.getBookmarksByBookId(target.id) as { position: string }[]).map(b => b.position),
    );
    const seenNotes = new Set(
      (db.getNotesByBookId(target.id) as { position: string }[]).map(n => n.position),
    );
    let restored = 0;
    for (const b of payload.bookmarks as any[]) {
      if (!b?.position || seenBookmarks.has(b.position)) continue;
      db.insertBookmark({
        book_id: target.id,
        position: b.position,
        text: b.text,
        color: b.color,
        style: b.style,
      });
      seenBookmarks.add(b.position);
      restored++;
    }
    for (const n of payload.notes as any[]) {
      if (!n?.position || seenNotes.has(n.position)) continue;
      db.insertNote({
        book_id: target.id,
        position: n.position,
        selected_text: n.selected_text,
        note: n.note,
        tags: n.tags,
      });
      seenNotes.add(n.position);
      restored++;
    }
    let positions = 0;
    for (const p of payload.positions as any[]) {
      if (!p?.position) continue;
      // 该方法本身按 (book_id, position) 去重
      db.addReadingPosition({
        book_id: target.id,
        position: p.position,
        label: p.label ?? '',
        progress: p.progress ?? 0,
        source: p.source ?? 'manual',
      });
      positions++;
    }

    // 书架元信息一并还原；进度只取更靠后的那个，避免把已读位置拉回去
    if (payload.book.category !== undefined) db.setCategory(target.id, payload.book.category ?? '');
    if (payload.book.status !== undefined) db.setBookStatus(target.id, payload.book.status ?? '');
    if (payload.book.rating !== undefined) db.setBookRating(target.id, payload.book.rating ?? 0);
    if (payload.book.favorite !== undefined) db.setFavorite(target.id, !!payload.book.favorite);
    const backupProgress = payload.book.progress ?? 0;
    if (backupProgress > (target.progress ?? 0)) db.updateBookProgress(target.id, backupProgress);

    return { bookId: target.id, title, restored, positions };
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
    // 只有「非空数组」才算有效缓存。空数组曾经也写进过库（导入时解析出 0 章），
    // 若把它当有效缓存直接返回，之后目录就永远是空的，只能手动重新解析才能救回。
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

  // 文档型格式（Markdown / DOCX）正文渲染：整篇一个 HTML。
  // 两者在阅读侧是同一套——连续滚动、不分章不分页，靠标题锚点跳转，所以共用一条通道。
  // Markdown 的图片按导入时记下的映射换成书库内的地址，读的时候不再做路径解析。
  ipcMain.handle('books:docHtml', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (!book) throw new Error('书籍不存在');

    if (book.file_type === 'docx') {
      // DOCX 的图由 mammoth 内联成 data: 地址，正文自带内容，没有映射要套
      const doc = await docxRender(book.file_path);
      return { html: doc.html, toc: doc.toc };
    }

    // 渲染时不做图片解析：书库里的 .md 与收进来的图不在同一棵目录树下，
    // 相对路径在那个位置必然找不到，硬解析只会把每张图都算成缺图
    const doc = await mdRender(book.file_path);
    let map: Record<string, string> = {};
    try {
      const raw = db.getSetting(`mdImages:${id}`);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>;
    } catch { /* 映射坏了就退回不改写，正文照常显示 */ }
    return { html: applyMarkdownImageMap(doc.html, map), toc: doc.toc };
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
    const book = db.getBookById(bookId) as any;
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      minWidth: 800,
      minHeight: 600,
      // 先按书名起标题：多开几本书时，任务栏悬停靠这行字分辨谁是谁，
      // 不能等渲染进程加载完才显示（那段空窗期正是用户去点任务栏的时候）
      title: book?.title || '阅读书架',
      backgroundColor: '#1a1a2e',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    loadRenderer(win, bookId);
    if (db.isSettingOn('screenProtection')) win.setContentProtection(true);
    // 独立阅读窗只能靠 × 关闭，而点 × 时渲染进程被直接销毁——React 的卸载清理**根本不会跑**
    // （渲染层全搜没有任何窗口级清理钩子），于是 `readingSession:<bookId>` 这个「正在读这本书」
    // 的标记会永远留在库里，下次开窗被当成异常退出、弹出假的「上次没有正常退出，继续阅读《X》？」。
    // 标记的本意就是「有窗口正读着这本书」，那这扇窗关了就由主进程替它销账。
    // 已知残留：主窗口在「关闭到托盘」模式下关闭、而其书仍在别的窗口里读着时，标记要等
    // will-quit 才清；那种组合下再开窗仍可能误报一次（末端由 will-quit 的 clearReadingSessions 兜底）。
    win.on('closed', () => {
      try { db.setSetting(`readingSession:${bookId}`, ''); } catch { /* 忽略 */ }
    });
  });

  // 内容预览与打印：把渲染进程生成的当页内容开在独立窗口里。
  // 这个窗口只负责「显示」：关掉 JS 与 sandbox 一起，
  // 把「渲染进程传来的 HTML」的爆炸半径压到最小。
  let printWin: BrowserWindow | null = null;

  /** 旧窗口必须先关，否则连点会把预览窗口堆满屏幕 */
  const closePrintWin = () => {
    if (printWin && !printWin.isDestroyed()) printWin.close();
  };

  /**
   * 开一扇只用来显示 / 打印的窗口。
   * 因为页面里关了 JS，打印入口做不进页面内，只能由主进程代按——
   * 这也是「应用内发起打印」必须走主进程的原因。
   */
  const openPrintWindow = async (html: string, title: string): Promise<BrowserWindow> => {
    closePrintWin();
    // 走临时文件而非 data: URL——正文可能很大，data: URL 在部分导航场景会被截断
    const tmpFile = path.join(app.getPath('temp'), `book-reader-print-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, 'utf-8');
    const win = new BrowserWindow({
      width: 900,
      height: 760,
      title: title || '内容预览',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    printWin = win;
    win.on('closed', () => {
      try { fs.unlinkSync(tmpFile); } catch { /* 已删除则忽略 */ }
      if (printWin === win) printWin = null;
    });
    await win.loadFile(tmpFile);
    return win;
  };

  ipcMain.handle('books:printPreview', async (_event, html: string, title: string) => {
    await openPrintWindow(html, title);
    return true;
  });

  /**
   * 应用内发起打印：开同一扇窗，再直接唤起系统打印对话框（silent: false）。
   *
   * 这一条早先是刻意不做的——原注释写「本机可能根本没接打印机，不再由应用代劳」。
   * 现在补上，但要老实处理失败：没有打印机、驱动报错、用户点取消，都会从回调里
   * 拿到 failureReason，一律原样交给界面提示。点了没反应比做不了更糟。
   * 用户主动取消不算失败，单独标出来，免得为一次取消弹个警告。
   */
  ipcMain.handle(
    'books:printContent',
    async (_event, html: string, title: string): Promise<{ ok: boolean; cancelled?: boolean; reason?: string }> => {
      const win = await openPrintWindow(html, title);
      return new Promise(resolve => {
        win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
          if (ok) return resolve({ ok: true });
          const text = reason || '';
          if (/cancel/i.test(text)) return resolve({ ok: false, cancelled: true });
          resolve({ ok: false, reason: text || '系统没有说明原因' });
        });
      });
    },
  );

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

  // 关闭漫画时释放整包缓存：漫画包常有上百 MB，读完还常驻内存没有必要
  ipcMain.handle('books:releaseComicCache', async (_event, id: number) => {
    const book = db.getBookById(id) as any;
    if (book) releaseComicCacheFor(book.file_path);
    return true;
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

  // 窗口标题：任务栏悬停时显示的就是这行字（缩略图下方那行）。
  // 页面自带的 <title> 会在每次载入时把它盖回去，所以 loadRenderer 那边同时
  // 拦掉了 page-title-updated——标题只有这一个出口，不会两处打架。
  ipcMain.handle('window:setTitle', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setTitle(String(title ?? ''));
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

  // 笔记正文与标签一起改（集中管理面板的编辑弹窗）
  ipcMain.handle('notes:update', (_event, id: number, content: string, tags: string) => {
    db.updateNote(id, content, tags);
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
  ipcMain.handle('rag:build', async (_event, bookId: number, ownerId?: string) => {
    const book = db.getBookById(bookId) as any;
    if (!book) throw new Error('书籍不存在');
    const controller = new AbortController();
    if (ownerId) ragAbortControllers.set(ownerId, controller);
    try {
      const sections = await extractBookSections(book.file_path, '.' + book.file_type, book.toc);
      const chunks = sections.flatMap(s => splitText({ label: s.label, target: s.target, text: s.text }));
      if (chunks.length === 0) throw new Error('未能提取正文，无法建索引');
      const vectors = await embedTexts(
        chunks.map(c => c.text),
        getEmbedBaseUrl(),
        () => db.assertOnlineEnabled('语义检索', getEmbedBaseUrl()),
        controller.signal,
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
    } finally {
      // 不留半本索引：中断也走清理，避免「建了一半」被当成完整索引
      if (controller.signal.aborted) db.clearBookVectors(bookId);
      if (ownerId) ragAbortControllers.delete(ownerId);
    }
  });

  ipcMain.handle('rag:clear', (_event, bookId: number) => {
    db.clearBookVectors(bookId);
  });

  // 语义检索：问题向量化 → 余弦 TopK
  ipcMain.handle('rag:search', async (_event, query: string, topK: number, bookId?: number, ownerId?: string) => {
    if (!query?.trim()) throw new Error('请输入问题');
    const all = db.getAllVectors() as any[];
    const rows = bookId ? all.filter(v => v.book_id === bookId) : all;
    if (rows.length === 0) throw new Error('还没有建立索引，先去语义检索页为书籍建索引');
    const controller = new AbortController();
    if (ownerId) ragAbortControllers.set(ownerId, controller);
    try {
      const [qvec] = await embedTexts(
        [query.trim().slice(0, 1000)],
        getEmbedBaseUrl(),
        () => db.assertOnlineEnabled('语义检索', getEmbedBaseUrl()),
        controller.signal,
      );
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
    } finally {
      if (ownerId) ragAbortControllers.delete(ownerId);
    }
  });

  // 渲染层发来的「停」：查表中断。查不到（已结束或从未登记）就当已经停了
  ipcMain.handle('rag:abort', (_event, ownerId: string) => {
    ragAbortControllers.get(ownerId)?.abort();
  });

  // ============ 本地模型管理 ============

  ipcMain.handle('models:status', () => {
    return ModelService.getInstance().status();
  });

  ipcMain.handle('models:download', async (_event, id: string) => {
    db.assertOnlineEnabled('本地模型下载');
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

  // ============ 本地 OCR ============

  /**
   * 把 OCR 模型与 wasm 的字节交给渲染进程。
   * 不返回 URL：打包后这些文件在 asar 里，渲染进程自己取不到；
   * 主进程的 fs 对 asar 透明，读成字节再走结构化克隆最稳。
   */
  ipcMain.handle('ocr:assets', () => {
    const dir = path.join(resourcesDir(), 'ocr');
    const read = (name: string) => {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) throw new Error(`缺少文字识别资源：${name}`);
      return fs.readFileSync(file);
    };
    return {
      detBuffer: read('det.onnx'),
      recBuffer: read('rec.onnx'),
      wasmBinary: read(path.join('ort', 'ort-wasm-simd-threaded.wasm')),
      // onnxruntime 要把这层胶水模块 import 进渲染进程；asar 里拿不到可 import 的 URL，
      // 所以连文本一起送过去，由渲染进程转成 blob URL 交给它
      mjsText: read(path.join('ort', 'ort-wasm-simd-threaded.mjs')).toString('utf-8'),
      keysText: read('keys.txt').toString('utf-8'),
    };
  });

  // ============ AI 阅读助手 ============
  // 配置来自设置页（aiBaseUrl/aiModel/aiApiKey），支持 Ollama / OpenAI / 兼容接口

  function getAiService(): AiService {
    const baseUrl = (db.getSetting('aiBaseUrl') || 'http://localhost:11434').replace(/\/$/, '');
    const model = db.getSetting('aiModel') || 'minicpm5-1b';
    const apiKey = db.getSetting('aiApiKey') || undefined;
    // 进程内推理照用（纯本地不出网）；只有回退 HTTP 且目标是外部地址时才需要过联网闸门
    return new AiService(
      { provider: 'custom', baseUrl, model, apiKey },
      () => db.assertOnlineEnabled('AI 阅读助手', baseUrl),
    );
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

  // 语义检索的中断控制（两条通道：建索引与检索）。
  // 渲染层只能发 fire-and-forget 的「停」指令，因此主进程必须自己登记：
  // 请求处理函数在 finally 里注销，停指令查表 abort——重复发停指令是安全的。
  const ragAbortControllers = new Map<string, AbortController>();

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
    if (!left || !right) throw new Error('该格式暂不支持比较（目前支持 TXT、EPUB、Markdown 与 Word 文档）');
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
      // 便携版：渲染进程拿不到 process.env，经这里透出去给设置页判断是否置灰
      isPortable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    };
  });

  // 开机自启：开关要立即生效，所以不走 settings 通道，单独即时写注册表
  ipcMain.handle('app:setAutoLaunch', (_event, flag: boolean) => {
    applyAutoLaunch(!!flag);
    return !!flag;
  });

  // 读取注册表里的真实状态：用户可能手动关掉过，回读比只信设置库更准
  ipcMain.handle('app:getAutoLaunch', () => {
    return isAutoLaunchEnabled();
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
    // 无头验收下不真的起文件监视：脚本会同时遍历书库目录，监视器会把
    // 验收自造的文件也导进来，污染用例结果（与 createWindow/createTray 同一约定）
    if (process.env.BOOKREADER_HEADLESS_ACCEPTANCE === '1') {
      throw new Error('无头验收模式下不启动文件夹监视');
    }
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
      snapshotBytes: dirSize(snapDir),
      booksBytes: dirSize(booksDir),
    };
  });

  ipcMain.handle('cache:clear', (_event, opts: { snapshots?: boolean }) => {
    const result: Record<string, number> = {};
    if (opts?.snapshots) {
      result.snapshots = clearSnapshots(path.join(app.getPath('userData'), 'snapshots'));
    }
    return result;
  });

  // ============ 隐私清理（纯本地） ============

  ipcMain.handle(
    'privacy:clear',
    (
      _event,
      opts: { positions?: boolean; timestamps?: boolean; clipboard?: boolean },
    ) => {
      const result: Record<string, number | boolean> = {};
      if (opts?.positions) result.positions = db.clearAutoPositions();
      if (opts?.timestamps) result.timestamps = db.clearReadingTimestamps();
      if (opts?.clipboard) {
        clipboard.clear();
        result.clipboard = true;
      }
      return result;
    },
  );

  // ============ 本地备份（纯离线，不联网） ============

  // 导出：默认增量（自上次导出后的变更），可显式要求全量。
  // 全量备份连书籍文件与封面一起打包成 zip——只导出数据的话，换台机器恢复出来
  // 书架仍是空的（库里记的是书库内副本的路径，新机器上那份文件并不存在）。
  ipcMain.handle('backup:export', async (event, full = false) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const stamp = localDateStamp();
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: full ? '导出全量备份（含书籍文件）' : '导出增量备份',
      defaultPath: `book-reader-backup-${stamp}.zip`,
      filters: [{ name: '备份归档', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return null;

    const since = full ? null : db.getSetting('lastLocalBackupAt');
    const payload = buildBackupFile(db, since);

    // 只有全量才带文件：增量备份的语义是「上次之后的变更」，文件没有增量概念
    const { files, skipped: skippedFiles } = full
      ? collectBookFileEntries(db.getAllBooks() as any[])
      : { files: [], skipped: 0 };

    // 归档是在内存里组装的，书库特别大时先打个招呼，免得用户以为程序卡死
    let totalBytes = 0;
    for (const f of files) {
      try {
        totalBytes += fs.statSync(f.sourcePath).size;
      } catch { /* 刚刚还在的文件也可能已被移走，忽略即可 */ }
    }
    if (totalBytes > 1.5 * 1024 ** 3) {
      const { response } = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['继续导出', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: `这次要打包的书籍文件共 ${(totalBytes / 1024 ** 3).toFixed(1)} GB`,
        detail: '导出期间会读入内存并占用较多资源、耗时较长，建议先关闭其它占用内存的程序。',
      });
      if (response !== 0) return null;
    }

    await writeBackupArchive(filePath, payload, files);
    // 仅在成功后推进增量基线，避免失败后丢变更
    db.setSetting('lastLocalBackupAt', payload.createdAt);
    const count =
      (payload.data.books?.length ?? 0) +
      (payload.data.bookmarks?.length ?? 0) +
      (payload.data.notes?.length ?? 0) +
      (payload.data.words?.length ?? 0);
    const bookFiles = files.filter(f => f.archiveName.startsWith('books/')).length;
    return {
      filePath,
      kind: payload.kind,
      count,
      bookFiles,
      skippedFiles,
      sizeBytes: fs.statSync(filePath).size,
    };
  });

  // 从备份恢复（幂等合并）。zip 归档里的书籍文件会先落回书库目录，再重建书籍记录
  ipcMain.handle('backup:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '选择备份文件',
      filters: [{ name: '备份归档', extensions: ['zip', 'json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return null;
    const payload = await readBackup(filePaths[0]);
    const restoredFiles = await extractBackupFiles(filePaths[0], booksDir());
    const { changed: restored, dropped } = mergeBackup(db, payload, restoredFiles);
    return {
      restored,
      dropped,
      createdAt: payload.createdAt,
      kind: payload.kind,
      books: restoredFiles.size,
    };
  });

  // 本地快照：手动生成一份全量快照
  ipcMain.handle('backup:snapshot', () => {
    const file = createSnapshot(db);
    const pruned = pruneSnapshots(14);
    return { file, pruned };
  });

  ipcMain.handle('backup:snapshots', () => listSnapshots());

  // 从快照回退（纯数据，不含书籍文件；要连书一起找回请用全量备份归档）
  ipcMain.handle('backup:restoreSnapshot', async (_event, file: string) => {
    const payload = await readBackup(file);
    const { changed: restored, dropped } = mergeBackup(db, payload);
    return { restored, dropped, createdAt: payload.createdAt };
  });

  // ============ Settings ============

  ipcMain.handle('settings:get', (_event, key: string) => {
    return db.getSetting(key);
  });

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.setSetting(key, value);
  });
}
