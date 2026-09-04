import { useState, useEffect, useRef } from 'react';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Book, Bookmark, Note } from '../types';
import { escapeHtml, excerptAround, clampPage } from '../utils/text';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

interface ReaderProps {
  book: Book;
  onBack: () => void;
}

type Panel = 'toc' | 'notes' | 'marks' | 'search' | null;

interface SelPopup {
  x: number;
  y: number;
  text: string;
  /** EPUB 为 CFI，TXT 为 txt:页:起:止 */
  position: string;
}

interface SearchHit {
  label: string;
  excerpt: string;
  /** EPUB 为 href，TXT 为页码 */
  target: string | number;
}

export function Reader({ book, onBack }: ReaderProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const lastContentsRef = useRef<any>(null);
  const pdfDocRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const txtRef = useRef<HTMLDivElement>(null);
  const readStartRef = useRef<number>(Date.now());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chapters, setChapters] = useState<{ label: string; href: string }[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [settings, setSettings] = useState({
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark' as 'dark' | 'light' | 'sepia',
  });

  // 选中弹窗 / 笔记草稿
  const [sel, setSel] = useState<SelPopup | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ text: string; position: string } | null>(null);
  const [noteContent, setNoteContent] = useState('');

  // 笔记书签数据
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  // TXT / PDF 分页
  const [txtPages, setTxtPages] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfReady, setPdfReady] = useState(false);

  // EPUB 版式
  const [flowMode, setFlowMode] = useState<'paginated' | 'scrolled'>('paginated');

  // 检索
  const [keyword, setKeyword] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  // TTS
  const [speaking, setSpeaking] = useState(false);

  // 手机模式
  const [phoneMode, setPhoneMode] = useState(false);
  const [clock, setClock] = useState('');

  // PDF 缩放 / 跳页 / 全屏 / 朗读变速
  const [pdfScale, setPdfScale] = useState(1.5);
  const pdfBaseWidthRef = useRef(0);
  const pdfWrapRef = useRef<HTMLDivElement>(null);
  const [jumpInput, setJumpInput] = useState('');
  const [ttsRate, setTtsRate] = useState(1);

  useEffect(() => {
    readStartRef.current = Date.now();
    // 载入朗读速度偏好
    window.electronAPI?.getSetting('ttsRate').then(v => {
      const r = Number(v);
      if (!Number.isNaN(r) && r >= 0.5 && r <= 2) setTtsRate(r);
    });
    loadBook();
    return () => {
      // 离开阅读器时上报本次阅读时长
      const seconds = (Date.now() - readStartRef.current) / 1000;
      window.electronAPI?.recordReadingTime(book.id, seconds);
      stopSpeak();
      bookRef.current?.destroy();
      bookRef.current = null;
      renditionRef.current = null;
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, [book.id]);

  // ---------- 加载 ----------

  const loadBook = async () => {
    setLoading(true);
    setError('');
    setPdfReady(false);
    setTxtPages([]);
    setPageIndex(0);
    setTotalPages(0);
    setSel(null);
    setNoteDraft(null);
    setHits([]);
    try {
      const api = window.electronAPI;
      if (!api) throw new Error('系统接口未就绪，请重启应用');
      const base64 = await api.getBookFileData(book.id);
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

      if (book.file_type === 'epub') {
        await loadEpub(bytes.buffer as ArrayBuffer);
      } else if (book.file_type === 'txt') {
        loadTxt(bytes);
      } else if (book.file_type === 'pdf') {
        await loadPdf(bytes);
      } else {
        throw new Error(`不支持的文件格式：${book.file_type}`);
      }
      await refreshMarks();
    } catch (err) {
      console.error('加载书籍失败:', err);
      setError(err instanceof Error ? err.message : '加载书籍失败');
    }
    setLoading(false);
  };

  const loadEpub = async (data: ArrayBuffer) => {
    if (!viewerRef.current) return;

    const epubBook = ePub(data);
    bookRef.current = epubBook;

    const rendition = epubBook.renderTo(viewerRef.current, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated',
    });

    renditionRef.current = rendition;
    applyTheme(rendition, settings.theme, settings.fontSize);
    await rendition.display();

    const nav = await epubBook.loaded.navigation;
    setChapters(nav.toc.map((ch: any) => ({ label: (ch.label as string).trim(), href: ch.href })));

    // 恢复已保存的高亮
    try {
      const api = window.electronAPI;
      if (api) {
        const saved = (await api.getBookmarks(book.id)) as Bookmark[];
        for (const b of saved) {
          try { rendition.annotations.highlight(b.position); } catch { /* CFI 失效则跳过 */ }
        }
      }
    } catch { /* 忽略 */ }

    // 选中文本
    rendition.on('selected', (cfiRange: string, contents: any) => {
      lastContentsRef.current = contents;
      const text = contents.window.getSelection().toString().trim();
      if (!text) return;
      const rect = contents.window.getSelection().getRangeAt(0).getBoundingClientRect();
      // iframe 内坐标换算到窗口坐标
      const iframe = contents.document.defaultView?.frameElement as HTMLElement | null;
      const frameRect = iframe?.getBoundingClientRect();
      setSel({
        x: Math.min((frameRect?.left ?? 0) + rect.left, window.innerWidth - 240),
        y: (frameRect?.top ?? 0) + rect.bottom + 8,
        text,
        position: cfiRange,
      });
    });

    rendition.on('relocated', (location: any) => {
      const progress = location.start?.progress || 0;
      window.electronAPI?.updateProgress(book.id, progress);
    });
  };

  const loadTxt = (bytes: Uint8Array) => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gbk').decode(bytes);
    }
    const paragraphs = text.split('\n');
    const pages: string[] = [];
    let current = '';
    for (const p of paragraphs) {
      current += p + '\n';
      if (current.length >= 3000) {
        pages.push(current);
        current = '';
      }
    }
    if (current) pages.push(current);
    setTxtPages(pages.length > 0 ? pages : ['（空文件）']);
    setPageIndex(0);
    setTotalPages(pages.length || 1);
  };

  const loadPdf = async (bytes: Uint8Array) => {
    const data = bytes.slice().buffer as ArrayBuffer;
    const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfDocRef.current = pdfDoc;
    setTotalPages(pdfDoc.numPages);
    setPageIndex(0);
    setPdfReady(true);
  };

  // ---------- 笔记书签 ----------

  const refreshMarks = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const [bm, nt] = await Promise.all([
      api.getBookmarks(book.id) as Promise<Bookmark[]>,
      api.getNotes(book.id) as Promise<Note[]>,
    ]);
    setBookmarks(bm);
    setNotes(nt);
  };

  const clearEpubSelection = () => {
    try { lastContentsRef.current?.window.getSelection().removeAllRanges(); } catch { /* 忽略 */ }
  };

  const handleHighlight = async () => {
    if (!sel) return;
    const api = window.electronAPI;
    if (!api) return;
    if (book.file_type === 'epub' && renditionRef.current) {
      renditionRef.current.annotations.highlight(sel.position);
    }
    await api.addBookmark({ book_id: book.id, position: sel.position, text: sel.text.slice(0, 200) });
    clearEpubSelection();
    setSel(null);
    await refreshMarks();
  };

  const handleSaveNote = async () => {
    if (!noteDraft || !noteContent.trim()) return;
    const api = window.electronAPI;
    if (!api) return;
    await api.addNote({
      book_id: book.id,
      position: noteDraft.position,
      selected_text: noteDraft.text.slice(0, 500),
      note: noteContent.trim(),
    });
    clearEpubSelection();
    setNoteDraft(null);
    setNoteContent('');
    setSel(null);
    await refreshMarks();
    setPanel('notes');
  };

  const handleDeleteBookmark = async (b: Bookmark) => {
    const api = window.electronAPI;
    if (!api) return;
    if (book.file_type === 'epub' && renditionRef.current) {
      try { renditionRef.current.annotations.remove(b.position, 'highlight'); } catch { /* 忽略 */ }
    }
    await api.deleteBookmark(b.id);
    await refreshMarks();
  };

  const handleDeleteNote = async (id: number) => {
    const api = window.electronAPI;
    if (!api) return;
    await api.deleteNote(id);
    await refreshMarks();
  };

  const jumpToMark = (position: string) => {
    if (book.file_type === 'epub') {
      renditionRef.current?.display(position);
    } else if (position.startsWith('txt:')) {
      const page = Number(position.split(':')[1]);
      if (!Number.isNaN(page)) setPageIndex(Math.min(page, totalPages - 1));
    }
    setPanel(null);
  };

  const handleExportNotes = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const filePath = await api.exportNotes(book.id);
      if (filePath) alert(`已导出到：${filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
  };

  // ---------- TXT 选中 ----------

  const handleTxtMouseUp = () => {
    if (book.file_type !== 'txt') return;
    const container = txtRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed) return;
    if (!container.contains(selection.anchorNode)) return;
    const text = selection.toString().trim();
    if (!text) return;
    const range = selection.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const rect = range.getBoundingClientRect();
    setSel({
      x: Math.min(rect.left, window.innerWidth - 240),
      y: rect.bottom + 8,
      text,
      position: `txt:${pageIndex}:${start}:${start + selection.toString().length}`,
    });
  };

  /** 当前 TXT 页渲染（含高亮） */
  const renderTxtHtml = () => {
    const text = txtPages[pageIndex] || '';
    const marks = bookmarks
      .filter(b => b.position.startsWith(`txt:${pageIndex}:`))
      .map(b => {
        const parts = b.position.split(':');
        return { s: Number(parts[2]), e: Number(parts[3]), id: b.id };
      })
      .filter(m => !Number.isNaN(m.s) && !Number.isNaN(m.e) && m.s < m.e && m.s < text.length)
      .sort((a, b) => a.s - b.s);
    if (marks.length === 0) return null;
    let html = '';
    let last = 0;
    for (const m of marks) {
      if (m.s < last) continue;
      const end = Math.min(m.e, text.length);
      html += escapeHtml(text.slice(last, m.s));
      html += `<mark data-id="${m.id}">${escapeHtml(text.slice(m.s, end))}</mark>`;
      last = end;
    }
    html += escapeHtml(text.slice(last));
    return html;
  };

  // ---------- TTS ----------

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) {
      alert('当前环境不支持语音朗读');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.slice(0, 15000));
    utter.lang = 'zh-CN';
    utter.rate = ttsRate;
    const voice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('zh'));
    if (voice) utter.voice = voice;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utter);
  };

  const stopSpeak = () => {
    try { window.speechSynthesis?.cancel(); } catch { /* 忽略 */ }
    setSpeaking(false);
  };

  /** 顶栏朗读：TXT 读剩余全文，EPUB 读当前页 */
  const handleHeaderSpeak = async () => {
    if (speaking) {
      stopSpeak();
      return;
    }
    if (book.file_type === 'txt') {
      speak(txtPages.slice(pageIndex).join('\n'));
    } else if (book.file_type === 'epub') {
      try {
        const loc = renditionRef.current?.currentLocation?.();
        const cfi: string | undefined = loc?.start?.cfi;
        if (!cfi || !bookRef.current) return;
        const range = await bookRef.current.getRange(cfi);
        const text = (range.toString() as string).trim();
        if (text) speak(text);
      } catch (err) {
        console.error('获取当前页文本失败:', err);
      }
    }
  };

  // ---------- 版式 / 主题 ----------

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

  const toggleFlow = () => {
    const next = flowMode === 'paginated' ? 'scrolled' : 'paginated';
    setFlowMode(next);
    renditionRef.current?.flow(next);
  };

  const changeTheme = (theme: 'dark' | 'light' | 'sepia') => {
    setSettings(s => ({ ...s, theme }));
    if (renditionRef.current) applyTheme(renditionRef.current, theme, settings.fontSize);
  };

  const changeFontSize = (delta: number) => {
    const newSize = Math.max(12, Math.min(32, settings.fontSize + delta));
    setSettings(s => ({ ...s, fontSize: newSize }));
    if (renditionRef.current) applyTheme(renditionRef.current, settings.theme, newSize);
  };

  // ---------- 翻页 ----------

  const renderPdfPage = async (pdfDoc: any, pageNum: number, scale: number) => {
    if (!canvasRef.current) return;
    const page = await pdfDoc.getPage(pageNum);
    if (!pdfBaseWidthRef.current) {
      pdfBaseWidthRef.current = page.getViewport({ scale: 1 }).width;
    }
    const viewport = page.getViewport({ scale });
    const canvas = canvasRef.current;
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
  };

  useEffect(() => {
    if (book.file_type === 'pdf' && pdfReady && pdfDocRef.current && !loading) {
      renderPdfPage(pdfDocRef.current, pageIndex + 1, pdfScale);
    }
  }, [pdfReady, pageIndex, loading, pdfScale]);

  /** PDF 缩放档位 */
  const changePdfScale = (delta: number) => {
    setPdfScale(s => Math.min(3, Math.max(0.5, Math.round((s + delta) * 10) / 10)));
  };

  /** PDF 适应宽度 */
  const fitPdfWidth = () => {
    if (!pdfBaseWidthRef.current || !pdfWrapRef.current) return;
    const avail = pdfWrapRef.current.clientWidth - 48;
    setPdfScale(Math.min(3, Math.max(0.5, Math.round((avail / pdfBaseWidthRef.current) * 10) / 10)));
  };

  /** 跳到指定页（TXT / PDF） */
  const jumpToPage = (raw: string) => {
    const target = clampPage(Number(raw), totalPages);
    setPageIndex(target - 1);
    setJumpInput('');
    window.electronAPI?.updateProgress(book.id, totalPages > 0 ? (target - 1) / totalPages : 0);
  };

  useEffect(() => {
    if (book.file_type === 'epub' && renditionRef.current) {
      const t = setTimeout(() => renditionRef.current?.resize(), 80);
      return () => clearTimeout(t);
    }
  }, [phoneMode]);

  useEffect(() => {
    if (!phoneMode) return;
    const update = () => {
      const d = new Date();
      setClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    update();
    const t = setInterval(update, 30000);
    return () => clearInterval(t);
  }, [phoneMode]);

  const handlePrev = () => {
    setSel(null);
    if (book.file_type === 'epub') {
      renditionRef.current?.prev();
    } else if (pageIndex > 0) {
      const next = pageIndex - 1;
      setPageIndex(next);
      window.electronAPI?.updateProgress(book.id, totalPages > 0 ? next / totalPages : 0);
    }
  };

  const handleNext = () => {
    setSel(null);
    if (book.file_type === 'epub') {
      renditionRef.current?.next();
    } else if (pageIndex < totalPages - 1) {
      const next = pageIndex + 1;
      setPageIndex(next);
      window.electronAPI?.updateProgress(book.id, totalPages > 0 ? next / totalPages : 0);
    }
  };

  const goToChapter = (href: string) => {
    renditionRef.current?.display(href);
    setPanel(null);
  };

  const handleToggleFullscreen = async () => {
    try {
      await window.electronAPI?.toggleFullscreen();
    } catch { /* 非 Electron 环境忽略 */ }
  };

  // 键盘快捷键：方向键/空格翻页，Home/End 跳转，F11 全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          handleNext();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          handlePrev();
          break;
        case 'Home':
          e.preventDefault();
          if (book.file_type === 'epub') renditionRef.current?.display();
          else setPageIndex(0);
          break;
        case 'End':
          e.preventDefault();
          if (book.file_type !== 'epub' && totalPages > 0) setPageIndex(totalPages - 1);
          break;
        case 'F11':
          e.preventDefault();
          handleToggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- 检索 ----------

  const handleSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setHits([]);
    try {
      if (book.file_type === 'txt') {
        const found: SearchHit[] = [];
        txtPages.forEach((page, i) => {
          if (page.toLowerCase().includes(kw.toLowerCase())) {
            found.push({ label: `第 ${i + 1} 页`, excerpt: excerptAround(page, kw), target: i });
          }
        });
        setHits(found);
      } else if (book.file_type === 'epub' && bookRef.current) {
        const epubBook = bookRef.current;
        const found: SearchHit[] = await Promise.all(
          epubBook.spine.spineItems.map((item: any) =>
            item
              .load(epubBook.load.bind(epubBook))
              .then((doc: any) => {
                const text = (doc?.body?.textContent as string) || '';
                const excerpt = excerptAround(text, kw);
                item.unload();
                if (!excerpt) return null;
                const tocLabel = chapters.find(c => item.href.includes(c.href) || c.href.includes(item.href))?.label;
                return { label: tocLabel || item.href, excerpt, target: item.href } as SearchHit;
              })
              .catch(() => {
                try { item.unload(); } catch { /* 忽略 */ }
                return null;
              }),
          ),
        ).then(list => list.filter((x): x is SearchHit => x !== null));
        setHits(found);
      }
    } finally {
      setSearching(false);
    }
  };

  const jumpToHit = (hit: SearchHit) => {
    if (book.file_type === 'txt' && typeof hit.target === 'number') {
      setPageIndex(hit.target);
    } else if (book.file_type === 'epub' && typeof hit.target === 'string') {
      renditionRef.current?.display(hit.target);
    }
    setPanel(null);
  };

  // ---------- 渲染 ----------

  const togglePanel = (p: Exclude<Panel, null>) => setPanel(cur => (cur === p ? null : p));

  const readerThemeClass =
    settings.theme === 'light' ? 'reader-light' : settings.theme === 'sepia' ? 'reader-sepia' : '';
  const txtHtml = book.file_type === 'txt' ? renderTxtHtml() : null;

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
          {book.file_type !== 'pdf' && (
            <button onClick={handleHeaderSpeak} className={speaking ? 'active' : ''} title={speaking ? '停止朗读' : '朗读'}>
              {speaking ? '⏹' : '🔊'}
            </button>
          )}
          {book.file_type === 'epub' && (
            <>
              <button onClick={toggleFlow} title={flowMode === 'paginated' ? '切换滚动模式' : '切换分页模式'}>
                {flowMode === 'paginated' ? '📜' : '📄'}
              </button>
              <button onClick={() => togglePanel('toc')} className={panel === 'toc' ? 'active' : ''}>📑 目录</button>
            </>
          )}
          {book.file_type === 'pdf' && (
            <>
              <button onClick={() => changePdfScale(-0.25)} title="缩小">🔍-</button>
              <button onClick={() => changePdfScale(0.25)} title="放大">🔍+</button>
              <button onClick={fitPdfWidth} title="适应宽度">↔</button>
            </>
          )}
          <button onClick={() => togglePanel('notes')} className={panel === 'notes' ? 'active' : ''} title="笔记">
            📝{notes.length > 0 ? ` ${notes.length}` : ''}
          </button>
          <button onClick={() => togglePanel('marks')} className={panel === 'marks' ? 'active' : ''} title="书签">
            🔖{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}
          </button>
          {book.file_type !== 'pdf' && (
            <button onClick={() => togglePanel('search')} className={panel === 'search' ? 'active' : ''} title="书内检索">
              🔍
            </button>
          )}
          <button
            onClick={() => setPhoneMode(m => !m)}
            className={phoneMode ? 'active' : ''}
            title="手机模式"
          >
            📱
          </button>
          <button onClick={handleToggleFullscreen} title="全屏 (F11)">
            ⛶
          </button>
        </div>
      </div>

      <div className="reader-body">
        {panel === 'toc' && book.file_type === 'epub' && (
          <div className="toc-panel">
            <h3>目录</h3>
            {chapters.map((ch, i) => (
              <div key={i} className="toc-item" onClick={() => goToChapter(ch.href)}>
                {ch.label}
              </div>
            ))}
          </div>
        )}

        {panel === 'notes' && (
          <div className="toc-panel">
            <div className="panel-title-row">
              <h3>我的笔记（{notes.length}）</h3>
              {(notes.length > 0 || bookmarks.length > 0) && (
                <button className="link-btn" onClick={handleExportNotes}>导出</button>
              )}
            </div>
            {notes.length === 0 ? (
              <p className="empty-text">选中正文后可写笔记</p>
            ) : (
              notes.map(n => (
                <div key={n.id} className="mark-item">
                  <p className="mark-quote">{n.selected_text}</p>
                  <p className="mark-note">{n.note}</p>
                  <div className="mark-actions">
                    <button onClick={() => jumpToMark(n.position)}>跳转</button>
                    <button className="danger" onClick={() => handleDeleteNote(n.id)}>删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {panel === 'marks' && (
          <div className="toc-panel">
            <h3>书签高亮（{bookmarks.length}）</h3>
            {bookmarks.length === 0 ? (
              <p className="empty-text">选中正文后可添加高亮书签</p>
            ) : (
              bookmarks.map(b => (
                <div key={b.id} className="mark-item">
                  <p className="mark-quote">{b.text}</p>
                  <div className="mark-actions">
                    <button onClick={() => jumpToMark(b.position)}>跳转</button>
                    <button className="danger" onClick={() => handleDeleteBookmark(b)}>删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {panel === 'search' && (
          <div className="toc-panel">
            <h3>书内检索</h3>
            <div className="search-box">
              <input
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="输入关键词..."
              />
              <button className="btn-primary" onClick={handleSearch} disabled={searching}>
                {searching ? '搜...' : '搜'}
              </button>
            </div>
            {hits.length === 0 && !searching && keyword && (
              <p className="empty-text">没有找到相关内容</p>
            )}
            {hits.map((h, i) => (
              <div key={i} className="mark-item search-hit" onClick={() => jumpToHit(h)}>
                <p className="mark-label">{h.label}</p>
                <p className="mark-quote">...{h.excerpt}...</p>
              </div>
            ))}
          </div>
        )}

        <div className={`reader-content ${readerThemeClass} ${phoneMode ? 'phone-mode' : ''}`} ref={viewerRef}>
          {phoneMode && (
            <div className="phone-statusbar">
              <span>{clock}</span>
              <span>5G 🔋</span>
            </div>
          )}
          {loading && <div className="loading">加载中...</div>}
          {!loading && error && (
            <div className="loading">
              <div>
                <div style={{ fontSize: 48, marginBottom: 16 }}>😢</div>
                <div>{error}</div>
                <button className="btn-primary" style={{ marginTop: 16 }} onClick={loadBook}>重新加载</button>
              </div>
            </div>
          )}
          {!loading && !error && book.file_type === 'txt' && txtPages.length > 0 && (
            <div
              ref={txtRef}
              className="txt-page"
              style={{ fontSize: settings.fontSize, lineHeight: settings.lineHeight }}
              onMouseUp={handleTxtMouseUp}
            >
              {txtHtml ? (
                <span dangerouslySetInnerHTML={{ __html: txtHtml }} />
              ) : (
                txtPages[pageIndex]
              )}
            </div>
          )}
          {!loading && !error && book.file_type === 'pdf' && (
            <div className="pdf-page" ref={pdfWrapRef}>
              <canvas ref={canvasRef} />
            </div>
          )}
        </div>
      </div>

      <div className="reader-footer">
        <button className="nav-btn" onClick={handlePrev}>上一页</button>
        {book.file_type !== 'epub' && totalPages > 0 && (
          <>
            <span className="page-indicator">{pageIndex + 1} / {totalPages}</span>
            <input
              className="jump-input"
              value={jumpInput}
              onChange={e => setJumpInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') jumpToPage(jumpInput);
              }}
              placeholder="跳页"
              title="输入页码回车跳转"
            />
          </>
        )}
        <button className="nav-btn" onClick={handleNext}>下一页</button>
      </div>

      {/* 选中操作条 */}
      {sel && (
        <div className="select-popup" style={{ left: sel.x, top: sel.y }}>
          <button onClick={handleHighlight} title="高亮并加入书签">🖍 高亮</button>
          <button
            onClick={() => {
              setNoteDraft({ text: sel.text, position: sel.position });
              setNoteContent('');
            }}
            title="写笔记"
          >
            📝 笔记
          </button>
          <button onClick={() => { speak(sel.text); setSel(null); clearEpubSelection(); }} title="朗读选中">
            🔊 朗读
          </button>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(sel.text); } catch { /* 忽略 */ }
              setSel(null);
              clearEpubSelection();
            }}
            title="复制"
          >
            📋 复制
          </button>
          <button onClick={() => { setSel(null); clearEpubSelection(); }} title="关闭">✕</button>
        </div>
      )}

      {/* 写笔记弹窗 */}
      {noteDraft && (
        <div className="modal-mask" onClick={() => setNoteDraft(null)}>
          <div className="note-modal" onClick={e => e.stopPropagation()}>
            <h3>写笔记</h3>
            <p className="mark-quote">{noteDraft.text.slice(0, 300)}</p>
            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              placeholder="写下你的想法..."
              rows={5}
              autoFocus
            />
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setNoteDraft(null)}>取消</button>
              <button className="btn-primary" onClick={handleSaveNote} disabled={!noteContent.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
