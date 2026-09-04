import { useState } from 'react';
import { Book, TocEntry } from './types';
import { BookList } from './components/BookList';
import { BookDetail } from './components/BookDetail';
import { Reader } from './components/Reader';
import { Sidebar } from './components/Sidebar';
import { SourceManager } from './components/SourceManager';
import { Settings } from './components/Settings';
import { Statistics } from './components/Statistics';

type View = 'library' | 'detail' | 'reader' | 'sources' | 'settings' | 'stats';

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
  onOpenFile: () => {},
};

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBook, setCurrentBook] = useState<Book | null>(null);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [readerTarget, setReaderTarget] = useState<TocEntry | null>(null);
  const [view, setView] = useState<View>('library');
  const [searchQuery, setSearchQuery] = useState('');

  const loadBooks = async () => {
    const allBooks = await api.getAllBooks();
    setBooks(allBooks as Book[]);
  };

  const handleOpenFile = async () => {
    await api.importBook();
    await loadBooks();
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

  const handleShowDetail = (book: Book) => {
    setDetailBook(book);
    setView('detail');
  };

  const handleBack = () => {
    setCurrentBook(null);
    setReaderTarget(null);
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
          <Reader book={currentBook} initialTarget={readerTarget} onBack={handleBack} />
        ) : null;
      case 'sources':
        return <SourceManager />;
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
    </div>
  );
}

export default App;
