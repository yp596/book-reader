import { useState, useEffect, type CSSProperties } from 'react';
import { Book, Bookmark, Note, TocEntry } from '../types';
import { formatFileSize } from '../utils/text';
import { coverHue } from '../utils/cover';
import { Icon, StarRating } from './Icon';

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
  // TXT 目录解析：可选规则、本书指定规则、目录来源（auto/manual）
  const [ruleNames, setRuleNames] = useState<string[]>([]);
  const [tocRule, setTocRule] = useState('');
  const [tocSource, setTocSource] = useState('');
  const [tocEditing, setTocEditing] = useState(false);
  const [tocBusy, setTocBusy] = useState(false);

  useEffect(() => {
    loadAll();
  }, [book.id]);

  const loadAll = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setTocLoading(true);
    try {
      const [t, n, m, info, rules] = await Promise.all([
        api.getBookToc(book.id) as Promise<TocEntry[]>,
        api.getNotes(book.id),
        api.getBookmarks(book.id),
        api.getBookFileInfo(book.id),
        api.getTocRules(book.id),
      ]);
      setToc(t);
      setNotes(n as Note[]);
      setMarks(m as Bookmark[]);
      setFileSize(info.size);
      setRuleNames(rules.rules);
      setTocRule(rules.current);
      setTocSource(rules.source);
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

  /** 切换本书使用的目录规则并重新解析（空串=恢复自动择优） */
  const applyTocRule = async (ruleName: string) => {
    const api = window.electronAPI;
    if (!api) return;
    setTocBusy(true);
    try {
      const entries = await api.reparseToc(book.id, ruleName);
      setToc(entries);
      setTocRule(ruleName);
      setTocSource('auto');
      setTocEditing(false);
    } catch (err) {
      alert(`重新解析失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTocBusy(false);
    }
  };

  /** 进入编辑态；退出时把改动写回（标记为手动编辑，不再被自动解析覆盖） */
  const toggleTocEdit = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (!tocEditing) {
      setTocEditing(true);
      return;
    }
    setTocBusy(true);
    try {
      await api.saveToc(book.id, toc);
      setTocSource('manual');
      setTocEditing(false);
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTocBusy(false);
    }
  };

  const renameTocEntry = (index: number, label: string) => {
    setToc(list => list.map((e, i) => (i === index ? { ...e, label } : e)));
  };

  const removeTocEntry = (index: number) => {
    setToc(list => list.filter((_, i) => i !== index));
  };

  return (
    <div className="book-detail">
      <button className="back-btn" onClick={onBack}>
        <Icon name="arrow-left" size={14} />
        返回书架
      </button>
      <button
        className="link-btn"
        style={{ marginLeft: 12 }}
        onClick={() => window.electronAPI?.openReaderWindow(book.id)}
      >
        <Icon name="external-link" size={13} />
        在新窗口打开
      </button>

      <div className="detail-hero">
        <div className="detail-cover">
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
        </div>
        <div className="detail-info">
          <h1>
            {book.title}
            {book.favorite ? <Icon name="star-fill" size={16} className="detail-fav" /> : null}
          </h1>
          <p className="detail-author">{book.author || '未知作者'}</p>
          {book.rating ? <StarRating value={book.rating} size={14} /> : null}
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
            <Icon name="book-open" size={15} />
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
            {book.file_type === 'txt' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, opacity: 0.75 }}>解析方式</label>
                  <select
                    value={tocRule}
                    disabled={tocBusy}
                    onChange={e => applyTocRule(e.target.value)}
                    style={{ flex: 1, minWidth: 160, maxWidth: 280 }}
                  >
                    <option value="">自动（内置规则择优）</option>
                    {ruleNames.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <button className="link-btn" disabled={tocBusy} onClick={() => applyTocRule(tocRule)}>
                    重新解析
                  </button>
                  <button className="link-btn" disabled={tocBusy} onClick={toggleTocEdit}>
                    {tocEditing ? '保存' : '编辑'}
                  </button>
                </div>
                {tocSource === 'manual' && !tocEditing && (
                  <p className="empty-text" style={{ marginBottom: 8 }}>
                    目录已手动编辑过，重新解析会覆盖手动改动
                  </p>
                )}
              </>
            )}
            {tocLoading ? (
              <p className="empty-text">加载目录中...</p>
            ) : toc.length === 0 ? (
              <p className="empty-text">本书无目录信息</p>
            ) : (
              <div className="toc-list">
                {toc.map((t, i) =>
                  tocEditing ? (
                    <div
                      key={i}
                      className="toc-item full"
                      style={{ display: 'flex', gap: 8, cursor: 'default' }}
                    >
                      <input
                        value={t.label}
                        onChange={e => renameTocEntry(i, e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button className="danger" onClick={() => removeTocEntry(i)}>删除</button>
                    </div>
                  ) : (
                    <div key={i} className="toc-item full" onClick={() => jumpToToc(t)}>
                      {t.label}
                    </div>
                  ),
                )}
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
