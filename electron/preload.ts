import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Books
  importBook: () => ipcRenderer.invoke('books:import'),
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

  // Bookmarks & Notes
  getBookmarks: (bookId: number) => ipcRenderer.invoke('bookmarks:get', bookId),
  addBookmark: (bookmark: any) => ipcRenderer.invoke('bookmarks:add', bookmark),
  deleteBookmark: (id: number) => ipcRenderer.invoke('bookmarks:delete', id),
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
  syncBackup: () => ipcRenderer.invoke('sync:backup'),
  syncRestore: () => ipcRenderer.invoke('sync:restore'),

  // AI
  aiSummarize: (text: string) => ipcRenderer.invoke('ai:summarize', text),
  aiExplain: (text: string, question: string) => ipcRenderer.invoke('ai:explain', text, question),
  aiTranslate: (text: string) => ipcRenderer.invoke('ai:translate', text),

  // Events
  onOpenFile: (callback: () => void) =>
    ipcRenderer.on('menu:open-file', callback),
});
