// 用 slim 入口：去掉 fromURL（及其 undici 依赖），
// undici 7 的 sqlite 缓存会在 Electron 老 Node 上触发 node:sqlite 崩溃
import * as cheerio from 'cheerio/slim';

/**
 * 单个章节最多翻几页。
 * 这是防呆上限：规则写歪或站点返回异常时，不能让抓取无限跑下去。
 */
const MAX_CONTENT_PAGES = 20;

export interface BookSourceConfig {
  name: string;
  url: string;
  search: {
    url: string;
    list: string;
    name: string;
    author: string;
    cover: string;
    detail: string;
  };
  chapters: {
    list: string;
    name: string;
    url: string;
  };
  content: {
    content: string;
    next?: string;
  };
}

export class BookSourceCrawler {
  private config: BookSourceConfig;

  constructor(config: BookSourceConfig) {
    this.config = config;
  }

  async search(keyword: string): Promise<any[]> {
    try {
      const url = this.config.search.url.replace('{{keyword}}', encodeURIComponent(keyword));
      const html = await this.fetchHtml(url);
      const $ = cheerio.load(html);
      const results: any[] = [];

      $(this.config.search.list).each((_, el) => {
        const $el = $(el);
        results.push({
          name: $el.find(this.config.search.name).text().trim(),
          author: $el.find(this.config.search.author).text().trim(),
          cover: $el.find(this.config.search.cover).attr('src') || '',
          detail: $el.find(this.config.search.detail).attr('href') || '',
        });
      });

      return results;
    } catch (error) {
      console.error('搜索失败:', error);
      return [];
    }
  }

  async getChapters(detailUrl: string): Promise<any[]> {
    try {
      const url = detailUrl.startsWith('http') ? detailUrl : `${this.config.url}${detailUrl}`;
      const html = await this.fetchHtml(url);
      const $ = cheerio.load(html);
      const chapters: any[] = [];

      $(this.config.chapters.list).each((_, el) => {
        const $el = $(el);
        chapters.push({
          name: $el.find(this.config.chapters.name).text().trim(),
          url: $el.find(this.config.chapters.url).attr('href') || '',
        });
      });

      return chapters;
    } catch (error) {
      console.error('获取章节列表失败:', error);
      return [];
    }
  }

  /**
   * 抓章节正文。配了 next 规则的书源会把正文分在多页，只抓第一页的话
   * 用户读到的是残缺的正文、且毫无提示（看起来就像书本身那么短）。
   *
   * 两个守卫缺一不可：站点在末页常把「下一页」指回自己，坏规则也可能绕成环，
   * 所以既按 URL 去重、又卡页数上限。
   */
  async getContent(chapterUrl: string): Promise<string> {
    try {
      const parts: string[] = [];
      const seen = new Set<string>();
      let url = chapterUrl.startsWith('http') ? chapterUrl : `${this.config.url}${chapterUrl}`;

      for (let page = 0; page < MAX_CONTENT_PAGES; page++) {
        if (seen.has(url)) break; // 绕回来了，说明已经抓过
        seen.add(url);

        const html = await this.fetchHtml(url);
        const $ = cheerio.load(html);
        parts.push($(this.config.content.content).text().trim());

        const next = this.findNextUrl($, url);
        if (!next) break;
        url = next;
      }

      return parts.filter(Boolean).join('\n');
    } catch (error) {
      console.error('获取章节内容失败:', error);
      return '';
    }
  }

  /** 按 next 规则找出下一页地址；规则没配、或页面上找不到，都返回 null 表示到此为止 */
  private findNextUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    const rule = this.config.content.next;
    if (!rule) return null;
    let href: string | undefined;
    try {
      href = $(rule).first().attr('href');
    } catch {
      return null; // 非法选择器：当没配处理，不要因为一个坏规则让整章抓不到
    }
    if (!href) return null;

    // 挡掉「像链接但不是正文下一页」的写法
    const trimmed = href.trim();
    if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) return null;

    try {
      return new URL(trimmed, currentUrl).toString();
    } catch {
      return null;
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`请求失败：${response.status}`);
    return response.text();
  }
}

/** 文本净化：按顺序应用全局正则替换，非法规则跳过 */
export function applyTextFilters(
  text: string,
  rules: { pattern: string; replacement: string }[],
): string {
  let out = text;
  for (const r of rules) {
    try {
      out = out.replace(new RegExp(r.pattern, 'g'), r.replacement ?? '');
    } catch {
      /* 非法规则跳过 */
    }
  }
  return out;
}
/** 从数据库行构造爬虫：优先 rules JSON，否则返回 null（规则不完整） */
export function buildCrawlerFromRow(source: any): BookSourceCrawler | null {
  try {
    if (!source?.rules) return null;
    const r = JSON.parse(source.rules);
    if (!r?.search?.url || !r?.search?.list) return null;
    return new BookSourceCrawler({
      name: source.name,
      url: source.url || '',
      search: {
        url: r.search.url || '',
        list: r.search.list || '',
        name: r.search.name || '',
        author: r.search.author || '',
        cover: r.search.cover || '',
        detail: r.search.detail || '',
      },
      chapters: {
        list: r.chapters?.list || '',
        name: r.chapters?.name || '',
        url: r.chapters?.url || '',
      },
      content: {
        content: r.content?.content || '',
        next: r.content?.next,
      },
    });
  } catch {
    return null;
  }
}

// 示例书源配置
export const sampleSources: BookSourceConfig[] = [
  {
    name: '笔趣阁',
    url: 'https://www.example.com',
    search: {
      url: 'https://www.example.com/search?q={{keyword}}',
      list: '.search-list .item',
      name: '.book-title',
      author: '.book-author',
      cover: '.book-cover img',
      detail: '.book-title a',
    },
    chapters: {
      list: '.chapter-list a',
      name: '.chapter-title',
      url: '',
    },
    content: {
      content: '.chapter-content',
    },
  },
];
