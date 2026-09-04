export interface Book {
  id: number;
  title: string;
  author?: string;
  cover_path?: string;
  file_path: string;
  file_type: 'epub' | 'txt' | 'pdf';
  progress: number;
  last_read_at?: string;
  created_at: string;
  favorite?: number;
  category?: string;
}

export interface TocEntry {
  label: string;
  href: string;
  page?: number;
}

export interface WordEntry {
  id: number;
  book_id?: number | null;
  book_title?: string;
  word: string;
  definition: string;
  context?: string;
  created_at: string;
}

export interface BookSource {
  id: number;
  name: string;
  url: string;
  search_url: string;
  chapters_url: string;
  content_url: string;
  rules?: string;
  enabled: number;
  created_at: string;
}

export interface Bookmark {
  id: number;
  book_id: number;
  position: string;
  text?: string;
  color?: string;
  created_at: string;
}

export interface Note {
  id: number;
  book_id: number;
  position: string;
  selected_text?: string;
  note?: string;
  created_at: string;
}

export interface Chapter {
  title: string;
  url: string;
}

export interface OnlineBook {
  name: string;
  author?: string;
  cover?: string;
  detail: string;
}

export interface OnlineChapter {
  name: string;
  url: string;
}

declare global {
  interface Window {
    electronAPI: {
      importBook: () => Promise<any>;
      importPaths: (paths: string[]) => Promise<any>;
      getPathForFile: (file: File) => string;
      renameBook: (id: number, title: string) => Promise<void>;
      toggleFavorite: (id: number) => Promise<number>;
      setCategory: (id: number, category: string) => Promise<void>;
      getCategories: () => Promise<string[]>;
      getBookToc: (id: number) => Promise<TocEntry[]>;
      getAllBooks: () => Promise<Book[]>;
      getBookById: (id: number) => Promise<Book>;
      deleteBook: (id: number) => Promise<void>;
      updateProgress: (id: number, progress: number) => Promise<void>;
      getBookFileData: (id: number) => Promise<string>;
      getBookFileInfo: (id: number) => Promise<{
        title: string;
        author: string;
        fileName: string;
        fileType: string;
        size: number;
        mtime: string;
        progress: number;
      }>;
      revealBookFile: (id: number) => Promise<void>;
      clearReadingHistory: () => Promise<void>;
      toggleFullscreen: () => Promise<boolean>;
      refreshBookMetadata: (id: number) => Promise<{ title: string; author?: string }>;
      getAllSources: () => Promise<BookSource[]>;
      addSource: (source: Omit<BookSource, 'id' | 'enabled' | 'created_at'>) => Promise<any>;
      deleteSource: (id: number) => Promise<void>;
      searchBooks: (sourceId: number, keyword: string) => Promise<any[]>;
      getChapters: (sourceId: number, url: string) => Promise<OnlineChapter[]>;
      getChapterContent: (
        sourceId: number,
        book: { url: string; title: string },
        chapter: { url: string; title: string; idx: number },
      ) => Promise<string>;
      exportBookTxt: (
        sourceId: number,
        book: { url: string; title: string },
        chapters: OnlineChapter[],
      ) => Promise<string | null>;
      getBookmarks: (bookId: number) => Promise<Bookmark[]>;
      addBookmark: (bookmark: Omit<Bookmark, 'id' | 'created_at'>) => Promise<any>;
      deleteBookmark: (id: number) => Promise<void>;
      updateBookmark: (id: number, text: string) => Promise<void>;
      getNotes: (bookId: number) => Promise<Note[]>;
      addNote: (note: Omit<Note, 'id' | 'created_at'>) => Promise<any>;
      deleteNote: (id: number) => Promise<void>;
      getSetting: (key: string) => Promise<string | null>;
      setSetting: (key: string, value: string) => Promise<void>;
      exportNotes: (bookId?: number) => Promise<string | null>;
      recordReadingTime: (bookId: number, seconds: number) => Promise<void>;
      getReadingTimeStats: () => Promise<{ today: number; total: number }>;
      getWeeklyStats: (days: number) => Promise<{ date: string; duration: number }[]>;
      getAllWords: () => Promise<WordEntry[]>;
      addWord: (word: { book_id?: number | null; word: string; definition: string; context?: string }) => Promise<any>;
      deleteWord: (id: number) => Promise<void>;
      syncBackup: () => Promise<boolean>;
      syncRestore: () => Promise<number>;
      aiSummarize: (text: string) => Promise<string>;
      aiExplain: (text: string, question: string) => Promise<string>;
      aiTranslate: (text: string) => Promise<string>;
      onOpenFile: (callback: () => void) => void;
    };
  }
}
