import { useState, useEffect, useRef } from 'react';
import { Book } from '../types';
import ePub from 'epubjs';

interface ReaderProps {
  book: Book;
  onBack: () => void;
}

export function Reader({ book, onBack }: ReaderProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [chapters, setChapters] = useState<{ label: string; href: string }[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [settings, setSettings] = useState({
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark' as 'dark' | 'light' | 'sepia',
  });

  useEffect(() => {
    loadBook();
    return () => {
      bookRef.current?.destroy();
    };
  }, [book]);

  const loadBook = async () => {
    if (!viewerRef.current) return;
    setLoading(true);

    try {
      if (book.file_type === 'epub') {
        await loadEpub(book.file_path);
      } else if (book.file_type === 'txt') {
        await loadTxt(book.file_path);
      } else if (book.file_type === 'pdf') {
        await loadPdf(book.file_path);
      }
    } catch (err) {
      console.error('加载书籍失败:', err);
    }

    setLoading(false);
  };

  const loadEpub = async (filePath: string) => {
    if (!viewerRef.current) return;

    const epubBook = ePub(filePath);
    bookRef.current = epubBook;

    const rendition = epubBook.renderTo(viewerRef.current, {
      width: '100%',
      height: '100%',
      spread: 'none',
    });

    renditionRef.current = rendition;

    // 应用主题
    applyTheme(rendition, settings.theme, settings.fontSize);

    // 显示书籍
    await rendition.display();

    // 获取目录
    const nav = await epubBook.loaded.navigation;
    setChapters(nav.toc.map((ch: any) => ({ label: ch.label.trim(), href: ch.href })));

    // 监听进度
    rendition.on('relocated', (location: any) => {
      const progress = location.start?.progress || 0;
      window.electronAPI.updateProgress(book.id, progress);
    });

    // 恢复阅读进度
    if (book.progress && book.progress > 0) {
      rendition.display();
    }
  };

  const loadTxt = async (_filePath: string) => {
    if (!viewerRef.current) return;
    // TXT 简单渲染
    viewerRef.current.innerHTML = `
      <div style="padding: 20px; max-width: 800px; margin: 0 auto; line-height: ${settings.lineHeight}; font-size: ${settings.fontSize}px;">
        <h1>${book.title}</h1>
        <p>TXT 文件加载中...</p>
      </div>
    `;
  };

  const loadPdf = async (_filePath: string) => {
    if (!viewerRef.current) return;
    viewerRef.current.innerHTML = `
      <div style="padding: 20px; text-align: center;">
        <h1>${book.title}</h1>
        <p>PDF 文件加载中...</p>
      </div>
    `;
  };

  const applyTheme = (rendition: any, theme: string, fontSize: number) => {
    const themes: Record<string, string> = {
      dark: 'background: #1a1a2e; color: #eaeaea;',
      light: 'background: #ffffff; color: #333333;',
      sepia: 'background: #f4ecd8; color: #5b4636;',
    };

    rendition.themes.default({
      'body': themes[theme],
      'p, div, span': { 'font-size': `${fontSize}px !important` },
    });
  };

  const handlePrev = () => {
    renditionRef.current?.prev();
  };

  const handleNext = () => {
    renditionRef.current?.next();
  };

  const goToChapter = (href: string) => {
    renditionRef.current?.display(href);
    setShowToc(false);
  };

  const changeTheme = (theme: 'dark' | 'light' | 'sepia') => {
    setSettings(s => ({ ...s, theme }));
    if (renditionRef.current) {
      applyTheme(renditionRef.current, theme, settings.fontSize);
    }
  };

  const changeFontSize = (delta: number) => {
    const newSize = Math.max(12, Math.min(32, settings.fontSize + delta));
    setSettings(s => ({ ...s, fontSize: newSize }));
    if (renditionRef.current) {
      applyTheme(renditionRef.current, settings.theme, newSize);
    }
  };

  return (
    <div className="reader">
      <div className="reader-header">
        <button className="back-btn" onClick={onBack}>← 返回</button>
        <h2 className="reader-title">{book.title}</h2>
        <div className="reader-actions">
          <button onClick={() => changeFontSize(-2)} title="缩小字号">A-</button>
          <button onClick={() => changeFontSize(2)} title="放大字号">A+</button>
          <button onClick={() => changeTheme('dark')} className={settings.theme === 'dark' ? 'active' : ''}>🌙</button>
          <button onClick={() => changeTheme('light')} className={settings.theme === 'light' ? 'active' : ''}>☀️</button>
          <button onClick={() => changeTheme('sepia')} className={settings.theme === 'sepia' ? 'active' : ''}>📜</button>
          <button onClick={() => setShowToc(!showToc)}>📑 目录</button>
        </div>
      </div>

      <div className="reader-body">
        {showToc && (
          <div className="toc-panel">
            <h3>目录</h3>
            {chapters.map((ch, i) => (
              <div key={i} className="toc-item" onClick={() => goToChapter(ch.href)}>
                {ch.label}
              </div>
            ))}
          </div>
        )}

        <div className="reader-content" ref={viewerRef}>
          {loading && <div className="loading">加载中...</div>}
        </div>
      </div>

      <div className="reader-footer">
        <button className="nav-btn" onClick={handlePrev}>上一页</button>
        <button className="nav-btn" onClick={handleNext}>下一页</button>
      </div>
    </div>
  );
}
