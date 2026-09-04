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
  getBookFileData: (id: number): Promise<string> =>
    ipcRenderer.invoke('books:getFileData', id),
  getBookFileInfo: (id: number) =>
    ipcRenderer.invoke('books:fileInfo', id),
  revealBookFile: (id: number) =>
    ipcRenderer.invoke('books:reveal', id),
  clearReadingHistory: () =>
    ipcRenderer.invoke('books:clearHistory'),
  toggleFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:toggleFullscreen'),
  refreshBookMetadata: (id: number) =>
    ipcRenderer.invoke('books:refreshMetadata', id),
  renameBook: (id: number, title: string) =>
    ipcRenderer.invoke('books:rename', id, title),
  toggleFavorite: (id: number) =>
    ipcRenderer.invoke('books:toggleFavorite', id),
  setCategory: (id: number, category: string) =>
    ipcRenderer.invoke('books:setCategory', id, category),
  getCategories: () =>
    ipcRenderer.invoke('books:categories'),
  getBookToc: (id: number) =>
    ipcRenderer.invoke('books:toc', id),

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

  // Vocab
  getAllWords: () => ipcRenderer.invoke('words:list'),
  addWord: (word: any) => ipcRenderer.invoke('words:add', word),
  deleteWord: (id: number) => ipcRenderer.invoke('words:delete', id),

  // AI
  aiSummarize: (text: string) => ipcRenderer.invoke('ai:summarize', text),
  aiExplain: (text: string, question: string) => ipcRenderer.invoke('ai:explain', text, question),
  aiTranslate: (text: string) => ipcRenderer.invoke('ai:translate', text),

  // RAG
  getRagStatus: () => ipcRenderer.invoke('rag:status'),
  buildRagIndex: (bookId: number) => ipcRenderer.invoke('rag:build', bookId),
  clearRagIndex: (bookId: number) => ipcRenderer.invoke('rag:clear', bookId),
  semanticSearch: (query: string, topK: number, bookId?: number) =>
    ipcRenderer.invoke('rag:search', query, topK, bookId),

  // Events
  onOpenFile: (callback: () => void) =>
    ipcRenderer.on('menu:open-file', callback),
});
