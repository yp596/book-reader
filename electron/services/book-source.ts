import * as cheerio from 'cheerio';

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

  async getContent(chapterUrl: string): Promise<string> {
    try {
      const url = chapterUrl.startsWith('http') ? chapterUrl : `${this.config.url}${chapterUrl}`;
      const html = await this.fetchHtml(url);
      const $ = cheerio.load(html);
      return $(this.config.content.content).text().trim();
    } catch (error) {
      console.error('获取章节内容失败:', error);
      return '';
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    return response.text();
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
