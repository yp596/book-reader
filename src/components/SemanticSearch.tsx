import { useState, useEffect } from 'react';
import { Book } from '../types';
import { Icon } from './Icon';

interface RagHit {
  book_id: number;
  bookTitle: string;
  chapter: string;
  target: string;
  excerpt: string;
  score: number;
}

interface IndexStatus {
  book_id: number;
  title: string;
  chunks: number;
  updated_at: string;
}

interface SemanticSearchProps {
  books: Book[];
  onOpenBook: (book: Book, target?: { label: string; href: string; page?: number }) => void;
}

export function SemanticSearch({ books, onOpenBook }: SemanticSearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RagHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [status, setStatus] = useState<IndexStatus[]>([]);
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [allBooks, setAllBooks] = useState<Book[]>(books);

  useEffect(() => {
    loadStatus();
    // 直接进本页时书架可能还没加载，自己拉一次
    if (books.length === 0) {
      window.electronAPI?.getAllBooks().then(b => setAllBooks(b as Book[])).catch(() => {});
    } else {
      setAllBooks(books);
    }
  }, []);

  const loadStatus = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setStatus(await api.getRagStatus());
  };

  const indexedIds = new Set(status.map(s => s.book_id));
  const unindexed = allBooks.filter(b => !indexedIds.has(b.id));

  const handleBuild = async (bookId: number) => {
    const api = window.electronAPI;
    if (!api) return;
    setBuildingId(bookId);
    try {
      const r = await api.buildRagIndex(bookId);
      alert(`建立完成，这本书拆成 ${r.chunks} 段内容，可以开始提问了。`);
      loadStatus();
    } catch (err) {
      alert(err instanceof Error ? err.message : '建索引失败');
    } finally {
      setBuildingId(null);
    }
  };

  const handleClear = async (bookId: number) => {
    if (!confirm('删除这本书的索引？删除后可随时重新建立，不影响书籍与笔记。')) return;
    try {
      await window.electronAPI?.clearRagIndex(bookId);
      loadStatus();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除索引失败，请重试');
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    const api = window.electronAPI;
    if (!api) return;
    setSearching(true);
    setSearchError('');
    setHits([]);
    try {
      setHits(await api.semanticSearch(query.trim(), 8));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '检索失败');
    } finally {
      setSearching(false);
    }
  };

  const openHit = async (hit: RagHit) => {
    const api = window.electronAPI;
    if (!api) return;
    const book = (await api.getBookById(hit.book_id)) as Book;
    if (!book) return;
    let target: { label: string; href: string; page?: number } | undefined;
    try {
      const t = JSON.parse(hit.target);
      if (t.href || t.page != null) target = { label: hit.chapter, href: t.href ?? '', page: t.page };
    } catch { /* 无目标则只打开书 */ }
    onOpenBook(book, target);
  };

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>语义检索</h1>
      </div>

      <div className="info-bar">
        <Icon name="info" size={15} />
        <p>按意思找内容，不止关键词。先给书建立索引，再用自然语言提问。索引与检索都在本机完成，不上传任何内容。</p>
      </div>

      <section className="settings-section">
        <h2>问一问</h2>
        <div className="search-box">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="例如：主人公为什么离开家乡？"
          />
          <button className="btn-primary" onClick={handleSearch} disabled={searching}>
            {searching ? '查找中…' : '搜'}
          </button>
        </div>
        {searchError && <p className="search-error">{searchError}</p>}
        {hits.map((h, i) => (
          <div key={i} className="mark-item search-hit" onClick={() => openHit(h)}>
            <p className="mark-label">
              《{h.bookTitle}》{h.chapter ? ` · ${h.chapter}` : ''} · 相关度 {(h.score * 100).toFixed(0)}%
            </p>
            <p className="mark-quote">...{h.excerpt}...</p>
          </div>
        ))}
        {!searching && query && hits.length === 0 && !searchError && (
          <p className="empty-text">没有找到相关内容，换个说法或换本书再试</p>
        )}
      </section>

      <section className="settings-section">
        <h2>索引管理</h2>
        {status.length === 0 && unindexed.length === 0 && (
          <p className="empty-text">书架里还没有书。先去书架导入一本，再回来建立索引。</p>
        )}
        {status.map(s => (
          <div key={s.book_id} className="source-card" style={{ marginBottom: 10 }}>
            <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
              <h3>《{s.title}》</h3>
              <p className="source-url">已整理 {s.chunks} 段 · {s.updated_at ? new Date(s.updated_at).toLocaleString() : ''}</p>
            </div>
            <div className="source-actions" style={{ gap: 8, display: 'flex' }}>
              <button className="btn-secondary small" onClick={() => handleBuild(s.book_id)} disabled={buildingId === s.book_id}>
                {buildingId === s.book_id ? '建立中…' : '重新建立'}
              </button>
              <button className="btn-danger small" onClick={() => handleClear(s.book_id)}>删除</button>
            </div>
          </div>
        ))}
        {unindexed.map(b => (
          <div key={b.id} className="source-card" style={{ marginBottom: 10, opacity: 0.75 }}>
            <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
              <h3>《{b.title}》</h3>
              <p className="source-url">尚未建立索引</p>
            </div>
            <div className="source-actions" style={{ gap: 8, display: 'flex' }}>
              <button className="btn-secondary small" onClick={() => handleBuild(b.id)} disabled={buildingId === b.id}>
                {buildingId === b.id ? '建立中…' : '建立索引'}
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
