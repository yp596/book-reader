import { useState, useEffect } from 'react';
import { Book } from '../types';
import { formatFileSize } from '../utils/text';

interface BookListProps {
  books: Book[];
  searchQuery: string;
  onSelectBook: (book: Book) => void;
  onShowDetail: (book: Book) => void;
  onRefresh: () => void;
  onImport: () => void;
}

type ViewMode = 'grid' | 'list';
type SortBy = 'recent' | 'title' | 'author';
type Filter = 'all' | 'reading' | 'finished' | 'favorite';

export function BookList({ books, searchQuery, onSelectBook, onShowDetail, onRefresh, onImport }: BookListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ book: Book; x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    onRefresh();
    window.electronAPI?.getCategories().then(setCategories).catch(() => {});
  }, []);

  const filteredBooks = books
    .filter(book => {
      switch (filter) {
        case 'reading':
          if (!(book.progress > 0 && book.progress < 0.95)) return false;
          break;
        case 'finished':
          if (!(book.progress >= 0.95)) return false;
          break;
        case 'favorite':
          if (!book.favorite) return false;
          break;
        default:
          break;
      }
      if (categoryFilter && book.category !== categoryFilter) return false;
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

  // 继续阅读：最近读过且未读完的第一本
  const continueBook = books
    .filter(b => b.progress > 0 && b.progress < 0.95 && b.last_read_at)
    .sort((a, b) => (b.last_read_at || '').localeCompare(a.last_read_at || ''))[0];

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ book, x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setContextMenu(null);

  const handleDelete = async () => {
    if (contextMenu) {
      await window.electronAPI?.deleteBook(contextMenu.book.id);
      closeMenu();
      onRefresh();
    }
  };

  const handleRefreshMetadata = async () => {
    if (contextMenu) {
      try {
        await window.electronAPI?.refreshBookMetadata(contextMenu.book.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '识别失败');
      }
      closeMenu();
      onRefresh();
    }
  };

  const handleRename = async () => {
    if (contextMenu) {
      const newName = prompt('输入新书名:', contextMenu.book.title);
      if (newName && newName.trim() && newName.trim() !== contextMenu.book.title) {
        try {
          await window.electronAPI?.renameBook(contextMenu.book.id, newName.trim());
          onRefresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : '重命名失败');
        }
      }
      closeMenu();
    }
  };

  const handleToggleFavorite = async () => {
    if (contextMenu) {
      await window.electronAPI?.toggleFavorite(contextMenu.book.id);
      closeMenu();
      onRefresh();
    }
  };

  const handleSetCategory = async () => {
    if (contextMenu) {
      const hint = categories.length > 0 ? `（已有：${categories.join('、')}）` : '';
      const cat = prompt(`输入分类${hint}，留空清除：`, contextMenu.book.category || '');
      if (cat !== null) {
        await window.electronAPI?.setCategory(contextMenu.book.id, cat.trim());
        const updated = await window.electronAPI?.getCategories();
        if (updated) setCategories(updated as string[]);
        onRefresh();
      }
      closeMenu();
    }
  };

  const handleReveal = async () => {
    if (contextMenu) {
      try {
        await window.electronAPI?.revealBookFile(contextMenu.book.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '打开失败');
      }
      closeMenu();
    }
  };

  const handleFileInfo = async () => {
    if (contextMenu) {
      try {
        const info = await window.electronAPI?.getBookFileInfo(contextMenu.book.id);
        if (info) {
          alert(
            `书名：${info.title}\n作者：${info.author}\n文件名：${info.fileName}\n格式：${info.fileType.toUpperCase()}\n大小：${formatFileSize(info.size)}\n修改时间：${info.mtime}\n进度：${Math.round(info.progress * 100)}%`,
          );
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '获取失败');
      }
      closeMenu();
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('确定清除全部阅读记录吗？书籍保留，进度归零。')) return;
    await window.electronAPI?.clearReadingHistory();
    onRefresh();
  };

  // 拖拽导入
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const api = window.electronAPI;
    if (!api) return;
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const p = api.getPathForFile(f);
        if (p) paths.push(p);
      } catch { /* 忽略 */ }
    }
    if (paths.length > 0) {
      await api.importPaths(paths);
      const updated = await api.getCategories();
      if (updated) setCategories(updated as string[]);
      onRefresh();
    }
  };

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'reading', label: '正在读' },
    { key: 'finished', label: '已读完' },
    { key: 'favorite', label: '⭐ 收藏' },
  ];

  return (
    <div
      className="book-list"
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">📚 松开导入 EPUB / TXT / PDF / DOCX</div>
        </div>
      )}

      <div className="book-list-header">
        <h1>我的书架</h1>
        <div className="book-list-controls">
          <button className="btn-secondary small" onClick={handleClearHistory} title="清除全部阅读进度">
            清除记录
          </button>
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

      {continueBook && (
        <div className="continue-card" onClick={() => onSelectBook(continueBook)}>
          <div className="continue-icon">📖</div>
          <div className="continue-info">
            <p className="continue-label">继续阅读</p>
            <h3>{continueBook.title}</h3>
            <div className="book-progress">
              <div className="progress-bar">
                <div style={{ width: `${continueBook.progress * 100}%` }} />
              </div>
              <span className="progress-text">{Math.round(continueBook.progress * 100)}%</span>
            </div>
          </div>
          <span className="continue-go">→</span>
        </div>
      )}

      <div className="filter-row">
        {filters.map(f => (
          <button
            key={f.key}
            className={`filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="category-select"
          >
            <option value="">全部分类</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {filteredBooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📚</div>
          <h2>书架空空如也</h2>
          <p>支持 EPUB、TXT、PDF、DOCX，可直接拖入窗口</p>
          <button className="btn-primary empty-cta" onClick={onImport}>
            ＋ 导入第一本书
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="book-grid">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className="book-card"
              onClick={() => onShowDetail(book)}
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
                {book.favorite ? <span className="fav-badge">⭐</span> : null}
              </div>
              <div className="book-info">
                <h3 className="book-title">{book.title}</h3>
                {book.author && <p className="book-author">{book.author}</p>}
                {book.category && <p className="book-category">{book.category}</p>}
                {book.progress > 0 && (
                  <div className="book-progress">
                    <div className="progress-bar">
                      <div style={{ width: `${book.progress * 100}%` }} />
                    </div>
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
              onClick={() => onShowDetail(book)}
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
                <h3>{book.favorite ? '⭐ ' : ''}{book.title}</h3>
                <p>{book.author || '未知作者'}{book.category ? ` · ${book.category}` : ''}</p>
                <p className="book-meta">{book.file_type.toUpperCase()} · {book.progress > 0 ? `已读 ${Math.round(book.progress * 100)}%` : '未读'}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={closeMenu}
        >
          <div className="context-menu-item" onClick={() => onShowDetail(contextMenu.book)}>详情</div>
          <div className="context-menu-item" onClick={handleToggleFavorite}>
            {contextMenu.book.favorite ? '取消收藏' : '⭐ 收藏'}
          </div>
          <div className="context-menu-item" onClick={handleSetCategory}>设置分类</div>
          <div className="context-menu-item" onClick={handleRename}>重命名</div>
          <div className="context-menu-item" onClick={handleRefreshMetadata}>重新识别标题</div>
          <div className="context-menu-item" onClick={handleFileInfo}>属性</div>
          <div className="context-menu-item" onClick={handleReveal}>打开所在位置</div>
          <div className="context-menu-item danger" onClick={handleDelete}>删除</div>
        </div>
      )}
    </div>
  );
}
