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
}

export interface BookSource {
  id: number;
  name: string;
  url: string;
  search_url: string;
  chapters_url: string;
  content_url: string;
  enabled: number;
  created_at: string;
}

export interface Bookmark {
  id: number;
  book_id: number;
  position: string;
  text?: string;
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

declare global {
  interface Window {
    electronAPI: {
      importBook: () => Promise<any>;
      getAllBooks: () => Promise<Book[]>;
      getBookById: (id: number) => Promise<Book>;
      deleteBook: (id: number) => Promise<void>;
      updateProgress: (id: number, progress: number) => Promise<void>;
      getAllSources: () => Promise<BookSource[]>;
      addSource: (source: Omit<BookSource, 'id' | 'enabled' | 'created_at'>) => Promise<any>;
      deleteSource: (id: number) => Promise<void>;
      searchBooks: (sourceId: number, keyword: string) => Promise<any[]>;
      getChapters: (sourceId: number, url: string) => Promise<Chapter[]>;
      getChapterContent: (sourceId: number, url: string) => Promise<string>;
      getBookmarks: (bookId: number) => Promise<Bookmark[]>;
      addBookmark: (bookmark: Omit<Bookmark, 'id' | 'created_at'>) => Promise<any>;
      deleteBookmark: (id: number) => Promise<void>;
      getNotes: (bookId: number) => Promise<Note[]>;
      addNote: (note: Omit<Note, 'id' | 'created_at'>) => Promise<any>;
      deleteNote: (id: number) => Promise<void>;
      getSetting: (key: string) => Promise<string | null>;
      setSetting: (key: string, value: string) => Promise<void>;
      onOpenFile: (callback: () => void) => void;
    };
  }
}
