import { useState, useEffect, useRef, type CSSProperties } from 'react';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Book, Bookmark, Note, TocEntry } from '../types';
import { escapeHtml, excerptAround, clampPage } from '../utils/text';
import { fontStackOf, highlightColorOf, HIGHLIGHT_COLORS } from '../utils/reader-options';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

interface ReaderProps {
  book: Book;
  onBack: () => void;
  /** 从详情页目录跳入的初始位置 */
  initialTarget?: TocEntry | null;
}

type Panel = 'toc' | 'notes' | 'marks' | 'search' | 'ai' | null;

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

export function Reader({ book, onBack, initialTarget }: ReaderProps) {
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
  // B 批：字体 / 双栏 / 自动翻页 / 检索词高亮
  const [fontKey, setFontKey] = useState('system');
  const fontKeyRef = useRef('system');
  const [dualColumn, setDualColumn] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [searchMark, setSearchMark] = useState('');
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // AI 助手
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiContext, setAiContext] = useState('');

  /** AI 调用统一入口（含未配置提示） */
  const runAi = async (fn: () => Promise<string>) => {
    const api = window.electronAPI;
    if (!api) return;
    setAiLoading(true);
    setAiAnswer('');
    try {
      setAiAnswer(await fn());
    } catch (err) {
      setAiAnswer(`调用失败：${err instanceof Error ? err.message : '未知错误'}\n请检查设置页的 AI 服务地址与模型是否可用。`);
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiSummarize = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const text = aiContext || (await getCurrentPageText());
    if (!text.trim()) {
      setAiAnswer('当前页没有可总结的文本（PDF 暂不支持）。');
      return;
    }
    setPanel('ai');
    await runAi(() => api.aiSummarize(text));
  };

  const handleAiTranslate = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const text = aiContext || (await getCurrentPageText());
    if (!text.trim()) {
      setAiAnswer('当前页没有可翻译的文本（PDF 暂不支持）。');
      return;
    }
    setPanel('ai');
    await runAi(() => api.aiTranslate(text));
  };

  const handleAiAsk = async () => {
    const api = window.electronAPI;
    if (!api || !aiQuestion.trim()) return;
    const text = aiContext || (await getCurrentPageText());
    if (!text.trim()) {
      setAiAnswer('当前页没有正文，无法结合上下文回答（PDF 暂不支持）。');
      return;
    }
    await runAi(() => api.aiExplain(text, aiQuestion.trim()));
  };

  /** 选中文本送去 AI：一键短解释 / 一键翻译（适配 1B 小模型，短问短答） */
  const handleAiQuick = async (kind: 'explain' | 'translate') => {
    if (!sel) return;
    const api = window.electronAPI;
    if (!api) return;
    const text = sel.text.slice(0, 1000);
    setSel(null);
    clearEpubSelection();
    setAiContext(text);
    setAiQuestion('');
    setPanel('ai');
    if (kind === 'translate') {
      await runAi(() => api.aiTranslate(text));
    } else {
      await runAi(() => api.aiExplain(text, '请用一两句话简短解释这段文字的意思'));
    }
  };

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
    // 载入朗读速度与字体偏好
    window.electronAPI?.getSetting('ttsRate').then(v => {
      const r = Number(v);
      if (!Number.isNaN(r) && r >= 0.5 && r <= 2) setTtsRate(r);
    });
    window.electronAPI?.getSetting('fontFamily').then(v => {
      if (v && fontStackOf(v)) {
        fontKeyRef.current = v;
        setFontKey(v);
        // 首屏可能已按默认字体渲染，重新应用
        if (renditionRef.current) {
          applyTheme(renditionRef.current, 'dark', 18);
        }
      }
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
    // 详情页跳入则直达章节，否则从头显示
    if (initialTarget?.href) {
      await rendition.display(initialTarget.href);
    } else {
      await rendition.display();
    }

    const nav = await epubBook.loaded.navigation;
    setChapters(nav.toc.map((ch: any) => ({ label: (ch.label as string).trim(), href: ch.href })));

    // 恢复已保存的高亮（含颜色）
    try {
      const api = window.electronAPI;
      if (api) {
        const saved = (await api.getBookmarks(book.id)) as Bookmark[];
        for (const b of saved) {
          try {
            const color = highlightColorOf(b.color || 'yellow');
            rendition.annotations.highlight(b.position, {}, undefined, undefined, {
              fill: color.epubFill,
              'fill-opacity': '0.35',
            });
          } catch { /* CFI 失效则跳过 */ }
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
    const total = pages.length || 1;
    setPageIndex(initialTarget?.page != null ? clampPage(initialTarget.page + 1, total) - 1 : 0);
    setTotalPages(total);
  };

  const loadPdf = async (bytes: Uint8Array) => {
    const data = bytes.slice().buffer as ArrayBuffer;
    const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfDocRef.current = pdfDoc;
    setTotalPages(pdfDoc.numPages);
    setPageIndex(
      initialTarget?.page != null ? clampPage(initialTarget.page, pdfDoc.numPages) - 1 : 0,
    );
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

  const handleHighlight = async (colorKey: string = 'yellow') => {
    if (!sel) return;
    const api = window.electronAPI;
    if (!api) return;
    const color = highlightColorOf(colorKey);
    if (book.file_type === 'epub' && renditionRef.current) {
      renditionRef.current.annotations.highlight(sel.position, {}, undefined, undefined, {
        fill: color.epubFill,
        'fill-opacity': '0.35',
      });
    }
    await api.addBookmark({
      book_id: book.id,
      position: sel.position,
      text: sel.text.slice(0, 200),
      color: color.key,
    });
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

  /** TXT 当前页渲染：书签高亮（含颜色）+ 检索词高亮合并 */
  const renderTxtHtml = () => {
    const text = txtPages[pageIndex] || '';
    interface TxtRange { s: number; e: number; cls: string; style?: string }
    const ranges: TxtRange[] = [];
    // 书签优先
    for (const b of bookmarks) {
      if (!b.position.startsWith(`txt:${pageIndex}:`)) continue;
      const parts = b.position.split(':');
      const s = Number(parts[2]);
      const e = Number(parts[3]);
      if (Number.isNaN(s) || Number.isNaN(e) || s >= e || s >= text.length) continue;
      const color = highlightColorOf(b.color || 'yellow');
      ranges.push({ s, e: Math.min(e, text.length), cls: '', style: `background:${color.css}` });
    }
    // 检索词（跳过与书签重叠的部分）
    if (searchMark) {
      const kw = searchMark.toLowerCase();
      const lower = text.toLowerCase();
      let idx = lower.indexOf(kw);
      while (idx >= 0) {
        const overlap = ranges.some(r => idx < r.e && idx + kw.length > r.s);
        if (!overlap) ranges.push({ s: idx, e: idx + kw.length, cls: 'search-mark' });
        idx = lower.indexOf(kw, idx + 1);
      }
    }
    if (ranges.length === 0) return null;
    ranges.sort((a, b) => a.s - b.s);
    let html = '';
    let last = 0;
    for (const r of ranges) {
      if (r.s < last) continue;
      html += escapeHtml(text.slice(last, r.s));
      const open = r.cls ? `<mark class="${r.cls}">` : `<mark style="${r.style}">`;
      html += `${open}${escapeHtml(text.slice(r.s, r.e))}</mark>`;
      last = r.e;
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

  /** 取当前页文本（AI 上下文用）：TXT 取本页，EPUB 取当前 CFI 范围 */
  const getCurrentPageText = async (): Promise<string> => {
    if (book.file_type === 'txt') {
      return txtPages[pageIndex] || '';
    }
    if (book.file_type === 'epub') {
      try {
        const loc = renditionRef.current?.currentLocation?.();
        const cfi: string | undefined = loc?.start?.cfi;
        if (!cfi || !bookRef.current) return '';
        const range = await bookRef.current.getRange(cfi);
        return (range.toString() as string).trim();
      } catch (err) {
        console.error('获取当前页文本失败:', err);
        return '';
      }
    }
    return '';
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
    const stack = fontStackOf(fontKeyRef.current);
    rendition.themes.default({
      'body': themes[theme] + (stack ? ` font-family: ${stack};` : ''),
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

  const changeFont = (key: string) => {
    fontKeyRef.current = key;
    setFontKey(key);
    window.electronAPI?.setSetting('fontFamily', key);
    if (renditionRef.current) {
      applyTheme(renditionRef.current, settings.theme, settings.fontSize);
    }
  };

  /** 双栏：TXT 用 CSS 分栏，EPUB 用 spread */
  const toggleDualColumn = () => {
    const next = !dualColumn;
    setDualColumn(next);
    if (book.file_type === 'epub' && renditionRef.current) {
      try {
        renditionRef.current.spread(next ? 'always' : 'none');
      } catch { /* 忽略 */ }
    }
  };

  /** 自动翻页 */
  const stopAuto = () => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoPlay(false);
  };

  const nextRef = useRef(() => {});
  nextRef.current = () => advancePage(1);

  const toggleAutoPlay = () => {
    if (autoPlay) {
      stopAuto();
      return;
    }
    setAutoPlay(true);
    autoTimerRef.current = setInterval(() => nextRef.current(), 3000);
  };

  useEffect(() => () => stopAuto(), []);

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

  /** 无副作用翻页（自动播放用，不停播） */
  const advancePage = (dir: 1 | -1) => {
    if (book.file_type === 'epub') {
      clearEpubSearchMarks();
      setSearchMark('');
      if (dir > 0) renditionRef.current?.next();
      else renditionRef.current?.prev();
    } else if (dir > 0 && pageIndex < totalPages - 1) {
      const next = pageIndex + 1;
      setPageIndex(next);
      setSearchMark('');
      window.electronAPI?.updateProgress(book.id, totalPages > 0 ? next / totalPages : 0);
    } else if (dir < 0 && pageIndex > 0) {
      const next = pageIndex - 1;
      setPageIndex(next);
      setSearchMark('');
      window.electronAPI?.updateProgress(book.id, totalPages > 0 ? next / totalPages : 0);
    }
  };

  const handlePrev = () => {
    setSel(null);
    stopAuto();
    advancePage(-1);
  };

  const handleNext = () => {
    setSel(null);
    stopAuto();
    advancePage(1);
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
      setSearchMark(keyword.trim());
      setPageIndex(hit.target);
    } else if (book.file_type === 'epub' && typeof hit.target === 'string') {
      const kw = keyword.trim();
      setSearchMark(kw);
      // 章节显示完成后再框选关键词
      renditionRef.current?.display(hit.target).then(() => markEpubKeyword(kw)).catch(() => {});
    }
    setPanel(null);
  };

  /** 清除 EPUB 章内检索标红 */
  const clearEpubSearchMarks = () => {
    try {
      const contents = renditionRef.current?.getContents?.() ?? [];
      for (const c of contents) {
        c.document.querySelectorAll('mark.epub-search').forEach((el: Element) => {
          const parent = el.parentNode;
          if (!parent) return;
          parent.replaceChild(c.document.createTextNode(el.textContent || ''), el);
          parent.normalize();
        });
      }
    } catch { /* 忽略 */ }
  };

  /** EPUB 当前章节内框选关键词（每文本节点首处） */
  const markEpubKeyword = (kw: string) => {
    clearEpubSearchMarks();
    if (!kw.trim()) return;
    try {
      const lower = kw.toLowerCase();
      const contents = renditionRef.current?.getContents?.() ?? [];
      for (const c of contents) {
        const doc = c.document as Document;
        const walker = doc.createTreeWalker(doc.body, window.NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if ((n.parentElement as Element | null)?.closest?.('mark.epub-search')) continue;
          nodes.push(n as Text);
        }
        for (const t of nodes) {
          const text = t.textContent || '';
          const idx = text.toLowerCase().indexOf(lower);
          if (idx < 0) continue;
          const mark = doc.createElement('mark');
          mark.className = 'epub-search';
          mark.setAttribute('style', 'background:rgba(255,152,0,.55);color:inherit;border-radius:2px;');
          mark.textContent = text.slice(idx, idx + kw.length);
          const parent = t.parentNode;
          if (!parent) continue;
          parent.insertBefore(doc.createTextNode(text.slice(0, idx)), t);
          parent.insertBefore(mark, t);
          parent.insertBefore(doc.createTextNode(text.slice(idx + kw.length)), t);
          parent.removeChild(t);
        }
      }
    } catch (err) {
      console.error('标红关键词失败:', err);
    }
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
          <select
            className="reader-select"
            value={fontKey}
            onChange={e => changeFont(e.target.value)}
            title="字体"
          >
            <option value="system">系统字体</option>
            <option value="serif">宋体</option>
            <option value="sans">黑体</option>
            <option value="kai">楷体</option>
            <option value="mono">等宽</option>
          </select>
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
          {book.file_type !== 'pdf' && (
            <button onClick={() => togglePanel('ai')} className={panel === 'ai' ? 'active' : ''} title="AI 助手">
              ✨
            </button>
          )}
          {book.file_type !== 'pdf' && (
            <button
              onClick={toggleDualColumn}
              className={dualColumn ? 'active' : ''}
              title="双栏 / 单栏"
            >
              📖
            </button>
          )}
          <button
            onClick={toggleAutoPlay}
            className={autoPlay ? 'active' : ''}
            title={autoPlay ? '停止自动翻页' : '自动翻页'}
          >
            {autoPlay ? '⏸' : '▶'}
          </button>
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

        {panel === 'ai' && (
          <div className="toc-panel">
            <h3>✨ AI 助手</h3>
            <p className="section-desc">
              {aiContext ? '基于选中文本回答' : '基于当前页正文回答'}（PDF 暂不支持）
            </p>
            <div className="ai-actions">
              <button className="btn-secondary small" onClick={handleAiSummarize} disabled={aiLoading}>
                总结本页
              </button>
              <button className="btn-secondary small" onClick={handleAiTranslate} disabled={aiLoading}>
                翻译本页
              </button>
              {aiContext && (
                <button className="btn-secondary small" onClick={() => setAiContext('')}>
                  改用整页
                </button>
              )}
            </div>
            <div className="search-box" style={{ marginTop: 12 }}>
              <input
                value={aiQuestion}
                onChange={e => setAiQuestion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAiAsk()}
                placeholder="就本页内容提问..."
              />
              <button className="btn-primary" onClick={handleAiAsk} disabled={aiLoading || !aiQuestion.trim()}>
                问
              </button>
            </div>
            {aiLoading && <p className="empty-text">思考中...</p>}
            {!aiLoading && aiAnswer && (
              <div className="mark-item">
                <p className="mark-note" style={{ whiteSpace: 'pre-wrap' }}>{aiAnswer}</p>
              </div>
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
              style={{
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
                fontFamily: fontStackOf(fontKey) || undefined,
                columnCount: dualColumn ? 2 : undefined,
                columnGap: dualColumn ? '48px' : undefined,
              } as CSSProperties}
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
          <div className="hl-colors">
            {HIGHLIGHT_COLORS.map(c => (
              <button
                key={c.key}
                className="hl-dot"
                style={{ background: c.css }}
                title={`高亮（${c.label}）`}
                onClick={() => handleHighlight(c.key)}
              />
            ))}
          </div>
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
          <button onClick={() => handleAiQuick('explain')} title="AI 一键短解释">
            ✨ 解释
          </button>
          <button onClick={() => handleAiQuick('translate')} title="AI 一键翻译">
            🌐 翻译
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
