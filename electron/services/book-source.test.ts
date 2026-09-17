import { describe, it, expect, vi, afterEach } from 'vitest';
import { BookSourceCrawler, buildCrawlerFromRow } from './book-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildCrawlerFromRow', () => {
  it('空规则返回 null', () => {
    expect(buildCrawlerFromRow(null)).toBeNull();
    expect(buildCrawlerFromRow({ name: 'x', rules: '' })).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    expect(buildCrawlerFromRow({ name: 'x', rules: '{broken' })).toBeNull();
  });

  it('缺少搜索地址返回 null', () => {
    const rules = JSON.stringify({ search: { url: '', list: '.item' } });
    expect(buildCrawlerFromRow({ name: 'x', rules })).toBeNull();
  });

  it('完整规则返回爬虫实例', () => {
    const rules = JSON.stringify({
      search: { url: 'https://ex.com/s?q={{keyword}}', list: '.item', name: '.t', author: '.a', detail: 'a' },
      chapters: { list: '.ch a', name: '', url: '' },
      content: { content: '.content' },
    });
    expect(buildCrawlerFromRow({ name: 'x', url: 'https://ex.com', rules })).toBeInstanceOf(BookSourceCrawler);
  });
});

describe('BookSourceCrawler.search', () => {
  const html = `
    <div class="item"><span class="t">三体</span><span class="a">刘慈欣</span><a href="/b/1">详情</a></div>
    <div class="item"><span class="t">球状闪电</span><span class="a">刘慈欣</span><a href="/b/2">详情</a></div>
  `;

  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => html })),
    );
  }

  function makeCrawler() {
    return new BookSourceCrawler({
      name: 'test',
      url: 'https://ex.com',
      search: {
        url: 'https://ex.com/s?q={{keyword}}',
        list: '.item',
        name: '.t',
        author: '.a',
        cover: '',
        detail: 'a',
      },
      chapters: { list: '', name: '', url: '' },
      content: { content: '' },
    });
  }

  it('按选择器解析搜索结果', async () => {
    stubFetch();
    const results = await makeCrawler().search('三体');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: '三体', author: '刘慈欣', detail: '/b/1' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('三体')),
      expect.anything(),
    );
  });

  it('请求失败返回空数组（不抛异常）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(await makeCrawler().search('三体')).toEqual([]);
  });
});

describe('BookSourceCrawler.getContent 的分页拼接', () => {
  /** 按 URL 返回不同 HTML，用来模拟多页正文 */
  function stubPages(pages: Record<string, string>) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const html = pages[url];
        if (html == null) throw new Error(`没有为 ${url} 准备页面`);
        return { ok: true, text: async () => html };
      }),
    );
    return calls;
  }

  function makeCrawler(next?: string) {
    return new BookSourceCrawler({
      name: 'test',
      url: 'https://ex.com',
      search: { url: '', list: '', name: '', author: '', cover: '', detail: '' },
      chapters: { list: '', name: '', url: '' },
      content: { content: '.content', next },
    });
  }

  const page = (text: string, nextHref?: string) =>
    `<div class="content">${text}</div>` + (nextHref ? `<a class="next" href="${nextHref}">下一页</a>` : '');

  it('没配 next 规则时只抓一页（原行为不变）', async () => {
    const calls = stubPages({ 'https://ex.com/c/1': page('第一页') });
    const text = await makeCrawler('a.next').getContent('/c/1');
    expect(text).toBe('第一页');
    expect(calls).toEqual(['https://ex.com/c/1']);
  });

  it('配了 next 规则时把后续页拼起来', async () => {
    const calls = stubPages({
      'https://ex.com/c/1': page('第一页', '/c/1_2'),
      'https://ex.com/c/1_2': page('第二页', '/c/1_3'),
      'https://ex.com/c/1_3': page('第三页'),
    });
    const text = await makeCrawler('a.next').getContent('/c/1');
    expect(text).toBe('第一页\n第二页\n第三页');
    expect(calls).toHaveLength(3);
  });

  it('下一页指回自己时停下来，不会无限抓', async () => {
    const calls = stubPages({
      'https://ex.com/c/1': page('首页', '/c/1'),
    });
    const text = await makeCrawler('a.next').getContent('/c/1');
    expect(text).toBe('首页');
    expect(calls).toHaveLength(1);
  });

  it('两页互相指来指去时靠 URL 去重停下', async () => {
    const calls = stubPages({
      'https://ex.com/c/1': page('甲', '/c/2'),
      'https://ex.com/c/2': page('乙', '/c/1'),
    });
    const text = await makeCrawler('a.next').getContent('/c/1');
    expect(text).toBe('甲\n乙');
    expect(calls).toHaveLength(2);
  });

  it('无视 javascript: 之类的假链接，当没有下一页', async () => {
    const calls = stubPages({ 'https://ex.com/c/1': page('正文', 'javascript:void(0)') });
    const text = await makeCrawler('a.next').getContent('/c/1');
    expect(text).toBe('正文');
    expect(calls).toHaveLength(1);
  });

  it('相对地址按当前页解析，能正确跟到下一页', async () => {
    const calls = stubPages({
      'https://ex.com/book/c/1': page('甲', '2.html'),
      'https://ex.com/book/c/2.html': page('乙'),
    });
    const text = await makeCrawler('a.next').getContent('/book/c/1');
    expect(text).toBe('甲\n乙');
    expect(calls[1]).toBe('https://ex.com/book/c/2.html');
  });
});
