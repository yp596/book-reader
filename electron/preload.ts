import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Books
  importBook: () => ipcRenderer.invoke('books:import'),
  getAllBooks: () => ipcRenderer.invoke('books:getAll'),
  getBookById: (id: number) => ipcRenderer.invoke('books:getById', id),
  deleteBook: (id: number) => ipcRenderer.invoke('books:delete', id),
  updateProgress: (id: number, progress: number) =>
    ipcRenderer.invoke('books:updateProgress', id, progress),

  // Sources
  getAllSources: () => ipcRenderer.invoke('sources:getAll'),
  addSource: (source: any) => ipcRenderer.invoke('sources:add', source),
  deleteSource: (id: number) => ipcRenderer.invoke('sources:delete', id),
  searchBooks: (sourceId: number, keyword: string) =>
    ipcRenderer.invoke('sources:search', sourceId, keyword),
  getChapters: (sourceId: number, url: string) =>
    ipcRenderer.invoke('sources:chapters', sourceId, url),
  getChapterContent: (sourceId: number, url: string) =>
    ipcRenderer.invoke('sources:content', sourceId, url),

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

  // Events
  onOpenFile: (callback: () => void) =>
    ipcRenderer.on('menu:open-file', callback),
});
