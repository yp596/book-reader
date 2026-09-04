import { useState, useEffect } from 'react';
import { Book, Bookmark, Note, TocEntry } from '../types';
import { formatFileSize } from '../utils/text';

interface BookDetailProps {
  book: Book;
  onBack: () => void;
  onRead: (book: Book) => void;
}

type Tab = 'toc' | 'notes' | 'marks' | 'info';

export function BookDetail({ book, onBack, onRead }: BookDetailProps) {
  const [tab, setTab] = useState<Tab>('toc');
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [fileSize, setFileSize] = useState(0);

  useEffect(() => {
    loadAll();
  }, [book.id]);

  const loadAll = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setTocLoading(true);
    try {
      const [t, n, m, info] = await Promise.all([
        api.getBookToc(book.id) as Promise<TocEntry[]>,
        api.getNotes(book.id),
        api.getBookmarks(book.id),
        api.getBookFileInfo(book.id),
      ]);
      setToc(t);
      setNotes(n as Note[]);
      setMarks(m as Bookmark[]);
      setFileSize(info.size);
    } catch {
      setToc([]);
    } finally {
      setTocLoading(false);
    }
  };

  const jumpToToc = (entry: TocEntry) => {
    // EPUB 用 href，TXT/PDF 用页码 — 交给阅读器处理，详情页只负责打开
    onRead({ ...book, _tocTarget: entry } as Book & { _tocTarget: TocEntry });
  };

  return (
    <div className="book-detail">
      <button className="back-btn" onClick={onBack}>← 返回书架</button>

      <div className="detail-hero">
        <div className="detail-cover">
          {book.cover_path ? (
            <img src={book.cover_path} alt={book.title} />
          ) : (
            <div className="book-cover-placeholder large">{book.file_type.toUpperCase()}</div>
          )}
        </div>
        <div className="detail-info">
          <h1>{book.favorite ? '⭐ ' : ''}{book.title}</h1>
          <p className="detail-author">{book.author || '未知作者'}</p>
          <p className="book-meta">
            {book.file_type.toUpperCase()} · {formatFileSize(fileSize)}
            {book.category ? ` · ${book.category}` : ''}
          </p>
          <div className="book-progress large">
            <div className="progress-bar">
              <div style={{ width: `${book.progress * 100}%` }} />
            </div>
            <span className="progress-text">
              {book.progress > 0 ? `已读 ${Math.round(book.progress * 100)}%` : '未开始'}
            </span>
          </div>
          <button className="btn-primary large" onClick={() => onRead(book)}>
            {book.progress > 0 ? '继续阅读' : '开始阅读'}
          </button>
        </div>
      </div>

      <div className="detail-tabs">
        {([
          ['toc', `目录${toc.length > 0 ? `（${toc.length}）` : ''}`],
          ['notes', `笔记（${notes.length}）`],
          ['marks', `书签（${marks.length}）`],
          ['info', '信息'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`detail-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'toc' && (
          <>
            {tocLoading ? (
              <p className="empty-text">加载目录中...</p>
            ) : toc.length === 0 ? (
              <p className="empty-text">本书无目录信息</p>
            ) : (
              <div className="toc-list">
                {toc.map((t, i) => (
                  <div key={i} className="toc-item full" onClick={() => jumpToToc(t)}>
                    {t.label}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'notes' && (
          <>
            {notes.length === 0 ? (
              <p className="empty-text">暂无笔记，去阅读时选中正文添加</p>
            ) : (
              notes.map(n => (
                <div key={n.id} className="mark-item">
                  {n.selected_text && <p className="mark-quote">{n.selected_text}</p>}
                  {n.note && <p className="mark-note">{n.note}</p>}
                  <p className="book-meta">{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</p>
                </div>
              ))
            )}
          </>
        )}

        {tab === 'marks' && (
          <>
            {marks.length === 0 ? (
              <p className="empty-text">暂无书签，去阅读时选中正文高亮</p>
            ) : (
              marks.map(m => (
                <div key={m.id} className="mark-item">
                  {m.text && <p className="mark-quote">{m.text}</p>}
                  <p className="book-meta">{m.created_at ? new Date(m.created_at).toLocaleString() : ''}</p>
                </div>
              ))
            )}
          </>
        )}

        {tab === 'info' && (
          <div className="info-table">
            <div className="info-row"><span>书名</span><span>{book.title}</span></div>
            <div className="info-row"><span>作者</span><span>{book.author || '未知'}</span></div>
            <div className="info-row"><span>格式</span><span>{book.file_type.toUpperCase()}</span></div>
            <div className="info-row"><span>大小</span><span>{formatFileSize(fileSize)}</span></div>
            <div className="info-row"><span>分类</span><span>{book.category || '未分类'}</span></div>
            <div className="info-row">
              <span>上次阅读</span>
              <span>{book.last_read_at ? new Date(book.last_read_at).toLocaleString() : '从未'}</span>
            </div>
            <div className="info-row">
              <span>加入时间</span>
              <span>{book.created_at ? new Date(book.created_at).toLocaleString() : '-'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
