import { useState, useEffect, useRef, type CSSProperties } from 'react';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Book, Bookmark, Note, TocEntry, ReadingPosition } from '../types';
import { escapeHtml, excerptAround, clampPage, lineToPageIndex, parseSavedPosition, serializeSavedPosition, SavedPosition } from '../utils/text';
import { fontStackOf, highlightColorOf, HIGHLIGHT_COLORS, type ThemeName } from '../utils/reader-options';
import { resolveThemeByClock, type AutoThemeConfig } from '../utils/auto-theme';
import {
  parseBookPrefs,
  mergePrefs,
  bookPrefsKey,
  DEFAULT_READER_PREFS,
  type ReaderPrefs,
} from '../utils/book-prefs';
import { parseMindmap, MindNode } from '../utils/mindmap';
import { lookupMark } from '../utils/mark-lookup';
import { normalizeText } from '../utils/text-normalize';
import { getPreset, resolveAction, DEFAULT_SHORTCUT_PRESET } from '../utils/shortcuts';
import { MindmapView } from './Mindmap';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

interface ReaderProps {
  book: Book;
  onBack: () => void;
  /** 从详情页目录跳入的初始位置 */
  initialTarget?: TocEntry | null;
  /** 从笔记跳入的原始位置串：EPUB 为 CFI，TXT 为 txt:页:起:止 */
  initialPosition?: string | null;
}

type Panel = 'toc' | 'notes' | 'marks' | 'search' | 'ai' | 'positions' | null;

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

export function Reader({ book, onBack, initialTarget, initialPosition }: ReaderProps) {
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
  const chaptersRef = useRef<{ label: string; href: string }[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [settings, setSettings] = useState({
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark' as 'dark' | 'light' | 'sepia',
  });
  /** 当前生效的阅读偏好，供 applyTheme 读取（避免异步读设置与首屏渲染的时序竞争） */
  const cfgRef = useRef({ theme: 'dark' as 'dark' | 'light' | 'sepia', fontSize: 18, lineHeight: 1.8 });
  /** 自动护眼配置（本次会话内有效） */
  const autoThemeCfgRef = useRef<AutoThemeConfig | null>(null);
  /** 用户本次阅读中手动改过主题：改过就不再被自动切换打扰 */
  const themeUserOverrideRef = useRef(false);
  /** 本书已保存的排版偏好（写回时作为合并基底，避免读改写竞态） */
  const bookPrefsRef = useRef<Partial<ReaderPrefs>>({});
  const savePrefsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 上次阅读位置：savedPosRef 是打开时恢复用，lastPosRef 是本次阅读的最新位置
  const savedPosRef = useRef<SavedPosition | null>(null);
  const lastPosRef = useRef<SavedPosition | null>(null);
  const savePosTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B 批：字体 / 双栏 / 自动翻页 / 检索词高亮
  const [fontKey, setFontKey] = useState('system');
  const fontKeyRef = useRef('system');
  const [dualColumn, setDualColumn] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [searchMark, setSearchMark] = useState('');
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 章节模式：章内分页，章界另起
  const [chapterIdx, setChapterIdx] = useState<number | null>(null);
  const [chapterPage, setChapterPage] = useState(0);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [bookPercent, setBookPercent] = useState(0);
  const locationRef = useRef<{
    href: string; startPage: number; endPage: number; total: number; progress: number;
  }>({ href: '', startPage: 1, endPage: 1, total: 1, progress: 0 });
  const chapterIdxRef = useRef<number | null>(null);
  const locationsRef = useRef<string[]>([]);
  const locationsDoneRef = useRef(false);
  const aliveRef = useRef<{ alive: boolean }>({ alive: true });

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
  /** TXT 目录（含段落行号），阅读器内可直接跳转与增补章节 */
  const [txtToc, setTxtToc] = useState<TocEntry[]>([]);
  /** 每页起始段落行号，用于目录行号 ↔ 页码互转 */
  const txtPageStartRef = useRef<number[]>([]);
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
  /** 查词模式：答案可存入生词本 */
  const [aiWord, setAiWord] = useState('');
  /** 多进度断点：本书已保存的阅读位置 */
  const [positions, setPositions] = useState<ReadingPosition[]>([]);
  /** 全局强制统一字体：压过电子书自带的奇葩字体 */
  const forceFontRef = useRef(false);
  /** 批注只读：屏蔽新增/删除批注的操作入口 */
  const readonlyMarksRef = useRef(false);
  /** 当前快捷键预设（从设置读取） */
  const presetRef = useRef(getPreset(DEFAULT_SHORTCUT_PRESET));
  /** TXT 规整：原文缓存 + 开关（非破坏性，原文与磁盘文件都不动） */
  const txtRawRef = useRef<string>('');
  const [normalizeOn, setNormalizeOn] = useState(false);
  /** 原文批注预览：点击正文高亮时展开对应的完整笔记 */
  const [markPreview, setMarkPreview] = useState<{
    position: string;
    text?: string;
    note?: string;
    noteId?: number;
    markId?: number;
  } | null>(null);
  /** 思维导图 */
  const [mindNodes, setMindNodes] = useState<MindNode[] | null>(null);
  const [mindTitle, setMindTitle] = useState('');

  /** EPUB 按 href 取整章文本（复用检索的 spine 加载套路） */
  const loadChapterText = async (href: string): Promise<string> => {
    const epubBook = bookRef.current;
    if (!epubBook) return '';
    const item = epubBook.spine.spineItems.find(
      (it: any) => it.href === href || href.includes(it.href) || it.href.includes(href),
    );
    if (!item) return '';
    try {
      const doc = await item.load(epubBook.load.bind(epubBook));
      const text = ((doc as any)?.body?.textContent as string) || '';
      return text.replace(/\s+/g, ' ').trim();
    } finally {
      try { item.unload(); } catch { /* 忽略 */ }
    }
  };

  /** 本书章节脑图：书名 → 章节 → 点章现生成子分支 */
  const handleBookMindmap = async () => {
    const api = window.electronAPI;
    if (!api || (book.file_type !== 'epub' && book.file_type !== 'txt')) return;
    setAiLoading(true);
    try {
      let chapterNodes: MindNode[] = [];
      if (book.file_type === 'epub') {
        chapterNodes = chapters.map(ch => ({
          text: ch.label,
          children: [],
          target: { href: ch.href },
        }));
      } else {
        const toc = await api.getBookToc(book.id);
        const entries = (toc as { label: string; page?: number }[]) || [];
        chapterNodes = entries.map((t, i) => ({
          text: t.label,
          children: [],
          target: { page: t.page ?? 0, endPage: entries[i + 1]?.page },
        }));
      }
      if (chapterNodes.length === 0) {
        setAiAnswer('本书没有目录信息，无法按章节生成。');
        setPanel('ai');
        return;
      }
      setMindNodes([{ text: book.title, children: chapterNodes }]);
      setMindTitle(`《${book.title}》章节脑图`);
    } finally {
      setAiLoading(false);
    }
  };

  /** 展开某章节：取文本 → AI 大纲 → 子分支 */
  const expandMindChapter = async (node: MindNode): Promise<MindNode[]> => {
    const api = window.electronAPI;
    if (!api || !node.target) return [];
    let text = '';
    if (node.target.href) {
      text = await loadChapterText(node.target.href);
    } else if (node.target.page != null) {
      const end = node.target.endPage ?? totalPages;
      text = txtPages.slice(node.target.page, Math.min(end, totalPages)).join('\n');
    }
    text = text.trim().slice(0, 3000);
    if (!text) return [{ text: '该章节无正文', children: [] }];
    const outline = await api.aiMindmap(text);
    const sub = parseMindmap(outline);
    return sub.length > 0 ? sub : [{ text: '生成失败，换一章试试', children: [] }];
  };

  /** 当前流式请求的 reqId（用于中断） */
  const aiReqRef = useRef<string | null>(null);

  const stopAi = () => {
    if (aiReqRef.current) {
      window.electronAPI?.aiAbort(aiReqRef.current);
      aiReqRef.current = null;
    }
    setAiLoading(false);
  };

  /**
   * AI 流式统一入口：进程内逐 token 回调追加显示，
   * 回退 HTTP 时整包到达（一次性补齐）。返回完整文本。
   */
  const runAiStream = async (
    kind: 'summarize' | 'explain' | 'translate' | 'mindmap',
    text: string,
    question?: string,
  ): Promise<string> => {
    const api = window.electronAPI;
    if (!api) return '';
    // 互斥：新请求先停旧请求
    if (aiReqRef.current) {
      try { await api.aiAbort(aiReqRef.current); } catch { /* 忽略 */ }
      aiReqRef.current = null;
    }
    setAiLoading(true);
    setAiAnswer('');
    let acc = '';
    try {
      const full: string = await new Promise((resolve, reject) => {
        const reqId = api.aiStream(kind, text, question, {
          onToken: chunk => {
            acc += chunk;
            setAiAnswer(acc);
          },
          onDone: f => resolve(f),
          onError: m => reject(new Error(m)),
        });
        aiReqRef.current = reqId;
      });
      // HTTP 回退整包到达（无中间 token）：用 full 补齐
      if (!acc && full) {
        acc = full;
        setAiAnswer(full);
      }
      return acc;
    } catch (err) {
      // 中断且已有部分输出：保留部分结果不报错
      if (!acc) {
        setAiAnswer(`调用失败：${err instanceof Error ? err.message : '未知错误'}\n请检查设置页的 AI 服务地址与模型是否可用。`);
      }
      return acc;
    } finally {
      aiReqRef.current = null;
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
    await runAiStream('summarize', text);
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
    await runAiStream('translate', text);
  };

  const handleAiMindmap = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const text = aiContext || (await getCurrentPageText());
    if (!text.trim()) {
      setAiAnswer('当前页没有正文，无法生成导图（PDF 暂不支持）。');
      setPanel('ai');
      return;
    }
    setPanel('ai');
    setAiLoading(true);
    try {
      const outline = await runAiStream('mindmap', text);
      const nodes = parseMindmap(outline);
      if (nodes.length === 0) {
        if (!outline) setAiAnswer('导图生成失败，模型返回为空。');
        return;
      }
      setMindNodes(nodes);
    } finally {
      // runAiStream 内部已处理 loading，这里兜底
      setAiLoading(false);
    }
  };

  const handleAiAsk = async () => {
    const api = window.electronAPI;
    if (!api || !aiQuestion.trim()) return;
    const text = aiContext || (await getCurrentPageText());
    if (!text.trim()) {
      setAiAnswer('当前页没有正文，无法结合上下文回答（PDF 暂不支持）。');
      return;
    }
    await runAiStream('explain', text, aiQuestion.trim());
  };

  /** 选中文本送去 AI：一键短解释 / 一键翻译 / 查词（适配 1B 小模型，短问短答） */
  const handleAiQuick = async (kind: 'explain' | 'translate' | 'define') => {
    if (!sel) return;
    const api = window.electronAPI;
    if (!api) return;
    const text = sel.text.slice(0, 200);
    setSel(null);
    clearEpubSelection();
    setAiContext(text);
    setAiQuestion('');
    setAiWord(kind === 'define' ? text : '');
    setPanel('ai');
    if (kind === 'translate') {
      await runAiStream('translate', text);
    } else if (kind === 'define') {
      await runAiStream('explain', text, '请简短解释这个词语的意思、词性和一个例句，不要长篇大论');
    } else {
      await runAiStream('explain', text, '请用一两句话简短解释这段文字的意思');
    }
  };

  /** 查词结果存入生词本 */
  const handleSaveWord = async () => {
    const api = window.electronAPI;
    if (!api || !aiWord.trim() || !aiAnswer.trim()) return;
    try {
      await api.addWord({
        book_id: book.id,
        word: aiWord.trim().slice(0, 100),
        definition: aiAnswer.trim().slice(0, 2000),
        context: aiContext.slice(0, 500),
      });
      showToast('已加入生词本');
      setAiWord('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败');
    }
  };

  // 手机模式
  const [phoneMode, setPhoneMode] = useState(false);
  const [clock, setClock] = useState('');

  // 阅读视图选项（会话级偏好，不写库）
  const [view, setView] = useState({
    pageShadow: true,
    invert: false,
    autoHideBar: false,
    clickEdge: false,
    edgeWidth: 10,
    cursor: 'text' as 'text' | 'default',
    alwaysOnTop: false,
  });
  const [showViewPanel, setShowViewPanel] = useState(false);
  const [barVisible, setBarVisible] = useState(true);

  // 轻量提示
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2000);
  };

  const updateView = (patch: Partial<typeof view>) => setView(v => ({ ...v, ...patch }));

  /** 窗口置顶开关 */
  const toggleAlwaysOnTop = async () => {
    const api = window.electronAPI;
    const next = !view.alwaysOnTop;
    updateView({ alwaysOnTop: next });
    try {
      const actual = await api?.setAlwaysOnTop(next);
      if (typeof actual === 'boolean') updateView({ alwaysOnTop: actual });
    } catch {
      showToast('当前环境不支持窗口置顶');
    }
  };

  // PDF 缩放 / 跳页 / 全屏 / 朗读变速
  const [pdfScale, setPdfScale] = useState(1.5);
  const pdfBaseWidthRef = useRef(0);
  const pdfWrapRef = useRef<HTMLDivElement>(null);
  const [jumpInput, setJumpInput] = useState('');
  const [ttsRate, setTtsRate] = useState(1);

  useEffect(() => {
    readStartRef.current = Date.now();
    // 换书重置：本次会话的手动主题覆盖失效
    themeUserOverrideRef.current = false;
    // 先读设置与上次阅读位置，再加载书籍
    initReader();
    return () => {
      // 离开阅读器时上报本次阅读时长
      aliveRef.current.alive = false;
      // 落盘最后阅读位置（防抖可能还没触发）
      flushPos();
      // 落盘待写的排版偏好（同上，避免刚调完字号就退出导致丢失）
      if (savePrefsTimerRef.current) {
        clearTimeout(savePrefsTimerRef.current);
        savePrefsTimerRef.current = null;
        window.electronAPI?.setSetting(
          bookPrefsKey(book.id),
          JSON.stringify(bookPrefsRef.current),
        );
      }
      if (aiReqRef.current) {
        window.electronAPI?.aiAbort(aiReqRef.current);
        aiReqRef.current = null;
      }
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

  /**
   * 多进度断点：进入时识别上次是否异常退出，退出时记录断点。
   * 用会话标记区分正常/异常——正常退出会清掉标记，
   * 下次打开若标记仍在，说明上轮没走完清理流程（崩溃或强杀）。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = window.electronAPI;
      if (!api) return;
      try {
        const raw = await api.getSetting(`readingSession:${book.id}`);
        if (raw) {
          const last = await api.getSetting(`lastPos:${book.id}`);
          const p = parseSavedPosition(last);
          if (p) {
            await api.addReadingPosition({
              book_id: book.id,
              position: serializeSavedPosition(p),
              label: '上次异常退出时',
              source: 'crash',
            });
          }
        }
        await api.setSetting(`readingSession:${book.id}`, String(Date.now()));
        if (alive) await refreshPositions();
      } catch { /* 忽略 */ }
    })();
    return () => {
      alive = false;
      const api = window.electronAPI;
      if (!api) return;
      const d = describeCurrentPos();
      if (d) api.addReadingPosition({ book_id: book.id, ...d, source: 'exit' });
      api.setSetting(`readingSession:${book.id}`, '');
    };
  }, [book.id]);

  /**
   * 自动护眼：长时间阅读时按时钟复查（默认每 5 分钟）。
   * 用户手动改过主题则不再打扰；关闭开关时不生效。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const cfg = autoThemeCfgRef.current;
      if (!cfg?.enabled || themeUserOverrideRef.current) return;
      const want = resolveThemeByClock(new Date(), cfg);
      if (want === cfgRef.current.theme) return;
      cfgRef.current = { ...cfgRef.current, theme: want };
      setSettings(s => ({ ...s, theme: want }));
      if (renditionRef.current) applyTheme(renditionRef.current);
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // ---------- 阅读位置持久化 ----------

  /** 立即落盘当前阅读位置（防抖收尾、离开阅读器时调用） */
  const flushPos = () => {
    if (savePosTimerRef.current) {
      clearTimeout(savePosTimerRef.current);
      savePosTimerRef.current = null;
    }
    const api = window.electronAPI;
    if (!api || !lastPosRef.current) return;
    api.setSetting(`lastPos:${book.id}`, serializeSavedPosition(lastPosRef.current)).catch(() => {
      /* 写失败不影响阅读 */
    });
  };

  /** 记录位置并延迟落盘，避免翻页/滚动时高频写库 */
  const scheduleSavePos = (pos: SavedPosition) => {
    lastPosRef.current = pos;
    if (savePosTimerRef.current) clearTimeout(savePosTimerRef.current);
    savePosTimerRef.current = setTimeout(flushPos, 800);
  };

  // ---------- 跳转历史（前进 / 后退） ----------

  /** 当前位置（不落盘），用于入栈 */
  const currentPosRef = useRef<SavedPosition | null>(null);
  const histRef = useRef<{ stack: SavedPosition[]; idx: number }>({ stack: [], idx: -1 });
  const [histState, setHistState] = useState({ canBack: false, canForward: false });

  const syncHistState = () => {
    const h = histRef.current;
    setHistState({ canBack: h.idx > 0, canForward: h.idx < h.stack.length - 1 });
  };

  const samePos = (a: SavedPosition, b: SavedPosition) =>
    a.cfi === b.cfi && a.page === b.page;

  /** 跳转前调用：把当前位置压入历史栈 */
  const pushHistory = () => {
    const pos = currentPosRef.current;
    if (!pos || (pos.cfi == null && pos.page == null)) return;
    const h = histRef.current;
    if (h.idx >= 0 && samePos(h.stack[h.idx], pos)) return;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(pos);
    if (h.stack.length > 100) h.stack.shift();
    h.idx = h.stack.length - 1;
    syncHistState();
  };

  const applyPos = (pos: SavedPosition) => {
    if (book.file_type === 'epub' && pos.cfi) renditionRef.current?.display(pos.cfi);
    else if (pos.page != null) setPageIndex(pos.page);
  };

  const goBack = () => {
    const h = histRef.current;
    if (h.idx <= 0) return;
    h.idx -= 1;
    applyPos(h.stack[h.idx]);
    syncHistState();
  };

  const goForward = () => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 1) return;
    h.idx += 1;
    applyPos(h.stack[h.idx]);
    syncHistState();
  };

  // ---------- 首末页 / 指定位置 ----------

  const goToFirst = () => {
    pushHistory();
    if (book.file_type === 'epub') renditionRef.current?.display();
    else setPageIndex(0);
  };

  const goToLast = () => {
    pushHistory();
    if (book.file_type !== 'epub') {
      if (totalPages > 0) setPageIndex(totalPages - 1);
      return;
    }
    // EPUB：优先用位置索引换算文末 CFI，无索引则退到最后一条目录
    let cfi = '';
    if (locationsRef.current.length > 0) {
      try {
        cfi = bookRef.current?.locations?.cfiFromPercentage?.(0.999) || '';
      } catch { /* 忽略，走目录回退 */ }
    }
    if (cfi) {
      renditionRef.current?.display(cfi);
      return;
    }
    const toc = chaptersRef.current;
    if (toc.length > 0) renditionRef.current?.display(toc[toc.length - 1].href);
  };

  /** EPUB 按百分比跳转（EPUB 无全局页码，用阅读百分比定位） */
  const jumpToPercent = (raw: string) => {
    const percent = Math.min(100, Math.max(1, Number(raw)));
    if (Number.isNaN(percent)) return;
    setJumpInput('');
    if (locationsRef.current.length === 0) {
      showToast('位置索引生成中，请稍后再试');
      return;
    }
    try {
      const cfi = bookRef.current?.locations?.cfiFromPercentage?.(percent / 100);
      if (cfi) {
        pushHistory();
        renditionRef.current?.display(cfi);
      }
    } catch {
      showToast('跳转失败，请重试');
    }
  };

  /** 读取阅读偏好与上次位置，然后加载书籍 */
  const initReader = async () => {
    lastPosRef.current = null;
    const api = window.electronAPI;
    if (!api) {
      await loadBook();
      return;
    }
    try {
      const [tts, font, fontSize, lineHeight, theme, pos, autoOn, autoDayStart, autoNightStart, autoDay, autoNight, bookPrefsRaw, presetKey, forceFont, readonly] = await Promise.all([
        api.getSetting('ttsRate'),
        api.getSetting('fontFamily'),
        api.getSetting('fontSize'),
        api.getSetting('lineHeight'),
        api.getSetting('theme'),
        api.getSetting(`lastPos:${book.id}`),
        api.getSetting('autoTheme'),
        api.getSetting('autoThemeDayStart'),
        api.getSetting('autoThemeNightStart'),
        api.getSetting('autoThemeDay'),
        api.getSetting('autoThemeNight'),
        api.getSetting(bookPrefsKey(book.id)),
        api.getSetting('shortcutPreset'),
        api.getSetting('forceFont'),
        api.getSetting('annotationsReadonly'),
      ]);
      forceFontRef.current = forceFont === 'true' || forceFont === '1';
      readonlyMarksRef.current = readonly === 'true' || readonly === '1';
      if (presetKey) presetRef.current = getPreset(presetKey);
      const rate = Number(tts);
      if (!Number.isNaN(rate) && rate >= 0.5 && rate <= 2) setTtsRate(rate);
      // 自动护眼配置（纯本地时钟判定）
      const autoCfg: AutoThemeConfig = {
        enabled: autoOn === 'true' || autoOn === '1',
        dayStart: Number.isFinite(Number(autoDayStart)) ? Number(autoDayStart) : 7,
        nightStart: Number.isFinite(Number(autoNightStart)) ? Number(autoNightStart) : 19,
        dayTheme: (autoDay === 'sepia' || autoDay === 'dark' ? autoDay : 'light') as ThemeName,
        nightTheme: (autoNight === 'sepia' || autoNight === 'light' ? autoNight : 'dark') as ThemeName,
      };
      autoThemeCfgRef.current = autoCfg;

      // 排版偏好：全局默认 ← 书籍专属覆盖
      const size = Number(fontSize);
      const lh = Number(lineHeight);
      const base: ReaderPrefs = {
        ...DEFAULT_READER_PREFS,
        theme: (theme === 'light' || theme === 'sepia' ? theme : 'dark') as ThemeName,
        fontSize: Number.isFinite(size) && size >= 12 && size <= 32 ? size : DEFAULT_READER_PREFS.fontSize,
        lineHeight: Number.isFinite(lh) && lh >= 1 && lh <= 3 ? lh : DEFAULT_READER_PREFS.lineHeight,
        fontFamily: font && fontStackOf(font) ? font : DEFAULT_READER_PREFS.fontFamily,
      };
      const saved = parseBookPrefs(bookPrefsRaw);
      bookPrefsRef.current = saved;
      const merged = mergePrefs(base, saved);
      // 自动护眼是用户显式开启的全局开关，优先于书籍专属主题
      if (autoCfg.enabled) merged.theme = resolveThemeByClock(new Date(), autoCfg);

      cfgRef.current = { theme: merged.theme, fontSize: merged.fontSize, lineHeight: merged.lineHeight };
      setSettings(cfgRef.current);
      fontKeyRef.current = merged.fontFamily;
      setFontKey(merged.fontFamily);
      setDualColumn(merged.dualColumn);
      setFlowMode(merged.flowMode);
      setPdfScale(merged.pdfScale);
      savedPosRef.current = parseSavedPosition(pos);
    } catch {
      /* 读取失败按默认值走 */
    }
    await loadBook();
  };

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
        setTxtToc(((await api.getBookToc(book.id)) as TocEntry[]) || []);
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
    applyTheme(rendition);
    // 跳转优先级：目录/检索指定位置 > 上次阅读位置 > 从头开始
    const savedCfi = savedPosRef.current?.cfi;
    if (initialTarget?.href) {
      await rendition.display(initialTarget.href);
    } else if (initialPosition) {
      // 笔记跳入：位置串即 CFI
      try {
        await rendition.display(initialPosition);
      } catch {
        await rendition.display();
      }
    } else if (savedCfi) {
      try {
        await rendition.display(savedCfi);
      } catch {
        // CFI 失效（书籍重排或换版本）时回退到开头
        await rendition.display();
      }
    } else {
      await rendition.display();
    }

    const nav = await epubBook.loaded.navigation;
    const toc = nav.toc.map((ch: any) => ({ label: (ch.label as string).trim(), href: ch.href }));
    setChapters(toc);
    chaptersRef.current = toc;

    // 位置索引：有缓存直接用，否则后台生成并存库（不阻塞阅读）
    const mountGuard = { alive: true };
    aliveRef.current = mountGuard;
    (async () => {
      try {
        const cached = (book as Book & { locations?: string }).locations;
        if (cached) {
          const arr = JSON.parse(cached);
          if (Array.isArray(arr) && arr.length > 0) {
            locationsRef.current = arr;
            locationsDoneRef.current = true;
            return;
          }
        }
        if (!mountGuard.alive) return;
        const list = await epubBook.locations.generate(800);
        if (!mountGuard.alive || !Array.isArray(list) || list.length === 0) return;
        locationsRef.current = list;
        locationsDoneRef.current = true;
        await window.electronAPI?.setBookLocations(book.id, JSON.stringify(list));
      } catch { /* 失败则降级为无 locations 行为 */ }
    })();

    // 恢复已保存的高亮（含颜色）
    try {
      const api = window.electronAPI;
      if (api) {
        const saved = (await api.getBookmarks(book.id)) as Bookmark[];
        for (const b of saved) {
          try {
            const color = highlightColorOf(b.color || 'yellow');
            rendition.annotations.highlight(b.position, { markId: b.id }, undefined, undefined, {
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

    // iframe 内点击空白处：取消划词条（与主文档行为一致）
    rendition.on('rendered', (_section: any, renderedView: any) => {
      try {
        const doc = renderedView?.document;
        if (!doc || doc.__blankClickBound) return;
        doc.__blankClickBound = true;
        doc.addEventListener('click', () => {
          if (!renderedView.window?.getSelection()?.toString().trim()) setSel(null);
        });
      } catch { /* 忽略 */ }
    });

    // 点击正文高亮 → 展开对应笔记（原文 → 笔记）
    rendition.on('markClicked', (cfiRange: string, data: any) => {
      openMarkPreview(cfiRange, data?.markId);
    });

    rendition.on('relocated', (location: any) => {
      const progress = location.start?.progress || 0;
      window.electronAPI?.updateProgress(book.id, progress);
      // 记住当前位置（EPUB 用 CFI，跨版式与字号仍可定位）
      const cfi: string | undefined = location.start?.cfi;
      if (cfi) {
        scheduleSavePos({ cfi });
        currentPosRef.current = { cfi };
      }
      // 章节模式状态同步（唯一可信源）
      const href: string = location.start?.href || location.end?.href || '';
      const startPage: number = location.start?.displayed?.page ?? 1;
      const endPage: number = location.end?.displayed?.page ?? startPage;
      const total: number = location.end?.displayed?.total ?? location.start?.displayed?.total ?? 1;
      locationRef.current = { href, startPage, endPage, total, progress };
      const idx = resolveChapterIdx(href);
      chapterIdxRef.current = idx;
      setChapterIdx(idx);
      setChapterPage(startPage);
      setChapterTotal(total);
      setBookPercent(Math.round(progress * 100));
    });
  };

  /** href 解析为目录序号，非目录章节返回 null */
  const resolveChapterIdx = (href: string): number | null => {
    if (!href || chaptersRef.current.length === 0) return null;
    const norm = (h: string) => h.split('#')[0].split('/').pop();
    const idx = chaptersRef.current.findIndex(ch => norm(ch.href) === norm(href));
    return idx >= 0 ? idx : null;
  };

  /**
   * TXT 分页。keepPage 非空时沿用该页码（规整切换场景），
   * 否则按目录/断点定位。
   */
  const paginateTxt = (text: string, keepPage: number | null = null) => {
    const paragraphs = text.split('\n');
    const pages: string[] = [];
    // 每页起始段落行号，用于把目录里的章节行号换算成真实页码
    const pageStartLines: number[] = [];
    let current = '';
    for (let i = 0; i < paragraphs.length; i++) {
      if (current === '') pageStartLines.push(i);
      current += paragraphs[i] + '\n';
      if (current.length >= 3000) {
        pages.push(current);
        current = '';
      }
    }
    if (current) pages.push(current);
    txtPageStartRef.current = pageStartLines;
    setTxtPages(pages.length > 0 ? pages : ['（空文件）']);
    const total = pages.length || 1;
    const savedPage = savedPosRef.current?.page;
    // 笔记跳入：TXT 的位置串形如 txt:页:起:止
    const notePage = initialPosition?.startsWith('txt:')
      ? Number(initialPosition.split(':')[1])
      : null;
    // 目录跳转页码从 0 起，保存的页码同样从 0 起，clampPage 入参为 1 起
    // 章节行号优先：按字符数估算的页码会与实际分页产生累积偏差
    const startPage =
      keepPage != null
        ? clampPage(keepPage + 1, total) - 1
        : initialTarget?.line != null
          ? lineToPageIndex(pageStartLines, initialTarget.line)
          : initialTarget?.page != null
            ? clampPage(initialTarget.page + 1, total) - 1
            : notePage != null && Number.isFinite(notePage)
              ? clampPage(notePage + 1, total) - 1
              : savedPage != null
                ? clampPage(savedPage + 1, total) - 1
                : 0;
    setPageIndex(startPage);
    setTotalPages(total);
  };

  const loadTxt = (bytes: Uint8Array) => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gbk').decode(bytes);
    }
    txtRawRef.current = text;
    paginateTxt(normalizeOn ? normalizeText(text) : text);
  };

  /** 切换文本规整：只换渲染源，不动原文、不写磁盘，可随时还原 */
  const toggleNormalize = () => {
    const next = !normalizeOn;
    setNormalizeOn(next);
    const raw = txtRawRef.current;
    if (!raw) return;
    paginateTxt(next ? normalizeText(raw) : raw, pageIndex);
  };

  /** TXT 目录跳转：优先按段落行号换算页码，缺失时退回页号 */
  const goToTxtLine = (line?: number, page?: number) => {
    const idx =
      line != null
        ? lineToPageIndex(txtPageStartRef.current, line)
        : clampPage((page ?? 0) + 1, totalPages) - 1;
    setPageIndex(idx);
    window.electronAPI?.updateProgress(book.id, totalPages > 0 ? idx / totalPages : 0);
  };

  /** 把当前页起始位置登记为章节并保存（目录转为手动编辑，不再被自动解析覆盖） */
  const handleAddChapterAtCursor = async () => {
    const line = txtPageStartRef.current[pageIndex];
    if (line == null) return;
    const firstLine =
      (txtPages[pageIndex] || '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
    const label = prompt('章节名称：', firstLine.slice(0, 30));
    if (!label) return;
    const next = [...txtToc, { label, href: '', page: pageIndex, line }].sort(
      (a, b) => (a.line ?? 0) - (b.line ?? 0),
    );
    setTxtToc(next);
    await window.electronAPI?.saveToc(book.id, next);
  };

  const loadPdf = async (bytes: Uint8Array) => {
    const data = bytes.slice().buffer as ArrayBuffer;
    const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfDocRef.current = pdfDoc;
    setTotalPages(pdfDoc.numPages);
    const savedPage = savedPosRef.current?.page;
    setPageIndex(
      initialTarget?.page != null
        ? clampPage(initialTarget.page, pdfDoc.numPages) - 1
        : savedPage != null
          ? clampPage(savedPage + 1, pdfDoc.numPages) - 1
          : 0,
    );
    setPdfReady(true);
  };

  // ---------- 笔记书签 ----------

  // ---------- 多进度断点 ----------

  const refreshPositions = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setPositions(await api.getReadingPositions(book.id));
  };

  /** 当前位置的可序列化形式 + 人类可读标签（直接用实时状态，不依赖可能未更新的 ref） */
  const describeCurrentPos = (): { position: string; label: string; progress: number } | null => {
    try {
      if (book.file_type === 'epub') {
        const loc = renditionRef.current?.currentLocation?.();
        const cfi: string | undefined = loc?.start?.cfi;
        if (!cfi) return null;
        const idx = chapterIdxRef.current;
        const label = idx != null && chaptersRef.current[idx] ? chaptersRef.current[idx].label : '当前页';
        return {
          position: serializeSavedPosition({ cfi }),
          label: label.slice(0, 60),
          progress: locationRef.current.progress,
        };
      }
      return {
        position: serializeSavedPosition({ page: pageIndex }),
        label: totalPages > 0 ? `第 ${pageIndex + 1}/${totalPages} 页` : '当前页',
        progress: totalPages > 0 ? pageIndex / totalPages : 0,
      };
    } catch {
      return null;
    }
  };

  const handleMarkPosition = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const d = describeCurrentPos();
    if (!d) return;
    await api.addReadingPosition({ book_id: book.id, ...d, source: 'manual' });
    await refreshPositions();
  };

  const handleDeletePosition = async (id: number) => {
    await window.electronAPI?.deleteReadingPosition(id);
    await refreshPositions();
  };

  const handleJumpPosition = (p: ReadingPosition) => {
    const pos = parseSavedPosition(p.position);
    if (!pos) {
      alert('该位置已失效（可能书籍已更换或重新解析过）');
      return;
    }
    pushHistory();
    if (book.file_type === 'epub' && pos.cfi) renditionRef.current?.display(pos.cfi);
    else if (pos.page != null) setPageIndex(pos.page);
    setPanel(null);
  };

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

  /** 点击空白处收起划词条（点操作条本身或刚划完词时不收起） */
  const handleContentClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest?.('.select-popup')) return;
    if (window.getSelection()?.toString().trim()) return;
    setSel(null);
    clearEpubSelection();
  };

  /** 批注只读检查：已拦截返回 true */
  const blockedByReadonly = (action: string) => {
    if (!readonlyMarksRef.current) return false;
    alert(`已开启「批注只读」，无法${action}。可在设置页关闭该模式。`);
    return true;
  };

  const handleHighlight = async (colorKey: string = 'yellow') => {
    if (blockedByReadonly('新增高亮')) return;
    if (!sel) return;
    const api = window.electronAPI;
    if (!api) return;
    const color = highlightColorOf(colorKey);
    // 先落库拿到 id，再挂到注解上——点击高亮时靠它反查笔记
    const markId = await api.addBookmark({
      book_id: book.id,
      position: sel.position,
      text: sel.text.slice(0, 200),
      color: color.key,
    });
    if (book.file_type === 'epub' && renditionRef.current) {
      renditionRef.current.annotations.highlight(sel.position, { markId }, undefined, undefined, {
        fill: color.epubFill,
        'fill-opacity': '0.35',
      });
    }
    clearEpubSelection();
    setSel(null);
    await refreshMarks();
  };

  const handleSaveNote = async () => {
    if (!noteDraft || !noteContent.trim()) return;
    if (blockedByReadonly('新增笔记')) return;
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

  const handleRenameBookmark = async (b: Bookmark) => {
    if (blockedByReadonly('修改书签')) return;
    const api = window.electronAPI;
    if (!api) return;
    const next = prompt('修改书签名称：', b.text || '');
    if (next !== null && next.trim() && next.trim() !== (b.text || '')) {
      try {
        await api.updateBookmark(b.id, next.trim());
        await refreshMarks();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '修改失败');
      }
    }
  };

  const handleDeleteBookmark = async (b: Bookmark) => {
    if (blockedByReadonly('删除书签')) return;
    const api = window.electronAPI;
    if (!api) return;
    if (book.file_type === 'epub' && renditionRef.current) {
      try { renditionRef.current.annotations.remove(b.position, 'highlight'); } catch { /* 忽略 */ }
    }
    await api.deleteBookmark(b.id);
    await refreshMarks();
  };

  const handleDeleteNote = async (id: number) => {
    if (blockedByReadonly('删除笔记')) return;
    const api = window.electronAPI;
    if (!api) return;
    await api.deleteNote(id);
    await refreshMarks();
  };

  /**
   * 原文 → 笔记：点击正文高亮时反查该处的批注与笔记。
   * 优先按 markId 精确匹配，退化到按 position 匹配。
   */
  const openMarkPreview = (position: string, markId?: number) => {
    const hit = lookupMark(bookmarks, notes, position, markId);
    if (hit) setMarkPreview(hit);
  };

  /** TXT 正文点击：命中带 data-id 的高亮时展开预览 */
  const handleTxtMarkClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.('mark[data-id]') as HTMLElement | null;
    if (!el) return;
    const id = Number(el.dataset.id);
    const mark = bookmarks.find(b => b.id === id);
    if (mark) openMarkPreview(mark.position, id);
  };

  const jumpToMark = (position: string) => {
    pushHistory();
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
      if (filePath) showToast(`已导出到：${filePath}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出失败');
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
    interface TxtRange { s: number; e: number; cls: string; style?: string; id?: number }
    const ranges: TxtRange[] = [];
    // 书签优先
    for (const b of bookmarks) {
      if (!b.position.startsWith(`txt:${pageIndex}:`)) continue;
      const parts = b.position.split(':');
      const s = Number(parts[2]);
      const e = Number(parts[3]);
      if (Number.isNaN(s) || Number.isNaN(e) || s >= e || s >= text.length) continue;
      const color = highlightColorOf(b.color || 'yellow');
      ranges.push({ s, e: Math.min(e, text.length), cls: '', style: `background:${color.css}`, id: b.id });
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
      const attr = r.id != null ? ` data-id="${r.id}"` : '';
      const open = r.cls ? `<mark class="${r.cls}">` : `<mark${attr} style="${r.style}">`;
      html += `${open}${escapeHtml(text.slice(r.s, r.e))}</mark>`;
      last = r.e;
    }
    html += escapeHtml(text.slice(last));
    return html;
  };

  // ---------- TTS ----------

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) {
      showToast('当前环境不支持语音朗读');
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

  const applyTheme = (rendition: any) => {
    const themes: Record<string, string> = {
      dark: 'background: #1a1a2e; color: #eaeaea;',
      light: 'background: #ffffff; color: #333333;',
      sepia: 'background: #f4ecd8; color: #5b4636;',
    };
    const { theme, fontSize, lineHeight } = cfgRef.current;
    const stack = fontStackOf(fontKeyRef.current);
    const force = forceFontRef.current;
    rendition.themes.default({
      'body':
        themes[theme] +
        ` line-height: ${lineHeight} !important;` +
        (stack ? ` font-family: ${stack}${force ? ' !important' : ''};` : ''),
      'p, div, span': { 'font-size': `${fontSize}px !important` },
    });
    // 强制统一：连元素级 font-family 一并压过，解决异体字/缺字乱码
    if (force && stack) {
      rendition.themes.default({
        '*, *::before, *::after': { 'font-family': `${stack} !important` },
      });
    }
  };

  const toggleFlow = () => {
    const next = flowMode === 'paginated' ? 'scrolled' : 'paginated';
    setFlowMode(next);
    renditionRef.current?.flow(next);
    queueSaveBookPrefs({ flowMode: next });
  };

  /**
   * 写回本书排版偏好：内存合并 + 600ms 防抖。
   * 用内存基底合并而非回读数据库，避免连点字号时的读改写竞态。
   */
  const queueSaveBookPrefs = (patch: Partial<ReaderPrefs>) => {
    bookPrefsRef.current = { ...bookPrefsRef.current, ...patch };
    if (savePrefsTimerRef.current) clearTimeout(savePrefsTimerRef.current);
    savePrefsTimerRef.current = setTimeout(() => {
      savePrefsTimerRef.current = null;
      window.electronAPI?.setSetting(bookPrefsKey(book.id), JSON.stringify(bookPrefsRef.current));
    }, 600);
  };

  /** 循环切换主题（快捷键用） */
  const cycleTheme = () => {
    const order: ThemeName[] = ['dark', 'light', 'sepia'];
    const idx = order.indexOf(cfgRef.current.theme as ThemeName);
    changeTheme(order[(idx + 1) % order.length]);
  };

  const changeTheme = (theme: 'dark' | 'light' | 'sepia') => {
    // 手动改过主题：本次阅读不再被自动护眼覆盖
    themeUserOverrideRef.current = true;
    cfgRef.current = { ...cfgRef.current, theme };
    setSettings(s => ({ ...s, theme }));
    if (renditionRef.current) applyTheme(renditionRef.current);
    queueSaveBookPrefs({ theme });
  };

  const changeFontSize = (delta: number) => {
    const newSize = Math.max(12, Math.min(32, cfgRef.current.fontSize + delta));
    cfgRef.current = { ...cfgRef.current, fontSize: newSize };
    setSettings(s => ({ ...s, fontSize: newSize }));
    if (renditionRef.current) applyTheme(renditionRef.current);
    queueSaveBookPrefs({ fontSize: newSize });
  };

  const changeFont = (key: string) => {
    fontKeyRef.current = key;
    setFontKey(key);
    // 全局默认字体与本书专属各记一份
    window.electronAPI?.setSetting('fontFamily', key);
    if (renditionRef.current) {
      applyTheme(renditionRef.current);
    }
    queueSaveBookPrefs({ fontFamily: key });
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
    queueSaveBookPrefs({ dualColumn: next });
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

  // TXT / PDF：页码变化即记录阅读位置（加载完成前不写，避免覆盖上次位置）
  useEffect(() => {
    if (loading || book.file_type === 'epub') return;
    scheduleSavePos({ page: pageIndex });
    currentPosRef.current = { page: pageIndex };
  }, [pageIndex, loading, book.file_type]);

  /** PDF 缩放档位 */
  const changePdfScale = (delta: number) => {
    setPdfScale(s => {
      const next = Math.min(3, Math.max(0.5, Math.round((s + delta) * 10) / 10));
      queueSaveBookPrefs({ pdfScale: next });
      return next;
    });
  };

  /** PDF 适应宽度 */
  const fitPdfWidth = () => {
    if (!pdfBaseWidthRef.current || !pdfWrapRef.current) return;
    const avail = pdfWrapRef.current.clientWidth - 48;
    const next = Math.min(3, Math.max(0.5, Math.round((avail / pdfBaseWidthRef.current) * 10) / 10));
    setPdfScale(next);
    queueSaveBookPrefs({ pdfScale: next });
  };

  /** 跳到指定页（TXT / PDF） */
  const jumpToPage = (raw: string) => {
    const target = clampPage(Number(raw), totalPages);
    pushHistory();
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

  /** 该章末尾 CFI（无 locations 时返回空） */
  const chapterEndCfi = (href: string): string => {
    try {
      const list = locationsRef.current;
      if (list.length === 0) return '';
      const item = bookRef.current?.spine.spineItems.find(
        (it: any) => it.href === href || href.includes(it.href) || it.href.includes(href),
      );
      if (!item || item.index == null) return '';
      // 章 CFI 基：/(spineIndex+1)*2!（见 epubcfi.generateChapterComponent）
      const base = `/6/${(item.index + 1) * 2}!`;
      let last = '';
      for (const cfi of list) {
        if (cfi.startsWith('epubcfi(' + base) || cfi.startsWith(base)) last = cfi;
        else if (last) break; // 已过本章区间
      }
      return last;
    } catch {
      return '';
    }
  };

  /** 无副作用翻页（自动播放用，不停播） */
  const advancePage = (dir: 1 | -1) => {
    if (book.file_type === 'epub') {
      clearEpubSearchMarks();
      setSearchMark('');
      const loc = locationRef.current;
      const idx = chapterIdxRef.current;
      const toc = chaptersRef.current;
      if (dir > 0) {
        // 本章末页 → 下一章另起；否则章内翻页
        const atChapterEnd = loc.endPage >= loc.total;
        if (atChapterEnd && idx != null && idx < toc.length - 1) {
          renditionRef.current?.display(toc[idx + 1].href);
          return;
        }
        renditionRef.current?.next();
        return;
      }
      // 本章首页 → 上一章末尾；否则章内回翻
      if (loc.startPage <= 1 && idx != null && idx > 0) {
        const prevHref = toc[idx - 1].href;
        const endCfi = chapterEndCfi(prevHref);
        if (endCfi) {
          renditionRef.current?.display(endCfi);
        } else {
          // 降级：上一章开头（仍保证无混合页）
          renditionRef.current?.display(prevHref);
        }
        return;
      }
      renditionRef.current?.prev();
      return;
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
    pushHistory();
    advancePage(-1);
  };

  const handleNext = () => {
    setSel(null);
    stopAuto();
    pushHistory();
    advancePage(1);
  };

  const goToChapter = (href: string) => {
    pushHistory();
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
      // 跳转历史
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
        return;
      }
      switch (e.key) {
        case 'Escape':
          // 优先收起面板，无面板时关闭文档返回书架
          if (panel) {
            e.preventDefault();
            setPanel(null);
          } else if (sel) {
            e.preventDefault();
            setSel(null);
            clearEpubSelection();
          } else {
            e.preventDefault();
            onBack();
          }
          break;
        default:
          break;
      }
      // 预设快捷键：未绑定的键一律放行，不抢占系统/浏览器行为
      const action = resolveAction(presetRef.current, e);
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case 'next': handleNext(); break;
        case 'prev': handlePrev(); break;
        case 'first': goToFirst(); break;
        case 'last': goToLast(); break;
        case 'toggleTheme': cycleTheme(); break;
        case 'fontUp': changeFontSize(2); break;
        case 'fontDown': changeFontSize(-2); break;
        case 'openToc': if (book.file_type === 'epub') togglePanel('toc'); break;
        case 'openSearch': if (book.file_type !== 'pdf') togglePanel('search'); break;
        case 'openNotes': togglePanel('notes'); break;
        case 'openPositions': togglePanel('positions'); break;
        case 'highlight': if (sel) handleHighlight(); break;
        case 'addNote':
          if (sel) {
            setNoteDraft({ text: sel.text, position: sel.position });
            setNoteContent('');
          }
          break;
        case 'toggleDualColumn': toggleDualColumn(); break;
        case 'toggleFullscreen': handleToggleFullscreen(); break;
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
    pushHistory();
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
    <div className={`reader ${view.autoHideBar ? 'bar-auto-hide' : ''}`}>
      {view.autoHideBar && (
        <div className="bar-trigger" onMouseEnter={() => setBarVisible(true)} />
      )}
      <div
        className={`reader-header ${view.autoHideBar && !barVisible ? 'bar-hidden' : ''}`}
        onMouseLeave={() => { if (view.autoHideBar) setBarVisible(false); }}
      >
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
            <button onClick={toggleFlow} title={flowMode === 'paginated' ? '切换滚动模式' : '切换分页模式'}>
              {flowMode === 'paginated' ? '📜' : '📄'}
            </button>
          )}
          {(book.file_type === 'epub' || book.file_type === 'txt') && (
            <button onClick={() => togglePanel('toc')} className={panel === 'toc' ? 'active' : ''}>📑 目录</button>
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
          {book.file_type === 'txt' && (
            <button
              onClick={toggleNormalize}
              className={normalizeOn ? 'active' : ''}
              title={normalizeOn ? '还原原始排版' : '文本规整：清理空行/缩进/硬折行（不改原文件）'}
            >
              ✨ 规整
            </button>
          )}
          <button onClick={() => togglePanel('positions')} className={panel === 'positions' ? 'active' : ''} title="阅读位置">
            📍{positions.length > 0 ? ` ${positions.length}` : ''}
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
          <button
            onClick={() => setShowViewPanel(v => !v)}
            className={showViewPanel ? 'active' : ''}
            title="阅读视图"
          >
            👁
          </button>
          <button onClick={handleToggleFullscreen} title="全屏 (F11)">
            ⛶
          </button>
        </div>
      </div>

      {/* 阅读视图选项面板 */}
      {showViewPanel && (
        <div className="view-panel">
          <h4>阅读视图</h4>
          <label className="view-row">
            <input
              type="checkbox"
              checked={view.pageShadow}
              onChange={e => updateView({ pageShadow: e.target.checked })}
            />
            <span>页面阴影与边框</span>
          </label>
          <label className="view-row">
            <input
              type="checkbox"
              checked={view.invert}
              onChange={e => updateView({ invert: e.target.checked })}
            />
            <span>页面反色（暗光护眼）</span>
          </label>
          <label className="view-row">
            <input
              type="checkbox"
              checked={view.clickEdge}
              onChange={e => updateView({ clickEdge: e.target.checked })}
            />
            <span>点击页面边缘翻页</span>
          </label>
          {view.clickEdge && (
            <label className="view-row">
              <span>边缘宽度</span>
              <input
                type="range"
                min={5}
                max={25}
                value={view.edgeWidth}
                onChange={e => updateView({ edgeWidth: Number(e.target.value) })}
              />
              <span className="view-value">{view.edgeWidth}%</span>
            </label>
          )}
          <label className="view-row">
            <input
              type="checkbox"
              checked={view.autoHideBar}
              onChange={e => {
                updateView({ autoHideBar: e.target.checked });
                setBarVisible(!e.target.checked);
              }}
            />
            <span>自动隐藏工具栏</span>
          </label>
          <label className="view-row">
            <span>光标样式</span>
            <select
              value={view.cursor}
              onChange={e => updateView({ cursor: e.target.value as 'text' | 'default' })}
            >
              <option value="text">阅读光标</option>
              <option value="default">选择光标</option>
            </select>
          </label>
          <label className="view-row">
            <input
              type="checkbox"
              checked={view.alwaysOnTop}
              onChange={toggleAlwaysOnTop}
            />
            <span>窗口置顶</span>
          </label>
        </div>
      )}

      <div className="reader-body">
        {panel === 'toc' && book.file_type === 'txt' && (
          <div className="toc-panel">
            <div className="panel-title-row">
              <h3>目录（{txtToc.length}）</h3>
              <button className="link-btn" onClick={handleAddChapterAtCursor}>＋ 当前位置</button>
            </div>
            {txtToc.length === 0 ? (
              <p className="empty-text">未识别到章节，可在书籍详情页调整解析方式</p>
            ) : (
              txtToc.map((t, i) => (
                <div key={i} className="toc-item" onClick={() => goToTxtLine(t.line, t.page)}>
                  {t.label}
                </div>
              ))
            )}
          </div>
        )}

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

        {panel === 'positions' && (
          <div className="toc-panel">
            <h3>阅读位置（{positions.length}）</h3>
            <button
              className="btn-primary small"
              style={{ width: '100%', marginBottom: 14 }}
              onClick={handleMarkPosition}
            >
              ＋ 标记当前位置
            </button>
            {positions.length === 0 ? (
              <p className="empty-text">还没有保存的位置</p>
            ) : (
              positions.map(p => (
                <div key={p.id} className="mark-item">
                  <p className="mark-label">
                    {p.source === 'crash' ? '⚠ 异常退出时' : p.source === 'exit' ? '退出时' : '手动标记'}
                    {p.progress > 0 ? ` · ${Math.round(p.progress * 100)}%` : ''}
                  </p>
                  <p className="mark-note">{p.label || '未命名位置'}</p>
                  <p className="book-meta">{new Date(p.created_at).toLocaleString()}</p>
                  <div className="mark-actions">
                    <button onClick={() => handleJumpPosition(p)}>跳转</button>
                    <button className="danger" onClick={() => handleDeletePosition(p.id)}>删除</button>
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
                    <button onClick={() => handleRenameBookmark(b)}>改名</button>
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
              <button className="btn-secondary small" onClick={handleAiMindmap} disabled={aiLoading}>
                🧠 脑图
              </button>
              {book.file_type !== 'pdf' && (
                <button className="btn-secondary small" onClick={handleBookMindmap} disabled={aiLoading}>
                  📚 本书脑图
                </button>
              )}
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
            {aiLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <p className="empty-text" style={{ padding: 0 }}>
                  {aiAnswer ? '生成中...' : '思考中...'}
                </p>
                <button className="btn-secondary small" onClick={stopAi}>
                  ⏹ 停止
                </button>
              </div>
            )}
            {aiAnswer && (
              <div className="mark-item">
                <p className="mark-note" style={{ whiteSpace: 'pre-wrap' }}>{aiAnswer}</p>
                {!aiLoading && aiWord && (
                  <div className="mark-actions">
                    <button onClick={handleSaveWord}>存入生词本</button>
                  </div>
                )}
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

        <div
          className={`reader-content ${readerThemeClass} ${phoneMode ? 'phone-mode' : ''}${view.pageShadow ? '' : ' no-shadow'}${view.invert ? ' invert' : ''}${view.cursor === 'default' ? ' cursor-default' : ''}`}
          ref={viewerRef}
          onClick={handleContentClick}
        >
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
              onClick={handleTxtMarkClick}
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

          {/* 点击页面边缘翻页 */}
          {view.clickEdge && !loading && !error && (
            <>
              <div
                className="edge-zone edge-left"
                style={{ width: `${view.edgeWidth}%` }}
                onClick={handlePrev}
                title="上一页"
              />
              <div
                className="edge-zone edge-right"
                style={{ width: `${view.edgeWidth}%` }}
                onClick={handleNext}
                title="下一页"
              />
            </>
          )}
        </div>
      </div>

      <div className="reader-footer">
        <button
          className="nav-btn ghost"
          onClick={goBack}
          disabled={!histState.canBack}
          title="后退到上一个跳转位置"
        >
          ↶
        </button>
        <button
          className="nav-btn ghost"
          onClick={goForward}
          disabled={!histState.canForward}
          title="前进到下一个跳转位置"
        >
          ↷
        </button>
        <button className="nav-btn" onClick={handlePrev}>上一页</button>
        {book.file_type === 'epub' && chapterIdx != null && chapterTotal > 0 ? (
          <span className="page-indicator wide">
            第{chapterIdx + 1}章 · {chapterPage}/{chapterTotal}页 · {bookPercent}%
          </span>
        ) : null}
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
        {book.file_type === 'epub' && (
          <input
            className="jump-input"
            value={jumpInput}
            onChange={e => setJumpInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') jumpToPercent(jumpInput);
            }}
            placeholder="跳转%"
            title="输入阅读百分比（1-100）回车跳转"
          />
        )}
        <button className="nav-btn" onClick={handleNext}>下一页</button>
      </div>

      {/* 选中操作条 */}
      {sel && (
        <div className="select-popup" style={{ left: sel.x, top: sel.y }}>
          {readonlyMarksRef.current ? null : (
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
          )}
          <button
            onClick={() => {
              setNoteDraft({ text: sel.text, position: sel.position });
              setNoteContent('');
            }}
            title={readonlyMarksRef.current ? '批注只读模式已开启' : '写笔记'}
            disabled={readonlyMarksRef.current}
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
          <button onClick={() => handleAiQuick('define')} title="查词并可存入生词本">
            📖 查词
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

      {/* 批注详情（原文 → 笔记） */}
      {markPreview && (
        <div className="modal-mask" onClick={() => setMarkPreview(null)}>
          <div className="note-modal" onClick={e => e.stopPropagation()}>
            <h3>批注详情</h3>
            {markPreview.text && <p className="mark-quote">{markPreview.text}</p>}
            {markPreview.note ? (
              <p className="mark-note" style={{ whiteSpace: 'pre-wrap' }}>{markPreview.note}</p>
            ) : (
              <p className="empty-text">此处只有高亮，还没有写笔记</p>
            )}
            <div className="form-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  jumpToMark(markPreview.position);
                  setMarkPreview(null);
                }}
              >
                跳到原文
              </button>
              {markPreview.noteId != null && (
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    if (!confirm('删除这条笔记？')) return;
                    await handleDeleteNote(markPreview.noteId!);
                    setMarkPreview(null);
                  }}
                >
                  删除笔记
                </button>
              )}
              <button className="btn-primary" onClick={() => setMarkPreview(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 思维导图 */}
      {mindNodes && (
        <MindmapView
          nodes={mindNodes}
          title={mindTitle}
          onClose={() => { setMindNodes(null); setMindTitle(''); }}
          onExpand={expandMindChapter}
        />
      )}

      {/* 轻量提示 */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
