import { useState, useEffect, type CSSProperties } from 'react';
import { Book } from '../types';
import { formatFileSize } from '../utils/text';
import { coverHue } from '../utils/cover';
import { Icon, StarRating } from './Icon';

interface BookListProps {
  books: Book[];
  searchQuery: string;
  onSelectBook: (book: Book) => void;
  onShowDetail: (book: Book) => void;
  onRefresh: () => void;
  onImport: () => void;
}

type ViewMode = 'grid' | 'list';
type SortBy = SortByWithRating;
type Filter = 'all' | 'reading' | 'finished' | 'favorite' | 'shelved' | 'idle';
type SortByWithRating = 'recent' | 'title' | 'author' | 'rating';

export function BookList({ books, searchQuery, onSelectBook, onShowDetail, onRefresh, onImport }: BookListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [seriesList, setSeriesList] = useState<string[]>([]);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ book: Book; x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** 闲置判定天数（设置页可调，默认 90 天） */
  const [idleDays, setIdleDays] = useState(90);
  // 批量管理：勾选态与所选 id
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  /** 源文件已改动或已移走的书：导入是复制，书库不主动看就发现不了 */
  const [sourceIssues, setSourceIssues] = useState<
    { id: number; title: string; status: 'changed' | 'missing'; sourcePath: string }[]
  >([]);
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);

  const loadSourceIssues = async () => {
    try {
      setSourceIssues((await window.electronAPI?.checkBookSources()) ?? []);
    } catch { /* 体检失败不打扰用户 */ }
  };

  const handleRefreshFromSource = async (id: number) => {
    try {
      await window.electronAPI?.refreshBookFromSource(id);
      setSourceIssues(prev => prev.filter(b => b.id !== id));
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新失败');
    }
  };

  useEffect(() => {
    onRefresh();
    void loadSourceIssues();
    window.electronAPI?.getCategories().then(setCategories).catch(() => {});
    window.electronAPI?.getSeriesList().then(setSeriesList).catch(() => {});
    window.electronAPI?.getSetting('idleDays').then(v => {
      const d = Number(v);
      if (Number.isFinite(d) && d > 0) setIdleDays(d);
    }).catch(() => {});
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
        case 'shelved':
          if (book.status !== 'shelved') return false;
          break;
        case 'idle': {
          // 从未读过则看加入时间；都没有时间戳的保守放行
          const raw = book.last_read_at || book.created_at;
          const t = raw ? new Date(raw).getTime() : NaN;
          if (!Number.isNaN(t) && t > Date.now() - idleDays * 86400_000) return false;
          break;
        }
        default:
          break;
      }
      if (categoryFilter && book.category !== categoryFilter) return false;
      if (seriesFilter && book.series !== seriesFilter) return false;
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
        case 'rating':
          return (b.rating ?? 0) - (a.rating ?? 0);
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
      if (!confirm(`确定从书架删除《${contextMenu.book.title}》？\n书签、笔记、阅读记录与书库内的文件副本将一并删除。`)) {
        closeMenu();
        return;
      }
      try {
        await window.electronAPI?.deleteBook(contextMenu.book.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '删除失败');
      }
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
      const newName = prompt('输入新书名（只改书架显示名，不动磁盘文件）:', contextMenu.book.title);
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

  const handleToggleLock = async () => {
    if (contextMenu) {
      try {
        const locked = await window.electronAPI?.toggleBookLock(contextMenu.book.id);
        if (locked) {
          alert('已锁定：删除、改名、分类、收藏、批注等编辑操作将被阻止；阅读与进度保存不受影响。');
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '操作失败');
      }
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

  const STATUS_OPTIONS = [
    { v: '', label: '清除标记（按进度推断）' },
    { v: 'reading', label: '在读' },
    { v: 'finished', label: '已读完' },
    { v: 'shelved', label: '搁置（暂时不读）' },
  ];

  const handleSetStatus = async () => {
    if (!contextMenu) return;
    const cur = contextMenu.book.status ?? '';
    const menu = STATUS_OPTIONS.map((o, i) => `${i}=${o.label}`).join('  ');
    const input = prompt(`设置阅读状态（${menu}）：`, String(Math.max(0, STATUS_OPTIONS.findIndex(o => o.v === cur))));
    if (input === null) return;
    const idx = Number(input);
    const picked = STATUS_OPTIONS[idx];
    if (!picked) {
      alert('请输入列表中的序号');
      return;
    }
    try {
      await window.electronAPI?.setBookStatus(contextMenu.book.id, picked.v);
    } catch (err) {
      alert(err instanceof Error ? err.message : '操作失败');
    }
    closeMenu();
    onRefresh();
  };

  const handleSetRating = async () => {
    if (!contextMenu) return;
    const cur = contextMenu.book.rating ?? 0;
    const input = prompt(`给《${contextMenu.book.title}》评分（0-5，0 表示清除）：`, String(cur));
    if (input === null) return;
    const r = Number(input);
    if (Number.isNaN(r) || r < 0 || r > 5) {
      alert('请输入 0 到 5 之间的数字');
      return;
    }
    try {
      await window.electronAPI?.setBookRating(contextMenu.book.id, r);
    } catch (err) {
      alert(err instanceof Error ? err.message : '操作失败');
    }
    closeMenu();
    onRefresh();
  };

  const handleExportList = async () => {
    try {
      const r = await window.electronAPI?.exportBookList();
      if (r) alert(`已导出 ${r.count} 本书的清单
${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
  };

  const handleExportOne = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.exportOneBook(contextMenu.book.id);
      if (r) alert(`已导出《${contextMenu.book.title}》的批注与笔记（${r.count} 条）
${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
    closeMenu();
  };

  const handleImportOne = async () => {
    try {
      const r = await window.electronAPI?.importOneBook();
      if (r) {
        alert(`已恢复《${r.title}》：批注与笔记 ${r.restored} 条、阅读位置 ${r.positions} 条。`);
        onRefresh();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复失败');
    }
    closeMenu();
  };

  const handleSaveAs = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.saveBookAs(contextMenu.book.id);
      if (r) alert(`已另存为：\n${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '另存失败');
    }
    closeMenu();
  };

  const handleExportText = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.exportBookText(contextMenu.book.id);
      if (r) alert(`已导出正文 ${r.chars.toLocaleString()} 字：\n${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
    closeMenu();
  };

  const handleSetSeries = async () => {
    if (!contextMenu) return;
    const hint = seriesList.length > 0 ? `（已有：${seriesList.join('、')}）` : '';
    const val = prompt(`设置所属系列${hint}，留空取消分组：`, contextMenu.book.series || '');
    if (val === null) return;
    try {
      await window.electronAPI?.setBookSeries(contextMenu.book.id, val.trim());
      setSeriesList((await window.electronAPI?.getSeriesList()) ?? []);
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : '操作失败');
    }
    closeMenu();
  };

  const handleBatchSeries = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const hint = seriesList.length > 0 ? `（已有：${seriesList.join('、')}）` : '';
    const val = prompt(`把所选 ${selectedIds.size} 本归入系列${hint}，留空取消分组：`, '');
    if (val === null) return;
    const targets = batchTargets();
    for (const b of targets) {
      try {
        await api.setBookSeries(b.id, val.trim());
      } catch { /* 单本失败不中断 */ }
    }
    const skipped = selectedIds.size - targets.length;
    setSeriesList((await api.getSeriesList()) ?? []);
    exitBatch();
    onRefresh();
    if (skipped > 0) alert(`已处理 ${targets.length} 本；${skipped} 本因锁定被跳过`);
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

  /** 复制文件路径：分享给别的软件或人时最常用的一步 */
  const handleCopyPath = async () => {
    if (!contextMenu) return;
    try {
      const p = await window.electronAPI?.copyBookPath(contextMenu.book.id);
      if (p) alert(`已复制文件路径：\n${p}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '复制失败');
    }
    closeMenu();
  };

  /** 交给系统默认程序打开（Windows 没有通用分享面板，这是最接近「发送到」的做法） */
  const handleOpenWithSystem = async () => {
    if (!contextMenu) return;
    try {
      await window.electronAPI?.openBookWithSystem(contextMenu.book.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '打开失败');
    }
    closeMenu();
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

  // ---------- 批量管理 ----------

  const toggleSelect = (id: number) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 锁定书籍不参与任何批量写操作 */
  const batchTargets = () => books.filter(b => selectedIds.has(b.id) && !b.locked);

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  const handleBatchCategory = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const hint = categories.length > 0 ? `（已有：${categories.join('、')}）` : '';
    const cat = prompt(`批量为 ${selectedIds.size} 本书设置分类${hint}，留空表示清除分类：`, '');
    if (cat === null) return;
    const targets = batchTargets();
    for (const b of targets) {
      try {
        await api.setCategory(b.id, cat.trim());
      } catch { /* 单本失败不中断整批 */ }
    }
    const skipped = selectedIds.size - targets.length;
    const updated = await api.getCategories();
    if (updated) setCategories(updated as string[]);
    exitBatch();
    onRefresh();
    if (skipped > 0) alert(`已处理 ${targets.length} 本；${skipped} 本因锁定被跳过`);
  };

  const handleBatchLock = async (locked: boolean) => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const targets = books.filter(b => selectedIds.has(b.id));
    for (const b of targets) {
      if (!!b.locked === locked) continue;
      try {
        await api.setBookLock(b.id, locked);
      } catch { /* 忽略 */ }
    }
    exitBatch();
    onRefresh();
  };

  /** 重置所选书籍的专属排版，回到全局默认 */
  const handleBatchResetPrefs = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    if (!confirm(`清除所选 ${selectedIds.size} 本书的专属排版，恢复全局默认？`)) return;
    for (const id of selectedIds) {
      try {
        await api.setSetting(`bookPrefs:${id}`, '');
      } catch { /* 忽略 */ }
    }
    exitBatch();
    alert('已重置，下次打开这些书籍将使用全局默认排版');
  };

  const handleBatchDelete = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const targets = batchTargets();
    const lockedCount = selectedIds.size - targets.length;
    const msg = `确定删除所选 ${targets.length} 本书？` +
      (lockedCount > 0 ? `（另有 ${lockedCount} 本因锁定被跳过）` : '') +
      '\n书签、笔记、阅读记录与书库内的文件副本将一并删除。';
    if (!confirm(msg)) return;
    for (const b of targets) {
      try {
        await api.deleteBook(b.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '删除失败');
      }
    }
    exitBatch();
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
    { key: 'favorite', label: '收藏' },
    { key: 'shelved', label: '搁置' },
    { key: 'idle', label: `闲置 ${idleDays} 天以上` },
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
          <div className="drop-hint">
            <Icon name="download" size={20} />
            松开导入 EPUB / TXT / PDF / DOCX
          </div>
        </div>
      )}

      <div className="book-list-header">
        <h1>我的书架</h1>        <div className="book-list-controls">
          <button
            className={`btn-secondary small${batchMode ? ' active-preset' : ''}`}
            onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
            title="批量管理书架"
          >
            {batchMode ? '退出批量' : '批量管理'}
          </button>
          <button className="btn-secondary small" onClick={handleExportList} title="导出全部书籍的清单（Markdown）">
            导出清单
          </button>
          <button className="btn-secondary small" onClick={handleClearHistory} title="清除全部阅读进度">
            清除记录
          </button>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
            <option value="recent">最近阅读</option>
            <option value="title">按书名</option>
            <option value="author">按作者</option>
            <option value="rating">按评分</option>
          </select>
          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="网格视图"
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="列表视图"
          >
            <Icon name="menu" size={15} />
          </button>
        </div>
      </div>

      {sourceIssues.length > 0 && (
        <div className="source-banner">
          <div className="source-banner-head">
            <span>
              <Icon name="alert" size={15} />
              有 {sourceIssues.length} 本书的源文件已被改动或移走，书库里的还是导入时的版本
            </span>
            <button className="link-btn" onClick={() => setSourcePanelOpen(o => !o)}>
              {sourcePanelOpen ? '收起' : '查看'}
            </button>
          </div>
          {sourcePanelOpen && (
            <div className="source-banner-list">
              {sourceIssues.map(b => (
                <div key={b.id} className="source-banner-row">
                  <div className="source-banner-info">
                    <strong>{b.title}</strong>
                    <em className="privacy-hint">
                      {b.status === 'missing' ? '源文件已不在原位置' : '源文件内容已变化'} · {b.sourcePath}
                    </em>
                  </div>
                  {b.status === 'changed' && (
                    <button className="btn-secondary small" onClick={() => handleRefreshFromSource(b.id)}>
                      用源文件更新
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {continueBook && (
        <div className="continue-card" onClick={() => onSelectBook(continueBook)}>
          <div className="continue-icon"><Icon name="book-open" size={20} /></div>
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
          <span className="continue-go"><Icon name="arrow-right" size={18} /></span>
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
        {seriesList.length > 0 && (
          <select
            value={seriesFilter}
            onChange={e => setSeriesFilter(e.target.value)}
            className="category-select"
          >
            <option value="">全部系列</option>
            {seriesList.map(x => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        )}
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

      {batchMode && (
        <div className="batch-bar">
          <span className="batch-count">已选 {selectedIds.size} 本</span>
          <button
            className="btn-secondary small"
            onClick={() => setSelectedIds(new Set(filteredBooks.map(b => b.id)))}
          >
            全选当前
          </button>
          <button className="btn-secondary small" onClick={() => setSelectedIds(new Set())}>
            清空
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchCategory}
            disabled={selectedIds.size === 0}
          >
            设分类
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchSeries}
            disabled={selectedIds.size === 0}
          >
            设系列
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchLock(true)}
            disabled={selectedIds.size === 0}
          >
            锁定
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchLock(false)}
            disabled={selectedIds.size === 0}
          >
            解锁
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchResetPrefs}
            disabled={selectedIds.size === 0}
          >
            重置排版
          </button>
          <button
            className="btn-danger small"
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
          >
            删除
          </button>
        </div>
      )}

      {filteredBooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="library" size={24} /></div>
          <h2>书架空空如也</h2>
          <p>支持 EPUB、TXT、PDF、DOCX，可直接拖入窗口</p>
          <button className="btn-primary empty-cta" onClick={onImport}>
            <Icon name="plus" size={15} />
            导入第一本书
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="book-grid">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className={`book-card${batchMode ? ' selectable' : ''}${selectedIds.has(book.id) ? ' selected' : ''}`}
              onClick={() => (batchMode ? toggleSelect(book.id) : onShowDetail(book))}
              onContextMenu={(e) => handleContextMenu(e, book)}
            >
              <div className="book-cover">
                {book.cover_path ? (
                  <img src={book.cover_path} alt={book.title} />
                ) : (
                  <div
                    className="book-cover-placeholder"
                    style={{ '--cover-h': coverHue(book.title) } as CSSProperties}
                  >
                    <span className="cover-title">{book.title}</span>
                    <span className="cover-foot">{book.file_type.toUpperCase()}</span>
                  </div>
                )}
                {batchMode && (
                  <span className={`pick-box${selectedIds.has(book.id) ? ' on' : ''}`}>
                    {selectedIds.has(book.id) ? <Icon name="check" size={13} strokeWidth={2.6} /> : ''}
                  </span>
                )}
                {book.favorite ? <span className="fav-badge"><Icon name="star-fill" size={12} /></span> : null}
                {book.locked ? <span className="lock-badge" title="已锁定"><Icon name="lock" size={11} /></span> : null}
                {book.status === 'shelved' ? <span className="shelf-badge" title="已搁置"><Icon name="package" size={11} /></span> : null}
              </div>
              <div className="book-info">
                <h3 className="book-title">{book.title}</h3>
                {book.author && <p className="book-author">{book.author}</p>}
                {book.rating ? (
                  <p className="book-rating" title={`评分 ${book.rating}/5`}>
                    <StarRating value={book.rating} />
                  </p>
                ) : null}
                {(book.series || book.category) && (
                  <p className="book-category">
                    {book.series || ''}
                    {book.series && book.category ? ' · ' : ''}
                    {book.category || ''}
                  </p>
                )}
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
                  <div
                    className="book-cover-placeholder small"
                    style={{ '--cover-h': coverHue(book.title) } as CSSProperties}
                  >
                    <span className="cover-foot">{book.file_type.toUpperCase()}</span>
                  </div>
                )}
              </div>
              <div className="book-list-info">
                <h3>
                  {book.favorite ? <Icon name="star-fill" size={11} className="list-fav" /> : null}
                  <span className="list-title-text">{book.title}</span>
                </h3>
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
            {contextMenu.book.favorite ? '取消收藏' : '加入收藏'}
          </div>
          <div className="context-menu-item" onClick={handleToggleLock}>
            {contextMenu.book.locked ? '解锁书籍' : '锁定书籍'}
          </div>
          <div className="context-menu-item" onClick={handleSetCategory}>设置分类</div>
          <div className="context-menu-item" onClick={handleSetSeries}>设置系列</div>
          <div className="context-menu-item" onClick={handleSetStatus}>阅读状态</div>
          <div className="context-menu-item" onClick={handleSetRating}>评分</div>
          <div className="context-menu-item" onClick={handleRename}>重命名书名</div>
          <div className="context-menu-item" onClick={handleRefreshMetadata}>重新识别标题</div>
          <div className="context-menu-item" onClick={handleFileInfo}>属性</div>
          <div className="context-menu-item" onClick={handleExportOne}>导出批注与笔记</div>
          <div className="context-menu-item" onClick={handleImportOne}>恢复批注与笔记</div>
          <div className="context-menu-item" onClick={handleSaveAs}>另存为副本</div>
          <div className="context-menu-item" onClick={handleExportText}>导出正文为 TXT</div>
          <div className="context-menu-item" onClick={handleReveal}>打开所在位置</div>
          <div className="context-menu-item" onClick={handleCopyPath}>复制文件路径</div>
          <div className="context-menu-item" onClick={handleOpenWithSystem}>用默认程序打开</div>
          <div className="context-menu-item danger" onClick={handleDelete}>删除</div>
        </div>
      )}
    </div>
  );
}
