import { useState, useEffect, useRef } from 'react';
import { Book, TocEntry } from './types';
import { BookList } from './components/BookList';
import { BookDetail } from './components/BookDetail';
import { Reader } from './components/Reader';
import { Sidebar } from './components/Sidebar';
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

type View = 'library' | 'detail' | 'reader' | 'rag' | 'vocab' | 'notes' | 'models' | 'settings' | 'stats' | 'help' | 'compare' | 'pdf';

// 安全获取 electronAPI，preload 未就绪时返回空实现
const api = window.electronAPI ?? {
  importBook: async () => [],
  getAllBooks: async () => [],
  getBookById: async () => null,
  deleteBook: async () => {},
  updateProgress: async () => {},
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
  onCloseTab: () => () => {},
  setWindowTitle: async () => {},
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

  /** 轻量提示：后台自动入库这类不必打断用户的消息用它，不用弹窗 */
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };

  /**
   * 首次启动引导的判定。
   *
   * 这段以前是 `window.electronAPI?.getSetting('onboarded').then(...).catch(() => {})`，
   * 三重静默叠在一起：可选链在 preload 缺失时整条短路、catch 吞掉 IPC 失败、
   * 且**一次都不重试**。任何一次瞬时失败都会变成「引导页永远不弹」，而控制台
   * 一条线索都没有——查起来无从下手（本文件顶部给 api 做空实现兜底，说明
   * 「preload 未就绪」是被承认过的场景，唯独这里没兜）。
   *
   * 现在：读不到就短退避重试；重试完仍读不到，按**未看过**处理并留一条 warn。
   * 依据是「取不到标记」不等于「用户看过」——而这是一张纯说明卡，
   * 误弹一次的代价远低于让新用户永远得不到引导。
   */
  useEffect(() => {
    let alive = true;
    const ATTEMPTS = 5;
    const RETRY_DELAY_MS = 200;

    /** 读到值就返回它（没存过是 null）；读不到返回 undefined，由调用方决定要不要重试 */
    const readOnboarded = async (): Promise<string | null | undefined> => {
      try {
        return await window.electronAPI?.getSetting('onboarded');
      } catch {
        return undefined;
      }
    };

    void (async () => {
      for (let i = 0; i < ATTEMPTS; i++) {
        const v = await readOnboarded();
        if (v !== undefined) {
          if (alive && v !== '1') setShowOnboarding(true);
          return;
        }
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
      if (!alive) return;
      console.warn('[onboarding] 读不到 onboarded 标记，按首次启动处理');
      setShowOnboarding(true);
    })();

    return () => { alive = false; };
  }, []);

  // 文件夹监视自动入库：主进程推来书名后刷新书架并说一句。
  // 之前只发不订阅，看完书回来书架还是旧的，用户会以为监视没生效。
  useEffect(() => {
    const eapi = window.electronAPI;
    if (!eapi?.onWatchImported) return;
    return eapi.onWatchImported(name => {
      showToast(`监视的文件夹有新书：《${name}》，已加入书架`);
      void loadBooks();
    });
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
  // 两条来源的空值含义不同：冷启动取不到路径就是普通启动，什么都不该做；
  // 只有运行中收到的无路径推送才代表菜单/快捷键发起的导入（Ctrl+O）。
  useEffect(() => {
    window.electronAPI
      ?.takeOpenFile?.()
      .then(filePath => { if (filePath) void handleOpenPath(filePath); })
      .catch(() => {});
    return api.onOpenFile(filePath => {
      if (filePath) void handleOpenPath(filePath);
      else void handleOpenFile();
    });
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
    try {
      const r = await api.importBook();
      await loadBooks();
      // 明确告知哪些没导进来、为什么——静默跳过会让人以为成功了
      if (r?.failed?.length) {
        const lines = r.failed.map(f => `· ${f.name}：${f.reason}`);
        alert(['以下文件未导入：', ...lines].join('\n'));
      } else if (r?.imported?.length) {
        showToast(`已导入 ${r.imported.length} 本书`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '导入失败，请重试');
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

  /**
   * Ctrl+W 关闭当前文档。键由主进程拦下再转发（EPUB 正文在 iframe 里，
   * 渲染层的 window 监听收不到那里的按键），这里只按当前视图决定关哪个标签。
   * 不在阅读视图时静默忽略——无应用菜单时该键本就没有默认行为，白拦一下无妨。
   */
  useEffect(() => {
    return api.onCloseTab(() => {
      if (view !== 'reader' || !currentBook) return;
      closeTab(currentBook.id);
    });
  }, [view, currentBook, closeTab]);

  /**
   * 窗口标题跟随当前书——任务栏悬停时显示的就是这行字，多开几本书时靠它分辨谁是谁。
   * 只在阅读视图用书名，回到书架 / 详情页 / 侧栏各页一律回到应用名：
   * 标题停在上一本书上，比没有标题更误导。
   */
  useEffect(() => {
    void api.setWindowTitle(view === 'reader' && currentBook ? currentBook.title : '阅读书架');
  }, [view, currentBook]);

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
            onOpenBook={handleSelectBook}
          />
        );
        // 标签栏常驻：单标签时也要能点 × 关掉。此前「只有一个标签时不套外壳」
        // 会让标签栏在关到剩一个时消失，最后一个标签再没有关闭入口。
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
