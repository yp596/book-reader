/**
 * PDF 文字层 → 流式段落。
 *
 * 朴素做法是把 pdfjs 返回的文本片段按顺序拼起来，但片段顺序不等于阅读顺序：
 * 多栏论文会左一栏右一栏地交错，每行还会各自变成一段。这里用坐标把片段还原成
 * 「行 → 段落」，并做分栏检测，使重排结果能读。
 *
 * 全部是纯函数，不依赖 pdfjs 实例，便于单测。
 */

export interface PdfTextItem {
  str: string;
  /** pdfjs 的变换矩阵 [a,b,c,d,e,f]，e 是 x 平移、f 是 y 平移 */
  transform: number[];
  width: number;
  height: number;
}

export interface LayoutLine {
  text: string;
  /** 基线 y（PDF 坐标，向上为正） */
  y: number;
  /** 行左边界 x */
  x: number;
  /** 行右边界 x */
  right: number;
  /** 该行估算字号 */
  fontSize: number;
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const isCjk = (ch: string) => CJK.test(ch);

/** 句末标点：出现在行尾通常意味着这里就是一个自然段结束 */
const SENTENCE_END = /[。！？；：!?;:…」』”"）)】》]$/;
/** 段落开头标记：出现即另起一段 */
const PARA_START = /^(第[一二三四五六七八九十百千\d]+[章节回卷篇]|[•·▪◦*\-—–]\s|[\d]+[.、]\s)/;
/** 标题判据：只看字号。短行并不等于标题——段落末行往往也短 */
const isLikelyHeading = (line: LayoutLine, bodyFontSize: number) =>
  line.fontSize > bodyFontSize * 1.15;

/**
 * 文本片段 → 行。
 * 同一行的判据是基线 y 足够接近（取字号的一半作为容差），
 * 行内按 x 排序后拼接，依据字间距决定是否补空格。
 */
export function itemsToLines(items: PdfTextItem[]): LayoutLine[] {
  const fragments = items
    .filter(it => typeof it.str === 'string' && it.str.trim() !== '')
    .map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width ?? 0,
      fontSize: Math.abs(it.transform[3]) || it.height || 10,
    }));
  if (fragments.length === 0) return [];

  // 先按 y 从大到小（PDF 里 y 越大越靠上），同一行内再按 x
  fragments.sort((a, b) => (Math.abs(a.y - b.y) > 0.5 ? b.y - a.y : a.x - b.x));

  const lines: LayoutLine[] = [];
  let group: typeof fragments = [];
  let groupY = fragments[0].y;
  let groupFont = fragments[0].fontSize;

  const flush = () => {
    if (group.length === 0) return;
    const sorted = [...group].sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = -Infinity;
    let prevChar = '';
    for (const frag of sorted) {
      const ch = frag.str[0] ?? '';
      if (text !== '') {
        const gap = frag.x - prevEnd;
        // 中文字符之间不补空格；拉丁文之间按间距判断，间距过大说明是两段
        const needSpace =
          !isCjk(prevChar) && !isCjk(ch) && gap > Math.max(frag.fontSize * 0.25, 1.2);
        if (needSpace && !text.endsWith(' ')) text += ' ';
      }
      text += frag.str;
      prevEnd = frag.x + frag.width;
      prevChar = frag.str[frag.str.length - 1] ?? ch;
    }
    lines.push({
      text: text.replace(/[ \t]+/g, ' ').trim(),
      y: groupY,
      x: sorted[0].x,
      right: prevEnd,
      fontSize: groupFont,
    });
    group = [];
  };

  for (const frag of fragments) {
    if (group.length === 0) {
      group = [frag];
      groupY = frag.y;
      groupFont = frag.fontSize;
      continue;
    }
    const sameBaseline = Math.abs(frag.y - groupY) <= Math.max(groupFont, frag.fontSize) * 0.5;
    // 横向间距过大说明是另一栏：双栏 PDF 的左右栏首行基线相同，
    // 只按 y 聚类会把两栏并进同一行，阅读顺序就全乱了
    const groupRight = group.reduce((max, f) => Math.max(max, f.x + f.width), -Infinity);
    const farApart = frag.x - groupRight > groupFont * 3;
    if (sameBaseline && !farApart) {
      group.push(frag);
      groupFont = Math.max(groupFont, frag.fontSize);
    } else {
      flush();
      group = [frag];
      groupY = frag.y;
      groupFont = frag.fontSize;
    }
  }
  flush();
  return lines.filter(l => l.text !== '');
}

/**
 * 检测竖向分栏：在页面横向找一条「几乎没文字」的空白带。
 * 只做两栏——学术论文的常见形态；三栏及以上收益递减、误判成本高。
 * 返回栏边界（左栏右界），无分栏返回 null。
 */
export function detectColumnSplit(lines: LayoutLine[], pageWidth: number): number | null {
  if (lines.length < 8 || pageWidth <= 0) return null;

  const bins = 100;
  const covered = new Array(bins).fill(0);
  for (const line of lines) {
    const from = Math.max(0, Math.floor((line.x / pageWidth) * bins));
    const to = Math.min(bins - 1, Math.floor((line.right / pageWidth) * bins));
    for (let i = from; i <= to; i++) covered[i]++;
  }

  // 只在中间 60% 找空白带，避免把页边距误判成栏缝
  const lo = Math.floor(bins * 0.2);
  const hi = Math.floor(bins * 0.8);
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = lo; i <= hi; i++) {
    // 覆盖行数不超过总行数 5% 的格子视为空白
    if (covered[i] <= lines.length * 0.05) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > bestLen) {
        bestLen = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && hi + 1 - runStart > bestLen) {
    bestLen = hi + 1 - runStart;
    bestStart = runStart;
  }
  // 空白带要够宽才算栏缝（超过页宽 5%）
  if (bestStart < 0 || bestLen < bins * 0.05) return null;

  const split = ((bestStart + bestLen / 2) / bins) * pageWidth;
  const left = lines.filter(l => l.right <= split);
  const right = lines.filter(l => l.x >= split);
  // 两侧都要有足够的行，否则只是段落缩进造成的偶然空白
  if (left.length < 3 || right.length < 3) return null;
  return split;
}

/** 按栏缝把行分成左右两组，阅读顺序为先整栏左、再整栏右 */
export function splitColumns(lines: LayoutLine[], split: number | null): LayoutLine[] {
  if (split === null) return [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const left = lines.filter(l => l.right <= split).sort((a, b) => b.y - a.y);
  const right = lines.filter(l => l.x >= split).sort((a, b) => b.y - a.y);
  return [...left, ...right];
}

/**
 * 页眉页脚判据用的文本归一化。
 * 页码每页都不同（「第 1 页」「第 2 页」），数字统一替换成 # 才可能匹配上；
 * 空白也压平，避免字间距差异导致同一页眉被判成两串。
 */
export function normalizeForRepeat(text: string): string {
  return text
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 找出跨页重复的页眉页脚。
 *
 * 只看页面上下边缘的一条带（正文极少出现在那里），并要求在足够多的页面上出现过，
 * 避免把正文里反复出现的句子误删。返回需剔除的归一化文本集合。
 */
export function findRepeatingLines(
  pages: LayoutLine[][],
  pageHeights: number[],
  options: { bandRatio?: number; minPages?: number; minRatio?: number } = {},
): Set<string> {
  const { bandRatio = 0.12, minPages = 3, minRatio = 0.3 } = options;
  if (pages.length < minPages) return new Set();

  const seenOnPages = new Map<string, Set<number>>();
  pages.forEach((lines, pageIndex) => {
    const height = pageHeights[pageIndex] ?? 0;
    if (height <= 0) return;
    for (const line of lines) {
      const nearTop = line.y > height * (1 - bandRatio);
      const nearBottom = line.y < height * bandRatio;
      if (!nearTop && !nearBottom) continue;
      const key = normalizeForRepeat(line.text);
      if (!key) continue;
      const pages_ = seenOnPages.get(key) ?? new Set<number>();
      pages_.add(pageIndex);
      seenOnPages.set(key, pages_);
    }
  });

  const threshold = Math.max(minPages, Math.ceil(pages.length * minRatio));
  const repeated = new Set<string>();
  for (const [key, pagesSeen] of seenOnPages) {
    if (pagesSeen.size >= threshold) repeated.add(key);
  }
  return repeated;
}

/**
 * 行 → 段落。
 * 另起一段的判据：上一行以句末标点收尾且明显短于栏宽、行距突然变大、
 * 当前行有缩进、或是标题。
 */
export function linesToParagraphs(lines: LayoutLine[]): string[] {
  if (lines.length === 0) return [];
  const fontSizes = lines.map(l => l.fontSize).sort((a, b) => a - b);
  const bodyFont = fontSizes[Math.floor(fontSizes.length / 2)] || 10;
  // 用行距中位数判断「行距突然变大」；只有一行时用字号兜底
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter(g => g > 0);
  // 用行距中位数判断「行距突然变大」。取偏小的那个中位数：
  // 行数少时若取偏大的，单个大行距会把基准抬高，规则就永远不触发
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap =
    sortedGaps.length > 0
      ? sortedGaps[Math.floor((sortedGaps.length - 1) / 2)]
      : bodyFont * 1.4;
  // 栏宽：多数行的右边界
  const rights = lines.map(l => l.right).sort((a, b) => a - b);
  const columnRight = rights[Math.floor(rights.length * 0.9)] ?? 0;

  const paragraphs: string[] = [];
  let current = '';
  /** 当前段落首行的左边界：缩进要相对它判断。
   *  用全页最左会误判——双栏版面的右栏整体右移，每一行都会被当成有缩进 */
  let paraLeft = 0;

  const join = (prev: string, next: string) => {
    const last = prev[prev.length - 1] ?? '';
    const first = next[0] ?? '';
    // 中文直接接上；拉丁文之间补空格；上一行以连字符结尾则吃掉连字符
    if (last === '-' && !isCjk(first)) return prev.slice(0, -1) + next;
    if (isCjk(last) || isCjk(first)) return prev + next;
    return `${prev} ${next}`;
  };

  lines.forEach((line, i) => {
    const prev = i > 0 ? lines[i - 1] : null;
    const gap = prev ? prev.y - line.y : 0;
    // 位置回到更靠上处，说明换栏或换页，必然另起一段
    const columnBreak = prev !== null && gap < 0;
    const indented = current !== '' && line.x - paraLeft > bodyFont * 1.5;
    const prevShort = prev ? prev.right < columnRight - bodyFont * 1.5 : false;
    const startsNew =
      !prev ||
      columnBreak ||
      gap > medianGap * 1.6 ||
      indented ||
      isLikelyHeading(line, bodyFont) ||
      (prevShort && SENTENCE_END.test(prev.text));
    const forced = PARA_START.test(line.text);

    if (startsNew || forced || current === '') {
      if (current) paragraphs.push(current);
      current = line.text;
      paraLeft = line.x;
    } else {
      current = join(current, line.text);
    }
  });
  if (current) paragraphs.push(current);
  return paragraphs;
}
