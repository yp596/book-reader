import { describe, it, expect } from 'vitest';
import { wrapDocRanges } from './Reader';

/**
 * 文档型格式（Markdown / DOCX）的批注落点靠「块内文本偏移 → 文本节点」这一层换算。
 * 这块最容易出的不是崩，而是**悄悄错位**：偏移算错一点，高亮就套在隔壁几个字上，
 * 用户只会觉得「标歪了」，很难说清哪一步坏了。所以这里把几种典型结构都钉住。
 */
function makeBlock(html: string): { doc: Document; block: HTMLElement } {
  const doc = new DOMParser().parseFromString(`<div id="hold"></div>`, 'text/html');
  const block = doc.getElementById('hold') as HTMLElement;
  block.innerHTML = html;
  return { doc, block };
}

/** 取块内的标记：文本 + 开始位置（按块内纯文本算） */
function marksOf(block: HTMLElement) {
  return Array.from(block.querySelectorAll('mark')).map(m => ({
    text: m.textContent,
    id: m.getAttribute('data-id'),
    cls: m.className,
  }));
}

describe('文档型格式的块内标记', () => {
  it('纯文本块按偏移套准', () => {
    const { doc, block } = makeBlock('<p>从前有座山，山里有座庙</p>');
    wrapDocRanges(doc, block, [{ s: 3, e: 5, id: 1 }]);
    expect(marksOf(block)).toEqual([{ text: '座山', id: '1', cls: '' }]);
  });

  it('跨行内元素边界也能套上（行内标签不会被切碎）', () => {
    const { doc, block } = makeBlock('<p>前面<strong>重点</strong>后面</p>');
    // 「面重点后」横跨 <strong> 的边界
    wrapDocRanges(doc, block, [{ s: 1, e: 5, id: 2 }]);
    expect(marksOf(block)).toEqual([{ text: '面重点后', id: '2', cls: '' }]);
    // 原来的行内标签还在，且被完整包在标记里
    expect(block.querySelector('mark strong')?.textContent).toBe('重点');
  });

  it('多条标记从后往前套，互不挤位', () => {
    const { doc, block } = makeBlock('<p>一二三四五六七八九十</p>');
    wrapDocRanges(doc, block, [
      { s: 0, e: 2, id: 1 },
      { s: 4, e: 6, id: 2 },
      { s: 8, e: 10, id: 3 },
    ]);
    expect(marksOf(block).map(m => m.text)).toEqual(['一二', '五六', '九十']);
    expect(block.textContent).toBe('一二三四五六七八九十');
  });

  it('重叠的两条只留先来的那条', () => {
    const { doc, block } = makeBlock('<p>一二三四五</p>');
    wrapDocRanges(doc, block, [
      { s: 0, e: 3, id: 1 },
      { s: 2, e: 5, id: 2 },
    ]);
    expect(marksOf(block)).toEqual([{ text: '一二三', id: '1', cls: '' }]);
  });

  it('偏移越界被钳到块尾，不会抛错', () => {
    const { doc, block } = makeBlock('<p>短句</p>');
    wrapDocRanges(doc, block, [{ s: 1, e: 999, id: 1 }]);
    expect(marksOf(block)).toEqual([{ text: '句', id: '1', cls: '' }]);
  });

  it('检索标记带类名，书签标记不带', () => {
    const { doc, block } = makeBlock('<p>找这个词</p>');
    wrapDocRanges(doc, block, [{ s: 1, e: 3, cls: 'search-mark' }]);
    expect(marksOf(block)).toEqual([{ text: '这个', id: null, cls: 'search-mark' }]);
  });

  it('起止重合的空区间不产生标记', () => {
    const { doc, block } = makeBlock('<p>文字</p>');
    wrapDocRanges(doc, block, [{ s: 1, e: 1, id: 1 }]);
    expect(marksOf(block)).toEqual([]);
    expect(block.textContent).toBe('文字');
  });

  it('没有文本节点的块（纯图片段落）静默跳过', () => {
    const { doc, block } = makeBlock('<p><img src="a.png" alt="图"></p>');
    expect(() => wrapDocRanges(doc, block, [{ s: 0, e: 2, id: 1 }])).not.toThrow();
    expect(marksOf(block)).toEqual([]);
  });
});
