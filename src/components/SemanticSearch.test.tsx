import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SemanticSearch } from './SemanticSearch';
import { Book } from '../types';

/**
 * 这几条测的是「点了有没有反应」：检索和建索引都可能在本地跑很久，
 * 用户点了没反应就会以为程序卡死。测试盯的是按钮真的调到了中断接口，
 * 以及中断之后界面回到可用状态——不是「函数算得对不对」。
 */
function makeBook(id: number, title: string): Book {
  return { id, title, file_path: `/books/${id}.epub`, file_type: 'epub', progress: 0, created_at: '' };
}

let searchResolvers: ((v: any) => void)[];
let buildResolvers: ((v: any) => void)[];
let ragAbort: ReturnType<typeof vi.fn>;

function installApi(books: Book[], indexStatus: any[] = []) {
  searchResolvers = [];
  buildResolvers = [];
  ragAbort = vi.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = {
    getAllBooks: vi.fn().mockResolvedValue(books),
    getRagStatus: vi.fn().mockResolvedValue(indexStatus),
    getBookById: vi.fn(),
    buildRagIndex: vi.fn(() => new Promise(r => buildResolvers.push(r))),
    semanticSearch: vi.fn(() => new Promise(r => searchResolvers.push(r))),
    ragAbort,
  };
}

beforeEach(() => {
  installApi([makeBook(1, '测试书')]);
});

afterEach(() => {
  cleanup();
  delete (window as any).electronAPI;
  vi.restoreAllMocks();
});

describe('语义检索的中断', () => {
  it('检索中给出「停止」，点了会真的去中断，并回到可用状态', async () => {
    render(<SemanticSearch books={[]} onOpenBook={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('建立索引')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/例如：主人公为什么离开家乡？/), {
      target: { value: '主人公为什么离开家乡' },
    });
    fireEvent.click(screen.getByText('搜'));
    // 检索没结束前，用户必须看得见一个能按的「停止」
    const stop = screen.getByText('停止');
    fireEvent.click(stop);

    await waitFor(() => expect(ragAbort).toHaveBeenCalledTimes(1));
    // 中断要按「这一次」请求的 ownerId 发，否则停到的是别人
    const ownerId = ragAbort.mock.calls[0][0];
    expect(typeof ownerId).toBe('string');
    expect(ownerId.startsWith('search-')).toBe(true);
    expect((window as any).electronAPI.semanticSearch.mock.calls[0][3]).toBe(ownerId);

    // 按了停止不能一直卡在「查找中」
    await waitFor(() => expect(screen.getByText('搜')).toBeTruthy());
  });

  it('检索自然结束后「停止」跟着消失，不会留下按不动的按钮', async () => {
    render(<SemanticSearch books={[]} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/例如：主人公为什么离开家乡？/), {
      target: { value: '问题' },
    });
    fireEvent.click(screen.getByText('搜'));
    expect(screen.getByText('停止')).toBeTruthy();

    searchResolvers[0]([]);

    await waitFor(() => expect(screen.queryByText('停止')).toBeNull());
    expect(ragAbort).not.toHaveBeenCalled();
  });

  it('建索引中给出「停止」，点了会中断，且不会误报成功', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<SemanticSearch books={[]} onOpenBook={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('建立索引')).toBeTruthy());

    fireEvent.click(screen.getByText('建立索引'));
    fireEvent.click(screen.getByText('停止'));

    await waitFor(() => expect(ragAbort).toHaveBeenCalledTimes(1));
    expect(ragAbort.mock.calls[0][0].startsWith('build-')).toBe(true);
    // 用户自己停的，不该弹「建立完成」这种假消息
    expect(alertSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('建立索引')).toBeTruthy());
  });

  it('同时只允许建一本书，避免两个索引互相覆盖', async () => {
    cleanup();
    installApi([makeBook(1, '甲'), makeBook(2, '乙')]);
    render(<SemanticSearch books={[]} onOpenBook={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('建立索引')).toHaveLength(2));

    const buttons = screen.getAllByText('建立索引') as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(ragAbort).not.toHaveBeenCalled());
    // 第一本在跑，第二本必须点不动
    expect((screen.getByText('建立索引') as HTMLButtonElement).disabled).toBe(true);
  });
});
