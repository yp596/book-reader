import { useState, useEffect } from 'react';
import { Book, TocEntry } from './types';
import { BookList } from './components/BookList';
import { BookDetail } from './components/BookDetail';
import { Reader } from './components/Reader';
import { Sidebar } from './components/Sidebar';
import { SourceManager } from './components/SourceManager';
import { SemanticSearch } from './components/SemanticSearch';
import { Vocab } from './components/Vocab';
import { Notes } from './components/Notes';
import { HelpAbout } from './components/HelpAbout';
import { Onboarding } from './components/Onboarding';
import { Models } from './components/Models';
import { Settings } from './components/Settings';
import { Statistics } from './components/Statistics';

type View = 'library' | 'detail' | 'reader' | 'sources' | 'rag' | 'vocab' | 'notes' | 'models' | 'settings' | 'stats' | 'help';

// 安全获取 electronAPI，preload 未就绪时返回空实现
const api = window.electronAPI ?? {
  importBook: async () => [],
  getAllBooks: async () => [],
  getBookById: async () => null,
  deleteBook: async () => {},
  updateProgress: async () => {},
  getAllSources: async () => [],
  addSource: async () => 0,
  deleteSource: async () => {},
  searchBooks: async () => [],
  getChapters: async () => [],
  getChapterContent: async () => '',
  getBookmarks: async () => [],
  addBookmark: async () => 0,
  deleteBookmark: async () => {},
  getNotes: async () => [],
  addNote: async () => 0,
  deleteNote: async () => {},
  getSetting: async () => null,
  setSetting: async () => {},
  importPaths: async () => ({ imported: [], failed: [] }),
  onOpenFile: () => () => {},
};

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBook, setCurrentBook] = useState<Book | null>(null);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [readerTarget, setReaderTarget] = useState<TocEntry | null>(null);
  /** 从笔记跳入时的原始位置串（EPUB 为 CFI，TXT 为 txt:页:起:止） */
  const [readerPosition, setReaderPosition] = useState<string | null>(null);
  const [view, setView] = useState<View>('library');
  const [searchQuery, setSearchQuery] = useState('');
  /** 首次启动引导：仅在未标记过时展示一次 */
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    window.electronAPI
      ?.getSetting('onboarded')
      .then(v => { if (v !== '1') setShowOnboarding(true); })
      .catch(() => {});
  }, []);

  // 多窗口：本窗口带 book 参数时，启动即打开这本书（由主进程 window:openReader 创建）
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('book'));
    if (!Number.isInteger(id) || id <= 0) return;
    window.electronAPI
      ?.getBookById(id)
      .then(b => { if (b) handleSelectBook(b as Book); })
      .catch(() => {});
  }, []);

  // 系统「打开方式」/ 双击关联文件：冷启动的路径要主动来取，运行中的等主进程推送。
  // 不带路径就来自 Ctrl+O，走打开文件对话框
  useEffect(() => {
    const openPath = (filePath?: string | null) => {
      if (filePath) void handleOpenPath(filePath);
      else void handleOpenFile();
    };
    window.electronAPI?.takeOpenFile?.().then(openPath).catch(() => {});
    return api.onOpenFile(openPath);
  }, []);

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    window.electronAPI?.setSetting('onboarded', '1').catch(() => {});
  };

  const loadBooks = async () => {
    const allBooks = await api.getAllBooks();
    setBooks(allBooks as Book[]);
  };

  /** 系统「打开方式」/ 双击关联文件打开的书：库里已有就直接读，没有才导入 */
  const handleOpenPath = async (filePath: string) => {
    const all = (await api.getAllBooks()) as Book[];
    const existing = all.find(b => b.file_path === filePath);
    if (existing) {
      handleSelectBook(existing);
      return;
    }
    const r = await api.importPaths([filePath]);
    await loadBooks();
    const first = r?.imported?.[0] as { id?: number } | undefined;
    if (first?.id) {
      const book = (await api.getBookById(first.id)) as Book | null;
      if (book) handleSelectBook(book);
      return;
    }
    // 导入没成功要说清为什么（如内容重复已跳过），静默无反应会让人以为双击没生效
    if (r?.failed?.length) {
      alert(['以下文件未导入：', ...r.failed.map(f => `· ${f.name}：${f.reason}`)].join('\n'));
    }
  };

  const handleOpenFile = async () => {
    const r = await api.importBook();
    await loadBooks();
    // 明确告知哪些没导进来、为什么——静默跳过会让人以为成功了
    if (r?.failed?.length) {
      const lines = r.failed.map(f => `· ${f.name}：${f.reason}`);
      alert(['以下文件未导入：', ...lines].join('\n'));
    }
  };

  const handleSelectBook = (book: Book, target?: TocEntry) => {
    // _tocTarget 为详情页目录跳转携带的参数
    const t = target ?? (book as Book & { _tocTarget?: TocEntry })._tocTarget ?? null;
    const { _tocTarget, ...clean } = book as Book & { _tocTarget?: TocEntry };
    setReaderTarget(t);
    setCurrentBook(clean);
    setDetailBook(null);
    setView('reader');
  };

  /** 笔记 → 原文：打开对应书籍并定位到批注位置 */
  const handleOpenNote = async (bookId: number, position: string) => {
    const api = window.electronAPI;
    if (!api) return;
    const b = (await api.getBookById(bookId)) as Book;
    if (!b) return;
    setReaderTarget(null);
    setReaderPosition(position);
    setCurrentBook(b);
    setDetailBook(null);
    setView('reader');
  };

  const handleShowDetail = (book: Book) => {
    setDetailBook(book);
    setView('detail');
  };

  const handleBack = () => {
    setCurrentBook(null);
    setReaderTarget(null);
    setReaderPosition(null);
    setDetailBook(null);
    setView('library');
    loadBooks();
  };

  const handleNavigate = (v: View) => {
    if (v !== 'reader' && v !== 'detail') {
      setCurrentBook(null);
      setDetailBook(null);
      setReaderTarget(null);
    }
    setView(v);
  };

  const renderContent = () => {
    switch (view) {
      case 'library':
        return (
          <BookList
            books={books}
            searchQuery={searchQuery}
            onSelectBook={handleSelectBook}
            onShowDetail={handleShowDetail}
            onRefresh={loadBooks}
            onImport={handleOpenFile}
          />
        );
      case 'detail':
        return detailBook ? (
          <BookDetail
            book={detailBook}
            onBack={handleBack}
            onRead={handleSelectBook}
          />
        ) : null;
      case 'reader':
        return currentBook ? (
          <Reader
            book={currentBook}
            initialTarget={readerTarget}
            initialPosition={readerPosition}
            onBack={handleBack}
          />
        ) : null;
      case 'sources':
        return <SourceManager />;
      case 'rag':
        return <SemanticSearch books={books} onOpenBook={handleSelectBook} />;
      case 'vocab':
        return <Vocab />;
      case 'notes':
        return <Notes onOpenNote={handleOpenNote} />;
      case 'help':
        return <HelpAbout />;
      case 'models':
        return <Models />;
      case 'settings':
        return <Settings />;
      case 'stats':
        return <Statistics />;
      default:
        return null;
    }
  };

  return (
    <div className="app">
      <Sidebar
        currentView={view === 'detail' ? 'library' : view}
        onNavigate={handleNavigate}
        onOpenFile={handleOpenFile}
        onSearch={setSearchQuery}
      />
      <main className="main-content">
        {renderContent()}
      </main>
      {showOnboarding && (
        <Onboarding
          onImport={handleOpenFile}
          onClose={dismissOnboarding}
        />
      )}
    </div>
  );
}

export default App;
