import { useState } from 'react';
import { Book } from './types';
import { BookList } from './components/BookList';
import { Reader } from './components/Reader';
import { Sidebar } from './components/Sidebar';
import { SourceManager } from './components/SourceManager';
import { Settings } from './components/Settings';
import { Statistics } from './components/Statistics';

type View = 'library' | 'reader' | 'sources' | 'settings' | 'stats';

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

  const handleSelectBook = (book: Book) => {
    setCurrentBook(book);
    setView('reader');
  };

  const handleBack = () => {
    setCurrentBook(null);
    setView('library');
    loadBooks();
  };

  const renderContent = () => {
    switch (view) {
      case 'library':
        return (
          <BookList
            books={books}
            searchQuery={searchQuery}
            onSelectBook={handleSelectBook}
            onRefresh={loadBooks}
          />
        );
      case 'reader':
        return currentBook ? (
          <Reader book={currentBook} onBack={handleBack} />
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
        currentView={view}
        onNavigate={setView}
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
