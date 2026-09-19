export interface Book {
  id: number;
  title: string;
  author?: string;
  cover_path?: string;
  file_path: string;
  /** 漫画包四种容器都进库（zip/rar/tar/7z），阅读侧按「是不是漫画」统一判定 */
  file_type: 'epub' | 'txt' | 'pdf' | 'md' | 'docx' | 'cbz' | 'cbr' | 'cbt' | 'cb7';
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
  /** 所属系列（空=未分组） */
  series?: string;
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

/** 备份恢复时因本地找不到对应书籍而未能恢复的条目数 */
export interface BackupDropped {
  books: number;
  bookmarks: number;
  notes: number;
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

export interface Bookmark {
  id: number;
  book_id: number;
  position: string;
  text?: string;
  color?: string;
  /** 标注样式：highlight=高亮底色 / underline=下划线 */
  style?: string;
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
      setBookSeries: (id: number, series: string) => Promise<void>;
      getSeriesList: () => Promise<string[]>;
      setBookRating: (id: number, rating: number) => Promise<void>;
      exportBookList: () => Promise<{ filePath: string; count: number } | null>;
      exportOneBook: (id: number) => Promise<{ filePath: string; count: number } | null>;
      importOneBook: () => Promise<{ bookId: number; title: string; restored: number; positions: number } | null>;
      saveBookAs: (id: number) => Promise<{ filePath: string } | null>;
      exportBookText: (id: number) => Promise<{ filePath: string; chars: number } | null>;
      /** 导出为 EPUB：正文按章节重新打包，返回章节数与产出字节数 */
      exportEpub: (id: number) => Promise<{ filePath: string; chapters: number; bytes: number } | null>;
      /**
       * 批量导出为 TXT / EPUB：只选一次目录，逐本写入。
       * 单本失败只跳过并记下原因，不中断整批；返回的 skipped 交给上层归类展示。
       */
      exportBatch: (
        ids: number[],
        format: 'txt' | 'epub',
      ) => Promise<{ dir: string; done: number; skipped: { title: string; reason: string }[] } | null>;
      /**
       * 批量提取内嵌图片：只选一次目录，每本书建一个子目录放它的图。
       * 单本失败只跳过并记下原因，不中断整批；books / images 分别是成功本数与图片张数。
       */
      extractBookImages: (ids: number[]) => Promise<{
        dir: string;
        books: number;
        images: number;
        skipped: { title: string; reason: string }[];
      } | null>;
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
      /**
       * 文档型格式（Markdown / DOCX）的正文：整篇渲染好的 HTML + 标题目录。
       * 不分章不分页——阅读侧按连续滚动显示，目录点到哪个标题就滚到哪里。
       */
      getDocHtml: (id: number) => Promise<{ html: string; toc: TocEntry[] }>;
      getTocRules: (id: number) => Promise<{ rules: string[]; current: string; source: string }>;
      reparseToc: (id: number, ruleName?: string) => Promise<TocEntry[]>;
      saveToc: (id: number, entries: TocEntry[]) => Promise<void>;
      getComicPages: (id: number) => Promise<string[]>;
      getComicPage: (id: number, name: string) => Promise<{ data: string; mime: string } | null>;
      /** 关闭漫画后释放主进程的整包缓存（内存回收用，失败不影响阅读） */
      releaseComicCache: (id: number) => Promise<boolean>;
      setContentProtection: (flag: boolean) => Promise<boolean>;
      setAutoLaunch: (flag: boolean) => Promise<boolean>;
      getAutoLaunch: () => Promise<boolean>;
      /** 全局热键（隐藏 / 显示窗口）：立即注册，返回值即是否真的注册上（被别的软件占用时为 false） */
      setGlobalHotkey: (accel: string) => Promise<boolean>;
      /** 窗口标题：任务栏悬停时显示的就是它 */
      setWindowTitle: (title: string) => Promise<void>;
      runPdfOp: (payload: {
        op: 'merge' | 'extract' | 'deletePages' | 'rotate' | 'crop' | 'watermark' | 'pageNumbers';
        sourceIds: number[];
        pages?: string;
        angle?: number;
        marginPercent?: number;
        text?: string;
      }) => Promise<{ filePath: string; pages: number } | null>;
      compareLoad: (idA: number, idB: number) => Promise<{
        left: { title: string; lines: string[]; total: number; truncated: boolean };
        right: { title: string; lines: string[]; total: number; truncated: boolean };
      }>;
      printPreview: (html: string, title: string) => Promise<boolean>;
      /** 与预览同源，但直接唤起系统打印对话框；cancelled=用户主动取消，reason 说明失败原因 */
      printContent: (
        html: string,
        title: string,
      ) => Promise<{ ok: boolean; cancelled?: boolean; reason?: string }>;
      exportPageImage: (
        rect: { x: number; y: number; width: number; height: number },
        title: string,
      ) => Promise<string | null>;
      openReaderWindow: (bookId: number) => Promise<void>;
      listFonts: () => Promise<{ name: string; family: string; url: string }[]>;
      importFonts: () => Promise<{ name: string; family: string; url: string }[]>;
      removeFont: (name: string) => Promise<{ name: string; family: string; url: string }[]>;
      getAllBooks: () => Promise<Book[]>;
      getBookById: (id: number) => Promise<Book>;
      deleteBook: (id: number) => Promise<void>;
      updateProgress: (id: number, progress: number) => Promise<void>;
      /** Markdown 的 [[目标]] 跳转：按书名或原文件名找书，找不到返回 null */
      findBookByWikilink: (target: string) => Promise<{ id: number; title: string } | null>;
      /** 书库标签汇总：按出现次数降序 */
      getAllTags: () => Promise<{ tag: string; bookIds: number[]; count: number }[]>;
      /** 未完成任务汇总（Markdown 里的 - [ ]） */
      getAllTasks: () => Promise<
        { bookId: number; bookTitle: string; text: string; chapter: string; href: string }[]
      >;
      /** frontmatter 属性汇总：每个「键: 值」出现在哪些书里 */
      getAllProps: () => Promise<{ key: string; value: string; bookIds: number[]; count: number }[]>;
      /** 引用关系：outgoing = 本书引用了谁，incoming = 谁引用了本书 */
      getBookLinks: (bookId: number) => Promise<{
        outgoing: { id: number; title: string; via: string }[];
        incoming: { id: number; title: string; via: string }[];
      }>;
      /** 测试 AI 服务连通性：ok 为 false 时 message 是给用户看的原因 */
      testAi: (cfg: { baseUrl: string; model: string; apiKey?: string }) => Promise<{
        ok: boolean;
        message: string;
      }>;
      getBookFileData: (id: number) => Promise<string>;
      getBookFileInfo: (id: number) => Promise<{
        title: string;
        author: string;
        fileName: string;
        fileType: string;
        size: number;
        mtime: string;
        progress: number;
        /** 总页数，只有 PDF 有：其余格式的「页」取决于字号或窗口宽度。读不出时为 null */
        pageCount: number | null;
        /** 被禁止的 PDF 权限项（如「打印」）；[]＝无限制，null＝没读出来或非 PDF */
        deniedPermissions: string[] | null;
      }>;
      revealBookFile: (id: number) => Promise<void>;
      copyBookPath: (id: number) => Promise<string>;
      openBookWithSystem: (id: number) => Promise<void>;
      clearReadingHistory: () => Promise<void>;
      toggleFullscreen: () => Promise<boolean>;
      setAlwaysOnTop: (flag: boolean) => Promise<boolean>;
      setBookLocations: (id: number, locationsJson: string) => Promise<void>;
      refreshBookMetadata: (id: number) => Promise<{ title: string; author?: string }>;
      checkBookSources: () => Promise<
        { id: number; title: string; status: 'changed' | 'missing'; sourcePath: string }[]
      >;
      refreshBookFromSource: (
        id: number,
      ) => Promise<{ id: number; title: string; sourcePath: string; fileType: string }>;
      getBookmarks: (bookId: number) => Promise<Bookmark[]>;
      addBookmark: (bookmark: Omit<Bookmark, 'id' | 'created_at'>) => Promise<any>;
      deleteBookmark: (id: number) => Promise<void>;
      updateBookmark: (id: number, text: string) => Promise<void>;
      getNotes: (bookId: number) => Promise<Note[]>;
      addNote: (note: Omit<Note, 'id' | 'created_at'>) => Promise<any>;
      deleteNote: (id: number) => Promise<void>;
      getAllNotes: () => Promise<NoteWithBook[]>;
      updateNoteTags: (id: number, tags: string) => Promise<void>;
      updateNote: (id: number, content: string, tags: string) => Promise<void>;
      getSetting: (key: string) => Promise<string | null>;
      setSetting: (key: string, value: string) => Promise<void>;
      exportNotes: (bookId?: number) => Promise<string | null>;
      recordReadingTime: (bookId: number, seconds: number) => Promise<void>;
      getReadingTimeStats: () => Promise<{ today: number; total: number }>;
      getWeeklyStats: (days: number) => Promise<{ date: string; duration: number }[]>;
      getAllWords: () => Promise<WordEntry[]>;
      addWord: (word: { book_id?: number | null; word: string; definition: string; context?: string }) => Promise<any>;
      deleteWord: (id: number) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      startWatch: (dir: string) => Promise<{ dir: string; ok: boolean }>;
      stopWatch: () => Promise<boolean>;
      watchStatus: () => Promise<{ watching: boolean; dir: string; savedDir: string }>;
      pickWatchDir: () => Promise<string | null>;
      onWatchImported: (cb: (name: string) => void) => () => void;
      getCacheStats: () => Promise<{
        snapshotBytes: number;
        booksBytes: number;
      }>;
      clearCache: (opts: { snapshots?: boolean }) => Promise<Record<string, number>>;
      getAppInfo: () => Promise<{
        version: string;
        electron: string;
        chrome: string;
        node: string;
        platform: string;
        dataDir: string;
        booksDir: string;
        isPortable: boolean;
      }>;
      clearPrivacy: (opts: {
        positions?: boolean;
        timestamps?: boolean;
        clipboard?: boolean;
      }) => Promise<Record<string, number | boolean>>;
      exportBackup: (full?: boolean) => Promise<{
        filePath: string;
        kind: string;
        count: number;
        /** 随归档打包的书籍文件数（增量备份为 0） */
        bookFiles: number;
        /** 源文件已不在本机、没能打包进来的书数 */
        skippedFiles: number;
        sizeBytes: number;
      } | null>;
      importBackup: () => Promise<{
        restored: number;
        /** 备份里挂不上书、未能恢复的条目数 */
        dropped: BackupDropped;
        createdAt: string;
        kind: string;
        books: number;
      } | null>;
      createSnapshot: () => Promise<{ file: string; pruned: number }>;
      listSnapshots: () => Promise<{ file: string; name: string; createdAt: string; sizeKB: number }[]>;
      restoreSnapshot: (file: string) => Promise<{ restored: number; dropped: BackupDropped; createdAt: string }>;
      getOcrAssets: () => Promise<{
        detBuffer: Uint8Array;
        recBuffer: Uint8Array;
        wasmBinary: Uint8Array;
        mjsText: string;
        keysText: string;
      }>;
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
      buildRagIndex: (bookId: number, ownerId?: string) => Promise<{ chunks: number }>;
      clearRagIndex: (bookId: number) => Promise<void>;
      ragAbort: (ownerId: string) => Promise<void>;
      semanticSearch: (
        query: string,
        topK: number,
        bookId?: number,
        ownerId?: string,
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
      onOpenFile: (callback: (path?: string) => void) => () => void;
      onCloseTab: (callback: () => void) => () => void;
      takeOpenFile: () => Promise<string | null>;
      takeCrashedSession: () => Promise<{ bookId: number; title: string } | null>;
    };
  }
}
