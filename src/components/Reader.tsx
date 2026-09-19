import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Book, Bookmark, Note, TocEntry, ReadingPosition } from '../types';
import { Icon } from './Icon';
import { escapeHtml, excerptAround, clampPage, lineToPageIndex, paginateText, parseSavedPosition, serializeSavedPosition, findKeyword, buildKeywordRegex, epubSectionText, markKeywordHtml, stepHitIndex, type SavedPosition, type KeywordOptions } from '../utils/text';
import { fontStackOf, highlightColorOf, HIGHLIGHT_COLORS, type ThemeName } from '../utils/reader-options';
import { resolveThemeByClock, type AutoThemeConfig } from '../utils/auto-theme';
import {
  parseBookPrefs,
  mergePrefs,
  bookPrefsKey,
  DEFAULT_READER_PREFS,
  PAGE_ANIMATIONS,
  type PageAnimation,
  type ReaderPrefs,
} from '../utils/book-prefs';
import { parseMindmap, MindNode } from '../utils/mindmap';
import { lookupMark, compareByPosition } from '../utils/mark-lookup';
import { normalizeText } from '../utils/text-normalize';
import {
  itemsToLines,
  detectColumnSplit,
  splitColumns,
  linesToBlocks,
  analyzeFontSizes,
  findRepeatingLines,
  normalizeForRepeat,
  type LayoutLine,
  type ReflowBlock,
} from '../utils/pdf-layout';
import { getPreset, resolveAction, buildKeyMap, parseShortcutOverrides, DEFAULT_SHORTCUT_PRESET } from '../utils/shortcuts';
import { STYLE_PRESETS, resolveCustomCss, validateCustomCss, MAX_CSS_LEN } from '../utils/reading-styles';
import { MindmapView } from './Mindmap';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

/** 本地导入字体的 key 前缀：family 取自文件名 */
const LOCAL_FONT_PREFIX = 'local:';

/** 阅读样式注入用的 style 节点 id：同一章节反复注入时复用同一个节点 */
const STYLE_NODE_ID = 'reader-style-preset';

/** 缩略图目标宽度（px）：和面板两列布局对齐，漫画原图几 MB 也先缩到这里 */
const THUMB_WIDTH = 96;

/**
 * 漫画类格式：CBZ=zip、CBR=rar、CBT=tar、CB7=7z。
 *
 * 底层 electron/services/comic.ts 是按文件头魔数识别容器的，与 file_type 无关，
 * 所以这四种包只要阅读侧认它们是漫画就能读。此前只判 'cbz'，导致 rar/tar/7z 的包
 * 能导入、能上书架，点开却报「不支持的文件格式」。
 */
const COMIC_FILE_TYPES = new Set(['cbz', 'cbr', 'cbt', 'cb7']);

/** 是否漫画类格式：判定集中一处，别再到处写 === 'cbz' */
const isComicFile = (fileType: string) => COMIC_FILE_TYPES.has(fileType);

/**
 * 文档型格式：Markdown 与 DOCX。
 *
 * 两者在阅读侧是同一套——整篇 HTML 连续滚动、不分章不分页，位置记「第几个顶层块」，
 * 跳转靠标题锚点。判定集中在这里，别再到处写 === 'md'。
 */
const DOC_FILE_TYPES = new Set(['md', 'docx']);
const isDocFile = (fileType: string) => DOC_FILE_TYPES.has(fileType);

/**
 * 文档型格式的批注位置串前缀，形如 `doc:块序号:起:止`。
 * 早期只有 Markdown 时存的是 `md:`，读的时候一并认，免得已做的批注失效。
 */
const isDocPos = (position: string) => position.startsWith('doc:') || position.startsWith('md:');

/** 滑动模式无目录时的连排块大小（页）。按块对齐，同一块内滚动不会反复换内容 */
const TXT_FLOW_WINDOW = 20;

/** 滑动模式单次连排渲染的页数上限：超长章节不许把整个 DOM 一次性撑起来 */
const TXT_FLOW_LIMIT = 100;

/** 字体 key → CSS font-family：本地导入的字体直接用其 family，预设走原有映射 */
const stackOfFontKey = (key: string) =>
  key.startsWith(LOCAL_FONT_PREFIX) ? `'${key.slice(LOCAL_FONT_PREFIX.length)}'` : fontStackOf(key);

/** 文档型格式 块内的一处标记：偏移按块内文本节点顺序累加 */
export interface DocRange {
  s: number;
  e: number;
  /** 检索词标记的类名；书签不带类名，靠行内 style 上色 */
  cls?: string;
  style?: string;
  /** 书签 id，落到 data-id 上供点击反查 */
  id?: number;
}

/**
 * 在某个块的 DOM 里按文本偏移套上标记。
 *
 * 偏移 → 节点的换算必须一次算完：套标记会切分文本节点，之后再换算就是按切分后的
 * 长度算了，后面的标记会整体错位。所以先记下锚点，再从后往前套——改动总落在更靠后的
 * 位置上，前面已记好的锚点不受影响。
 */
export function wrapDocRanges(doc: Document, block: HTMLElement, ranges: DocRange[]): void {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(block, window.NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);

  const starts: number[] = [];
  let acc = 0;
  for (const t of nodes) {
    starts.push(acc);
    acc += (t.textContent || '').length;
  }
  const total = acc;
  const anchorOf = (off: number) => {
    const clamped = Math.max(0, Math.min(off, total));
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (clamped >= starts[i]) {
        const len = (nodes[i].textContent || '').length;
        return { node: nodes[i], offset: Math.min(clamped - starts[i], len) };
      }
    }
    return null;
  };

  // 去掉重叠：两条标记相交时套上去会互相吞并，后一条整条跳过（前面的书签优先保留）
  const kept: DocRange[] = [];
  let last = 0;
  for (const r of [...ranges].sort((a, b) => a.s - b.s)) {
    if (r.s < last || r.e <= r.s) continue;
    kept.push(r);
    last = r.e;
  }

  for (let k = kept.length - 1; k >= 0; k--) {
    const r = kept[k];
    const a = anchorOf(r.s);
    const b = anchorOf(r.e);
    if (!a || !b) continue;
    const mark = doc.createElement('mark');
    if (r.cls) mark.className = r.cls;
    if (r.style) mark.setAttribute('style', r.style);
    if (r.id != null) mark.setAttribute('data-id', String(r.id));
    const range = doc.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      // 用 extractContents 而不是 surroundContents：标记跨过 <strong>、<code> 这类
      // 行内元素边界时 surroundContents 会直接抛错，抽出来再套回去则两种情形都能落
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    } catch {
      /* 区间失效（位置串与当前正文对不上）就跳过这一条，正文照常显示 */
    }
  }
}

interface ReaderProps {
  book: Book;
  onBack: () => void;
  /** 从详情页目录跳入的初始位置 */
  initialTarget?: TocEntry | null;
  /** 从笔记跳入的原始位置串：EPUB 为 CFI，TXT 为 txt:页:起:止 */
  initialPosition?: string | null;
  /** Markdown 的 [[目标]] 跳转：把另一本书交给上层打开（同窗口多标签） */
  onOpenBook?: (book: Book) => void;
}

type Panel = 'toc' | 'notes' | 'marks' | 'search' | 'ai' | 'positions' | 'typo' | 'thumbs' | 'ocr' | null;

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

export function Reader({ book, onBack, initialTarget, initialPosition, onOpenBook }: ReaderProps) {
  /**
   * 当前这本书的格式能力。
   *
   * UI 里所有「这个功能对它有没有用」的判断都从这里取，不再到处写
   * book.file_type === 'xxx'。散判最容易漏——漏一处就是一个点了没反应的按钮。
   * 拿不准某按钮该不该出现时，先问：它依赖下面哪一项能力？
   * 放在组件最前面，是因为快捷键处理也要用，那段的引用位置更早。
   */
  const isDoc = isDocFile(book.file_type);
  const caps = {
    /** 能划词、能提取正文——朗读 / 检索 / AI / 双栏 / 标注都靠它 */
    text: book.file_type === 'epub' || book.file_type === 'txt' || isDoc,
    /**
     * 能书内检索。
     * PDF 划不了词，本来进不来；但 pdfjs 抽出来的文字层足够做检索，所以单开一个口子。
     * 不能直接并进 caps.text——那一个开关还管着朗读、笔记、AI、双栏和标注十来处，
     * 放开它等于让 PDF 长出四个它支撑不了的功能。
     */
    search: book.file_type === 'epub' || book.file_type === 'txt' || isDoc || book.file_type === 'pdf',
    /**
     * 有「分页 / 连续滚动」两种版式。
     * 文档型格式不在此列：它天生是一份连续文档，没有页可分，见 caps.vertical 同理。
     */
    flow: book.file_type === 'epub' || book.file_type === 'txt',
    /** 能竖排 */
    vertical: book.file_type === 'epub' || book.file_type === 'txt',
    /** 整页即一张图 */
    image: book.file_type === 'pdf' || isComicFile(book.file_type),
    /**
     * 能分双栏。分栏靠 CSS 多列，得有一个「一屏高」的容器才成立；
     * 文档型格式是一整篇连续长文、高度不受限，分栏后第二栏会跑到视口右边够不着。
     */
    dualColumn: book.file_type === 'epub' || book.file_type === 'txt',
    /** 有页面缩略图（一页一张图才有意义；TXT/EPUB/文档用目录跳转更省） */
    thumbs: book.file_type === 'pdf' || isComicFile(book.file_type),
    /** 能识别当前页文字 */
    ocr: book.file_type === 'pdf' || isComicFile(book.file_type),
    /** 字号 / 字体族对正文生效（PDF 重排成流式排版后、文档型格式正文也吃这一套） */
    font: book.file_type === 'epub' || book.file_type === 'txt' || book.file_type === 'pdf' || isDoc,
  };

  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const lastContentsRef = useRef<any>(null);
  const pdfDocRef = useRef<any>(null);
  /** PDF 每页文字层，供书内检索用；换书时随 pdfDocRef 一起清掉 */
  const pdfPageTextRef = useRef<{ doc: unknown; texts: string[] } | null>(null);
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
  /** 用户导入的本地字体：family 取自文件名，靠注入的 @font-face 生效 */
  const [localFonts, setLocalFonts] = useState<{ name: string; family: string }[]>([]);
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
  /** 缩略图按页缓存小图；只给滚到可见的页生成，长文档不能全量渲染 */
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const thumbPendingRef = useRef<Set<number>>(new Set());
  /** TXT 目录（含段落行号），阅读器内可直接跳转与增补章节 */
  const [txtToc, setTxtToc] = useState<TocEntry[]>([]);
  /**
   * 章节标题集合，仅供分页使用。
   * 用 ref 而不是从 txtToc 推导：目录取回来是异步的，而首次分页在它之前就跑完了，
   * 直接读 state 会拿到空集合，导致首页仍然跨章。
   */
  const chapterLabelsRef = useRef<Set<string>>(new Set());
  /** 每页起始段落行号，用于目录行号 ↔ 页码互转 */
  const txtPageStartRef = useRef<number[]>([]);
  /** 滑动模式：上一次的连排窗口起点，用于区分「换了窗口」与「窗口内滚动」 */
  const lastFlowStartRef = useRef(-1);
  /** 滑动模式：本次 pageIndex 变化是否由滚动回填引起（是则不要重新定位视口） */
  const txtScrollByUserRef = useRef(false);
  /** 滑动模式：滚动回填已排入下一帧，避免一帧内重复处理 */
  const flowScrollTickRef = useRef(false);
  /** 文档型格式：滚动回填已排入下一帧，避免一帧内重复处理 */
  const docScrollTickRef = useRef(false);
  /** 漫画（CBZ）：页面条目名清单与当前页图片数据，按页拉取，不整包驻留 */
  const [comicPages, setComicPages] = useState<string[]>([]);
  const [comicPageData, setComicPageData] = useState<{ data: string; mime: string } | null>(null);
  /** 双页合并时右半页（页码在后的那页）的数据 */
  const [comicNextData, setComicNextData] = useState<{ data: string; mime: string } | null>(null);
  /**
   * 漫画页的小窗口缓存：只保留可见页前后各一页，翻页即换窗口、离开窗口的页立刻丢弃。
   * 这样前后翻页不必再等一次 IPC，且窗口大小与书有多少页无关，不会把整包留在内存里。
   */
  const comicCacheRef = useRef<Map<string, { data: string; mime: string }>>(new Map());
  const [comicSpread, setComicSpread] = useState(false);
  const [comicRtl, setComicRtl] = useState(false);
  /** 竖排阅读：只对文字类格式生效 */
  const [vertical, setVertical] = useState(false);
  const verticalRef = useRef(false);
  /** 本地 OCR：当前页识别结果与进度，仅扫描版 PDF / 漫画有入口 */
  const [ocrLines, setOcrLines] = useState<{ text: string; score: number }[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState('');
  const [ocrPage, setOcrPage] = useState<number | null>(null);
  /** 快捷键分发要同步读取翻页方向，用 ref 避免闭包拿到旧值 */
  const comicRtlRef = useRef(false);
  const [pdfReady, setPdfReady] = useState(false);

  // EPUB 版式
  const [flowMode, setFlowMode] = useState<'paginated' | 'scrolled'>('paginated');
  /** 打开这本书时该用的版式：文档型格式 导入的书默认连续滚动，其余按偏好 */
  const initialFlowRef = useRef<'paginated' | 'scrolled'>('paginated');
  /** 当前版式：relocated 回调要据此判断——滚动模式下 relocated 会随滚动频繁触发，不该放翻页动效 */
  const flowModeRef = useRef<'paginated' | 'scrolled'>('paginated');
  /** 同理：双栏偏好也要在 renderTo 之前就备好——setState 是异步的，读 state 会拿到旧值 */
  const initialDualRef = useRef(false);

  // 检索
  const [keyword, setKeyword] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * 当前停在第几处命中，-1 表示本轮检索还没跳过。
   * 与 hits 同生共死：每次重新检索都重置，否则新结果会带着旧下标、
   * 「第 3 / 2 处」这种读数就出来了（越界由 stepHitIndex 兜住，但读数得自己管）。
   */
  const [hitIndex, setHitIndex] = useState(-1);
  /**
   * 当前命中项，用于把它滚进可视区。
   * 命中动辄几十处、列表比面板长，「下一处」跳过去之后按钮在视野外，
   * 面板里就看不到自己现在停在第几处。
   */
  const activeHitRef = useRef<HTMLDivElement | null>(null);
  /** 检索高级选项：区分大小写 / 全词匹配（中文没有词边界，全词对中文不生效） */
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);

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
  /** PDF 重排：抽取文字层后按流式排版渲染，适配窗口宽度 */
  const [pdfReflow, setPdfReflow] = useState(false);
  const [reflowPages, setReflowPages] = useState<ReflowBlock[][]>([]);
  const [reflowPage, setReflowPage] = useState(0);
  /** PDF 的书签目录（主进程从 outline 解析，带页码），原始版式下跳页用 */
  const [pdfToc, setPdfToc] = useState<TocEntry[]>([]);
  /**
   * PDF 已重排：视图按「重排屏」渲染。屏是按字数重新切的，跨原始页边界，
   * 与 PDF 原始页序是两套坐标——所有跳转与位置记忆都得先认清当前是哪一套。
   */
  const inPdfReflow = book.file_type === 'pdf' && pdfReflow && reflowPages.length > 0;
  const [reflowBusy, setReflowBusy] = useState(false);
  /**
   * 文档型格式 正文与目录。
   * 整篇一个 HTML，靠滚动阅读——不切章、不分页，所以没有「当前第几页」这回事，
   * 阅读位置改记「第几个顶层块」（见 SavedPosition.docBlock）。
   */
  const [docHtml, setDocHtml] = useState('');
  const [docToc, setDocToc] = useState<TocEntry[]>([]);
  /** 文档型格式 当前所在的顶层块序号，滚动时回填 */
  const [docBlock, setDocBlock] = useState(0);
  /** 排版自定义：背景色 / 文字色 / 页边距 / 段间距 / 字间距 / 首行缩进 */
  const [typo, setTypo] = useState({ bgColor: '', textColor: '', pagePadding: 56, paraSpacing: 0, pageGap: 0, letterSpacing: 0, textIndent: 0 });
  const typoRef = useRef(typo);
  /** 阅读样式预设：styleCssRef 存当前要注入的 CSS，切换时免去异步读设置 */
  const [stylePreset, setStylePreset] = useState('none');
  const styleCssRef = useRef('');
  /** 自定义 CSS：切预设时要用它重新解析，所以留一份；草稿是输入框里的内容 */
  const customCssRef = useRef('');
  const [customCssDraft, setCustomCssDraft] = useState('');
  const [showCustomCss, setShowCustomCss] = useState(false);
  /** 批注排序：按时间（默认）或按位置 */
  const [markSort, setMarkSort] = useState<'time' | 'position'>('time');
  /** 显示/隐藏全部批注（只影响渲染，不删数据） */
  const [hideMarks, setHideMarks] = useState(false);
  /** EPUB 注解在绘制那一刻就定死了样式，重绘时要读最新值，故另存 ref */
  const hideMarksRef = useRef(false);
  /** 翻页动画档位：平滑 / 减弱 / 关闭。动画回调不在 React 渲染周期里，另存 ref */
  const [pageAnim, setPageAnim] = useState<PageAnimation>('off');
  const pageAnimRef = useRef<PageAnimation>('off');
  /** 系统「减少动态效果」：开启时平滑档也要降级，无障碍偏好优先于应用设置 */
  const prefersReducedMotionRef = useRef(false);
  /** 全局强制统一字体：压过电子书自带的奇葩字体 */
  const forceFontRef = useRef(false);
  /** 批注只读：屏蔽新增/删除批注的操作入口 */
  const readonlyMarksRef = useRef(false);
  /** 当前快捷键预设（从设置读取） */
  const presetRef = useRef(getPreset(DEFAULT_SHORTCUT_PRESET));
  /** TXT 规整：原文缓存 + 开关（非破坏性，原文与磁盘文件都不动） */
  const txtRawRef = useRef<string>('');
  const [normalizeOn, setNormalizeOn] = useState(false);
  /** TXT 原始字节：手动换编码要反复重解码同一份字节，解码后的字符串存不下这个信息 */
  const txtBytesRef = useRef<Uint8Array | null>(null);
  /** TXT 编码：'auto' 为自动识别（UTF-8 严格模式失败回退 GBK），其余为 TextDecoder 编码名 */
  const [txtEncoding, setTxtEncoding] = useState('auto');
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

  /**
   * 应用内输入弹窗。Electron 的渲染进程不支持 window.prompt（调用即抛
   * "prompt() is not supported."），所以章节命名、书签改名这类输入要自绘。
   */
  const [textPrompt, setTextPrompt] = useState<{
    title: string;
    hint?: string;
    value: string;
    confirmLabel?: string;
    onConfirm: (value: string) => Promise<void> | void;
  } | null>(null);
  const [textPromptBusy, setTextPromptBusy] = useState(false);

  const submitTextPrompt = async () => {
    if (!textPrompt) return;
    setTextPromptBusy(true);
    try {
      await textPrompt.onConfirm(textPrompt.value);
      setTextPrompt(null);
    } finally {
      setTextPromptBusy(false);
    }
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
      showToast('本系统暂不支持窗口置顶');
    }
  };

  // PDF 缩放 / 跳页 / 全屏 / 朗读变速
  const [pdfScale, setPdfScale] = useState(1.5);
  /** PDF 页面旋转角度（0/90/180/270） */
  const [pdfRotation, setPdfRotation] = useState(0);
  const pdfBaseWidthRef = useRef(0);
  /** 页面自然高度（scale=1），适应高度 / 适应整页要用，与宽度同一时机取一次 */
  const pdfBaseHeightRef = useRef(0);
  const pdfWrapRef = useRef<HTMLDivElement>(null);
  /** 高分屏用的设备像素比（上限 2），变化时重渲染当前页 */
  const [dpr, setDpr] = useState(() => Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
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
      // 页文字层缓存留着会把上一本书的正文搜出来，跟着 doc 一起清
      pdfPageTextRef.current = null;
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
      // 取同步好的最新位置，不能直接调 describeCurrentPos——那个闭包是挂载时的，
      // 非 EPUB 分支会读到第 1 页
      const d = exitPosRef.current;
      if (d) api.addReadingPosition({ book_id: book.id, ...d, source: 'exit' });
      api.setSetting(`readingSession:${book.id}`, '');
      // 释放主进程里的漫画整包缓存（非漫画书按路径匹配不上，是空操作）
      api.releaseComicCache?.(book.id);
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
  /**
   * 退出时断点用的最新位置。
   * 记录断点那个 effect 的 cleanup 闭包停在挂载那一刻，里面直接读 pageIndex/totalPages
   * 这两个 state 的话永远拿到 0，TXT/PDF/漫画的「退出时」断点会一直是第 1 页
   * （EPUB 走 rendition ref 所以没这个问题）。下面每次渲染同步一份供 cleanup 取用。
   */
  const exitPosRef = useRef<{ position: string; label: string; progress: number } | null>(null);
  const histRef = useRef<{ stack: SavedPosition[]; idx: number }>({ stack: [], idx: -1 });
  const [histState, setHistState] = useState({ canBack: false, canForward: false });

  const syncHistState = () => {
    const h = histRef.current;
    setHistState({ canBack: h.idx > 0, canForward: h.idx < h.stack.length - 1 });
  };

  const samePos = (a: SavedPosition, b: SavedPosition) =>
    a.cfi === b.cfi && a.page === b.page && a.reflow === b.reflow && a.docBlock === b.docBlock;

  /** 跳转前调用：把当前位置压入历史栈 */
  const pushHistory = () => {
    const pos = currentPosRef.current;
    if (!pos || (pos.cfi == null && pos.page == null && pos.reflow == null && pos.docBlock == null)) return;
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
    // 文档型格式 没有页，历史栈里带的是块序号
    else if (isDoc && pos.docBlock != null) scrollToDocBlock(pos.docBlock);
    // 重排下屏序与原始页序不换算：历史栈里带了屏号就按屏号还原
    else if (inPdfReflow && pos.reflow != null) {
      setReflowPage(Math.min(pos.reflow, reflowPages.length - 1));
    }
    // 历史栈里的页码可能来自规整前的旧版本，页数变少后直接跳会落到不存在的空白页
    else if (pos.page != null) {
      setPageIndex(totalPages > 0 ? clampPage(pos.page + 1, totalPages) - 1 : pos.page);
    }
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
    if (book.file_type === 'epub') {
      renditionRef.current?.display();
      return;
    }
    // 文档型格式 没有页，回到文档顶端
    if (isDoc) {
      scrollToDocBlock(0);
      return;
    }
    // 重排后视图读的是 reflowPage，喂 pageIndex 等于没按
    if (inPdfReflow) {
      setReflowPage(0);
      return;
    }
    setPageIndex(0);
  };

  const goToLast = () => {
    pushHistory();
    if (isDoc) {
      const el = txtRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      return;
    }
    if (book.file_type !== 'epub') {
      if (inPdfReflow) {
        setReflowPage(reflowPages.length - 1);
        return;
      }
      if (totalPages > 0) setPageIndex(totalPages - 1);
      return;
    }
    // EPUB：优先用位置索引换算文末 CFI，无索引则退到最后一条目录
    let cfi = '';
    if (locationsRef.current.length > 0) {
      try {
        // 索引不可用时这里拿到的可能是 -1（数字），只有字符串才是可用的 CFI。
        // 以前 -1 会被当成真值直接 display，跳不动又不再回退目录。
        const got = bookRef.current?.locations?.cfiFromPercentage?.(0.999);
        if (typeof got === 'string') cfi = got;
      } catch { /* 忽略，走目录回退 */ }
    }
    if (cfi) {
      void renditionRef.current?.display(cfi)?.catch?.(() => { /* 跳不动就停在原位 */ });
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
      // 索引为空时 cfiFromPercentage 返回 -1 而不是字符串，直接 display 会抛
      // “No Section Found”，表现为点了没反应，所以先判类型
      if (typeof cfi === 'string' && cfi) {
        pushHistory();
        void renditionRef.current?.display(cfi)?.catch?.(() => showToast('跳转失败，请重试'));
      } else {
        showToast('这本书的位置索引不可用，可改用目录跳转');
      }
    } catch {
      showToast('跳转失败，请重试');
    }
  };

  // ---------- 文档型格式（整篇连续滚动）----------
  // 与 TXT 的「滑动模式」是两回事：那边是把按字数切好的页连起来排（有页码、有连排窗口），
  // 这边根本没有页——一整篇文档从头滚到尾，位置只能指望顶层块。

  /** 正文容器里的顶层块（段落 / 标题 / 列表 / 代码块…），序号即阅读位置的锚点 */
  const docBlocksOf = (): HTMLElement[] =>
    txtRef.current ? (Array.from(txtRef.current.children) as HTMLElement[]) : [];

  /**
   * 从第 index 个顶层块起取纯文本。
   * 朗读要的是「从这里读到文末」，AI 上下文要的是「眼前这一段」，
   * 差别只在 maxChars：给了就截断，不给就取到底。
   */
  const docTextFrom = (index: number, maxChars = 0): string => {
    let out = '';
    for (const b of docBlocksOf().slice(Math.max(0, index))) {
      out += (b.textContent || '') + '\n';
      if (maxChars > 0 && out.length >= maxChars) break;
    }
    const text = out.trim();
    return maxChars > 0 ? text.slice(0, maxChars) : text;
  };

  /** 把某一块顶到视口上沿。用增量而非绝对赋值，免得算错 padding / border 整体偏一截 */
  const scrollToDocBlock = (index: number) => {
    const el = txtRef.current;
    const blocks = docBlocksOf();
    if (!el || blocks.length === 0) return;
    const target = blocks[Math.min(Math.max(index, 0), blocks.length - 1)];
    if (!target) return;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
  };

  /** 滚动回填当前块：视口上沿之下最后一块，就是眼前正在读的那块 */
  const handleDocScroll = () => {
    if (docScrollTickRef.current) return;
    docScrollTickRef.current = true;
    requestAnimationFrame(() => {
      docScrollTickRef.current = false;
      const el = txtRef.current;
      if (!el) return;
      const base = el.getBoundingClientRect().top;
      const blocks = Array.from(el.children) as HTMLElement[];
      let current = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].getBoundingClientRect().top - base <= 8) current = i;
        else break;
      }
      setDocBlock(prev => (prev === current ? prev : current));
    });
  };

  /** 目录 / 待办跳转：滚到对应标题。目标不存在就当没点，不动视图 */
  const goToDocAnchor = (href: string) => {
    const el = txtRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[id="${href.replace(/^#/, '')}"]`);
    if (!target) return;
    pushHistory();
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
    setPanel(null);
  };

  /**
   * 正文挂上 DOM 之后再定位。
   * 顺序不能反：渲染前容器里还没有那些标题和块，怎么算都落不到地方。
   */
  useEffect(() => {
    if (!isDoc || !docHtml) return;
    const el = txtRef.current;
    if (!el) return;
    // 优先级与别的格式一致：指定位置 > 指定锚点 > 上次阅读位置 > 从头开始
    if (initialPosition && isDocPos(initialPosition)) {
      const block = Number(initialPosition.split(':')[1]);
      if (!Number.isNaN(block)) {
        scrollToDocBlock(block);
        return;
      }
    }
    if (initialTarget?.href) {
      const target = el.querySelector<HTMLElement>(`[id="${initialTarget.href.replace(/^#/, '')}"]`);
      if (target) {
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
        return;
      }
    }
    if (savedPosRef.current?.docBlock != null) scrollToDocBlock(savedPosRef.current.docBlock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docHtml, book.id]);

  /**
   * 正文 HTML → 带批注 / 检索标记的显示内容。
   *
   * 不能像 TXT 那样按纯文本下标切字符串：文档型格式 正文本身就是 HTML，下标一旦跨过
   * 标签边界就会把标签切碎。所以先解析成 DOM，按顶层块收集文本节点，再用与划词时
   * 同一套规则（文本节点顺序拼接后的偏移）落标记，最后整段取回 innerHTML——
   * 算出来的和标上去的因此天然一致，也不会有上一轮的标记残留。
   */
  const docDisplayHtml = useMemo(() => {
    if (!isDoc || !docHtml) return '';
    const markable = !hideMarks && bookmarks.some(b => isDocPos(b.position));
    if (!markable && !searchMark) return docHtml;

    // 用 DOMParser 而不是 document.createElement：解析出来的文档没有浏览上下文，
    // 里面的图片不会真的去加载，免得为了套标记把整篇的图都再取一遍
    const doc = new DOMParser().parseFromString('<div id="doc-hold"></div>', 'text/html');
    const root = doc.getElementById('doc-hold') as HTMLElement | null;
    if (!root) return docHtml;
    root.innerHTML = docHtml;

    const byBlock = new Map<number, DocRange[]>();
    const add = (bi: number, r: DocRange) => {
      const list = byBlock.get(bi);
      if (list) list.push(r);
      else byBlock.set(bi, [r]);
    };

    if (markable) {
      for (const b of bookmarks) {
        const parts = b.position.split(':');
        if (!isDocPos(b.position)) continue;
        const bi = Number(parts[1]);
        const s = Number(parts[2]);
        const e = Number(parts[3]);
        if (!Number.isInteger(bi) || Number.isNaN(s) || Number.isNaN(e) || s >= e) continue;
        const color = highlightColorOf(b.color || 'yellow');
        const style = b.style === 'underline'
          ? `border-bottom:2px solid ${color.solid}; background:transparent`
          : `background:${color.css}`;
        add(bi, { s, e, style, id: b.id });
      }
    }

    const blocks = Array.from(root.children) as HTMLElement[];
    if (searchMark) {
      const base = buildKeywordRegex(searchMark, {
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
      });
      // 另起一个带 g 的实例：复用同一个正则，exec 的 lastIndex 会跨块串味
      const re = new RegExp(base.source, base.flags + 'g');
      blocks.forEach((block, bi) => {
        const text = block.textContent || '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          // 空匹配会让 lastIndex 原地打转，直接跳出
          if (m[0].length === 0) break;
          const s = m.index;
          const e = s + m[0].length;
          // 与书签重叠的跳过：书签是用户标的，检索标记只是临时提示
          const taken = (byBlock.get(bi) ?? []).some(r => s < r.e && e > r.s);
          if (!taken) add(bi, { s, e, cls: 'search-mark' });
          re.lastIndex = e;
        }
      });
    }

    for (const [bi, ranges] of byBlock) {
      const block = blocks[bi];
      if (block) wrapDocRanges(doc, block, ranges);
    }
    return root.innerHTML;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docHtml, isDoc, bookmarks, hideMarks, searchMark, searchCaseSensitive, searchWholeWord]);

  /**
   * 标记一变，容器里的 HTML 整块换掉，滚动位置有可能被打回顶部。
   * 重绘后把视口重新对齐回原来读的那一块：没被打回时这一步等于原地不动，不碍事。
   */
  useLayoutEffect(() => {
    if (!isDoc || !docDisplayHtml) return;
    scrollToDocBlock(docBlock);
    // 只在标记重绘后对齐一次；docBlock 变了不代表 HTML 变了，列进来会与滚动回填互相打架
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docDisplayHtml]);

  /**
   * 文档型格式 划词：锚点记「第几个顶层块 + 块内文本偏移」。
   * 不用页码——文档型格式 没有页；也不用绝对字符偏移——块才是重新打开时算得准的那个基准。
   */
  const handleDocMouseUp = () => {
    if (!isDoc) return;
    const container = txtRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed) return;
    if (!container.contains(selection.anchorNode)) return;
    const raw = selection.toString();
    const text = raw.trim();
    if (!text) return;

    // 顶层块是锚点的第一段。选区跨块时以起点所在块为准，与 TXT 滑动模式一致
    const anchorEl =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement ?? null;
    let node: Element | null = anchorEl;
    while (node && node.parentElement !== container) node = node.parentElement;
    if (!node) return;
    const block = node as HTMLElement;
    const blocks = Array.from(container.children) as HTMLElement[];
    const blockIdx = blocks.indexOf(block);
    if (blockIdx < 0) return;

    const range = selection.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(block);
    let start: number;
    try {
      pre.setEnd(range.startContainer, range.startOffset);
      start = pre.toString().length;
    } catch {
      // 起点不在这一块里（跨块拖选），没有可靠锚点
      return;
    }
    const end = Math.min(start + raw.length, (block.textContent || '').length);

    const rect = range.getBoundingClientRect();
    setSel({
      x: Math.min(rect.left, window.innerWidth - 240),
      y: rect.bottom + 8,
      text,
      position: `doc:${blockIdx}:${start}:${end}`,
    });
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
      const [tts, font, fontSize, lineHeight, theme, pos, autoOn, autoDayStart, autoNightStart, autoDay, autoNight, bookPrefsRaw, presetKey, forceFont, readonly, styleKey, customCss] = await Promise.all([
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
        api.getSetting('readingStylePreset'),
        api.getSetting('customReadingCss'),
      ]);
      forceFontRef.current = forceFont === 'true' || forceFont === '1';
      readonlyMarksRef.current = readonly === 'true' || readonly === '1';
      // 阅读样式：全局设置只当默认值，本书记过就按本书的来（下面 mergePrefs）
      const globalStyle = STYLE_PRESETS.some(p => p.key === styleKey) ? String(styleKey) : 'none';
      customCssRef.current = customCss ?? '';
      setCustomCssDraft(customCssRef.current);
      // 自定义键位叠在预设上：被抢走的键要真的让位，否则会出现「改了没生效」
      const preset = getPreset(presetKey ?? DEFAULT_SHORTCUT_PRESET);
      presetRef.current = {
        ...preset,
        map: buildKeyMap(preset, parseShortcutOverrides(await api.getSetting('shortcutCustom'))),
      };
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
        fontFamily: font && stackOfFontKey(font) ? font : DEFAULT_READER_PREFS.fontFamily,
        readingStyle: globalStyle,
      };
      const saved = parseBookPrefs(bookPrefsRaw);
      bookPrefsRef.current = saved;
      const merged = mergePrefs(base, saved);
      // 阅读样式：预设名不认识就回落「跟随主题」；自定义 CSS 非空时优先
      const styleName = STYLE_PRESETS.some(p => p.key === merged.readingStyle)
        ? merged.readingStyle
        : 'none';
      styleCssRef.current = resolveCustomCss(customCssRef.current, styleName);
      setStylePreset(styleName);
      // 自动护眼是用户显式开启的全局开关，优先于书籍专属主题
      if (autoCfg.enabled) merged.theme = resolveThemeByClock(new Date(), autoCfg);

      cfgRef.current = { theme: merged.theme, fontSize: merged.fontSize, lineHeight: merged.lineHeight };
      setSettings(cfgRef.current);
      fontKeyRef.current = merged.fontFamily;
      setFontKey(merged.fontFamily);
      initialDualRef.current = merged.dualColumn;
      setDualColumn(merged.dualColumn);
      // 版式默认按格式定：TXT 小说整章连排滚动才读得顺，被字数阈值切成好几页很割裂；
      // EPUB 保持分页——滚动版式下 epub.js 的 next()/prev() 不是翻页语义，翻页键会失灵。
      // 用户在本节里切过版式（saved.flowMode）就以他的选择为准，不再被默认值改回去。
      const flow: 'paginated' | 'scrolled' =
        saved.flowMode ?? (book.file_type === 'txt' ? 'scrolled' : 'paginated');
      initialFlowRef.current = flow;
      setFlowMode(flow);
      flowModeRef.current = flow;
      setPdfScale(merged.pdfScale);
      const typoNext = {
        bgColor: merged.bgColor,
        textColor: merged.textColor,
        pagePadding: merged.pagePadding,
        paraSpacing: merged.paraSpacing,
        pageGap: merged.pageGap,
        letterSpacing: merged.letterSpacing,
        textIndent: merged.textIndent,
      };
      typoRef.current = typoNext;
      setTypo(typoNext);
      setComicSpread(merged.comicSpread);
      setComicRtl(merged.comicRtl);
      comicRtlRef.current = merged.comicRtl;
      setVertical(merged.vertical);
      verticalRef.current = merged.vertical;
      setHideMarks(merged.hideMarks);
      hideMarksRef.current = merged.hideMarks;
      setPageAnim(merged.pageAnimation);
      pageAnimRef.current = merged.pageAnimation;
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
    setComicPages([]);
    setComicPageData(null);
    setSel(null);
    setNoteDraft(null);
    setHits([]);
    setDocHtml('');
    setDocToc([]);
    setDocBlock(0);
    try {
      const api = window.electronAPI;
      if (!api) throw new Error('系统接口未就绪，请重启应用');

      if (isComicFile(book.file_type)) {
        // 漫画按页取用，不把整个压缩包读进渲染进程
        await loadComic();
      } else if (isDoc) {
        // 文档型格式（Markdown / DOCX）由主进程整篇渲染好再送过来：语法、公式、
        // 代码高亮、图片这一整套处理只有一份实现，在渲染进程重写一遍必然慢慢走样
        const doc = await api.getDocHtml(book.id);
        setDocHtml(doc.html);
        setDocToc(doc.toc);
      } else {
        const base64 = await api.getBookFileData(book.id);
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

        if (book.file_type === 'epub') {
          await loadEpub(bytes.buffer as ArrayBuffer);
        } else if (book.file_type === 'txt') {
          // 目录要先于分页取回来：分页要靠章节标题做「章界另起」
          const toc = ((await api.getBookToc(book.id)) as TocEntry[]) || [];
          setTxtToc(toc);
          chapterLabelsRef.current = new Set(toc.map(t => t.label.trim()).filter(Boolean));
          loadTxt(bytes);
        } else if (book.file_type === 'pdf') {
          // PDF 的 outline 目录主进程侧就能解析，里面带页码；原始版式下也把目录给出来，
          // 不能只在「重排」之后才有——那边用的是重排后的屏号，是另一套坐标系
          const toc = ((await api.getBookToc(book.id)) as TocEntry[]) || [];
          setPdfToc(toc.filter(t => t.page != null));
          await loadPdf(bytes);
        } else {
          throw new Error(`不支持的文件格式：${book.file_type}`);
        }
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
      // 双栏偏好要在这里就应用：只恢复 state 的话按钮显示为已开启，
      // 排版却还是单栏，用户得点两次才生效
      spread: initialDualRef.current ? 'always' : 'none',
      flow: initialFlowRef.current,
    });

    renditionRef.current = rendition;
    applyTheme(rendition);

    // 书内超链接：脚注、交叉引用、章末跳转在 EPUB 里很常见，
    // 默认点击无反应，这里接管并区分「书内跳转」与「外部链接」
    rendition.hooks.content.register((contents: any) => {
      const doc: Document = contents.document;
      // 每章渲染时注入一次，翻页与跳章都自动带上
      applyReadingStyleTo(contents, styleCssRef.current);
      doc.addEventListener('click', (e: MouseEvent) => {
        // Markdown 的 [[目标]]：跳到同一书库里的另一篇笔记，不是外链也不是章节锚点
        const wikilink = (e.target as HTMLElement)?.closest?.('.wikilink') as HTMLElement | null;
        if (wikilink) {
          e.preventDefault();
          void openWikilink(wikilink.getAttribute('data-target') || '');
          return;
        }

        const anchor = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.getAttribute('href') || '';
        if (!href) return;

        // 纯锚点：章内定位，交给浏览器默认行为
        if (href.startsWith('#')) return;

        if (/^https?:/i.test(href)) {
          e.preventDefault();
          window.electronAPI?.openExternal(anchor.href).catch(() => {});
          return;
        }

        // 书内相对链接：相对当前章节所在目录解析。
        // 锚点必须保留——epubjs 的 spine.get 会自行剥掉 #fragment 找章节，
        // 而 contents.locationOf 正是靠 fragment 做 getElementById 定位脚注，
        // 早先在这里 split('#') 会把脚注全部退化成「跳到该章开头」。
        e.preventDefault();
        const base = (contents.section?.href as string) || '';
        const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
        const target = href.startsWith('/') ? href.slice(1) : dir + href;
        try {
          rendition.display(target);
        } catch { /* 目标不存在则忽略 */ }
      });
    });
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
            // 必须把缓存一并喂回 epubjs：cfiFromPercentage 读的是它内部 Locations 的
            // _locations 与 total，只填自己的 ref 的话那个索引是空的，百分比跳转与末页
            // 跳转会拿到 -1 并静默失败（重开一本书就复现）。load() 会连 total 一起设好。
            epubBook.locations.load(cached);
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
            rendition.annotations.highlight(
              b.position,
              { markId: b.id },
              undefined,
              undefined,
              epubAnnotationStyles(color, b.style),
            );
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
      // 分页模式下每次换页放一次动效；滚动模式下 relocated 会随滚动频繁触发，放了反而晃眼
      if (flowModeRef.current === 'paginated') playFlipFx();
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
   * 否则按目录/断点定位。切页规则见 paginateText：字数到顶、或遇上章节标题。
   */
  const paginateTxt = (text: string, keepPage: number | null = null) => {
    // 目录可能晚于首次分页到达，所以标题集合走 ref，并在这里兜底再取一次
    const labels = chapterLabelsRef.current.size > 0 ? chapterLabelsRef.current : txtToc.map(t => t.label);
    const { pages, startLines: pageStartLines } = paginateText(text, labels);
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

  /** TXT 解码：auto 走严格 UTF-8 探测（失败回退 GBK），指定编码则强制按该编码解。
   *  注：fatal 只对 UTF-8 是真严格，GBK/Big5 等遇到非法字节只会静默替换成 U+FFFD，
   *  所以「自动识别」只能靠 UTF-8 fatal 探测，不能反过来对 GBK 探测。 */
  const decodeTxt = (bytes: Uint8Array, encoding: string): string => {
    if (encoding !== 'auto') return new TextDecoder(encoding).decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('gbk').decode(bytes);
    }
  };

  const loadTxt = (bytes: Uint8Array, encoding = txtEncoding, keepPage: number | null = null) => {
    txtBytesRef.current = bytes;
    const text = decodeTxt(bytes, encoding);
    txtRawRef.current = text;
    paginateTxt(normalizeOn ? normalizeText(text) : text, keepPage);
  };

  /** 切换文本规整：只换渲染源，不动原文、不写磁盘，可随时还原 */
  const toggleNormalize = () => {
    const next = !normalizeOn;
    setNormalizeOn(next);
    const raw = txtRawRef.current;
    if (!raw) return;
    paginateTxt(next ? normalizeText(raw) : raw, pageIndex);
  };

  /** 手动指定 TXT 编码：只重解码重分页，不动原文件、不写磁盘，页码尽量保住 */
  const changeTxtEncoding = (encoding: string) => {
    setTxtEncoding(encoding);
    const bytes = txtBytesRef.current;
    if (!bytes) return;
    loadTxt(bytes, encoding, pageIndex);
    // 换编码后页码数值可能不变（keepPage 保持原值），React 会跳过相同 state 的 effect，
    // 进度不主动落册就要等用户翻页才刷新（书架百分比停在旧值），这里主动存一次
    scheduleSavePos({ page: pageIndex });
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
    setTextPrompt({
      title: '添加章节',
      hint: '把当前页的开头登记为一章；目录会转为手动编辑，不再被自动解析覆盖',
      value: firstLine.slice(0, 30),
      confirmLabel: '添加',
      onConfirm: async label => {
        const name = label.trim();
        if (!name) {
          showToast('章节名不能为空，未添加');
          return;
        }
        const next = [...txtToc, { label: name, href: '', page: pageIndex, line }].sort(
          (a, b) => (a.line ?? 0) - (b.line ?? 0),
        );
        setTxtToc(next);
        chapterLabelsRef.current = new Set(next.map(t => t.label.trim()).filter(Boolean));
        try {
          await window.electronAPI?.saveToc(book.id, next);
          showToast(`已添加章节「${name}」`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : '章节保存失败，请重试');
        }
      },
    });
  };

  /** 漫画：取页面清单并恢复上次页码，图片由下方 effect 按需拉取 */
  const loadComic = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const pages = await api.getComicPages(book.id);
    const total = pages.length || 1;
    const savedPage = savedPosRef.current?.page;
    // 目录跳转页码从 0 起，保存的页码同样从 0 起，clampPage 入参为 1 起
    const startPage =
      initialTarget?.page != null
        ? clampPage(initialTarget.page + 1, total) - 1
        : savedPage != null
          ? clampPage(savedPage + 1, total) - 1
          : 0;
    setComicPages(pages);
    setTotalPages(total);
    setPageIndex(startPage);
  };

  /** 重排视图的目录：直接取层级识别出的标题块，带上所在页与块序号以便跳转 */
  const reflowToc = useMemo(
    () =>
      reflowPages.flatMap((blocks, page) =>
        blocks
          .map((block, index) => ({ block, index }))
          .filter(({ block }) => block.kind === 'heading')
          .map(({ block, index }) => ({ level: block.level, text: block.text, page, index })),
      ),
    [reflowPages],
  );

  /** 跨页跳转要等重排页渲染完再滚动，先把块序号挂起来 */
  const pendingReflowIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const index = pendingReflowIndexRef.current;
    if (index == null) return;
    pendingReflowIndexRef.current = null;
    document
      .querySelector(`[data-reflow-block="${reflowPage}-${index}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [reflowPage, reflowPages]);

  /** 跳转到重排视图里的某个标题块 */
  const jumpToReflowBlock = (page: number, index: number) => {
    setPanel(null);
    if (page === reflowPage) {
      // 同一页内跳转不会触发上面的 effect，直接滚
      document
        .querySelector(`[data-reflow-block="${page}-${index}"]`)
        ?.scrollIntoView({ block: 'start' });
      return;
    }
    pendingReflowIndexRef.current = index;
    setReflowPage(page);
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
      // 文档型格式 没有页可分，位置就是「第几个顶层块」。标签取最近的那个标题，
      // 比「第 37 段」有用得多——一眼就知道读到哪一节了
      if (isDoc) {
        const blocks = docBlocksOf();
        const total = blocks.length || 1;
        const headings = Array.from(
          txtRef.current?.querySelectorAll<HTMLElement>('[id^="dh-"]') ?? [],
        );
        let label = '';
        for (const h of headings) {
          const idx = blocks.indexOf(h);
          if (idx < 0) continue; // 嵌在引用块里的标题，不属于顶层块序列
          if (idx > docBlock) break;
          label = (h.textContent || '').trim();
        }
        return {
          position: serializeSavedPosition({ docBlock }),
          label: (label || `第 ${docBlock + 1} 段`).slice(0, 60),
          progress: total > 1 ? docBlock / total : 0,
        };
      }
      // PDF 重排后眼前的「屏」与原始页序没有换算关系：两套坐标都带上，
      // 切回原始版式时用 page，留在重排里就用 reflow
      if (inPdfReflow) {
        return {
          position: serializeSavedPosition({ page: pageIndex, reflow: reflowPage }),
          label: `第 ${reflowPage + 1}/${reflowPages.length} 屏`,
          progress: reflowPages.length > 0 ? reflowPage / reflowPages.length : 0,
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

  /** 每次渲染同步最新位置给退出时的断点（声明见上方 ref 区） */
  useEffect(() => {
    exitPosRef.current = describeCurrentPos();
  });

  const handleMarkPosition = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const d = describeCurrentPos();
    if (!d) return;
    await api.addReadingPosition({ book_id: book.id, ...d, source: 'manual' });
    await refreshPositions();
  };

  const handleDeletePosition = async (id: number) => {
    if (!confirm('删除这个阅读位置？删除后无法恢复。')) return;
    try {
      await window.electronAPI?.deleteReadingPosition(id);
      await refreshPositions();
      showToast('已删除该阅读位置');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败，请重试');
    }
  };

  const handleJumpPosition = (p: ReadingPosition) => {
    const pos = parseSavedPosition(p.position);
    if (!pos) {
      alert('这个位置已失效（书籍可能重新解析过）。建议从目录重新定位。');
      return;
    }
    pushHistory();
    if (book.file_type === 'epub' && pos.cfi) {
      // 失效的 CFI 会让 display 抛错：接住它，别变成一次无声的空跳
      void renditionRef.current?.display(pos.cfi)?.catch?.(() => {
        showToast('这个位置已失效，建议从目录重新定位');
      });
    } else if (isDoc && pos.docBlock != null) {
      // 文档型格式 没有页，断点记的是块序号
      scrollToDocBlock(pos.docBlock);
    } else if (inPdfReflow && pos.reflow != null) {
      // 人正留在重排模式里：屏序与原始页序不换算，要用当初记下的屏号
      setReflowPage(Math.min(pos.reflow, reflowPages.length - 1));
    } else if (pos.page != null) {
      // 规整、重新解析都会让页数变少，按当时的页码直接跳会落到不存在的空白页
      setPageIndex(totalPages > 0 ? clampPage(pos.page + 1, totalPages) - 1 : pos.page);
    }
    setPanel(null);
  };

  const sortMarks = <T extends { position: string }>(list: T[]): T[] =>
    markSort === 'time' ? list : [...list].sort(compareByPosition);

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

  /**
   * 拖拽移动视图（PDF 原始版式、漫画这类「整页一张图」的内容）。
   *
   * 为什么不给文字类格式也开：那几类里按住拖动**就是划词选中**，划词菜单、高亮、
   * 笔记全建立在它上面，把按下事件抢过来等于把它们一起废掉。而拖拽平移在概念上
   * 本来就只属于固定版式——流式排版的正文是纵向流动的，滚动条已经把它表达完了。
   *
   * 用 Pointer Events + setPointerCapture：指针划出容器、划出窗口都不会丢事件，
   * 松手时能确定地收尾；若退回用挂在 window 上的 mousemove，这些边界都得自己兜。
   */
  const panRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [panActive, setPanActive] = useState(false);
  /**
   * 容器此刻是否真的有可滚动的量。没有就不给 grab 光标——「整页装得下」的 PDF
   * 悬停时若显示一只抓手，等于承诺了一个拖不动的手势。
   * 只在指针移入时判定一次，不挂 ResizeObserver：能改变滚动量的操作（缩放、翻页、
   * 切窗口大小）都要先把鼠标移出容器去点按钮或拖边框，回来时判定的就是最新结果，
   * 为此常驻两个观察者不划算。
   */
  const [panReady, setPanReady] = useState(false);

  const hasPanRoom = (el: HTMLElement) =>
    el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;

  const handlePanDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 只认左键：右键要留给上下文菜单，中键留给系统自动滚动
    if (e.button !== 0) return;
    const el = e.currentTarget;
    // 没得滚就不接管，免得把指针捕获过去却什么都动不了
    if (!hasPanRoom(el)) return;
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    setPanActive(true);
  };

  const handlePanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    // 往右拖内容就跟着往右走，所以滚动量是起始值减去位移
    e.currentTarget.scrollLeft = p.left - (e.clientX - p.x);
    e.currentTarget.scrollTop = p.top - (e.clientY - p.y);
  };

  const handlePanUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    panRef.current = null;
    setPanActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handlePanEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    setPanReady(hasPanRoom(e.currentTarget));
  };

  const handlePanLeave = () => setPanReady(false);

  const panHandlers = {
    onPointerDown: handlePanDown,
    onPointerMove: handlePanMove,
    onPointerUp: handlePanUp,
    onPointerCancel: handlePanUp,
    onPointerEnter: handlePanEnter,
    onPointerLeave: handlePanLeave,
  };

  /** 只有一套视图会挂载，panActive 是全局的也不会串到别的容器上 */
  const panClass = (base = '') =>
    [base, panReady ? 'pan-surface' : '', panActive ? 'pan-active' : ''].filter(Boolean).join(' ');

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

  /**
   * EPUB 注解样式：下划线用描边，高亮用填充。
   * 隐藏批注时改为全透明并关掉指针事件——不关事件的话，看不见的矩形会挡住划词。
   */
  const epubAnnotationStyles = (color: { epubFill: string }, style?: string) =>
    hideMarksRef.current
      ? {
          fill: 'transparent',
          'fill-opacity': '0',
          stroke: 'transparent',
          'stroke-width': '0px',
          'pointer-events': 'none',
        }
      : style === 'underline'
        ? { stroke: color.epubFill, 'stroke-width': '3px', fill: 'transparent', 'fill-opacity': '0' }
        : { fill: color.epubFill, 'fill-opacity': '0.35' };

  /**
   * 重画 EPUB 注解。注解的样式只在 highlight() 那一刻写进 SVG，
   * 所以显隐开关必须重挂一遍才能生效。
   */
  const resyncEpubMarks = () => {
    const rendition = renditionRef.current;
    if (book.file_type !== 'epub' || !rendition) return;
    for (const b of bookmarks) {
      try {
        rendition.annotations.remove(b.position, 'highlight');
      } catch { /* CFI 失效则跳过 */ }
      try {
        rendition.annotations.highlight(
          b.position,
          { markId: b.id },
          undefined,
          undefined,
          epubAnnotationStyles(highlightColorOf(b.color || 'yellow'), b.style),
        );
      } catch { /* CFI 失效则跳过 */ }
    }
  };

  /** 显隐批注：TXT 靠状态重渲染，EPUB 要手动重画注解 */
  const toggleHideMarks = () => {
    const next = !hideMarks;
    setHideMarks(next);
    hideMarksRef.current = next;
    queueSaveBookPrefs({ hideMarks: next });
    resyncEpubMarks();
  };

  /** 当前页的位图源：PDF 用已渲染的画布，漫画用当前页的图片数据解码 */
  const currentPageImage = async (): Promise<HTMLCanvasElement | HTMLImageElement> => {
    if (book.file_type === 'pdf') {
      const canvas = canvasRef.current;
      if (!canvas || !pdfReady) throw new Error('当前页尚未渲染完成');
      return canvas;
    }
    if (!comicPageData) throw new Error('当前页尚未加载');
    const img = new Image();
    img.src = `data:${comicPageData.mime};base64,${comicPageData.data}`;
    await img.decode();
    return img;
  };

  /**
   * 本地 OCR：识别当前页文字。
   * 模型约 16MB，首次点击才从主进程取并常驻；全部在本机运算，不联网。
   */
  const runOcr = async () => {
    if (ocrBusy) return;
    setOcrBusy(true);
    setOcrError('');
    try {
      const { initOcrFromMain, recognizeImage } = await import('../utils/ocr/engine');
      await initOcrFromMain();
      const source = await currentPageImage();
      const lines = await recognizeImage(source);
      setOcrLines(lines.map(l => ({ text: l.text, score: l.score })));
      setOcrPage(pageIndex + 1);
      if (lines.length === 0) setOcrError('这一页没有识别到文字');
    } catch (err) {
      setOcrLines([]);
      setOcrError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setOcrBusy(false);
    }
  };

  /** 识别结果整体复制，便于贴到笔记里 */
  const copyOcrText = async () => {
    const text = ocrLines.map(l => l.text).join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制识别结果');
    } catch {
      showToast('复制失败');
    }
  };

  const handleHighlight = async (colorKey: string = 'yellow', style: 'highlight' | 'underline' = 'highlight') => {
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
      style,
    });
    if (book.file_type === 'epub' && renditionRef.current) {
      renditionRef.current.annotations.highlight(
        sel.position,
        { markId },
        undefined,
        undefined,
        epubAnnotationStyles(color, style),
      );
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
    setTextPrompt({
      title: '修改书签名称',
      hint: '只改书签标签，不影响正文内容',
      value: b.text || '',
      confirmLabel: '保存',
      onConfirm: async next => {
        const name = next.trim();
        if (!name || name === (b.text || '')) return;
        try {
          await api.updateBookmark(b.id, name);
          await refreshMarks();
          showToast('书签名称已更新');
        } catch (err) {
          showToast(err instanceof Error ? err.message : '修改失败，请重试');
        }
      },
    });
  };

  const handleDeleteBookmark = async (b: Bookmark) => {
    if (blockedByReadonly('删除书签')) return;
    const api = window.electronAPI;
    if (!api) return;
    // 删除不可恢复，统一在这里确认，调用方不必各自再问一遍
    if (!confirm(`删除书签「${b.text || '未命名'}」？删除后无法恢复。`)) return;
    try {
      if (book.file_type === 'epub' && renditionRef.current) {
        try { renditionRef.current.annotations.remove(b.position, 'highlight'); } catch { /* 忽略 */ }
      }
      await api.deleteBookmark(b.id);
      await refreshMarks();
      showToast('已删除该书签');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败，请重试');
    }
  };

  const handleDeleteNote = async (id: number) => {
    if (blockedByReadonly('删除笔记')) return;
    const api = window.electronAPI;
    if (!api) return;
    if (!confirm('删除这条笔记？笔记正文与高亮标记一并删除，无法恢复。')) return;
    try {
      await api.deleteNote(id);
      await refreshMarks();
      showToast('已删除该笔记');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败，请重试');
    }
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
    } else if (isDocPos(position)) {
      // 文档型格式的批注锚点是块序号
      const block = Number(position.split(':')[1]);
      if (!Number.isNaN(block)) scrollToDocBlock(block);
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

    // 滑动模式下容器里连排了好几页，偏移必须相对「选区所在的那一块」来算，页号也取该块的
    // data-page；否则前面几块的字数会被算进来，标注锚点整体前移、落在别的页上。
    // 分页模式没有分块，基准就退回容器本身。
    let base: Node = container;
    let markedPage = pageIndex;
    const anchorEl =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement ?? null;
    const block = anchorEl?.closest<HTMLElement>('.txt-flow-page') ?? null;
    if (block) {
      base = block;
      const p = Number(block.dataset.page);
      if (!Number.isNaN(p)) markedPage = p;
    }

    const pre = range.cloneRange();
    pre.selectNodeContents(base);
    let start: number;
    try {
      pre.setEnd(range.startContainer, range.startOffset);
      start = pre.toString().length;
    } catch {
      // 跨块拖选时起点不在基准块内，setEnd 会抛错；这种选区没有可靠的单页锚点，放弃
      return;
    }
    const rect = range.getBoundingClientRect();
    setSel({
      x: Math.min(rect.left, window.innerWidth - 240),
      y: rect.bottom + 8,
      text,
      position: `txt:${markedPage}:${start}:${start + selection.toString().length}`,
    });
  };

  /** TXT 当前页渲染：书签高亮（含颜色）+ 检索词高亮合并 */
  /**
   * 把某一页正文渲染成「已注入批注 / 检索标记」的 HTML。
   * 该页没有任何标记时返回 null，调用方直接走纯文本节点这条更快路径。
   * 参数化页码是为了滑动模式：那里要一次连排渲染好几页，各页的批注偏移都按自己的页号算。
   */
  const renderTxtPageHtml = (pageIdx: number): string | null => {
    const text = txtPages[pageIdx] || '';
    interface TxtRange { s: number; e: number; cls: string; style?: string; id?: number }
    const ranges: TxtRange[] = [];
    // 书签优先（隐藏批注时整段跳过）
    for (const b of hideMarks ? [] : bookmarks) {
      if (!b.position.startsWith(`txt:${pageIdx}:`)) continue;
      const parts = b.position.split(':');
      const s = Number(parts[2]);
      const e = Number(parts[3]);
      if (Number.isNaN(s) || Number.isNaN(e) || s >= e || s >= text.length) continue;
      const color = highlightColorOf(b.color || 'yellow');
      const style = b.style === 'underline'
        ? `border-bottom:2px solid ${color.solid}; background:transparent`
        : `background:${color.css}`;
      ranges.push({ s, e: Math.min(e, text.length), cls: '', style, id: b.id });
    }
    // 检索词（跳过与书签重叠的部分）：与检索用同一套匹配规则
    if (searchMark) {
      const base = buildKeywordRegex(searchMark, {
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
      });
      // 另起一个带 g 的实例：复用同一个正则，exec 的 lastIndex 会跨节点串味
      const re = new RegExp(base.source, base.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // 空匹配会让 lastIndex 原地打转，直接跳出
        if (m[0].length === 0) break;
        const s = m.index;
        const e = s + m[0].length;
        const overlap = ranges.some(r => s < r.e && e > r.s);
        if (!overlap) ranges.push({ s, e, cls: 'search-mark' });
        re.lastIndex = e;
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

  // ---------- TXT 滑动（连排滚动）----------
  // 这段必须在 advancePage 之前：翻页键在滑动模式下要靠窗口范围判断滚一屏还是翻页。

  /**
   * 滑动模式（连续滚动）是否生效：小说一章常被字数阈值切成好几页，连排才读得顺。
   * 竖排（古籍右起）时滚动轴是横向的，与这里的纵向连排对不上，退回分页。
   */
  const txtFlowOn =
    book.file_type === 'txt' && flowMode === 'scrolled' && txtPages.length > 0 && !vertical;

  /**
   * 连排窗口的起点页。
   *
   * 有目录取当前页所在章的章首，没目录按固定页数分块；章过长时再在章内按页数分块。
   * 三种都刻意只依赖「块起点」这一个稳定值：同一窗口内滚动时它不变，
   * 下面的 range 与内容 memo 就不重算，滚动才不会一顿一顿。
   */
  const txtFlowStart = useMemo(() => {
    if (!txtFlowOn) return -1;
    const last = txtPages.length - 1;
    const starts = txtPageStartRef.current;
    if (txtToc.length > 0 && starts.length === txtPages.length) {
      let chapStart = 0;
      let chapEnd = last;
      for (const t of txtToc) {
        if (t.line == null) continue;
        const p = lineToPageIndex(starts, t.line);
        if (p <= pageIndex) chapStart = p;
        else break;
      }
      for (const t of txtToc) {
        if (t.line == null) continue;
        const p = lineToPageIndex(starts, t.line);
        if (p > chapStart) { chapEnd = p - 1; break; }
      }
      if (chapEnd - chapStart + 1 > TXT_FLOW_LIMIT) {
        chapStart += Math.floor((pageIndex - chapStart) / TXT_FLOW_LIMIT) * TXT_FLOW_LIMIT;
      }
      return chapStart;
    }
    return Math.floor(pageIndex / TXT_FLOW_WINDOW) * TXT_FLOW_WINDOW;
  }, [txtFlowOn, pageIndex, txtPages, txtToc]);

  /** 连排窗口 [起点, 终点]（闭区间）；分页模式为 null */
  const txtFlowRange = useMemo<[number, number] | null>(() => {
    if (txtFlowStart < 0) return null;
    const last = txtPages.length - 1;
    const starts = txtPageStartRef.current;
    let end = Math.min(last, txtFlowStart + TXT_FLOW_WINDOW - 1);
    if (txtToc.length > 0 && starts.length === txtPages.length) {
      end = last;
      for (const t of txtToc) {
        if (t.line == null) continue;
        const p = lineToPageIndex(starts, t.line);
        if (p > txtFlowStart) { end = p - 1; break; }
      }
    }
    end = Math.min(end, txtFlowStart + TXT_FLOW_LIMIT - 1, last);
    return [txtFlowStart, Math.max(end, txtFlowStart)];
  }, [txtFlowStart, txtPages, txtToc]);

  // ---------- TTS ----------

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) {
      showToast('本系统暂不支持语音朗读');
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

  /** 取当前页文本（AI 上下文用）：TXT 取本页，EPUB 取当前 CFI 范围，文档型格式 取眼前这一段 */
  const getCurrentPageText = async (): Promise<string> => {
    if (book.file_type === 'txt') {
      return txtPages[pageIndex] || '';
    }
    // 文档型格式 没有页，按「从当前块起一段」给，长度对齐一屏的量级
    if (isDoc) {
      return docTextFrom(docBlock, 2000);
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

  /** 顶栏朗读：TXT 读剩余全文，EPUB 读当前页，文档型格式 从眼前这块读到文末 */
  const handleHeaderSpeak = async () => {
    if (speaking) {
      stopSpeak();
      return;
    }
    if (book.file_type === 'txt') {
      speak(txtPages.slice(pageIndex).join('\n'));
    } else if (isDoc) {
      const text = docTextFrom(docBlock);
      if (text) speak(text);
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

  /**
   * 把阅读样式写进某个章节文档。
   * 自建 style 节点，没用 epub.js 的 addStylesheetCss——后者遇到空串会直接返回、
   * 不清掉旧样式，切回「跟随主题」时就擦不掉了。
   */
  const applyReadingStyleTo = (contents: any, css: string) => {
    const doc: Document | undefined = contents?.document;
    if (!doc?.head) return;
    let el = doc.getElementById(STYLE_NODE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = doc.createElement('style');
      el.id = STYLE_NODE_ID;
    }
    el.textContent = css;
    // 清掉历史遗留的同前缀节点：早期版本用 `预设名-章节` 这种带后缀的 id，
    // 同一个 epub.js key 下多个样式表叠加时，后插入的未必读得到先前那些，
    // 结果就是切样式擦不干净的「幽灵样式」。
    for (const stale of Array.from(doc.querySelectorAll(`[id^="${STYLE_NODE_ID}-"]`))) {
      if (stale !== el) stale.remove();
    }
    // 每次都挪到 head 末尾：主题与排版样式同样带 !important，只能靠 DOM 顺序压过它们
    doc.head.appendChild(el);
  };

  /** 把当前样式刷到已经渲染出来的章节上（切预设、改自定义 CSS 都走它） */
  const applyReadingStyleNow = (css: string) => {
    styleCssRef.current = css;
    const contents = renditionRef.current?.getContents?.();
    const list: any[] = Array.isArray(contents) ? contents : contents ? [contents] : [];
    for (const c of list) applyReadingStyleTo(c, css);
  };

  /** 切换阅读样式预设：立即作用于已渲染的章节，并按书记住 */
  const changeReadingStyle = (key: string) => {
    setStylePreset(key);
    applyReadingStyleNow(resolveCustomCss(customCssRef.current, key));
    queueSaveBookPrefs({ readingStyle: key });
  };

  /** 应用自定义 CSS：校验不通过就原样退回，不静默吞掉 */
  const saveCustomCss = () => {
    const check = validateCustomCss(customCssDraft);
    if (!check.ok) {
      showToast(check.reason ?? '自定义样式不可用');
      return;
    }
    const css = customCssDraft.trim();
    customCssRef.current = css;
    applyReadingStyleNow(resolveCustomCss(css, stylePreset));
    window.electronAPI?.setSetting('customReadingCss', css).catch(() => {});
    showToast(css ? '自定义样式已应用' : '已停用自定义样式');
  };

  /** 清空自定义 CSS，回到当前预设 */
  const clearCustomCss = () => {
    setCustomCssDraft('');
    customCssRef.current = '';
    applyReadingStyleNow(resolveCustomCss('', stylePreset));
    window.electronAPI?.setSetting('customReadingCss', '').catch(() => {});
    showToast('已停用自定义样式');
  };

  const applyTheme = (rendition: any) => {
    const themes: Record<string, { bg: string; fg: string }> = {
      dark: { bg: '#1a1a2e', fg: '#eaeaea' },
      light: { bg: '#ffffff', fg: '#333333' },
      sepia: { bg: '#f4ecd8', fg: '#5b4636' },
    };
    const { theme, fontSize, lineHeight } = cfgRef.current;
    const stack = stackOfFontKey(fontKeyRef.current);
    const force = forceFontRef.current;
    const t = typoRef.current;
    // 自定义颜色优先于主题预设；留空则跟随主题
    const bg = t.bgColor || themes[theme].bg;
    const fg = t.textColor || themes[theme].fg;
    // 一次备齐再交给 epub.js。它内部是 registerRules('default', …) 后 update()，
    // 而 update() 拿到的是同一个 StyleSheet 对象：先插入的规则会让后面的插入下标失效，
    // 于是同一个键下的旧值既没被覆盖也没被删掉，改完字号旧规则还在、值不生效。
    // 合并成一次调用就是整表替换，天然没有残留。
    const rules: Record<string, any> = {
      'body':
        ` background: ${bg} !important; color: ${fg} !important;` +
        ` line-height: ${lineHeight} !important;` +
        (t.letterSpacing > 0 ? ` letter-spacing: ${t.letterSpacing}em !important;` : '') +
        (verticalRef.current ? ' writing-mode: vertical-rl;' : '') +
        (stack ? ` font-family: ${stack}${force ? ' !important' : ''};` : ''),
      'p, div, span': { 'font-size': `${fontSize}px !important` },
    };
    // 段落间距与首行缩进合并进同一条 p 规则：rules 是整表替换，分开写会让后者覆盖前者
    if (t.paraSpacing > 0 || t.textIndent > 0) {
      const pRule: Record<string, string> = {};
      if (t.paraSpacing > 0) pRule['margin-bottom'] = `${t.paraSpacing}em !important`;
      if (t.textIndent > 0) pRule['text-indent'] = `${t.textIndent}em !important`;
      rules['p'] = pRule;
    }
    // 强制统一：连元素级 font-family 一并压过，解决异体字/缺字乱码
    if (force && stack) {
      rules['*, *::before, *::after'] = { 'font-family': `${stack} !important` };
    }
    rendition.themes.default(rules);
  };

  const toggleFlow = () => {
    const next = flowMode === 'paginated' ? 'scrolled' : 'paginated';
    setFlowMode(next);
    flowModeRef.current = next;
    renditionRef.current?.flow(next);
    // 竖排的滚动轴是横向的，连排滑动要的是纵向，两者互斥：开滚动就自动转回横排
    if (next === 'scrolled' && verticalRef.current) {
      setVertical(false);
      verticalRef.current = false;
      queueSaveBookPrefs({ vertical: false });
      if (renditionRef.current) applyTheme(renditionRef.current);
    }
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

  /**
   * 生成打印用 HTML：只含当前阅读内容，工具条在打印时隐藏。
   * 各格式取当前可见内容——TXT 当前页、EPUB 当前章节、漫画当前页图、PDF 当前页画布、
   * 文档型格式 此刻在屏幕上的那几块。
   */
  const buildPrintHtml = async (): Promise<string> => {
    let body = '';
    if (book.file_type === 'txt') {
      body = `<pre>${escapeHtml(txtPages[pageIndex] ?? '')}</pre>`;
    } else if (book.file_type === 'epub') {
      const href = locationRef.current.href;
      const text = href ? await loadChapterText(href) : '';
      body = text ? `<p>${escapeHtml(text)}</p>` : '<p>（未取到当前章节内容）</p>';
    } else if (isComicFile(book.file_type)) {
      body = comicPageData
        ? `<img src="data:${comicPageData.mime};base64,${comicPageData.data}" alt="">`
        : '<p>（当前页尚未加载）</p>';
    } else if (book.file_type === 'pdf') {
      const dataUrl = canvasRef.current?.toDataURL('image/png');
      body = dataUrl ? `<img src="${dataUrl}" alt="">` : '<p>（当前页尚未渲染）</p>';
    } else if (isDoc) {
      const el = txtRef.current;
      const blocks = docBlocksOf();
      if (el && blocks.length > 0) {
        const { top, bottom } = el.getBoundingClientRect();
        const shown = blocks.filter(b => {
          const r = b.getBoundingClientRect();
          return r.bottom > top && r.top < bottom;
        });
        const from = shown.length > 0 ? blocks.indexOf(shown[0]) : docBlock;
        const to = shown.length > 0 ? blocks.indexOf(shown[shown.length - 1]) + 1 : docBlock + 1;
        // 打印排版好的 HTML 而不是纯文本：标题、列表、代码块、表格本来就是
        // 文档型格式 的内容本身，退化成纯文本等于把这份文档拆了
        body = `<div class="doc-out">${blocks
          .slice(from, to)
          .map(b => b.outerHTML)
          .join('')}</div>`;
      }
      if (!body) body = '<p>（当前内容尚未加载）</p>';
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(book.title)}</title>
<style>
  body { font-family: "Noto Serif SC","Songti SC",serif; line-height: 1.8; margin: 0; padding: 24px; color: #222; }
  pre { white-space: pre-wrap; word-break: break-word; font: inherit; margin: 0; }
  img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  /* 文档型格式的正文块要按文档排版，这些规则只作用于 .doc-out，不影响别的格式 */
  .doc-out h1, .doc-out h2, .doc-out h3, .doc-out h4 { line-height: 1.4; margin: 18px 0 8px; }
  .doc-out p { margin: 0 0 12px; }
  .doc-out pre { background: #f5f5f5; padding: 8px 10px; border-radius: 4px; overflow: auto;
                font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em; }
  .doc-out code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em; }
  .doc-out blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
  .doc-out table { border-collapse: collapse; margin: 0 0 12px; }
  .doc-out th, .doc-out td { border: 1px solid #ccc; padding: 4px 8px; }
  .doc-out img { margin: 12px 0; }
</style></head><body>
${body}</body></html>`;
  };

  /** 打开预览窗口：把当前页内容单独拿出来看（也可在其中用系统快捷键打印） */
  const handlePrint = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      await api.printPreview(await buildPrintHtml(), book.title);
    } catch (err) {
      alert(`打开预览失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  /**
   * 应用内直接打印：与预览同源，但不先看预览，直接唤起系统打印对话框。
   * 用户主动取消不打扰；真正的失败（没有打印机、驱动报错）必须说清楚——
   * 「点了没反应」比「打印不了」更难排查。
   */
  const handlePrintNow = async () => {
    const api = window.electronAPI;
    if (!api?.printContent) return;
    try {
      const r = await api.printContent(await buildPrintHtml(), book.title);
      if (!r.ok && !r.cancelled) alert(`打印没能开始：${r.reason ?? '未知原因'}`);
    } catch (err) {
      alert(`打印失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  /**
   * 导出当前页为图片。
   * 用 Electron 截窗口可见区域，TXT / EPUB / PDF / 漫画一套逻辑走通——
   * 不用把正文转成 canvas，也就不必引 html2canvas 之类的依赖。
   * 截的是屏幕上看得见的部分：正文长到需要滚动时，超出视口的内容不会入镜。
   */
  const handleExportPageImage = async () => {
    const api = window.electronAPI;
    const el = viewerRef.current as HTMLElement | null;
    if (!api?.exportPageImage || !el) return;
    try {
      const box = el.getBoundingClientRect();
      const filePath = await api.exportPageImage(
        {
          x: Math.round(box.left),
          y: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        book.title,
      );
      if (filePath) showToast(`已导出到：${filePath}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出失败');
    }
  };

  /** 漫画双页合并开关 */
  const toggleComicSpread = () => {    const next = !comicSpread;
    setComicSpread(next);
    queueSaveBookPrefs({ comicSpread: next });
  };

  /** 漫画右向左翻页开关（日漫） */
  const toggleComicRtl = () => {    const next = !comicRtl;
    setComicRtl(next);
    comicRtlRef.current = next;
    queueSaveBookPrefs({ comicRtl: next });
  };

  /** 竖排阅读开关：改完要重刷版式，EPUB 走主题、TXT 走容器样式 */
  const toggleVertical = () => {
    const next = !vertical;
    setVertical(next);
    verticalRef.current = next;
    queueSaveBookPrefs({ vertical: next });
    // 竖排是横向滚动轴，与连排滑动对不上：开竖排就退回分页，别留个按了没反应的版式开关
    if (next && flowModeRef.current === 'scrolled') {
      setFlowMode('paginated');
      flowModeRef.current = 'paginated';
      queueSaveBookPrefs({ flowMode: 'paginated' });
    }
    if (renditionRef.current) applyTheme(renditionRef.current);
  };

  /** 循环切换主题（快捷键用） */
  const cycleTheme = () => {    const order: ThemeName[] = ['dark', 'light', 'sepia'];
    const idx = order.indexOf(cfgRef.current.theme as ThemeName);
    changeTheme(order[(idx + 1) % order.length]);
  };

  /** 改排版并即时生效（同时写回本书偏好） */
  const applyTypo = (patch: Partial<typeof typo>) => {
    const next = { ...typoRef.current, ...patch };
    typoRef.current = next;
    setTypo(next);
    queueSaveBookPrefs(patch);
    if (renditionRef.current) applyTheme(renditionRef.current);
  };

  /**
   * 翻页动效：内容换好后做一次快速淡入，让翻页不至于「硬切」。
   *
   * 用 Web Animations API 而不是 React 状态 + class：连点翻页时每次调用都会新建一份
   * 动画，不会互相打断；也不必为动画触发额外的重渲染。
   * 「减弱」档位把时长压到一半；系统若开了「减少动态效果」，平滑档也降级为减弱档。
   * 关闭档直接返回，不做任何事。
   */
  const playFlipFx = () => {
    const mode = pageAnimRef.current;
    if (mode === 'off') return;
    const el = viewerRef.current;
    if (!el || typeof el.animate !== 'function') return;
    const soft = mode === 'reduced' || prefersReducedMotionRef.current;
    try {
      el.animate(
        [
          { opacity: soft ? 0.6 : 0.3 },
          { opacity: 1 },
        ],
        { duration: soft ? 90 : 180, easing: 'ease-out' },
      );
    } catch {
      /* 动画不可用时静默跳过，翻页本身不受影响 */
    }
  };

  /** 切换翻页动画档位（按书记忆） */
  const changePageAnim = (key: PageAnimation) => {
    setPageAnim(key);
    pageAnimRef.current = key;
    queueSaveBookPrefs({ pageAnimation: key });
    // 立刻放一次，让人当场看到这档动画长什么样
    playFlipFx();
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

  /** 设备像素比：窗口在不同缩放率的显示器之间移动时会变，跟着重渲染当前页 */
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  /** 跟随系统「减少动态效果」：开启时翻页动画降级为减弱档 */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { prefersReducedMotionRef.current = mq.matches; };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /** 当前在跑的 PDF 渲染任务：同一张 canvas 上不能再起第二个 */
  const pdfRenderTaskRef = useRef<{ cancel: () => void; promise: Promise<void> } | null>(null);

  const renderPdfPage = async (pdfDoc: any, pageNum: number, scale: number, rotation = 0) => {
    if (!canvasRef.current) return;
    const page = await pdfDoc.getPage(pageNum);
    if (!pdfBaseWidthRef.current) {
      const base = page.getViewport({ scale: 1 });
      pdfBaseWidthRef.current = base.width;
      pdfBaseHeightRef.current = base.height;
    }
    // 上一次渲染可能还在往这张 canvas 上画。页数、缩放、旋转快速变化时，
    // pdfjs 会直接抛「Cannot use the same canvas during multiple render() operations」，
    // 表现就是快速翻页出现空白页，所以先取消并等它收尾再改画布尺寸。
    const prev = pdfRenderTaskRef.current;
    if (prev) {
      try { prev.cancel(); } catch { /* 已结束 */ }
      try { await prev.promise; } catch { /* 被取消是预期内的 */ }
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 高分屏：画布背衬按设备像素比放大，再按 CSS 像素指定显示宽度，
    // 否则 4K/200% 缩放下 PDF 会被拉糊。不写死高度——宽度交给样式里的
    // max-width:100% 去夹，高度靠 height:auto 跟比例，窄窗口才不会被压扁。
    // 上限取 2：200% 已经足够清晰，再高只是白吃内存（一页背衬能到几十 MB）。
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const viewport = page.getViewport({ scale: scale * dpr, rotation });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
    const ctx = canvas.getContext('2d')!;
    const task = page.render({ canvasContext: ctx, viewport });
    pdfRenderTaskRef.current = task;
    try {
      await task.promise;
    } catch (err) {
      // 被下一次渲染取消属于正常路径，其余错误交给调用方提示
      if ((err as { name?: string } | null)?.name !== 'RenderingCancelledException') throw err;
    } finally {
      if (pdfRenderTaskRef.current === task) pdfRenderTaskRef.current = null;
    }
  };

  useEffect(() => {
    if (book.file_type === 'pdf' && pdfReady && pdfDocRef.current && !loading && !pdfReflow) {
      renderPdfPage(pdfDocRef.current, pageIndex + 1, pdfScale, pdfRotation)
        // 画布重绘完成再放动效：先淡出旧页、再跳出新页会闪一下
        .then(() => playFlipFx())
        .catch(err => {
          if ((err as { name?: string } | null)?.name !== 'RenderingCancelledException') {
            showToast('这一页渲染失败，文件可能已损坏');
          }
        });
    }
  }, [pdfReady, pageIndex, loading, pdfScale, pdfReflow, pdfRotation, dpr]);

  // TXT / PDF：页码变化即记录阅读位置（加载完成前不写，避免覆盖上次位置）
  useEffect(() => {
    if (loading || book.file_type === 'epub') return;
    // PDF 重排下变的是屏号，两套坐标一起记，切回原始版式才不会丢位置
    const pos: SavedPosition = inPdfReflow
      ? { page: pageIndex, reflow: reflowPage }
      : { page: pageIndex };
    scheduleSavePos(pos);
    currentPosRef.current = pos;
    // TXT 换页是同步替换文本，这里放动效；PDF 与漫画等内容真正就绪后再放（见各自分支）
    // 滑动模式下 pageIndex 由滚动回填，放动效会在连续滚动中反复闪，跳过
    if (book.file_type === 'txt' && !txtFlowOn) playFlipFx();
  }, [pageIndex, loading, book.file_type, txtFlowOn, reflowPage, inPdfReflow]);

  // 文档型格式：块序号变化即记录阅读位置。
  // 打开时会先写一次 docBlock=0，但紧接着的定位滚动会把它改回来，800ms 的防抖
  // 把两次合并成一次落盘，落下去的仍是定位后的块。
  useEffect(() => {
    if (loading || !isDoc || !docHtml) return;
    const pos: SavedPosition = { docBlock };
    scheduleSavePos(pos);
    currentPosRef.current = pos;
    // 书架上的百分比也得跟着走：文档型格式 没有页，别的格式那几处 updateProgress
    // 都挂在翻页上，这里不主动上报的话进度会一直停在打开时的值
    window.electronAPI?.updateProgress(book.id, docBlock / Math.max(1, docBlocksOf().length));
  }, [docBlock, loading, isDoc, docHtml]);

  // 漫画：图片是异步取回来的，等当前页数据到位再放动效，否则淡入的是上一页
  useEffect(() => {
    if (isComicFile(book.file_type) && comicPageData) playFlipFx();
  }, [comicPageData, book.file_type]);

  // PDF 重排：页码变化即整页重绘，直接放动效
  useEffect(() => {
    if (book.file_type === 'pdf' && pdfReflow) playFlipFx();
  }, [reflowPage, pdfReflow, book.file_type]);

  /** PDF 缩放档位 */
  /**
   * 抽取 PDF 文字层并重排为流式页。
   * 扫描版 PDF 没有文字层，这里会明确告知而不是给出一片空白。
   */
  const buildPdfReflow = async () => {
    const doc = pdfDocRef.current;
    if (!doc) return;
    setReflowBusy(true);
    try {
      // 第一遍：取出每页的文本行与页面尺寸。
      // 页眉页脚必须跨页统计才能识别——页码每页都不同，单页看不出重复。
      const perPageLines: LayoutLine[][] = [];
      const pageSizes: { width: number; height: number }[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        perPageLines.push(
          itemsToLines((tc.items as any[]).filter(it => typeof it.str === 'string')),
        );
        pageSizes.push({ width: vp.width, height: vp.height });
      }

      // 贴在上下边缘且跨页重复的行判为页眉页脚，重排时丢掉，免得混进正文
      const skip = findRepeatingLines(
        perPageLines,
        pageSizes.map(s => s.height),
      );

      // 字号分档要跨页统计：单页可能只有标题没有正文，分不出档次
      const profile = analyzeFontSizes(perPageLines);

      const pages: ReflowBlock[][] = [];
      let buf: ReflowBlock[] = [];
      let bufLength = 0;
      perPageLines.forEach((lines, i) => {
        const kept =
          skip.size > 0 ? lines.filter(l => !skip.has(normalizeForRepeat(l.text))) : lines;
        if (kept.length === 0) return;
        // 分栏要在剔除页眉页脚之后判：残留的页眉会污染空白带的统计
        const split = detectColumnSplit(kept, pageSizes[i].width);
        const blocks = linesToBlocks(splitColumns(kept, split), profile);
        if (blocks.length === 0) return;
        buf.push(...blocks);
        bufLength += blocks.reduce((n, b) => n + b.text.length, 0);
        if (bufLength >= 3000) {
          pages.push(buf);
          buf = [];
          bufLength = 0;
        }
      });
      if (buf.length > 0) pages.push(buf);

      if (pages.length === 0) {
        alert(
          '本书没有可提取的文字层，可能是扫描版 PDF。\n' +
          '扫描版无法重排；可点工具栏的「识别」，用本机 OCR 取出当前页文字。',
        );
        return;
      }
      setReflowPages(pages);
      // 按原页码比例换算到重排后的位置，避免跳回开头
      const ratio = doc.numPages > 0 ? pageIndex / doc.numPages : 0;
      setReflowPage(Math.min(pages.length - 1, Math.floor(ratio * pages.length)));
      setPdfReflow(true);
    } catch (err) {
      alert(`重排失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setReflowBusy(false);
    }
  };

  const togglePdfReflow = async () => {
    if (pdfReflow) {
      // 关掉重排：按屏序比例换算回原始页序。不换算就会跳回「进入重排时」那个旧页码，
      // 读了几十屏再切回去等于白读。与开启时的换算对称。
      if (reflowPages.length > 0 && totalPages > 0) {
        const ratio = reflowPage / reflowPages.length;
        setPageIndex(Math.min(totalPages - 1, Math.floor(ratio * totalPages)));
      }
      setPdfReflow(false);
      return;
    }
    // 已抽取过就直接切回，不重复解析
    if (reflowPages.length > 0) {
      setPdfReflow(true);
      return;
    }
    await buildPdfReflow();
  };

  /** 顺时针旋转 90°（用于横向扫描件） */
  const rotatePdf = () => setPdfRotation(r => (r + 90) % 360);

  const changePdfScale = (delta: number) => {
    setPdfScale(s => {
      const next = Math.min(3, Math.max(0.5, Math.round((s + delta) * 10) / 10));
      queueSaveBookPrefs({ pdfScale: next });
      return next;
    });
  };

  /**
   * PDF 适应宽度 / 适应高度 / 适应整页。
   * 基准是页面自然尺寸（scale=1）。放大缩小的档位是固定 ±0.25，适应类则是按容器算出来的倍数。
   * 旋转 90°/270° 时 pdfjs 会把页面宽高对调，基准也要跟着对调——否则横版扫描件转过来后
   * 「适应宽度」会拿原始宽度去除可用宽度，算出来的倍数只够半屏。
   */
  const fitPdf = (mode: 'width' | 'height' | 'page') => {
    const wrap = pdfWrapRef.current;
    if (!wrap || !pdfBaseWidthRef.current || !pdfBaseHeightRef.current) return;
    const swapped = pdfRotation % 180 !== 0;
    const baseW = swapped ? pdfBaseHeightRef.current : pdfBaseWidthRef.current;
    const baseH = swapped ? pdfBaseWidthRef.current : pdfBaseHeightRef.current;
    // 横向留白是样式里的 padding:24px；纵向还要再扣掉页面间距（JSX 里内联加的上下 padding）
    const availW = wrap.clientWidth - 48;
    const availH = wrap.clientHeight - 48 - typo.pageGap * 2;
    if (availW <= 0 || availH <= 0) return;
    const byWidth = availW / baseW;
    const byHeight = availH / baseH;
    const raw = mode === 'width' ? byWidth : mode === 'height' ? byHeight : Math.min(byWidth, byHeight);
    // 向下取整到千分位，而不是四舍五入到 0.1：适应类的语义是「装得进」，取整进位会让画布
    // 比可用区大一点点，宽度那侧有 max-width:100% 兜着看不出来，高度那侧就是实打实地溢出
    // （页面比视口高几个像素，底下永远露一条边）。下限 0.5 / 上限 3 与放大缩小档位保持一致。
    const next = Math.min(3, Math.max(0.5, Math.floor(raw * 1000) / 1000));
    setPdfScale(next);
    queueSaveBookPrefs({ pdfScale: next });
  };

  const fitPdfWidth = () => fitPdf('width');
  const fitPdfHeight = () => fitPdf('height');
  const fitPdfPage = () => fitPdf('page');

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

  /**
   * EPUB 滚动版式下把视口滚动一屏。
   * epub.js 在 scrolled 下的 next() 是「跳下一个 section」——section 比视口高时，中间整段内容会被
   * 直接跳过，所以这里自己滚容器。内容没超出视口、或已在两端时返回 false，交回章节翻页。
   */
  const scrollEpubBy = (dir: 1 | -1): boolean => {
    const container = (renditionRef.current as any)?.manager?.container as HTMLElement | undefined;
    if (!container) return false;
    const max = container.scrollHeight - container.clientHeight;
    if (max <= 0) return false;
    const before = container.scrollTop;
    const step = Math.max(80, Math.round(container.clientHeight * 0.88));
    const target = Math.max(0, Math.min(max, before + dir * step));
    if (target === before) return false;
    container.scrollTo({ top: target, behavior: 'smooth' });
    return true;
  };

  /** 无副作用翻页（自动播放用，不停播） */
  const advancePage = (dir: 1 | -1) => {
    // 滚动版式下「下一页」= 滚一屏，到两端才退回章节翻页
    if (book.file_type === 'epub' && flowModeRef.current === 'scrolled' && scrollEpubBy(dir)) return;
    if (txtFlowOn || isDoc) {
      const el = txtRef.current;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        const before = el.scrollTop;
        const step = Math.max(80, Math.round(el.clientHeight * 0.88));
        const target = Math.max(0, Math.min(max, before + dir * step));
        if (target !== before) {
          el.scrollTo({ top: target, behavior: 'smooth' });
          return;
        }
        // 已滚到容器两端：把页号推过连排窗口边界，让窗口整体前移 / 后退，
        // 否则同一窗口内 setPageIndex 不会触发重排，按键等于没反应。
        // 文档型格式 没有「下一屏内容」这回事，滚到头就停住，不往下走。
        if (txtFlowOn && txtFlowRange) {
          if (dir > 0 && txtFlowRange[1] < txtPages.length - 1) {
            setPageIndex(txtFlowRange[1] + 1);
            setSearchMark('');
            return;
          }
          if (dir < 0 && txtFlowRange[0] > 0) {
            setPageIndex(txtFlowRange[0] - 1);
            setSearchMark('');
            return;
          }
        }
      }
    }
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
    } else if (book.file_type === 'pdf' && pdfReflow) {
      const next = reflowPage + dir;
      if (next < 0 || next >= reflowPages.length) return;
      setReflowPage(next);
      setSearchMark('');
      window.electronAPI?.updateProgress(
        book.id,
        reflowPages.length > 0 ? next / reflowPages.length : 0,
      );
    } else if (dir > 0 && pageIndex < totalPages - 1) {
      // 漫画双页合并时一次跨两页
      const step = isComicFile(book.file_type) && comicSpread ? 2 : 1;
      const next = Math.min(pageIndex + step, totalPages - 1);
      setPageIndex(next);
      setSearchMark('');
      window.electronAPI?.updateProgress(book.id, totalPages > 0 ? next / totalPages : 0);
    } else if (dir < 0 && pageIndex > 0) {
      const step = isComicFile(book.file_type) && comicSpread ? 2 : 1;
      const next = Math.max(pageIndex - step, 0);
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

  /**
   * Markdown 的 [[目标]] 跳转：按书名或原文件名在书库中找另一篇笔记并打开。
   * 找不到时说清楚「没导入」，而不是静默无反应。
   */
  const openWikilink = async (target: string) => {
    const name = target.trim();
    if (!name) return;
    const api = window.electronAPI;
    if (!api?.findBookByWikilink) return;
    try {
      const found = await api.findBookByWikilink(name);
      if (!found) {
        showToast(`书库里没有《${name}》，需要先把它导入书架`);
        return;
      }
      if (found.id === book.id) {
        showToast('链接指向的就是当前这本书');
        return;
      }
      const target2 = (await api.getBookById(found.id)) as Book | null;
      if (!target2) {
        showToast(`《${found.title}》已不在书库`);
        return;
      }
      if (onOpenBook) onOpenBook(target2);
      else showToast(`找到《${found.title}》，当前窗口不支持跳转`);
    } catch {
      showToast(`跳转失败，请确认《${name}》已经导入`);
    }
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
      let action = resolveAction(presetRef.current, e);
      if (!action) return;
      e.preventDefault();
      // 日漫右向左：左右键的语义与横排文本相反，翻页动作对调
      if (isComicFile(book.file_type) && comicRtlRef.current) {
        if (action === 'next') action = 'prev';
        else if (action === 'prev') action = 'next';
      }
      switch (action) {
        case 'next': handleNext(); break;
        case 'prev': handlePrev(); break;
        case 'first': goToFirst(); break;
        case 'last': goToLast(); break;
        case 'toggleTheme': cycleTheme(); break;
        case 'fontUp': changeFontSize(2); break;
        case 'fontDown': changeFontSize(-2); break;
        case 'openToc':
          // 文字类按章节切；PDF 重排后也有章节，原始版式的 PDF 与漫画没有
          if (panelAllowed('toc')) togglePanel('toc');
          else showToast('这种格式没有目录面板，PDF 与漫画可用缩略图跳页');
          break;
        case 'openSearch':
          if (caps.search) togglePanel('search');
          else showToast('这种格式暂不支持书内检索');
          break;
        case 'openNotes':
          // 纯图格式划不了词，笔记必然是空的；说清楚，别让人以为面板坏了
          if (caps.text) togglePanel('notes');
          else showToast('这种格式不能划词，笔记用不上；标页请用「阅读位置」');
          break;
        case 'openPositions': togglePanel('positions'); break;
        case 'highlight':
          if (!caps.text) showToast('这种格式不能划词标注；标页请用「阅读位置」');
          else if (sel) handleHighlight();
          else showToast('请先选中一段文字，再按高亮键');
          break;
        case 'addNote':
          if (!caps.text) showToast('这种格式不能划词，写不了笔记');
          else if (sel) {
            setNoteDraft({ text: sel.text, position: sel.position });
            setNoteContent('');
          } else showToast('请先选中一段文字，再按笔记键');
          break;
        case 'toggleDualColumn':
          if (caps.text) toggleDualColumn();
          else showToast('双栏只作用于文字排版，这种格式用不上');
          break;
        case 'toggleFullscreen': handleToggleFullscreen(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- 检索 ----------

  /**
   * PDF 每页的文字层，供书内检索用。
   * 按行拼、而不是把 text item 直接用空格连起来：itemsToLines 会依据字间距决定补不补空格，
   * 直接连会往中文词中间塞空格，明明在书上、却一搜就搜不到。
   * 整本抽一遍不便宜，按 doc 实例缓存；换书时 doc 换了，缓存自然作废。
   */
  const getPdfPageTexts = async (doc: any): Promise<string[]> => {
    const cached = pdfPageTextRef.current;
    if (cached && cached.doc === doc) return cached.texts;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      texts.push(
        itemsToLines((tc.items as any[]).filter(it => typeof it.str === 'string'))
          .map(l => l.text)
          .join('\n'),
      );
    }
    pdfPageTextRef.current = { doc, texts };
    return texts;
  };

  const handleSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setHits([]);
    // 上一轮的命中下标对新结果没有意义，一起清掉（面板上的「第 x / y 处」也不会留着旧读数）
    setHitIndex(-1);
    const opts: KeywordOptions = { caseSensitive: searchCaseSensitive, wholeWord: searchWholeWord };
    try {
      if (book.file_type === 'txt') {
        const found: SearchHit[] = [];
        txtPages.forEach((page, i) => {
          const hit = findKeyword(page, kw, opts);
          if (hit) {
            // 摘要从命中处截，否则「全词匹配」命中的是后一处、看到的却是前一处的上下文
            found.push({
              label: `第 ${i + 1} 页`,
              excerpt: excerptAround(page.slice(hit.index), kw),
              target: i,
            });
          }
        });
        setHits(found);
      } else if (isDoc) {
        const found: SearchHit[] = [];
        // 逐顶层块找，不是逐页：文档型格式 没有页，块既是阅读位置也是跳转目标。
        // 标签取该块之前最近的那个标题，与断点标签同一套算法
        let heading = '';
        docBlocksOf().forEach((block, i) => {
          const own = (block.textContent || '').trim();
          const text = block.textContent || '';
          if (block.id?.startsWith('dh-')) heading = own;
          const hit = findKeyword(text, kw, opts);
          if (!hit) return;
          found.push({
            label: (heading || `第 ${i + 1} 段`).slice(0, 40),
            // 摘要从命中处截，否则「全词匹配」命中的是后一处、看到的却是前一处的上下文
            excerpt: excerptAround(text.slice(hit.index), kw),
            target: i,
          });
        });
        setHits(found);
      } else if (book.file_type === 'epub' && bookRef.current) {
        const epubBook = bookRef.current;
        const found: SearchHit[] = await Promise.all(
          epubBook.spine.spineItems.map((item: any) =>
            item
              .load(epubBook.load.bind(epubBook))
              .then((doc: any) => {
                // 正文取法有坑（epub.js 交出的是 <html> 而不是 Document），见 epubSectionText
                const text = epubSectionText(doc);
                const hit = findKeyword(text, kw, opts);
                item.unload();
                if (!hit) return null;
                const excerpt = excerptAround(text.slice(hit.index), kw);
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
      } else if (book.file_type === 'pdf') {
        const found: SearchHit[] = [];
        if (inPdfReflow) {
          // 重排视图已经按语义切好了块，直接搜块；坐标系是「屏 + 块」，
          // 和原始页不是一回事，所以跳转目标要同时带上两个数（见 jumpToHit）
          let heading = '';
          reflowPages.forEach((blocks, page) => {
            blocks.forEach((block, index) => {
              if (block.kind === 'heading') heading = block.text.trim();
              const hit = findKeyword(block.text, kw, opts);
              if (!hit) return;
              found.push({
                label: (heading || `第 ${page + 1} 屏`).slice(0, 40),
                excerpt: excerptAround(block.text.slice(hit.index), kw),
                target: `${page}:${index}`,
              });
            });
          });
        } else if (pdfDocRef.current) {
          const texts = await getPdfPageTexts(pdfDocRef.current);
          texts.forEach((text, i) => {
            const hit = findKeyword(text, kw, opts);
            if (!hit) return;
            found.push({
              label: `第 ${i + 1} 页`,
              excerpt: excerptAround(text.slice(hit.index), kw),
              target: i,
            });
          });
          // 一页都没抽出字，基本就是扫描版：说清楚，别让人以为检索坏了
          if (texts.every(t => !t)) showToast('这份 PDF 没有文字层，可能是扫描版；可先用「识别」取字');
        }
        setHits(found);
      }
    } finally {
      setSearching(false);
    }
  };

  /**
   * 跳到某一处命中。
   *
   * keepPanel 是给「上一处 / 下一处」用的：点结果时跳完就该收面板（腾出地方看正文），
   * 但连续翻找时面板一收、按钮就没了，只能每次重开面板重搜——所以步进走同一个函数、
   * 只是不收面板。四种格式的坐标系（TXT 页号 / 文档块号 / EPUB href / PDF 页号或屏:块）
   * 全在这一个函数里分派，步进复用它是为了避免另写一套跳转而慢慢和这套分叉。
   */
  const jumpToHit = (hit: SearchHit, keepPanel = false) => {
    pushHistory();
    if (book.file_type === 'txt' && typeof hit.target === 'number') {
      setSearchMark(keyword.trim());
      // 检索用的是当前分页的页码，但跳转时阅读设置可能已经改过、页数也变了
      setPageIndex(totalPages > 0 ? clampPage(hit.target + 1, totalPages) - 1 : hit.target);
    } else if (isDoc && typeof hit.target === 'number') {
      setSearchMark(keyword.trim());
      // 标记一变，正文 HTML 会整块重绘。把目标块同步记下来：重绘后的对齐用的是
      // 这个值，否则会被「重绘前读到的那一块」拉回去
      setDocBlock(hit.target);
      scrollToDocBlock(hit.target);
    } else if (book.file_type === 'epub' && typeof hit.target === 'string') {
      const kw = keyword.trim();
      setSearchMark(kw);
      // 章节显示完成后再框选关键词；带上当前检索选项，标红位置才和命中列表一致
      const opts: KeywordOptions = { caseSensitive: searchCaseSensitive, wholeWord: searchWholeWord };
      renditionRef.current?.display(hit.target).then(() => markEpubKeyword(kw, opts)).catch(() => {});
    } else if (book.file_type === 'pdf' && typeof hit.target === 'number') {
      // 原始版式：正文是 canvas 画出来的，没有 DOM 可标红，只能跳到那一页让人自己看
      setSearchMark('');
      setPageIndex(clampPage(hit.target + 1, totalPages) - 1);
    } else if (book.file_type === 'pdf' && typeof hit.target === 'string') {
      // 重排视图：块是我们自己渲染的，标红方式和文字类一致
      setSearchMark(keyword.trim());
      const [page, index] = hit.target.split(':').map(Number);
      jumpToReflowBlock(page, index);
    }
    if (!keepPanel) setPanel(null);
  };

  /**
   * 上一处 / 下一处。下标越界由 stepHitIndex 往返兜住，
   * 所以这里只要把新下标落到状态上、再走同一条跳转路径即可。
   * 历史照记（与点结果完全同一条路径）：连点十处就留十条、退一步退一处，
   * 与「点十次结果」的既有行为一致，不为步进另立一套规矩。
   */
  const stepHit = (delta: number) => {
    const next = stepHitIndex(hitIndex, hits.length, delta);
    if (next < 0) return;
    setHitIndex(next);
    jumpToHit(hits[next], true);
  };

  /**
   * 把当前命中项滚进可视区。用 block:'nearest'——已经在视野里就什么都不做，
   * 免得每步都让整个面板跳一下（命中项挤在首屏时那种抖动比不滚更烦）。
   */
  useEffect(() => {
    if (hitIndex < 0) return;
    activeHitRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hitIndex]);

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
  const markEpubKeyword = (kw: string, opts: KeywordOptions = {}) => {
    clearEpubSearchMarks();
    if (!kw.trim()) return;
    try {
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
          // 与检索用同一套匹配规则，否则「区分大小写」下命中的位置和标红的位置会对不上
          const hit = findKeyword(text, kw, opts);
          if (!hit) continue;
          const mark = doc.createElement('mark');
          mark.className = 'epub-search';
          mark.setAttribute('style', 'background:rgba(255,152,0,.55);color:inherit;border-radius:2px;');
          mark.textContent = text.slice(hit.index, hit.index + hit.length);
          const parent = t.parentNode;
          if (!parent) continue;
          parent.insertBefore(doc.createTextNode(text.slice(0, hit.index)), t);
          parent.insertBefore(mark, t);
          parent.insertBefore(doc.createTextNode(text.slice(hit.index + hit.length)), t);
          parent.removeChild(t);
        }
      }
    } catch (err) {
      console.error('标红关键词失败:', err);
    }
  };

  // ---------- 渲染 ----------

  /**
   * 该面板对当前格式有没有意义。没意义就别开——开了只会是个空壳，
   * 用户还得自己琢磨「为什么点开什么都没有」。
   */
  const panelAllowed = (p: Exclude<Panel, null>): boolean => {
    switch (p) {
      case 'ocr': return caps.ocr;
      // 重排把页面重新切过，缩略图上的原始页与眼前的屏对不上，这时候不给
      case 'thumbs': return caps.thumbs && !(book.file_type === 'pdf' && pdfReflow);
      case 'notes':
      case 'marks':
      case 'ai': return caps.text;
      // 检索与上面三个不同：PDF 划不了词，但它有文字层，搜得动（见 caps.search）
      case 'search': return caps.search;
      // 目录：文字类走章节；PDF 重排后按重排屏切、原始版式按 outline 页码切，
      // 两者是不同坐标系，各自有内容才给面板；漫画没有目录
      case 'toc':
        if (caps.text) return true;
        if (book.file_type !== 'pdf') return false;
        return pdfReflow ? reflowToc.length > 0 : pdfToc.length > 0;
      // 排版自定义（页间距等）与阅读位置各格式都用得上
      case 'typo':
      case 'positions': return true;
      default: return true;
    }
  };

  const togglePanel = (p: Exclude<Panel, null>) => {
    if (!panelAllowed(p)) return;
    setPanel(cur => (cur === p ? null : p));
  };

  // 换书时当前面板若对新格式没意义（比如从 EPUB 的笔记翻到漫画），直接关掉
  useEffect(() => {
    setPanel(cur => (cur && !panelAllowed(cur) ? null : cur));
    // panelAllowed 随格式与 pdfReflow 变化，这里只在换书时兜一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const readerThemeClass =
    settings.theme === 'light' ? 'reader-light' : settings.theme === 'sepia' ? 'reader-sepia' : '';
  const thumbCount = isComicFile(book.file_type) ? comicPages.length : totalPages;
  // 换书清空缩略图与漫画页缓存，别把上一本的图留着占内存
  useEffect(() => {
    setThumbs({});
    thumbPendingRef.current.clear();
    comicCacheRef.current.clear();
  }, [book.id]);

  /** 把整页图缩成缩略图：漫画单页可能几 MB，原样留在列表里滚动会把内存吃光 */
  const downscaleToThumb = (src: string) =>
    new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, THUMB_WIDTH / Math.max(1, img.width));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas 不可用'));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });

  /** 生成某一页的缩略图；已有缓存或正在生成的直接跳过 */
  const ensureThumb = async (idx: number) => {
    if (thumbs[idx] || thumbPendingRef.current.has(idx)) return;
    thumbPendingRef.current.add(idx);
    try {
      let url: string | null = null;
      if (isComicFile(book.file_type)) {
        const name = comicPages[idx];
        const page = name ? await window.electronAPI?.getComicPage(book.id, name) : null;
        if (page) url = await downscaleToThumb(`data:${page.mime};base64,${page.data}`);
      } else {
        const doc = pdfDocRef.current;
        if (doc) {
          const page = await doc.getPage(idx + 1);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: THUMB_WIDTH / Math.max(1, base.width) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport }).promise;
            url = canvas.toDataURL('image/jpeg', 0.7);
          }
        }
      }
      if (url) setThumbs(prev => ({ ...prev, [idx]: url as string }));
    } catch {
      /* 单页失败就留空格子，不影响其它页 */
    } finally {
      thumbPendingRef.current.delete(idx);
    }
  };

  // 滚到可见才生成：500 页的 PDF 全量渲染要几十秒，用户多半只看附近几页
  useEffect(() => {
    if (panel !== 'thumbs' || !caps.thumbs) return;
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.thumb);
          if (Number.isInteger(idx)) void ensureThumb(idx);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '160px' },
    );
    document.querySelectorAll<HTMLElement>('[data-thumb]').forEach(el => observer.observe(el));
    // 打开面板时把当前页那格滚进视野，长文档不用自己找
    document.querySelector('.thumb-item.active')?.scrollIntoView({ block: 'center' });
    return () => observer.disconnect();
  }, [panel, caps.thumbs, book.id, thumbCount]);

  // 漫画翻页：按需拉取当前页（双页合并时连下一页一起），并预热前后各一页。
  // 只缓存可见页 ±1 这一小段，翻页即换窗口、离开的页立即释放，避免整包驻留内存。
  useEffect(() => {
    if (!isComicFile(book.file_type)) return;
    const api = window.electronAPI;
    const current = comicPages[pageIndex];
    if (!api || !current) {
      comicCacheRef.current.clear();
      setComicPageData(null);
      setComicNextData(null);
      return;
    }
    const spreadNext = comicSpread ? comicPages[pageIndex + 1] : undefined;

    // 可见页是当前页（双页时再加下一页）；预热范围是可见页前后各一页
    const visible = spreadNext ? [current, spreadNext] : [current];
    const desired = new Set<string>();
    for (const name of visible) {
      const i = comicPages.indexOf(name);
      for (const j of [i - 1, i, i + 1]) {
        if (j >= 0 && j < comicPages.length) desired.add(comicPages[j]);
      }
    }
    // 先淘汰再预热：窗口外的页留着只会白占内存
    for (const key of [...comicCacheRef.current.keys()]) {
      if (!desired.has(key)) comicCacheRef.current.delete(key);
    }

    let alive = true;
    const load = async (name: string) => {
      const cached = comicCacheRef.current.get(name);
      if (cached) return cached;
      const page = await api.getComicPage(book.id, name);
      if (page) comicCacheRef.current.set(name, page);
      return page ?? null;
    };

    load(current)
      .then(page => { if (alive) setComicPageData(page); })
      .catch(() => { if (alive) setComicPageData(null); });
    if (spreadNext) {
      load(spreadNext)
        .then(page => { if (alive) setComicNextData(page); })
        .catch(() => { if (alive) setComicNextData(null); });
    } else {
      setComicNextData(null);
    }
    // 预热只暖缓存，不动当前显示的图；失败也不要紧，真翻过去时会再取一次
    for (const name of desired) {
      if (name === current || name === spreadNext) continue;
      void load(name).catch(() => { /* 预热失败忽略 */ });
    }

    return () => { alive = false; };
  }, [book.file_type, book.id, comicPages, pageIndex, comicSpread]);

  // 本地字体：取回列表并注入 @font-face。字体文件经 bookfile:// 协议读取，
  // 与封面同一条通道；URL 里的路径是 base64url，不经过 URL 结构规整。
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    api
      .listFonts()
      .then(fonts => {
        if (!alive || fonts.length === 0) return;
        setLocalFonts(fonts);
        const style = document.createElement('style');
        style.dataset.localFonts = '1';
        style.textContent = fonts
          .map(f => `@font-face{font-family:'${f.family}';src:url('${f.url}');font-display:swap;}`)
          .join('\n');
        document.head.appendChild(style);
      })
      .catch(() => { /* 取不到按无本地字体处理 */ });
    return () => {
      alive = false;
      document.querySelector('style[data-local-fonts]')?.remove();
    };
  }, []);

  // 分页模式才用得上单页 HTML；滑动模式走连排窗口，这里不必白算一页
  const txtHtml = book.file_type === 'txt' && !txtFlowOn ? renderTxtPageHtml(pageIndex) : null;

  // 文档型格式 没有页码，底部只能给个「读到全篇的百分之多少」——块序号就是位置
  const docPercent = isDoc ? Math.round((docBlock / Math.max(1, docBlocksOf().length)) * 100) : 0;
  /** 翻页键在 文档型格式 里滚的是「一屏」，按钮文案跟着说清楚 */
  const pageNavLabels = isDoc ? { prev: '上一屏', next: '下一屏' } : { prev: '上一页', next: '下一页' };

  /** 连排窗口内各页的标记 HTML（该页无标记时为空串，渲染时直接输出纯文本） */
  const txtFlowHtml = useMemo(() => {
    if (!txtFlowRange) return null;
    const out: string[] = [];
    for (let i = txtFlowRange[0]; i <= txtFlowRange[1]; i++) out.push(renderTxtPageHtml(i) ?? '');
    return out;
    // renderTxtPageHtml 每次 render 都是新闭包，但它读的量下面全列了：依赖不变则结果不变
  }, [txtFlowRange, txtPages, bookmarks, searchMark, hideMarks, searchCaseSensitive, searchWholeWord]);

  /**
   * 滑动模式滚动时把「当前可见页」回填进 pageIndex。
   * 进度、页码、位置记忆全靠它；缺了它连续滚动时这些数字都是死的。
   * 用 rAF 收口：滚动事件比屏幕刷新密得多，逐个处理只会白算一批马上被推翻的位置。
   */
  const handleTxtFlowScroll = () => {
    if (flowScrollTickRef.current) return;
    flowScrollTickRef.current = true;
    requestAnimationFrame(() => {
      flowScrollTickRef.current = false;
      const el = txtRef.current;
      if (!el || !txtFlowRange) return;
      const base = el.getBoundingClientRect().top;
      let current = txtFlowRange[0];
      for (const node of el.querySelectorAll<HTMLElement>('[data-page]')) {
        if (node.getBoundingClientRect().top - base <= 8) current = Number(node.dataset.page);
        else break;
      }
      if (current !== pageIndex) {
        // 记下这次页码变化来自滚动，下面的定位 effect 要据此放行，否则会把读者拽回去
        txtScrollByUserRef.current = true;
        setPageIndex(current);
      }
    });
  };

  /**
   * 把视口对准 pageIndex 所在的那一块。
   * 触发它的 pageIndex 变化有两个来源，要求正好相反：
   *   - 滚动回填（txtScrollByUserRef 置位）：视口本来就在那儿，再定位一次会把读者拽回去；
   *   - 跳转（目录 / 批注 / 断点 / 搜索 / 翻页跨到窗口边界）：必须定位，否则点了没反应。
   * 所以只放行后者；但窗口起点也变了时要一律定位——新渲染的块得重新对齐 scrollTop。
   */
  useEffect(() => {
    if (!txtFlowRange) {
      lastFlowStartRef.current = -1;
      return;
    }
    const el = txtRef.current;
    if (!el) return;
    const windowChanged = lastFlowStartRef.current !== txtFlowStart;
    const byScroll = txtScrollByUserRef.current;
    txtScrollByUserRef.current = false;
    lastFlowStartRef.current = txtFlowStart;
    if (byScroll && !windowChanged) return;
    const node = el.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
    if (!node) return;
    // 增量修正：把该块顶部对齐到容器可视区顶部。用增量而非绝对赋值，
    // 免得算错 padding / border 把定位整体偏移一截。
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
  }, [txtFlowStart, txtFlowRange, pageIndex]);

  /**
   * 排版量（字号 / 行距 / 页边距等）一变，正文高度就变，原来的 scrollTop 会把视口带到别的
   * 段落去。这里在重排后把当前块顶部重新对齐一次。与上面那个 effect 分开写：那个跟「跳到哪」，
   * 这个只跟「排版变了」。
   */
  useEffect(() => {
    if (!txtFlowRange) return;
    const el = txtRef.current;
    if (!el) return;
    const node = el.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
    if (!node) return;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
    // pageIndex 不列入依赖：它由上面的 effect 负责，列进来会与滚动回填互相打架
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    txtFlowRange,
    settings.fontSize,
    settings.lineHeight,
    fontKey,
    dualColumn,
    typo.pagePadding,
    typo.paraSpacing,
    typo.pageGap,
    typo.letterSpacing,
  ]);

  return (
    <div className={`reader ${view.autoHideBar ? 'bar-auto-hide' : ''}`}>
      {view.autoHideBar && (
        <div className="bar-trigger" onMouseEnter={() => setBarVisible(true)} />
      )}
      <div
        className={`reader-header ${view.autoHideBar && !barVisible ? 'bar-hidden' : ''}`}
        onMouseLeave={() => { if (view.autoHideBar) setBarVisible(false); }}
      >
        <button className="back-btn" onClick={onBack}>
          <Icon name="arrow-left" size={14} />
          返回
        </button>
        <h2 className="reader-title">{book.title}</h2>
        <div className="reader-actions">
          {/* 字体与字号只作用于正文排版：漫画整页是图，调了没有任何反应，直接不给 */}
          {caps.font && (
            <>
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
            {localFonts.map(f => (
              <option key={f.name} value={`${LOCAL_FONT_PREFIX}${f.family}`}>
                {f.family}
              </option>
            ))}
          </select>
              <button onClick={() => changeFontSize(-2)} title="缩小字号">A−</button>
              <button onClick={() => changeFontSize(2)} title="放大字号">A+</button>
            </>
          )}
          <span className="tool-sep" />
          <button onClick={() => changeTheme('dark')} className={settings.theme === 'dark' ? 'active' : ''} title="深色主题">
            <Icon name="moon" size={15} />
          </button>
          <button onClick={() => changeTheme('light')} className={settings.theme === 'light' ? 'active' : ''} title="浅色主题">
            <Icon name="sun" size={15} />
          </button>
          <button onClick={() => changeTheme('sepia')} className={settings.theme === 'sepia' ? 'active' : ''} title="护眼纸色主题">
            <Icon name="palette" size={15} />
          </button>
          <span className="tool-sep" />
          {caps.text && (
            <button onClick={handleHeaderSpeak} className={speaking ? 'active' : ''} title={speaking ? '停止朗读' : '朗读'}>
              <Icon name={speaking ? 'stop' : 'volume'} size={15} />
            </button>
          )}
          {caps.flow && (
            <button onClick={toggleFlow} title={flowMode === 'paginated' ? '切换滚动模式' : '切换分页模式'}>
              <Icon name={flowMode === 'paginated' ? 'book' : 'rows'} size={15} />
            </button>
          )}
          <button onClick={handlePrintNow} title="打印当前内容（唤起系统打印对话框）">
            <Icon name="printer" size={15} />
          </button>
          <button onClick={handlePrint} title="打印预览（先在独立窗口里看一眼）">
            预览
          </button>
          <button onClick={handleExportPageImage} title="导出当前页为图片（PNG）">
            <Icon name="image" size={15} />
          </button>
          <span className="tool-sep" />
          {panelAllowed('thumbs') && (
            <button
              onClick={() => togglePanel('thumbs')}
              className={panel === 'thumbs' ? 'active' : ''}
              title="页面缩略图"
            >
              <Icon name="grid" size={15} />
            </button>
          )}
          {panelAllowed('toc') && (
            <button onClick={() => togglePanel('toc')} className={panel === 'toc' ? 'active' : ''} title="目录">
              <Icon name="list" size={15} />
              目录
            </button>
          )}
          {caps.vertical && (
            <button
              onClick={toggleVertical}
              className={vertical ? 'active' : ''}
              title={vertical ? '切换为横排' : '切换为竖排（从右向左）'}
            >
              <Icon name={vertical ? 'columns' : 'rows'} size={15} />
            </button>
          )}
          {isComicFile(book.file_type) && (
            <>
              <button
                onClick={toggleComicSpread}
                className={comicSpread ? 'active' : ''}
                title={comicSpread ? '单页显示' : '双页合并'}
              >
                <Icon name={comicSpread ? 'side-by-side' : 'book'} size={15} />
              </button>
              <button
                onClick={toggleComicRtl}
                className={comicRtl ? 'active' : ''}
                title={comicRtl ? '左向右翻页' : '右向左翻页（日漫）'}
              >
                <Icon name={comicRtl ? 'arrow-left' : 'arrow-right'} size={15} />
              </button>
            </>
          )}
          {book.file_type === 'pdf' && (
            <>
              <button onClick={() => changePdfScale(-0.25)} title="缩小">
                <Icon name="zoom-out" size={15} />
              </button>
              <button onClick={() => changePdfScale(0.25)} title="放大">
                <Icon name="zoom-in" size={15} />
              </button>
              <button onClick={fitPdfWidth} title="适应宽度">
                <Icon name="fit-width" size={15} />
              </button>
              <button onClick={fitPdfHeight} title="适应高度">
                <Icon name="fit-height" size={15} />
              </button>
              <button onClick={fitPdfPage} title="适应整页">
                <Icon name="fit-page" size={15} />
              </button>
              <button
                onClick={rotatePdf}
                className={pdfRotation ? 'active' : ''}
                title="顺时针旋转 90°"
              >
                <Icon name="rotate-cw" size={15} />
                {pdfRotation ? `${pdfRotation}°` : null}
              </button>
              <button
                onClick={togglePdfReflow}
                className={pdfReflow ? 'active' : ''}
                disabled={reflowBusy}
                title={pdfReflow ? '还原原始版式' : '重排为流式排版（适配窗口宽度，不改原文件）'}
              >
                <Icon name="wand" size={15} />
                {reflowBusy ? '重排中…' : '重排'}
              </button>
            </>
          )}
          {caps.ocr && (
            <button
              onClick={() => togglePanel('ocr')}
              className={panel === 'ocr' ? 'active' : ''}
              title="识别当前页的文字（本机运算，不上传）"
            >
              <Icon name="scan" size={15} />
              识别
            </button>
          )}
          <button
            onClick={() => togglePanel('typo')}
            className={panel === 'typo' ? 'active' : ''}
            title="排版自定义"
          >
            <Icon name="type" size={15} />
          </button>
          {/* 书签 / 笔记 / 批注显隐都要先划词，纯图格式永远划不中，
              留着按钮只会让人以为是坏的。PDF 与漫画标页请用「阅读位置」 */}
          {caps.text && (
            <>
              <button onClick={() => togglePanel('notes')} className={panel === 'notes' ? 'active' : ''} title="笔记">
                <Icon name="note" size={15} />
                {notes.length > 0 ? notes.length : null}
              </button>
              <button
                onClick={toggleHideMarks}
                className={hideMarks ? 'active' : ''}
                title={hideMarks ? '显示批注' : '隐藏批注（不删除）'}
              >
                <Icon name={hideMarks ? 'eye-off' : 'eye'} size={15} />
              </button>
              <button onClick={() => togglePanel('marks')} className={panel === 'marks' ? 'active' : ''} title="书签">
                <Icon name="bookmark" size={15} />
                {bookmarks.length > 0 ? bookmarks.length : null}
              </button>
            </>
          )}
          {book.file_type === 'txt' && (
            <button
              onClick={toggleNormalize}
              className={normalizeOn ? 'active' : ''}
              title={normalizeOn ? '还原原始排版' : '文本规整：清理空行/缩进/硬折行（不改原文件）'}
            >
              <Icon name="eraser" size={15} />
              规整
            </button>
          )}
          {book.file_type === 'txt' && (
            <select
              className="reader-select"
              value={txtEncoding}
              onChange={e => changeTxtEncoding(e.target.value)}
              title="文本编码：出现乱码时手动指定原文编码（只改显示，不改原文件）"
            >
              <option value="auto">编码：自动</option>
              <option value="utf-8">UTF-8</option>
              <option value="gbk">GBK / GB2312</option>
              <option value="gb18030">GB18030</option>
              <option value="big5">Big5（繁体）</option>
              <option value="utf-16le">UTF-16 LE</option>
              <option value="utf-16be">UTF-16 BE</option>
            </select>
          )}
          <button onClick={() => togglePanel('positions')} className={panel === 'positions' ? 'active' : ''} title="阅读位置">
            <Icon name="map-pin" size={15} />
            {positions.length > 0 ? positions.length : null}
          </button>
          <span className="tool-sep" />
          {caps.search && (
            <button onClick={() => togglePanel('search')} className={panel === 'search' ? 'active' : ''} title="书内检索">
              <Icon name="search" size={15} />
            </button>
          )}
          {caps.text && (
            <button onClick={() => togglePanel('ai')} className={panel === 'ai' ? 'active' : ''} title="AI 助手">
              <Icon name="sparkles" size={15} />
            </button>
          )}
          {caps.dualColumn && (
            <button
              onClick={toggleDualColumn}
              className={dualColumn ? 'active' : ''}
              title="双栏 / 单栏"
            >
              <Icon name="side-by-side" size={15} />
            </button>
          )}
          <button
            onClick={toggleAutoPlay}
            className={autoPlay ? 'active' : ''}
            title={autoPlay ? '停止自动翻页' : '自动翻页'}
          >
            <Icon name={autoPlay ? 'pause' : 'play'} size={13} />
          </button>
          <span className="tool-sep" />
          <button
            onClick={() => setPhoneMode(m => !m)}
            className={phoneMode ? 'active' : ''}
            title="手机模式"
          >
            <Icon name="phone" size={15} />
          </button>
          <button
            onClick={() => setShowViewPanel(v => !v)}
            className={showViewPanel ? 'active' : ''}
            title="阅读视图"
          >
            <Icon name="sliders" size={15} />
          </button>
          <button onClick={handleToggleFullscreen} title="全屏 (F11)">
            <Icon name="maximize" size={15} />
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
            <span>翻页动画</span>
            <select
              value={pageAnim}
              onChange={e => changePageAnim(e.target.value as PageAnimation)}
              title="翻页时内容淡入。「减弱」更短更轻；系统若开启「减少动态效果」会自动按减弱档播放"
            >
              {PAGE_ANIMATIONS.map(a => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
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
        {panel === 'ocr' && (
          <div className="toc-panel">
            <div className="panel-title-row">
              <h3>识别当前页文字</h3>
              {ocrLines.length > 0 && (
                <button className="link-btn" onClick={copyOcrText}>复制全部</button>
              )}
            </div>
            <button className="btn-primary small" onClick={runOcr} disabled={ocrBusy}>
              {ocrBusy ? '识别中…' : ocrPage === pageIndex + 1 ? '重新识别这一页' : '识别这一页'}
            </button>
            <p className="section-desc" style={{ marginTop: 12 }}>
              扫描版 PDF 与漫画的页面是图片，没有可复制的文字。识别在本机完成，
              图片不会离开这台电脑。
            </p>
            {ocrBusy && <p className="empty-text">首次识别需要加载模型，请稍候…</p>}
            {!ocrBusy && ocrError && <p className="empty-text">{ocrError}</p>}
            {!ocrBusy && ocrLines.length > 0 && (
              <>
                <p className="section-desc">第 {ocrPage} 页 · 共 {ocrLines.length} 行</p>
                {ocrLines.map((line, i) => (
                  <p
                    key={i}
                    className="ocr-line"
                    // 置信度低的行淡显，方便对照原图复核
                    style={{ opacity: line.score < 0.6 ? 0.6 : 1 }}
                    title={`置信度 ${(line.score * 100).toFixed(0)}%`}
                  >
                    {line.text}
                  </p>
                ))}
              </>
            )}
          </div>
        )}

        {panel === 'toc' && book.file_type === 'pdf' && pdfReflow && (
          <div className="toc-panel">
            <h3>目录（{reflowToc.length}）</h3>
            {reflowToc.length === 0 ? (
              <p className="empty-text">未识别到标题，可能是扫描版或版式过于简单</p>
            ) : (
              reflowToc.map((item, i) => (
                <div
                  key={i}
                  className="toc-item"
                  // 按层级缩进，让目录能看出结构
                  style={{ paddingLeft: 10 + (item.level - 1) * 14 }}
                  onClick={() => jumpToReflowBlock(item.page, item.index)}
                >
                  {item.text}
                </div>
              ))
            )}
          </div>
        )}

        {/* 原始版式下的 PDF 目录：走的是 PDF 自带的书签 outline，页码即原始页序，
            与上面重排分支的「屏号」不是一回事，所以分成两块 */}
        {panel === 'toc' && book.file_type === 'pdf' && !pdfReflow && (
          <div className="toc-panel">
            <h3>目录（{pdfToc.length}）</h3>
            {pdfToc.length === 0 ? (
              <p className="empty-text">这份 PDF 没有书签目录</p>
            ) : (
              pdfToc.map((item, i) => (
                <div key={i} className="toc-item" onClick={() => jumpToPage(String(item.page))}>
                  {item.label}
                </div>
              ))
            )}
          </div>
        )}

        {panel === 'toc' && book.file_type === 'txt' && (
          <div className="toc-panel">
            <div className="panel-title-row">
              <h3>目录（{txtToc.length}）</h3>
              <button className="link-btn" onClick={handleAddChapterAtCursor}>
                <Icon name="plus" size={13} />
                当前位置
              </button>
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

        {/* 文档型格式 的目录就是标题列表：点一下滚到对应标题，与浏览器里看锚点链接是一回事 */}
        {panel === 'toc' && isDoc && (
          <div className="toc-panel">
            <h3>目录（{docToc.length}）</h3>
            {docToc.length === 0 ? (
              <p className="empty-text">正文里没有标题</p>
            ) : (
              docToc.map((t, i) => (
                <div key={i} className="toc-item" onClick={() => goToDocAnchor(t.href)}>
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

        {panel === 'thumbs' && caps.thumbs && (
          <div className="toc-panel">
            <h3>页面缩略图</h3>
            <div className="thumb-list">
              {Array.from({ length: thumbCount }, (_, i) => (
                <button
                  key={i}
                  data-thumb={i}
                  className={`thumb-item${i === pageIndex ? ' active' : ''}`}
                  onClick={() => jumpToPage(String(i + 1))}
                  title={`第 ${i + 1} 页`}
                >
                  {thumbs[i] ? (
                    <img src={thumbs[i]} alt={`第 ${i + 1} 页`} />
                  ) : (
                    <span className="thumb-ph">{i + 1}</span>
                  )}
                  <span className="thumb-no">{i + 1}</span>
                </button>
              ))}
            </div>
            <p className="section-desc" style={{ marginBottom: 0 }}>
              缩略图滚动到哪生成到哪，点一下即可跳页。
            </p>
          </div>
        )}

        {panel === 'typo' && (
          <div className="toc-panel">
            <h3>排版自定义</h3>

            <div className="form-row">
              <label>阅读样式</label>
              <select
                value={stylePreset}
                onChange={e => changeReadingStyle(e.target.value)}
              >
                {STYLE_PRESETS.map(p => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
            </div>
            <p className="section-desc" style={{ marginTop: -6 }}>
              {STYLE_PRESETS.find(p => p.key === stylePreset)?.desc}
            </p>

            <div className="form-row" style={{ marginBottom: 8 }}>
              <button className="link-btn" onClick={() => setShowCustomCss(v => !v)}>
                {showCustomCss ? '收起自定义 CSS' : '自定义 CSS…'}
              </button>
            </div>
            {showCustomCss && (
              <>
                <textarea
                  value={customCssDraft}
                  onChange={e => setCustomCssDraft(e.target.value)}
                  maxLength={MAX_CSS_LEN}
                  rows={6}
                  spellCheck={false}
                  placeholder="p { text-indent: 2em; }（仅 EPUB，留空即停用）"
                />
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  <button className="link-btn" onClick={saveCustomCss}>应用</button>
                  <button className="link-btn" onClick={clearCustomCss}>清除</button>
                </div>
              </>
            )}

            <div className="form-row">
              <label>背景色</label>
              <div className="color-row">
                <input
                  type="color"
                  value={typo.bgColor || '#1a1a2e'}
                  onChange={e => applyTypo({ bgColor: e.target.value })}
                />
                {typo.bgColor && (
                  <button className="link-btn" onClick={() => applyTypo({ bgColor: '' })}>跟随主题</button>
                )}
              </div>
            </div>

            <div className="form-row">
              <label>文字色</label>
              <div className="color-row">
                <input
                  type="color"
                  value={typo.textColor || '#eaeaea'}
                  onChange={e => applyTypo({ textColor: e.target.value })}
                />
                {typo.textColor && (
                  <button className="link-btn" onClick={() => applyTypo({ textColor: '' })}>跟随主题</button>
                )}
              </div>
            </div>

            <div className="form-row">
              <label>页边距 {typo.pagePadding} px</label>
              <input
                type="range"
                min={0}
                max={200}
                step={4}
                value={typo.pagePadding}
                onChange={e => applyTypo({ pagePadding: Number(e.target.value) })}
              />
            </div>

            <div className="form-row">
              <label>页面间距 +{typo.pageGap} px</label>
              <input
                type="range"
                min={0}
                max={200}
                step={4}
                value={typo.pageGap}
                onChange={e => applyTypo({ pageGap: Number(e.target.value) })}
              />
            </div>

            <div className="form-row">
              <label>段落间距 {typo.paraSpacing.toFixed(1)} 字</label>
              <input
                type="range"
                min={0}
                max={3}
                step={0.1}
                value={typo.paraSpacing}
                onChange={e => applyTypo({ paraSpacing: Number(e.target.value) })}
              />
            </div>

            <div className="form-row">
              <label>字间距 {typo.letterSpacing.toFixed(2)} 字</label>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={typo.letterSpacing}
                onChange={e => applyTypo({ letterSpacing: Number(e.target.value) })}
              />
            </div>

            <div className="form-row">
              <label>首行缩进 {typo.textIndent.toFixed(1)} 字</label>
              <input
                type="range"
                min={0}
                max={4}
                step={0.5}
                value={typo.textIndent}
                onChange={e => applyTypo({ textIndent: Number(e.target.value) })}
              />
            </div>

            <p className="section-desc" style={{ marginBottom: 0 }}>
              阅读样式、段落间距与首行缩进对 EPUB 生效（TXT 以空行分段、没有段落结构，不适用首行缩进）；
              字间距对 EPUB 与 TXT 都生效。
              页面间距是叠加在默认留白之上的上下留白（漫画双页合并时也用作两页之间的间隙），
              EPUB 的版式由 epub.js 控制、此项对其不生效。
              以上设置按书记忆，下次打开自动还原；自定义 CSS 是全局的，对所有书生效。
            </p>
          </div>
        )}

        {panel === 'notes' && (
          <div className="toc-panel">
            <div className="panel-title-row">
              <h3>我的笔记（{notes.length}）</h3>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  className="link-btn"
                  onClick={() => setMarkSort(s => (s === 'time' ? 'position' : 'time'))}
                  title="切换排序方式"
                >
                  {markSort === 'time' ? '按时间' : '按位置'}
                </button>
                {(notes.length > 0 || bookmarks.length > 0) && (
                  <button className="link-btn" onClick={handleExportNotes}>导出</button>
                )}
              </div>
            </div>
            {notes.length === 0 ? (
              <p className="empty-text">选中正文后可写笔记</p>
            ) : (
              sortMarks(notes).map(n => (
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
              <Icon name="plus" size={13} />
              标记当前位置
            </button>
            {positions.length === 0 ? (
              <p className="empty-text">还没有保存的位置</p>
            ) : (
              positions.map(p => (
                <div key={p.id} className="mark-item">
                  <p className="mark-label">
                    {p.source === 'crash' ? '异常退出时' : p.source === 'exit' ? '退出时' : '手动标记'}
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
              sortMarks(bookmarks).map(b => (
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
            <h3>
              <Icon name="sparkles" size={14} />
              AI 助手
            </h3>
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
                <Icon name="network" size={14} />
                思维导图
              </button>
              <button className="btn-secondary small" onClick={handleBookMindmap} disabled={aiLoading}>
                <Icon name="library" size={14} />
                本书思维导图
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
            {aiLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <p className="empty-text" style={{ padding: 0 }}>
                  {aiAnswer ? '生成中…' : '思考中…'}
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
                {searching ? '查找中…' : '搜'}
              </button>
            </div>
            <label className="view-row">
              <input
                type="checkbox"
                checked={searchCaseSensitive}
                onChange={e => setSearchCaseSensitive(e.target.checked)}
              />
              <span>区分大小写</span>
            </label>
            <label className="view-row">
              <input
                type="checkbox"
                checked={searchWholeWord}
                onChange={e => setSearchWholeWord(e.target.checked)}
              />
              <span>全词匹配（中文没有词边界，不受影响）</span>
            </label>
            {hits.length === 0 && !searching && keyword && (
              <p className="empty-text">没有找到相关内容</p>
            )}
            {hits.length > 0 && (
              <div className="search-nav">
                <span className="search-count">
                  共找到 {hits.length} 处
                  {hitIndex >= 0 && ` · 第 ${hitIndex + 1} / ${hits.length} 处`}
                </span>
                {/* 命中是「一处所在页/章」而不是每个词：步进就是换到下一个有该词的页/章，
                    到了末尾再按回到第一处（stepHitIndex 往返），不做到头禁用 */}
                <span className="search-nav-btns">
                  <button onClick={() => stepHit(-1)} title="上一处（到头回到最后一处）">
                    <Icon name="chevron-left" size={14} />上一处
                  </button>
                  <button onClick={() => stepHit(1)} title="下一处（到头回到第一处）">
                    下一处<Icon name="chevron-right" size={14} />
                  </button>
                </span>
              </div>
            )}
            {hits.map((h, i) => (
              <div
                key={i}
                className={`mark-item search-hit${i === hitIndex ? ' active' : ''}`}
                ref={i === hitIndex ? activeHitRef : undefined}
                onClick={() => { setHitIndex(i); jumpToHit(h); }}
              >
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
              <span>5G <Icon name="battery" size={14} /></span>
            </div>
          )}
          {loading && <div className="loading">加载中…</div>}
          {!loading && error && (
            <div className="loading">
              <div style={{ textAlign: 'center', maxWidth: 420 }}>
                <div style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
                  <Icon name="alert" size={38} strokeWidth={1.4} />
                </div>
                <div style={{ marginBottom: 6 }}>这本书打不开了</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.8 }}>
                  {book.file_type.toUpperCase()} 文件可能已损坏，或这种格式暂不支持。
                  可以先回书架换一本；想确认文件是否完好，可用系统默认程序打开它。
                </div>
                <div className="form-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
                  <button className="btn-secondary" onClick={onBack}>返回书架</button>
                  <button className="btn-primary" onClick={loadBook}>重新加载</button>
                </div>
                <details style={{ marginTop: 14, textAlign: 'left' }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12 }}>
                    查看详情
                  </summary>
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8, wordBreak: 'break-all' }}>
                    {error}
                  </p>
                </details>
              </div>
            </div>
          )}
          {!loading && !error && isComicFile(book.file_type) && totalPages > 0 && (
            <div
              {...panHandlers}
              className={panClass('comic-pane')}
              style={{
                // 这里必须是 height:100%。`flex: 1` 在这一层是无效声明——
                // .reader-content 不是 flex 容器，高度会退化成 auto 随图片撑开，
                // 容器自身不滚，比窗口高的漫画页会被直接裁掉、滚不到。
                height: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                overflow: 'auto',
                padding: 8 + typo.pageGap,
                minWidth: 0,
              }}
            >
              {comicPageData ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 8 + typo.pageGap,
                    justifyContent: 'center',
                    alignItems: 'flex-start',
                    maxWidth: '100%',
                  }}
                >
                  {/* 右向左时页码大的在左边，与日漫阅读顺序一致 */}
                  {(comicRtl ? [comicNextData, comicPageData] : [comicPageData, comicNextData])
                    .filter((p): p is { data: string; mime: string } => p !== null)
                    .map((page, i) => (
                      <img
                        key={i}
                        src={`data:${page.mime};base64,${page.data}`}
                        alt=""
                        // 不关掉的话按住拖动走的是 HTML5 拖拽（拖出一张半透明残影），
                        // 指针事件被它吃掉，平移就永远触发不了
                        draggable={false}
                        style={{
                          maxWidth: comicSpread ? '50%' : '100%',
                          height: 'auto',
                          objectFit: 'contain',
                        }}
                      />
                    ))}
                </div>
              ) : (
                <p className="empty-text">加载中…</p>
              )}
            </div>
          )}
          {!loading && !error && book.file_type === 'txt' && txtPages.length > 0 && (
            <div
              ref={txtRef}
              className="txt-page"
              style={{
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
                fontFamily: stackOfFontKey(fontKey) || undefined,
                background: typo.bgColor || undefined,
                color: typo.textColor || undefined,
                paddingLeft: typo.pagePadding,
                paddingRight: typo.pagePadding,
                // 叠加在样式表的默认留白（上 40 / 下 60）之上，默认 0 时外观与原来一致
                paddingTop: 40 + typo.pageGap,
                paddingBottom: 60 + typo.pageGap,
                // 字间距：TXT 无段落结构，首行缩进不适用，只给字符加间距
                letterSpacing: typo.letterSpacing ? `${typo.letterSpacing}em` : undefined,
                columnCount: dualColumn ? 2 : undefined,
                columnGap: dualColumn ? '48px' : undefined,
                writingMode: vertical ? 'vertical-rl' : undefined,
              } as CSSProperties}
              onMouseUp={handleTxtMouseUp}
              onClick={handleTxtMarkClick}
              onScroll={txtFlowRange ? handleTxtFlowScroll : undefined}
            >
              {txtFlowRange ? (
                // 滑动模式：整块连排渲染，每页带 data-page 供滚动回填与跳转定位
                Array.from({ length: txtFlowRange[1] - txtFlowRange[0] + 1 }, (_, k) => {
                  const p = txtFlowRange[0] + k;
                  const html = txtFlowHtml?.[k];
                  return (
                    <div className="txt-flow-page" data-page={p} key={p}>
                      {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : txtPages[p]}
                    </div>
                  );
                })
              ) : txtHtml ? (
                <span dangerouslySetInnerHTML={{ __html: txtHtml }} />
              ) : (
                txtPages[pageIndex]
              )}
            </div>
          )}
          {!loading && !error && isDoc && docHtml && (
            // 整篇一个滚动容器，不切章不分页：文档型格式 本来就没有页码这回事，
            // 定位靠顶层块、跳转靠标题锚点（见上面的 docBlocksOf / goToDocAnchor）
            <div
              ref={txtRef}
              className="txt-page doc-page"
              style={{
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
                fontFamily: stackOfFontKey(fontKey) || undefined,
                background: typo.bgColor || undefined,
                color: typo.textColor || undefined,
                paddingLeft: typo.pagePadding,
                paddingRight: typo.pagePadding,
                paddingTop: 40 + typo.pageGap,
                paddingBottom: 60 + typo.pageGap,
                letterSpacing: typo.letterSpacing ? `${typo.letterSpacing}em` : undefined,
              } as CSSProperties}
              onMouseUp={handleDocMouseUp}
              onClick={handleTxtMarkClick}
              onScroll={handleDocScroll}
              dangerouslySetInnerHTML={{ __html: docDisplayHtml }}
            />
          )}
          {!loading && !error && book.file_type === 'pdf' && !pdfReflow && (
            <div
              {...panHandlers}
              className={panClass('pdf-page')}
              ref={pdfWrapRef}
              // 样式表默认上下 24px，叠加页面间距
              style={{ paddingTop: 24 + typo.pageGap, paddingBottom: 24 + typo.pageGap }}
            >
              <canvas ref={canvasRef} />
            </div>
          )}
          {!loading && !error && book.file_type === 'pdf' && pdfReflow && reflowPages.length > 0 && (
            <div
              className="txt-page pdf-reflow"
              style={{ fontSize: settings.fontSize, lineHeight: settings.lineHeight }}
            >
              {reflowPages[reflowPage].map((block, i) => {
                const cls = block.kind === 'heading' ? `reflow-heading reflow-h${block.level}` : 'reflow-para';
                // 检索命中后标红：块是纯文本渲染的，没有 DOM 可以插标记，只能自己拼 HTML。
                // 没命中时 marked 为空串，原样走纯文本这条更快的路。
                const marked = searchMark
                  ? markKeywordHtml(block.text, searchMark, {
                      caseSensitive: searchCaseSensitive,
                      wholeWord: searchWholeWord,
                    })
                  : '';
                return marked ? (
                  <p
                    key={i}
                    data-reflow-block={`${reflowPage}-${i}`}
                    className={cls}
                    dangerouslySetInnerHTML={{ __html: marked }}
                  />
                ) : (
                  <p key={i} data-reflow-block={`${reflowPage}-${i}`} className={cls}>
                    {block.text}
                  </p>
                );
              })}
            </div>
          )}

          {/* 点击页面边缘翻页；漫画右向左时左右对调 */}
          {view.clickEdge && !loading && !error && (
            <>
              <div
                className="edge-zone edge-left"
                style={{ width: `${view.edgeWidth}%` }}
                onClick={isComicFile(book.file_type) && comicRtl ? handleNext : handlePrev}
                title={isComicFile(book.file_type) && comicRtl ? '下一页' : '上一页'}
              />
              <div
                className="edge-zone edge-right"
                style={{ width: `${view.edgeWidth}%` }}
                onClick={isComicFile(book.file_type) && comicRtl ? handlePrev : handleNext}
                title={isComicFile(book.file_type) && comicRtl ? '上一页' : '下一页'}
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
          <Icon name="undo" size={16} />
        </button>
        <button
          className="nav-btn ghost"
          onClick={goForward}
          disabled={!histState.canForward}
          title="前进到下一个跳转位置"
        >
          <Icon name="redo" size={16} />
        </button>
        <button className="nav-btn" onClick={handlePrev}>{pageNavLabels.prev}</button>
        {isDoc && (
          <span className="page-indicator" title="文档型格式 没有页码，这里表示读到全篇的位置">
            {docPercent}%
          </span>
        )}
        {book.file_type === 'epub' && chapterIdx != null && chapterTotal > 0 ? (
          <span className="page-indicator wide">
            第{chapterIdx + 1}章 · {chapterPage}/{chapterTotal}页 · {bookPercent}%
          </span>
        ) : null}
        {book.file_type !== 'epub' && pdfReflow && reflowPages.length > 0 && (
          <span className="page-indicator">
            {reflowPage + 1} / {reflowPages.length}
          </span>
        )}
        {book.file_type === 'txt' && txtRawRef.current.length > 0 && (
          <span className="word-count" title="全书字数（不含空白字符）">
            {txtRawRef.current.replace(/\s/g, '').length.toLocaleString()} 字
          </span>
        )}
        {book.file_type !== 'epub' && !pdfReflow && totalPages > 0 && (
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
        <button className="nav-btn" onClick={handleNext}>{pageNavLabels.next}</button>
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
            <Icon name="note" size={14} />
            笔记
          </button>
          <button onClick={() => { speak(sel.text); setSel(null); clearEpubSelection(); }} title="朗读选中">
            <Icon name="volume" size={14} />
            朗读
          </button>
          <button onClick={() => handleHighlight(undefined as any, 'underline')} title="加下划线">
            <span style={{ borderBottom: '2px solid currentColor', paddingBottom: 1 }}>U</span>
          </button>
          <button onClick={() => handleAiQuick('explain')} title="AI 一键短解释">
            <Icon name="sparkles" size={14} />
            解释
          </button>
          <button onClick={() => handleAiQuick('translate')} title="AI 一键翻译">
            <Icon name="globe" size={14} />
            翻译
          </button>
          <button onClick={() => handleAiQuick('define')} title="查词并可存入生词本">
            <Icon name="book-open" size={14} />
            查词
          </button>
          <button
            onClick={async () => {
              // 复制成功与否都要说一声：不出声的话用户会反复点，不知道到底复制上没有
              try {
                await navigator.clipboard.writeText(sel.text);
                showToast('已复制到剪贴板');
              } catch {
                showToast('复制失败，请手动选中文本后按 Ctrl+C');
              }
              setSel(null);
              clearEpubSelection();
            }}
            title="复制"
          >
            <Icon name="copy" size={14} />
            复制
          </button>
          <span className="sel-count">{sel.text.replace(/\s/g, '').length} 字</span>
          <button onClick={() => { setSel(null); clearEpubSelection(); }} title="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* 文本输入弹窗：章节命名、书签改名共用（Electron 不支持 window.prompt） */}
      {textPrompt && (
        <div
          className="modal-mask"
          onClick={() => {
            if (!textPromptBusy) setTextPrompt(null);
          }}
        >
          <div className="note-modal" onClick={e => e.stopPropagation()}>
            <h3>{textPrompt.title}</h3>
            {textPrompt.hint && <p className="section-desc">{textPrompt.hint}</p>}
            <input
              className="tag-input"
              style={{ width: '100%' }}
              value={textPrompt.value}
              autoFocus
              onChange={e => setTextPrompt({ ...textPrompt, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') void submitTextPrompt();
              }}
            />
            <div className="form-actions">
              <button className="btn-secondary" disabled={textPromptBusy} onClick={() => setTextPrompt(null)}>
                取消
              </button>
              <button className="btn-primary" disabled={textPromptBusy} onClick={() => void submitTextPrompt()}>
                {textPromptBusy ? '处理中…' : textPrompt.confirmLabel ?? '保存'}
              </button>
            </div>
          </div>
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
                    // 确认统一由 handleDeleteNote 负责，这里不再重复问一次
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
