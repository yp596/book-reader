import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Books
  importBook: () => ipcRenderer.invoke('books:import'),
  importPaths: (paths: string[]) => ipcRenderer.invoke('books:importPaths', paths),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getAllBooks: () => ipcRenderer.invoke('books:getAll'),
  getBookById: (id: number) => ipcRenderer.invoke('books:getById', id),
  deleteBook: (id: number) => ipcRenderer.invoke('books:delete', id),
  updateProgress: (id: number, progress: number) =>
    ipcRenderer.invoke('books:updateProgress', id, progress),
  /** Markdown 的 [[目标]] 跳转：按书名或原文件名找书 */
  findBookByWikilink: (target: string) => ipcRenderer.invoke('books:findByWikilink', target),
  /** 书库标签汇总（Markdown 正文里的 #标签） */
  getAllTags: () => ipcRenderer.invoke('books:getAllTags'),
  /** 未完成任务汇总（Markdown 里的 - [ ]） */
  getAllTasks: () => ipcRenderer.invoke('books:getAllTasks'),
  /** frontmatter 属性汇总（书架按属性筛选用） */
  getAllProps: () => ipcRenderer.invoke('books:getAllProps'),
  /** 引用关系：本书引用了谁、又被谁引用（Markdown 的 [[目标]]） */
  getBookLinks: (bookId: number) => ipcRenderer.invoke('books:getLinks', bookId),
  /** 测试 AI 服务连通性（外接大模型用） */
  testAi: (cfg: { baseUrl: string; model: string; apiKey?: string }) =>
    ipcRenderer.invoke('ai:test', cfg),
  getBookFileData: (id: number): Promise<string> =>
    ipcRenderer.invoke('books:getFileData', id),
  getBookFileInfo: (id: number) =>
    ipcRenderer.invoke('books:fileInfo', id),
  revealBookFile: (id: number) =>
    ipcRenderer.invoke('books:reveal', id),
  copyBookPath: (id: number) => ipcRenderer.invoke('books:copyPath', id),
  openBookWithSystem: (id: number) => ipcRenderer.invoke('books:openWithSystem', id),
  clearReadingHistory: () =>
    ipcRenderer.invoke('books:clearHistory'),
  toggleFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:toggleFullscreen'),
  setAlwaysOnTop: (flag: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  setBookLocations: (id: number, locationsJson: string) =>
    ipcRenderer.invoke('books:setLocations', id, locationsJson),
  refreshBookMetadata: (id: number) =>
    ipcRenderer.invoke('books:refreshMetadata', id),
  checkBookSources: () => ipcRenderer.invoke('books:checkSources'),
  refreshBookFromSource: (id: number) => ipcRenderer.invoke('books:refreshFromSource', id),
  renameBook: (id: number, title: string) =>
    ipcRenderer.invoke('books:rename', id, title),
  toggleFavorite: (id: number) =>
    ipcRenderer.invoke('books:toggleFavorite', id),
  toggleBookLock: (id: number) =>
    ipcRenderer.invoke('books:toggleLock', id),
  setBookLock: (id: number, locked: boolean) =>
    ipcRenderer.invoke('books:setLock', id, locked),
  setBookStatus: (id: number, status: string) =>
    ipcRenderer.invoke('books:setStatus', id, status),
  setBookSeries: (id: number, series: string) =>
    ipcRenderer.invoke('books:setSeries', id, series),
  getSeriesList: () => ipcRenderer.invoke('books:seriesList'),
  setBookRating: (id: number, rating: number) =>
    ipcRenderer.invoke('books:setRating', id, rating),
  exportBookList: () => ipcRenderer.invoke('books:exportList'),
  exportOneBook: (id: number) => ipcRenderer.invoke('books:exportOne', id),
  importOneBook: () => ipcRenderer.invoke('books:importOne'),
  saveBookAs: (id: number) => ipcRenderer.invoke('books:saveAs', id),
  exportBookText: (id: number) => ipcRenderer.invoke('books:exportText', id),
  getReadingPositions: (bookId: number) => ipcRenderer.invoke('positions:list', bookId),
  addReadingPosition: (p: any) => ipcRenderer.invoke('positions:add', p),
  deleteReadingPosition: (id: number) => ipcRenderer.invoke('positions:delete', id),
  setCategory: (id: number, category: string) =>
    ipcRenderer.invoke('books:setCategory', id, category),
  getCategories: () =>
    ipcRenderer.invoke('books:categories'),
  getBookToc: (id: number) =>
    ipcRenderer.invoke('books:toc', id),
  getTocRules: (id: number) =>
    ipcRenderer.invoke('books:tocRules', id),
  reparseToc: (id: number, ruleName?: string) =>
    ipcRenderer.invoke('books:reparseToc', id, ruleName),
  saveToc: (id: number, entries: unknown[]) =>
    ipcRenderer.invoke('books:saveToc', id, entries),
  getComicPages: (id: number) =>
    ipcRenderer.invoke('books:comicPages', id),
  getComicPage: (id: number, name: string) =>
    ipcRenderer.invoke('books:comicPage', id, name),
  releaseComicCache: (id: number) =>
    ipcRenderer.invoke('books:releaseComicCache', id),
  setContentProtection: (flag: boolean) =>
    ipcRenderer.invoke('window:setContentProtection', flag),
  printPreview: (html: string, title: string) =>
    ipcRenderer.invoke('books:printPreview', html, title),
  exportPageImage: (
    rect: { x: number; y: number; width: number; height: number },
    title: string,
  ) => ipcRenderer.invoke('reader:exportImage', rect, title),
  openReaderWindow: (bookId: number) =>
    ipcRenderer.invoke('window:openReader', bookId),

  // Sources
  getAllSources: () => ipcRenderer.invoke('sources:getAll'),
  addSource: (source: any) => ipcRenderer.invoke('sources:add', source),
  deleteSource: (id: number) => ipcRenderer.invoke('sources:delete', id),
  searchBooks: (sourceId: number, keyword: string) =>
    ipcRenderer.invoke('sources:search', sourceId, keyword),
  getChapters: (sourceId: number, url: string) =>
    ipcRenderer.invoke('sources:chapters', sourceId, url),
  getChapterContent: (sourceId: number, book: any, chapter: any) =>
    ipcRenderer.invoke('sources:content', sourceId, book, chapter),
  exportBookTxt: (sourceId: number, book: any, chapters: any[]) =>
    ipcRenderer.invoke('sources:exportTxt', sourceId, book, chapters),
  exportBookEpub: (sourceId: number, book: any, chapters: any[]) =>
    ipcRenderer.invoke('sources:exportEpub', sourceId, book, chapters),

  // Filters & follows
  getFilters: () => ipcRenderer.invoke('filters:list'),
  addFilter: (filter: any) => ipcRenderer.invoke('filters:add', filter),
  toggleFilter: (id: number, enabled: number) => ipcRenderer.invoke('filters:toggle', id, enabled),
  deleteFilter: (id: number) => ipcRenderer.invoke('filters:delete', id),
  getFollows: () => ipcRenderer.invoke('follows:list'),
  followBook: (follow: any) => ipcRenderer.invoke('follows:add', follow),
  unfollowBook: (id: number) => ipcRenderer.invoke('follows:remove', id),
  clearFollowUpdate: (id: number) => ipcRenderer.invoke('follows:clearUpdate', id),
  checkUpdates: (ids?: number[]) => ipcRenderer.invoke('follows:check', ids),

  // Bookmarks & Notes
  getBookmarks: (bookId: number) => ipcRenderer.invoke('bookmarks:get', bookId),
  addBookmark: (bookmark: any) => ipcRenderer.invoke('bookmarks:add', bookmark),
  deleteBookmark: (id: number) => ipcRenderer.invoke('bookmarks:delete', id),
  updateBookmark: (id: number, text: string) =>
    ipcRenderer.invoke('bookmarks:update', id, text),
  getNotes: (bookId: number) => ipcRenderer.invoke('notes:get', bookId),
  addNote: (note: any) => ipcRenderer.invoke('notes:add', note),
  deleteNote: (id: number) => ipcRenderer.invoke('notes:delete', id),
  getAllNotes: () => ipcRenderer.invoke('notes:getAll'),
  updateNoteTags: (id: number, tags: string) => ipcRenderer.invoke('notes:updateTags', id, tags),
  updateNote: (id: number, content: string, tags: string) =>
    ipcRenderer.invoke('notes:update', id, content, tags),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) =>
    ipcRenderer.invoke('settings:set', key, value),

  // Notes export & reading timer & sync
  exportNotes: (bookId?: number) => ipcRenderer.invoke('notes:export', bookId),
  recordReadingTime: (bookId: number, seconds: number) =>
    ipcRenderer.invoke('stats:recordTime', bookId, seconds),
  getReadingTimeStats: () => ipcRenderer.invoke('stats:readingTime'),
  getWeeklyStats: (days: number) => ipcRenderer.invoke('stats:weekly', days),
  syncBackup: () => ipcRenderer.invoke('sync:backup'),
  syncRestore: () => ipcRenderer.invoke('sync:restore'),

  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  // 文件夹监视
  startWatch: (dir: string) => ipcRenderer.invoke('watch:start', dir),
  stopWatch: () => ipcRenderer.invoke('watch:stop'),
  watchStatus: () => ipcRenderer.invoke('watch:status'),
  pickWatchDir: () => ipcRenderer.invoke('watch:pick'),
  onWatchImported: (cb: (name: string) => void) => {
    const listener = (_e: any, name: string) => cb(name);
    ipcRenderer.on('watch:imported', listener);
    return () => ipcRenderer.removeListener('watch:imported', listener);
  },

  // 缓存管理
  getCacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: (opts: { snapshots?: boolean; chapterCache?: boolean }) =>
    ipcRenderer.invoke('cache:clear', opts),

  // PDF 编辑
  runPdfOp: (payload: any) => ipcRenderer.invoke('pdf:run', payload),

  // 文档比较
  compareLoad: (idA: number, idB: number) =>
    ipcRenderer.invoke('compare:load', idA, idB),

  // 本地字体
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  importFonts: () => ipcRenderer.invoke('fonts:import'),
  removeFont: (name: string) => ipcRenderer.invoke('fonts:remove', name),

  // 应用信息
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  takeCrashedSession: () => ipcRenderer.invoke('app:takeCrashedSession'),

  // 隐私清理
  clearPrivacy: (opts: {
    positions?: boolean;
    chapterCache?: boolean;
    timestamps?: boolean;
    clipboard?: boolean;
  }) => ipcRenderer.invoke('privacy:clear', opts),

  // 本地备份（纯离线）
  exportBackup: (full?: boolean) => ipcRenderer.invoke('backup:export', full),  importBackup: () => ipcRenderer.invoke('backup:import'),
  createSnapshot: () => ipcRenderer.invoke('backup:snapshot'),
  listSnapshots: () => ipcRenderer.invoke('backup:snapshots'),
  restoreSnapshot: (file: string) => ipcRenderer.invoke('backup:restoreSnapshot', file),

  // Vocab
  getAllWords: () => ipcRenderer.invoke('words:list'),
  addWord: (word: any) => ipcRenderer.invoke('words:add', word),
  deleteWord: (id: number) => ipcRenderer.invoke('words:delete', id),

  // Models
  getModelStatus: () => ipcRenderer.invoke('models:status'),
  downloadModel: (id: string) => ipcRenderer.invoke('models:download', id),
  startModel: (id: string) => ipcRenderer.invoke('models:start', id),
  stopModel: (id: string) => ipcRenderer.invoke('models:stop', id),
  onModelProgress: (callback: (info: any) => void) => {
    const listener = (_event: any, info: any) => callback(info);
    ipcRenderer.on('models:progress', listener);
    return () => ipcRenderer.removeListener('models:progress', listener);
  },

  // 本地 OCR：模型字节由主进程读好送来
  getOcrAssets: () => ipcRenderer.invoke('ocr:assets'),

  // AI
  aiSummarize: (text: string) => ipcRenderer.invoke('ai:summarize', text),
  aiExplain: (text: string, question: string) => ipcRenderer.invoke('ai:explain', text, question),
  aiTranslate: (text: string) => ipcRenderer.invoke('ai:translate', text),
  aiMindmap: (text: string) => ipcRenderer.invoke('ai:mindmap', text),
  aiAbort: (reqId: string) => ipcRenderer.invoke('ai:abort', reqId),
  aiStream: (
    kind: 'summarize' | 'explain' | 'translate' | 'mindmap',
    text: string,
    question: string | undefined,
    callbacks: { onToken: (chunk: string) => void; onDone: (full: string) => void; onError: (message: string) => void },
  ) => {
    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tokenListener = (_event: any, chunk: string) => callbacks.onToken(chunk);
    const doneListener = (_event: any, full: string) => {
      cleanup();
      callbacks.onDone(full);
    };
    const errorListener = (_event: any, message: string) => {
      cleanup();
      callbacks.onError(message);
    };
    const cleanup = () => {
      ipcRenderer.removeListener(`ai:token:${reqId}`, tokenListener);
      ipcRenderer.removeListener(`ai:done:${reqId}`, doneListener);
      ipcRenderer.removeListener(`ai:error:${reqId}`, errorListener);
    };
    ipcRenderer.on(`ai:token:${reqId}`, tokenListener);
    ipcRenderer.on(`ai:done:${reqId}`, doneListener);
    ipcRenderer.on(`ai:error:${reqId}`, errorListener);
    ipcRenderer.invoke('ai:stream', { reqId, kind, text, question }).catch((err: Error) => {
      cleanup();
      callbacks.onError(err instanceof Error ? err.message : 'AI 调用失败');
    });
    return reqId;
  },

  // RAG
  getRagStatus: () => ipcRenderer.invoke('rag:status'),
  // ownerId 由调用方生成，用来标识「这一次」请求；不发或已结束时点「停止」是安全的空操作
  buildRagIndex: (bookId: number, ownerId?: string) => ipcRenderer.invoke('rag:build', bookId, ownerId),
  clearRagIndex: (bookId: number) => ipcRenderer.invoke('rag:clear', bookId),
  semanticSearch: (query: string, topK: number, bookId?: number, ownerId?: string) =>
    ipcRenderer.invoke('rag:search', query, topK, bookId, ownerId),
  ragAbort: (ownerId: string) => ipcRenderer.invoke('rag:abort', ownerId),

  // Events
  // 系统「打开方式」拉起的文件（冷启动时由渲染进程主动来取）
  takeOpenFile: (): Promise<string | null> => ipcRenderer.invoke('app:takeOpenFile'),
  onOpenFile: (callback: (path?: string) => void) => {
    const listener = (_e: any, filePath?: string) => callback(filePath);
    ipcRenderer.on('menu:open-file', listener);
    return () => ipcRenderer.removeListener('menu:open-file', listener);
  },
});
