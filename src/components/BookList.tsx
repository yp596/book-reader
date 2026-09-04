import { useState, useEffect } from 'react';
import { Book } from '../types';

interface BookListProps {
  books: Book[];
  searchQuery: string;
  onSelectBook: (book: Book) => void;
  onRefresh: () => void;
}

type ViewMode = 'grid' | 'list';
type SortBy = 'recent' | 'title' | 'author';

export function BookList({ books, searchQuery, onSelectBook, onRefresh }: BookListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [contextMenu, setContextMenu] = useState<{ book: Book; x: number; y: number } | null>(null);

  useEffect(() => {
    onRefresh();
  }, []);

  const filteredBooks = books
    .filter(book => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        book.title.toLowerCase().includes(q) ||
        book.author?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'title':
          return a.title.localeCompare(b.title);
        case 'author':
          return (a.author || '').localeCompare(b.author || '');
        case 'recent':
        default:
          return (b.last_read_at || '').localeCompare(a.last_read_at || '');
      }
    });

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ book, x: e.clientX, y: e.clientY });
  };

  const handleDelete = async () => {
    if (contextMenu) {
      await window.electronAPI.deleteBook(contextMenu.book.id);
      setContextMenu(null);
      onRefresh();
    }
  };

  const handleRename = async () => {
    if (contextMenu) {
      const newName = prompt('输入新书名:', contextMenu.book.title);
      if (newName && newName !== contextMenu.book.title) {
        // TODO: 实现重命名
        setContextMenu(null);
      }
    }
  };

  return (
    <div className="book-list">
      <div className="book-list-header">
        <h1>我的书架</h1>
        <div className="book-list-controls">
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
            <option value="recent">最近阅读</option>
            <option value="title">按书名</option>
            <option value="author">按作者</option>
          </select>
          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            ▦
          </button>
          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            ☰
          </button>
        </div>
      </div>

      {filteredBooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📚</div>
          <h2>书架空空如也</h2>
          <p>点击「导入书籍」按钮添加 EPUB、TXT 或 PDF 文件</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="book-grid">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className="book-card"
              onClick={() => onSelectBook(book)}
              onContextMenu={(e) => handleContextMenu(e, book)}
            >
              <div className="book-cover">
                {book.cover_path ? (
                  <img src={book.cover_path} alt={book.title} />
                ) : (
                  <div className="book-cover-placeholder">
                    <span>{book.file_type.toUpperCase()}</span>
                  </div>
                )}
              </div>
              <div className="book-info">
                <h3 className="book-title">{book.title}</h3>
                {book.author && <p className="book-author">{book.author}</p>}
                {book.progress > 0 && (
                  <div className="book-progress">
                    <div className="progress-bar" style={{ width: `${book.progress * 100}%` }} />
                    <span className="progress-text">{Math.round(book.progress * 100)}%</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="book-list-view">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className="book-list-item"
              onClick={() => onSelectBook(book)}
              onContextMenu={(e) => handleContextMenu(e, book)}
            >
              <div className="book-list-cover">
                {book.cover_path ? (
                  <img src={book.cover_path} alt={book.title} />
                ) : (
                  <div className="book-cover-placeholder small">{book.file_type.toUpperCase()}</div>
                )}
              </div>
              <div className="book-list-info">
                <h3>{book.title}</h3>
                <p>{book.author || '未知作者'}</p>
                <p className="book-meta">{book.file_type.toUpperCase()} · {book.progress > 0 ? `${Math.round(book.progress * 100)}%` : '未读'}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <div className="context-menu-item" onClick={handleRename}>重命名</div>
          <div className="context-menu-item danger" onClick={handleDelete}>删除</div>
        </div>
      )}
    </div>
  );
}
