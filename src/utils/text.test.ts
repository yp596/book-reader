import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  excerptAround,
  formatMinutes,
  formatFileSize,
  formatPdfPermissions,
  formatSince,
  stepHitIndex,
  clampPage,
  lineToPageIndex,
  serializeSavedPosition,
  parseSavedPosition,
  findKeyword,
  paginateText,
  epubSectionText,
  markKeywordHtml,
} from './text';

describe('escapeHtml', () => {
  it('转义尖括号和 &', () => {
    expect(escapeHtml('<mark>a&b</mark>')).toBe('&lt;mark&gt;a&amp;b&lt;/mark&gt;');
  });

  it('普通文本原样返回', () => {
    expect(escapeHtml('三体第一章')).toBe('三体第一章');
  });
});

describe('excerptAround', () => {
  it('截取关键词前后各 40 字', () => {
    const text = '前言' + 'x'.repeat(100) + '关键词' + 'y'.repeat(100);
    const result = excerptAround(text, '关键词');
    expect(result).toContain('关键词');
    expect(result.length).toBeLessThanOrEqual(40 + 3 + 40 + 10);
  });

  it('找不到返回空串', () => {
    expect(excerptAround('hello world', '不存在')).toBe('');
  });

  it('大小写不敏感', () => {
    expect(excerptAround('Hello World', 'hello')).toContain('Hello');
  });
});

describe('formatMinutes', () => {
  it('不足一小时显示分钟', () => {
    expect(formatMinutes(30 * 60)).toBe('30 分钟');
  });

  it('超一小时显示小时+分钟', () => {
    expect(formatMinutes(90 * 60)).toBe('1 小时 30 分');
  });

  it('零秒显示 0 分钟', () => {
    expect(formatMinutes(0)).toBe('0 分钟');
  });
});

describe('formatFileSize', () => {
  it('B / KB / MB 进制正确', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('GB 保留两位小数', () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });
});

describe('clampPage', () => {
  it('范围内原样返回', () => {
    expect(clampPage(3, 10)).toBe(3);
  });

  it('越界钳制到两端', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
  });

  it('非法输入回退第 1 页', () => {
    expect(clampPage(NaN, 10)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('lineToPageIndex', () => {
  const starts = [0, 10, 20, 30];

  it('行号落在页起始行上，取该页', () => {
    expect(lineToPageIndex(starts, 0)).toBe(0);
    expect(lineToPageIndex(starts, 10)).toBe(1);
    expect(lineToPageIndex(starts, 30)).toBe(3);
  });

  it('行号落在页中间，取所属页', () => {
    expect(lineToPageIndex(starts, 5)).toBe(0);
    expect(lineToPageIndex(starts, 19)).toBe(1);
    expect(lineToPageIndex(starts, 29)).toBe(2);
  });

  it('行号超出范围，钳到末页', () => {
    expect(lineToPageIndex(starts, 9999)).toBe(3);
  });

  it('行号为负，取首页', () => {
    expect(lineToPageIndex(starts, -1)).toBe(0);
  });

  it('空页表返回 0', () => {
    expect(lineToPageIndex([], 5)).toBe(0);
  });
});

describe('阅读位置序列化', () => {
  it('CFI 往返一致', () => {
    const pos = { cfi: 'epubcfi(/6/12!/4/2/2)' };
    expect(parseSavedPosition(serializeSavedPosition(pos))).toEqual(pos);
  });

  it('页码往返一致', () => {
    const pos = { page: 42 };
    expect(parseSavedPosition(serializeSavedPosition(pos))).toEqual(pos);
  });

  it('PDF 重排屏号与页码并存，往返一致', () => {
    const pos = { page: 3, reflow: 30 };
    expect(parseSavedPosition(serializeSavedPosition(pos))).toEqual(pos);
  });

  it('只有重排屏号也算有效位置', () => {
    expect(parseSavedPosition(JSON.stringify({ reflow: 5 }))).toEqual({ reflow: 5 });
  });

  it('文档型格式的块序号往返一致，且能与别的坐标并存', () => {
    expect(parseSavedPosition(serializeSavedPosition({ docBlock: 12 }))).toEqual({ docBlock: 12 });
    expect(parseSavedPosition(serializeSavedPosition({ page: 1, docBlock: 0 }))).toEqual({
      page: 1,
      docBlock: 0,
    });
  });

  it('早先存下的 mdBlock 仍读得出来（换名前后的进度不能丢）', () => {
    expect(parseSavedPosition(JSON.stringify({ mdBlock: 7 }))).toEqual({ docBlock: 7 });
    expect(parseSavedPosition(JSON.stringify({ page: 2, mdBlock: 7 }))).toEqual({
      page: 2,
      docBlock: 7,
    });
  });

  it('空值与坏数据返回 null', () => {
    expect(parseSavedPosition(null)).toBeNull();
    expect(parseSavedPosition('')).toBeNull();
    expect(parseSavedPosition('{ bad json')).toBeNull();
    expect(parseSavedPosition('{}')).toBeNull();
  });

  it('丢弃非法字段', () => {
    expect(parseSavedPosition(JSON.stringify({ cfi: '', page: -3 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ cfi: 123, page: 1.5 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ reflow: -1, cfi: '' }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ reflow: 2.5, page: -3 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ docBlock: -1 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ docBlock: 1.5 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ mdBlock: -1 }))).toBeNull();
    expect(parseSavedPosition(JSON.stringify({ cfi: 'epubcfi(/6/4!)', page: -1 }))).toEqual({
      cfi: 'epubcfi(/6/4!)',
    });
  });
});

describe('检索关键字的匹配选项', () => {
  it('默认不区分大小写', () => {
    expect(findKeyword('A Cat sat', 'cat')).toEqual({ index: 2, length: 3 });
    expect(findKeyword('A Cat sat', 'CAT')).toEqual({ index: 2, length: 3 });
  });

  it('区分大小写时只认原样写法', () => {
    expect(findKeyword('A Cat sat', 'cat', { caseSensitive: true })).toBeNull();
    expect(findKeyword('A Cat sat', 'Cat', { caseSensitive: true })).toEqual({ index: 2, length: 3 });
  });

  it('全词匹配不命中更长的单词', () => {
    expect(findKeyword('category cat', 'cat')).toEqual({ index: 0, length: 3 });
    expect(findKeyword('category cat', 'cat', { wholeWord: true })).toEqual({ index: 9, length: 3 });
    expect(findKeyword('category', 'cat', { wholeWord: true })).toBeNull();
  });

  it('全词匹配对中文不生效（中文没有词边界）', () => {
    expect(findKeyword('顷刻炼化第二章', '第二章', { wholeWord: true })).toEqual({ index: 4, length: 3 });
  });

  it('正则元字符按字面量处理，不会被当成语法', () => {
    expect(findKeyword('a.b', '.')).toEqual({ index: 1, length: 1 });
    expect(findKeyword('a.b', 'a.b')).toEqual({ index: 0, length: 3 });
    expect(findKeyword('axb', 'a.b')).toBeNull();
    expect(findKeyword('(x)', '(x)')).toEqual({ index: 0, length: 3 });
  });
});

describe('paginateText 章节边界', () => {
  /** 造一段「正文长度不足以自然换页、但章节标题必须另起」的文本 */
  const body = (n: number, tag: string) => Array.from({ length: n }, () => `${tag}正文内容`).join('\n');

  it('没有章节标题时按字数切页（原有行为不能丢）', () => {
    const text = Array.from({ length: 800 }, (_, i) => `第${i}行正文内容`).join('\n');
    const { pages } = paginateText(text, []);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toBe(text + '\n');
  });

  it('章节标题必须落在页首，不能插在上一章的段落中间', () => {
    const text = `${body(30, '甲')}\n第一章 开端\n${body(30, '乙')}`;
    const { pages } = paginateText(text, ['第一章 开端']);
    const hit = pages.find(p => p.includes('第一章 开端'));
    expect(hit).toBeDefined();
    // 标题前面不能还有别的正文
    expect(hit!.split('\n')[0].trim()).toBe('第一章 开端');
  });

  it('一页里不会同时出现两章（这就是被报的 bug）', () => {
    const text = [
      '第一章 甲章', ...Array.from({ length: 40 }, () => '甲章正文'),
      '第二章 乙章', ...Array.from({ length: 40 }, () => '乙章正文'),
      '第三章 丙章', ...Array.from({ length: 40 }, () => '丙章正文'),
    ].join('\n');
    const { pages } = paginateText(text, ['第一章 甲章', '第二章 乙章', '第三章 丙章']);
    for (const page of pages) {
      const heads = ['第一章 甲章', '第二章 乙章', '第三章 丙章'].filter(h =>
        page.split('\n').some(l => l.trim() === h),
      );
      expect(heads.length).toBeLessThanOrEqual(1);
    }
  });

  it('超长章节内部仍按字数分页（章内分页，不是一整章一页）', () => {
    const text = `第一章 长章\n${Array.from({ length: 800 }, () => '正文内容').join('\n')}`;
    const { pages } = paginateText(text, ['第一章 长章']);
    expect(pages.length).toBeGreaterThan(1);
  });

  it('startLines 与 pages 一一对应，供目录行号换页码', () => {
    const text = `${body(10, '甲')}\n第一章 开端\n${body(10, '乙')}`;
    const { pages, startLines } = paginateText(text, ['第一章 开端']);
    expect(startLines).toHaveLength(pages.length);
    // 每页起始行号递增，且指到的那一行确实是该页第一行
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i].split('\n')[0]).toBe(text.split('\n')[startLines[i]]);
    }
  });

  it('标题集合为空时不额外切页，避免老书没目录就乱切', () => {
    const text = `${body(10, '甲')}\n第一章 开端\n${body(10, '乙')}`;
    expect(paginateText(text, []).pages).toHaveLength(paginateText(text, []).pages.length);
    expect(paginateText(text, []).pages.length).toBeLessThan(paginateText(text, ['第一章 开端']).pages.length);
  });

  it('空白标题被忽略，不会把每个空行都当章界', () => {
    const text = '甲\n\n乙\n\n丙';
    const { pages } = paginateText(text, ['', '   ']);
    expect(pages).toHaveLength(1);
  });
});

describe('epubSectionText 取章节正文', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  /**
   * 回归护栏：epub.js 的 Section.load() 交出的是 documentElement（<html> 元素），
   * 不是 Document。谁把实现改回读 `.body`，这条就会掉成空串——
   * 而线上表现是「检索不报错、永远 0 命中」，从现象完全看不出是这一行。
   */
  it('传 <html> 元素（epub.js 的实际形状）能取到正文', () => {
    const doc = parse('<html><head><title>书名</title></head><body><p>第一章的正文内容</p></body></html>');
    expect(epubSectionText(doc.documentElement)).toContain('第一章的正文内容');
  });

  it('不把 <head> 里的标题与样式搜进去', () => {
    const doc = parse('<html><head><title>书名甲</title><style>p{color:red}</style></head><body>正文乙</body></html>');
    const text = epubSectionText(doc.documentElement);
    expect(text).toContain('正文乙');
    expect(text).not.toContain('书名甲');
    expect(text).not.toContain('color');
  });

  it('传 Document 本身也取得到（章节缓存路径的余量）', () => {
    const doc = parse('<html><body>正文丙</body></html>');
    expect(epubSectionText(doc)).toContain('正文丙');
  });

  it('空值不抛错，返回空串', () => {
    expect(epubSectionText(null)).toBe('');
    expect(epubSectionText(undefined)).toBe('');
  });
});

describe('markKeywordHtml 给纯文本打检索标记', () => {
  it('命中词包成 mark', () => {
    expect(markKeywordHtml('前有正文后有', '正文')).toBe('前有<mark class="search-mark">正文</mark>后有');
  });

  it('多处命中都标上', () => {
    const mark = '<mark class="search-mark">甲</mark>';
    expect(markKeywordHtml('甲甲', '甲')).toBe(mark + mark);
  });

  it('原文里的尖括号被转义，不会变成标签', () => {
    // 这条是安全性所在：拼出来的 HTML 会直接进 dangerouslySetInnerHTML
    const html = markKeywordHtml('<b>正文</b>', '正文');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('关键词里带尖括号也能命中（两边都转义过，位置对得上）', () => {
    expect(markKeywordHtml('看 <b> 这个', '<b>')).toBe('看 <mark class="search-mark">&lt;b&gt;</mark> 这个');
  });

  it('没命中返回空串，调用方据此走纯文本路径', () => {
    expect(markKeywordHtml('正文', '天书')).toBe('');
  });

  it('关键词为空不标，也避免正则匹配一切', () => {
    expect(markKeywordHtml('正文', '   ')).toBe('');
  });
});

describe('检索命中的步进', () => {
  it('还没跳过时：下一个去第一处，上一个去最后一处', () => {
    expect(stepHitIndex(-1, 3, 1)).toBe(0);
    expect(stepHitIndex(-1, 3, -1)).toBe(2);
  });

  it('中间步进就是加一减一', () => {
    expect(stepHitIndex(0, 3, 1)).toBe(1);
    expect(stepHitIndex(2, 3, -1)).toBe(1);
  });

  it('到头往回绕——翻找是循环的，末尾再按「下一处」该回到第一处', () => {
    expect(stepHitIndex(2, 3, 1)).toBe(0);
    expect(stepHitIndex(0, 3, -1)).toBe(2);
  });

  it('只有一处时原地不动，不该变成 0 号之外的地方', () => {
    expect(stepHitIndex(0, 1, 1)).toBe(0);
    expect(stepHitIndex(0, 1, -1)).toBe(0);
  });

  it('没有命中返回 -1，调用方据此把按钮置灰', () => {
    expect(stepHitIndex(-1, 0, 1)).toBe(-1);
    expect(stepHitIndex(2, 0, 1)).toBe(-1);
  });

  it('重新检索后列表变短、旧下标越界，落回有效范围', () => {
    expect(stepHitIndex(4, 3, 1)).toBe(2);
    expect(stepHitIndex(4, 3, -1)).toBe(0);
  });
});

describe('文件信息文案', () => {
  it('权限三态各说各的：无限制 / 列出禁止项 / 读不出', () => {
    expect(formatPdfPermissions([])).toBe('无限制');
    expect(formatPdfPermissions(['打印', '复制内容'])).toBe('禁止打印、复制内容');
    // null 是「读不出来」（含非 PDF），不能顺手写成「无限制」——那是在替用户担保没验证过的事
    expect(formatPdfPermissions(null)).toBe('—');
  });

  it('相对时间按档给说法，认不出的时间戳给空串', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(formatSince(ago(30 * 1000))).toBe('刚刚');
    expect(formatSince(ago(5 * 60000))).toBe('5 分钟前');
    expect(formatSince(ago(3 * 3600000))).toBe('3 小时前');
    expect(formatSince(ago(2 * 86400000))).toBe('2 天前');
    expect(formatSince('不是时间')).toBe('');
  });
});
