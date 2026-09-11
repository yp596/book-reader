import { describe, it, expect } from 'vitest';
import {
  itemsToLines,
  normalizeForRepeat,
  findRepeatingLines,
  type LayoutLine,
  detectColumnSplit,
  splitColumns,
  linesToParagraphs,
  type PdfTextItem,
} from './pdf-layout';

/** 造一个文本片段：transform 里 [4] 是 x、[5] 是 y、[0]/[3] 是缩放（约等于字号） */
const item = (str: string, x: number, y: number, fontSize = 10): PdfTextItem => ({
  str,
  transform: [fontSize, 0, 0, fontSize, x, y],
  width: str.length * fontSize * 0.6,
  height: fontSize,
});

describe('itemsToLines', () => {
  it('同一基线的片段并成一行', () => {
    const lines = itemsToLines([item('Hello', 50, 700), item('world', 95, 700)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello world');
  });

  it('不同基线拆成不同行，且按 y 从大到小排（PDF 的 y 向上为正）', () => {
    const lines = itemsToLines([item('second', 50, 680), item('first', 50, 700)]);
    expect(lines.map(l => l.text)).toEqual(['first', 'second']);
  });

  it('中文字符之间不补空格', () => {
    const lines = itemsToLines([item('中文', 50, 700), item('测试', 62, 700)]);
    expect(lines[0].text).toBe('中文测试');
  });

  it('拉丁文间距过大时补空格', () => {
    const lines = itemsToLines([item('one', 50, 700), item('two', 80, 700)]);
    expect(lines[0].text).toBe('one two');
  });

  it('空片段被忽略', () => {
    expect(itemsToLines([item('   ', 50, 700)])).toEqual([]);
    expect(itemsToLines([])).toEqual([]);
  });
});

describe('detectColumnSplit', () => {
  // 每行铺满约 216px（约占 600 页宽的 36%），栏缝落在页面中部 —— 贴近真实双栏版面
  const twoColumnPage = () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(item(`L${i} `.padEnd(36, 'x'), 50, 700 - i * 20));
    for (let i = 0; i < 10; i++) lines.push(item(`R${i} `.padEnd(36, 'x'), 330, 700 - i * 20));
    return lines;
  };

  it('双栏页面能找出栏缝', () => {
    const lines = itemsToLines(twoColumnPage());
    const split = detectColumnSplit(lines, 600);
    expect(split).not.toBeNull();
    expect(split!).toBeGreaterThan(250);
    expect(split!).toBeLessThan(330);
  });

  it('单栏页面不误判', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`line ${i}`, 50, 700 - i * 20));
    expect(detectColumnSplit(itemsToLines(items), 600)).toBeNull();
  });

  it('行数太少时不做分栏判断', () => {
    expect(detectColumnSplit(itemsToLines([item('a', 50, 700)]), 600)).toBeNull();
  });
});

describe('splitColumns', () => {
  it('阅读顺序是先整栏左、再整栏右', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => item(`L${i} `.padEnd(36, 'x'), 50, 700 - i * 20)),
      ...Array.from({ length: 5 }, (_, i) => item(`R${i} `.padEnd(36, 'x'), 330, 700 - i * 20)),
    ];
    const lines = itemsToLines(items);
    const ordered = splitColumns(lines, detectColumnSplit(lines, 600));
    expect(ordered.slice(0, 5).every(l => l.text.startsWith('L'))).toBe(true);
    expect(ordered.slice(5).every(l => l.text.startsWith('R'))).toBe(true);
  });

  it('无分栏时按 y 自上而下', () => {
    const lines = itemsToLines([item('b', 50, 680), item('a', 50, 700)]);
    expect(splitColumns(lines, null).map(l => l.text)).toEqual(['a', 'b']);
  });
});

describe('linesToParagraphs', () => {
  it('未结束的行接上一行成段', () => {
    const lines = itemsToLines([
      item('这是一段话的开头，', 50, 700),
      item('接着写下去。', 50, 680),
    ]);
    expect(linesToParagraphs(lines)).toEqual(['这是一段话的开头，接着写下去。']);
  });

  it('句末标点且行明显偏短时另起一段', () => {
    const lines = itemsToLines([
      item('第一段到这里就结束了。', 50, 700),
      item('第二段开始，内容比较长一些，', 50, 680),
      item('还要继续写下去才算完整。', 50, 660),
    ]);
    const paragraphs = linesToParagraphs(lines);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toBe('第一段到这里就结束了。');
    expect(paragraphs[1]).toBe('第二段开始，内容比较长一些，还要继续写下去才算完整。');
  });

  it('行距突然变大时另起一段', () => {
    const lines = itemsToLines([
      item('第一行写满了这一栏的宽度继续写', 50, 700),
      item('第二行接着上一行继续往下写', 50, 680),
      item('这一段离得比较远应该另起', 50, 620),
    ]);
    expect(linesToParagraphs(lines)).toHaveLength(2);
  });

  it('拉丁文跨行拼接补空格，行尾连字符吃掉', () => {
    const lines = itemsToLines([
      item('inter-', 50, 700),
      item('national', 50, 680),
    ]);
    expect(linesToParagraphs(lines)).toEqual(['international']);
  });

  it('空输入返回空数组', () => {
    expect(linesToParagraphs([])).toEqual([]);
  });
});

describe('整页组合（行 → 分栏 → 段落）', () => {
  it('双栏页面的段落不会左右串在一起', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item(`左栏第${i}行的内容，`, 50, 700 - i * 20)),
      ...Array.from({ length: 6 }, (_, i) => item(`右栏第${i}行的内容，`, 320, 700 - i * 20)),
    ];
    const lines = itemsToLines(items);
    const paragraphs = linesToParagraphs(splitColumns(lines, detectColumnSplit(lines, 600)));
    // 左栏的内容必须整体排在右栏之前
    const text = paragraphs.join('\n');
    expect(text.indexOf('左栏第0行')).toBeLessThan(text.indexOf('右栏第0行'));
    expect(text.indexOf('左栏第5行')).toBeLessThan(text.indexOf('右栏第0行'));
  });

  it('扫描件（无文字层）得到空结果', () => {
    expect(linesToParagraphs(splitColumns(itemsToLines([]), null))).toEqual([]);
  });
});

describe('页眉页脚剔除', () => {
  const line = (text: string, y: number): LayoutLine => ({
    text, y, x: 50, right: 50 + text.length * 6, fontSize: 10,
  });
  /** 一页：页眉在顶、页脚在底、正文在中间 */
  const page = (header: string, footer: string, body: string) => [
    line(header, 780),
    line(body, 400),
    line(footer, 20),
  ];
  const HEIGHT = 800;

  it('页码不同也能识别成同一个页眉', () => {
    expect(normalizeForRepeat('第 12 页')).toBe(normalizeForRepeat('第 13 页'));
    expect(normalizeForRepeat('  Page   7  ')).toBe('Page #');
  });

  it('跨页重复的页眉页脚被标出', () => {
    const pages = [1, 2, 3, 4].map(n => page(`我的书 第 ${n} 页`, `第 ${n} 页`, `这是第 ${n} 章的正文`));
    const repeated = findRepeatingLines(pages, pages.map(() => HEIGHT));
    // 页眉与页脚都该命中（归一化后形如 "# 我的书 第 # 页" / "第 # 页"）
    expect(repeated.size).toBeGreaterThanOrEqual(2);
    expect([...repeated].some(k => k.includes('我的书'))).toBe(true);
  });

  it('正文里重复出现的句子不会被误删（不在上下边缘带）', () => {
    const pages = [1, 2, 3, 4].map(() => page('页眉', '页脚', '这句话每页都有'));
    const repeated = findRepeatingLines(pages, pages.map(() => HEIGHT));
    expect(repeated.has('这句话每页都有')).toBe(false);
  });

  it('页数太少时不做剔除', () => {
    const pages = [1, 2].map(n => page('页眉', '页脚', `正文 ${n}`));
    expect(findRepeatingLines(pages, pages.map(() => HEIGHT)).size).toBe(0);
  });

  it('出现页数不足阈值时不剔除（避免误删偶发重复）', () => {
    // 20 页里只有 3 页带同一页眉，阈值应为 max(3, 6) = 6
    const pages = Array.from({ length: 20 }, (_, i) =>
      i < 3 ? page('偶发页眉', '页脚', `正文 ${i}`) : page('', '', `正文 ${i}`),
    );
    const repeated = findRepeatingLines(pages, pages.map(() => HEIGHT));
    expect(repeated.has(normalizeForRepeat('偶发页眉'))).toBe(false);
  });
});
