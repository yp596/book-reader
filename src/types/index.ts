export interface Book {
  id: number;
  title: string;
  author?: string;
  cover_path?: string;
  file_path: string;
  file_type: 'epub' | 'txt' | 'pdf' | 'cbz';
  progress: number;
  last_read_at?: string;
  created_at: string;
  favorite?: number;
  category?: string;
  toc?: string;
  locations?: string;
  locked?: number;
  /** 阅读状态：''=按进度推断 / reading / finished / shelved */
  status?: string;
  /** 星级评分：0 未评分，1-5 有效 */
  rating?: number;
}

export interface ReadingPosition {
  id: number;
  book_id: number;
  position: string;
  label: string;
  progress: number;
  /** manual=手动标记 / exit=正常退出 / crash=异常退出恢复 */
  source: 'manual' | 'exit' | 'crash';
  created_at: string;
}

export interface TocEntry {
  label: string;
  href: string;
  page?: number;
  /** TXT 章节所在段落行号（0 起），优先于 page 用于换算真实页码 */
  line?: number;
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

export interface ModelStatus {
  id: string;
  name: string;
  desc: string;
  sizeMB: number;
  port: number;
  downloaded: boolean;
  running: boolean;
  binReady: boolean;
}

export interface ModelProgressInfo {
  id: string;
  kind: 'download' | 'starting' | 'running' | 'stopped';
  percent?: number;
  done?: number;
  total?: number;
}

export interface TextFilter {
  id: number;
  name: string;
  pattern: string;
  replacement: string;
  enabled: number;
  created_at: string;
}

export interface FollowedBook {
  id: number;
  source_id: number;
  book_url: string;
  title: string;
  last_chapter: string;
  last_count: number;
  last_check?: string;
  has_update: number;
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
  /** 标签：逗号分隔存储 */
  tags?: string;
  created_at: string;
}

/** 跨书籍笔记：附带书名，供汇总页展示与跳转 */
export interface NoteWithBook extends Note {
  book_title?: string;
  book_type?: string;
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
      importBook: () => Promise<{ imported: unknown[]; failed: { name: string; reason: string }[] }>;
      importPaths: (paths: string[]) => Promise<{ imported: unknown[]; failed: { name: string; reason: string }[] }>;
      getPathForFile: (file: File) => string;
      renameBook: (id: number, title: string) => Promise<void>;
      toggleFavorite: (id: number) => Promise<number>;
      toggleBookLock: (id: number) => Promise<number>;
      setBookLock: (id: number, locked: boolean) => Promise<void>;
      setBookStatus: (id: number, status: string) => Promise<void>;
      setBookRating: (id: number, rating: number) => Promise<void>;
      getReadingPositions: (bookId: number) => Promise<ReadingPosition[]>;
      addReadingPosition: (p: {
        book_id: number;
        position: string;
        label?: string;
        progress?: number;
        source?: 'manual' | 'exit' | 'crash';
      }) => Promise<number>;
      deleteReadingPosition: (id: number) => Promise<void>;
      setCategory: (id: number, category: string) => Promise<void>;
      getCategories: () => Promise<string[]>;
      getBookToc: (id: number) => Promise<TocEntry[]>;
      getTocRules: (id: number) => Promise<{ rules: string[]; current: string; source: string }>;
      reparseToc: (id: number, ruleName?: string) => Promise<TocEntry[]>;
      saveToc: (id: number, entries: TocEntry[]) => Promise<void>;
      getComicPages: (id: number) => Promise<string[]>;
      getComicPage: (id: number, name: string) => Promise<{ data: string; mime: string } | null>;
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
      setAlwaysOnTop: (flag: boolean) => Promise<boolean>;
      setBookLocations: (id: number, locationsJson: string) => Promise<void>;
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
      exportBookEpub: (
        sourceId: number,
        book: { url: string; title: string },
        chapters: OnlineChapter[],
      ) => Promise<string | null>;
      getFilters: () => Promise<TextFilter[]>;
      addFilter: (filter: { name: string; pattern: string; replacement: string }) => Promise<any>;
      toggleFilter: (id: number, enabled: number) => Promise<void>;
      deleteFilter: (id: number) => Promise<void>;
      getFollows: () => Promise<FollowedBook[]>;
      followBook: (follow: { source_id: number; book_url: string; title: string }) => Promise<void>;
      unfollowBook: (id: number) => Promise<void>;
      clearFollowUpdate: (id: number) => Promise<void>;
      checkUpdates: (ids?: number[]) => Promise<{ id: number; title: string; newCount: number }[]>;
      getBookmarks: (bookId: number) => Promise<Bookmark[]>;
      addBookmark: (bookmark: Omit<Bookmark, 'id' | 'created_at'>) => Promise<any>;
      deleteBookmark: (id: number) => Promise<void>;
      updateBookmark: (id: number, text: string) => Promise<void>;
      getNotes: (bookId: number) => Promise<Note[]>;
      addNote: (note: Omit<Note, 'id' | 'created_at'>) => Promise<any>;
      deleteNote: (id: number) => Promise<void>;
      getAllNotes: () => Promise<NoteWithBook[]>;
      updateNoteTags: (id: number, tags: string) => Promise<void>;
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
      getAppInfo: () => Promise<{
        version: string;
        electron: string;
        chrome: string;
        node: string;
        platform: string;
        dataDir: string;
        booksDir: string;
      }>;
      clearPrivacy: (opts: {
        positions?: boolean;
        chapterCache?: boolean;
        timestamps?: boolean;
        clipboard?: boolean;
      }) => Promise<Record<string, number | boolean>>;
      exportBackup: (full?: boolean) => Promise<{ filePath: string; kind: string; count: number } | null>;
      importBackup: () => Promise<{ restored: number; createdAt: string; kind: string } | null>;
      createSnapshot: () => Promise<{ file: string; pruned: number }>;
      listSnapshots: () => Promise<{ file: string; name: string; createdAt: string; sizeKB: number }[]>;
      restoreSnapshot: (file: string) => Promise<{ restored: number; createdAt: string }>;
      aiSummarize: (text: string) => Promise<string>;
      aiExplain: (text: string, question: string) => Promise<string>;
      aiTranslate: (text: string) => Promise<string>;
      aiMindmap: (text: string) => Promise<string>;
      aiAbort: (reqId: string) => Promise<void>;
      aiStream: (
        kind: 'summarize' | 'explain' | 'translate' | 'mindmap',
        text: string,
        question: string | undefined,
        callbacks: {
          onToken: (chunk: string) => void;
          onDone: (full: string) => void;
          onError: (message: string) => void;
        },
      ) => string;
      getRagStatus: () => Promise<{ book_id: number; title: string; chunks: number; updated_at: string }[]>;
      buildRagIndex: (bookId: number) => Promise<{ chunks: number }>;
      clearRagIndex: (bookId: number) => Promise<void>;
      semanticSearch: (
        query: string,
        topK: number,
        bookId?: number,
      ) => Promise<
        {
          book_id: number;
          bookTitle: string;
          chapter: string;
          target: string;
          excerpt: string;
          score: number;
        }[]
      >;
      getModelStatus: () => Promise<ModelStatus[]>;
      downloadModel: (id: string) => Promise<boolean>;
      startModel: (id: string) => Promise<boolean>;
      stopModel: (id: string) => Promise<void>;
      onModelProgress: (callback: (info: ModelProgressInfo) => void) => () => void;
      onOpenFile: (callback: () => void) => void;
    };
  }
}
