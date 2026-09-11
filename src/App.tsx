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
import { Compare } from './components/Compare';
import { PdfTools } from './components/PdfTools';

type View = 'library' | 'detail' | 'reader' | 'sources' | 'rag' | 'vocab' | 'notes' | 'models' | 'settings' | 'stats' | 'help' | 'compare' | 'pdf';

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

  // 崩溃恢复：上次没走正常退出流程时，问一句要不要接着读
  useEffect(() => {
    const eapi = window.electronAPI;
    if (!eapi?.takeCrashedSession) return;
    eapi
      .takeCrashedSession()
      .then(session => {
        if (!session) return;
        if (!window.confirm(`上次没有正常退出，继续阅读《${session.title}》？`)) return;
        return eapi.getBookById(session.bookId).then(b => {
          if (b) openTab(b as Book);
        });
      })
      .catch(() => {});
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
    openTab(clean);
  };

  /**
   * 同窗口多标签：打开过的书留在标签条里，切回来还停在原位。
   * 位置不会丢——Reader 卸载时会 flush 当前位置，挂载时按书读回。
   */
  const [tabs, setTabs] = useState<Book[]>([]);

  /** 把书加进标签（已在标签里就只切过去），并设为当前标签 */
  const openTab = (book: Book) => {
    setTabs(prev => (prev.some(b => b.id === book.id) ? prev : [...prev, book]));
    setCurrentBook(book);
    setDetailBook(null);
    setView('reader');
  };

  /** 切标签：清掉上一本书带过来的跳转目标，位置由 Reader 自己按书恢复 */
  const activateTab = (book: Book) => {
    if (book.id === currentBook?.id) return;
    setReaderTarget(null);
    setReaderPosition(null);
    setCurrentBook(book);
    setDetailBook(null);
    setView('reader');
  };

  /** 关标签：关的是当前标签就接上右边那个（没有则左边），全关了就退回书架 */
  const closeTab = (id: number) => {
    const idx = tabs.findIndex(b => b.id === id);
    const next = tabs.filter(b => b.id !== id);
    setTabs(next);
    if (currentBook?.id !== id) return;
    setReaderTarget(null);
    setReaderPosition(null);
    const fallback = next[Math.min(idx, next.length - 1)] ?? null;
    if (fallback) {
      setCurrentBook(fallback);
    } else {
      setCurrentBook(null);
      setView('library');
    }
  };

  /** 笔记 → 原文：打开对应书籍并定位到批注位置 */
  const handleOpenNote = async (bookId: number, position: string) => {
    const api = window.electronAPI;
    if (!api) return;
    const b = (await api.getBookById(bookId)) as Book;
    if (!b) return;
    setReaderTarget(null);
    setReaderPosition(position);
    openTab(b);
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
      case 'reader': {
        if (!currentBook) return null;
        const reader = (
          <Reader
            key={currentBook.id}
            book={currentBook}
            initialTarget={readerTarget}
            initialPosition={readerPosition}
            onBack={handleBack}
          />
        );
        // 只有一个标签时不套外壳，布局与原来完全一致
        if (tabs.length <= 1) return reader;
        return (
          <div className="reader-tabs-wrap">
            <div className="reader-tabs">
              {tabs.map(b => (
                <div
                  key={b.id}
                  className={`reader-tab${b.id === currentBook.id ? ' active' : ''}`}
                  onClick={() => activateTab(b)}
                  title={b.title}
                >
                  <span className="reader-tab-title">{b.title}</span>
                  <button
                    className="reader-tab-close"
                    title="关闭标签"
                    onClick={e => {
                      e.stopPropagation();
                      closeTab(b.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {reader}
          </div>
        );
      }
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
        return <Statistics onOpenBook={handleSelectBook} />;
      case 'compare':
        return <Compare books={books} />;
      case 'pdf':
        return <PdfTools books={books} />;
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
