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
