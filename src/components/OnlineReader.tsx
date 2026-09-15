import { useState, useEffect } from 'react';
import { BookSource, OnlineBook, OnlineChapter } from '../types';
import { Icon } from './Icon';

interface OnlineReaderProps {
  source: BookSource;
  book: OnlineBook;
  onBack: () => void;
}

export function OnlineReader({ source, book, onBack }: OnlineReaderProps) {
  const [chapters, setChapters] = useState<OnlineChapter[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const [content, setContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [caching, setCaching] = useState(false);
  const [cacheProgress, setCacheProgress] = useState('');
  const [exporting, setExporting] = useState(false);
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    loadChapters();
  }, []);

  const loadChapters = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setLoadingChapters(true);
    setLoadError('');
    try {
      const list = await api.getChapters(source.id, book.detail);
      setChapters(list as OnlineChapter[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '获取章节失败');
    } finally {
      setLoadingChapters(false);
    }
  };

  const openChapter = async (idx: number) => {
    const api = window.electronAPI;
    if (!api || !chapters[idx]) return;
    setCurrentIdx(idx);
    setLoadingContent(true);
    setContent('');
    try {
      const text = await api.getChapterContent(
        source.id,
        { url: book.detail, title: book.name },
        { url: chapters[idx].url, title: chapters[idx].name, idx },
      );
      setContent(text || '（本章内容为空）');
    } catch (err) {
      setContent(`获取失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setLoadingContent(false);
    }
  };

  /** 整本缓存到本地数据库 */
  const handleCacheAll = async () => {
    const api = window.electronAPI;
    if (!api || chapters.length === 0) return;
    setCaching(true);
    try {
      for (let i = 0; i < chapters.length; i++) {
        setCacheProgress(`正在缓存 ${i + 1} / ${chapters.length}`);
        await api.getChapterContent(
          source.id,
          { url: book.detail, title: book.name },
          { url: chapters[i].url, title: chapters[i].name, idx: i },
        );
      }
      setCacheProgress('缓存完成');
      setTimeout(() => { setCaching(false); setCacheProgress(''); }, 1500);
    } catch (err) {
      setCacheProgress(`缓存中断：${err instanceof Error ? err.message : '未知错误'}`);
      setTimeout(() => { setCaching(false); setCacheProgress(''); }, 2500);
    }
  };

  const handleExport = async (kind: 'txt' | 'epub') => {
    const api = window.electronAPI;
    if (!api || chapters.length === 0) return;
    setExporting(true);
    try {
      const filePath =
        kind === 'txt'
          ? await api.exportBookTxt(source.id, { url: book.detail, title: book.name }, chapters)
          : await api.exportBookEpub(source.id, { url: book.detail, title: book.name }, chapters);
      if (filePath) alert(`已导出到：${filePath}`);
    } catch (err) {
      alert(`导出失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setExporting(false);
    }
  };

  const handleFollow = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setFollowing(true);
    try {
      await api.followBook({ source_id: source.id, book_url: book.detail, title: book.name });
      // 不能说「会提醒你」：目前没有通知机制，只在「书源 → 追更」里手动检查
      alert('已加入追更。回到「书源 → 追更」点「检查更新」即可查看最新章节。');
    } catch (err) {
      alert(err instanceof Error ? err.message : '追更失败');
    } finally {
      setFollowing(false);
    }
  };

  // 正文阅读视图
  if (currentIdx !== null && chapters[currentIdx]) {
    const ch = chapters[currentIdx];
    return (
      <div className="reader">
        <div className="reader-header">
          <button className="back-btn" onClick={() => setCurrentIdx(null)}>
            <Icon name="arrow-left" size={14} />
            章节列表
          </button>
          <h2 className="reader-title">{ch.name}</h2>
          <div className="reader-actions">
            <span className="page-indicator">{currentIdx + 1} / {chapters.length}</span>
          </div>
        </div>
        <div className="reader-body">
          <div className="reader-content">
            {loadingContent ? (
              <div className="loading">加载中...</div>
            ) : (
              <div className="txt-page" style={{ fontSize: 19, lineHeight: 2 }}>
                {content}
              </div>
            )}
          </div>
        </div>
        <div className="reader-footer">
          <button className="nav-btn" onClick={() => openChapter(currentIdx - 1)} disabled={currentIdx <= 0}>
            上一章
          </button>
          <button
            className="nav-btn"
            onClick={() => openChapter(currentIdx + 1)}
            disabled={currentIdx >= chapters.length - 1}
          >
            下一章
          </button>
        </div>
      </div>
    );
  }

  // 章节列表视图
  return (
    <div className="source-manager">
      <div className="source-header">
        <button className="back-btn" onClick={onBack}>
          <Icon name="arrow-left" size={14} />
          返回搜索
        </button>
        <div className="source-actions">
          <button className="btn-secondary" onClick={handleFollow} disabled={following}>
            {following ? '追更中...' : <><Icon name="pin" size={14} /> 追更</>}
          </button>
          <button className="btn-secondary" onClick={handleCacheAll} disabled={caching || chapters.length === 0}>
            {caching ? '缓存中...' : '缓存整本'}
          </button>
          <button className="btn-secondary" onClick={() => handleExport('txt')} disabled={exporting || chapters.length === 0}>
            {exporting ? '导出中...' : '导出 TXT'}
          </button>
          <button className="btn-secondary" onClick={() => handleExport('epub')} disabled={exporting || chapters.length === 0}>
            {exporting ? '导出中...' : '导出 EPUB'}
          </button>
        </div>
      </div>

      <h1 style={{ marginBottom: 4 }}>{book.name}</h1>
      <p className="book-meta" style={{ marginBottom: 16 }}>
        {book.author || '未知作者'} · 共 {chapters.length} 章 {cacheProgress && `· ${cacheProgress}`}
      </p>

      {loadingChapters && <div className="loading" style={{ position: 'static', padding: 40 }}>加载章节中...</div>}
      {loadError && (
        <div className="empty-state small">
          <p>{loadError}</p>
          <button className="btn-primary" style={{ marginTop: 12 }} onClick={loadChapters}>重试</button>
        </div>
      )}
      {!loadingChapters && !loadError && (
        <div className="chapter-grid">
          {chapters.map((ch, i) => (
            <div key={i} className="chapter-item" onClick={() => openChapter(i)}>
              {ch.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
