import { useState } from 'react';
import { Book } from './types';
import { BookList } from './components/BookList';
import { Reader } from './components/Reader';
import { Sidebar } from './components/Sidebar';
import { SourceManager } from './components/SourceManager';
import { Settings } from './components/Settings';
import { Statistics } from './components/Statistics';

type View = 'library' | 'reader' | 'sources' | 'settings' | 'stats';

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBook, setCurrentBook] = useState<Book | null>(null);
  const [view, setView] = useState<View>('library');
  const [searchQuery, setSearchQuery] = useState('');

  const loadBooks = async () => {
    const allBooks = await window.electronAPI.getAllBooks();
    setBooks(allBooks as Book[]);
  };

  const handleOpenFile = async () => {
    await window.electronAPI.importBook();
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
