import { describe, it, expect, vi, afterEach } from 'vitest';
import { AiService } from './ai-service';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubChatReply(content: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    })),
  );
}

function makeService() {
  return new AiService({ provider: 'custom', baseUrl: 'http://localhost:11434', model: 'test-model' });
}

describe('AiService.chat', () => {
  it('返回第一候选内容', async () => {
    stubChatReply('你好');
    expect(await makeService().chat([{ role: 'user', content: 'hi' }])).toBe('你好');
  });

  it('带 onToken 时 HTTP 回退仍返回整包（无模型环境）', async () => {
    stubChatReply('完整回答');
    const onToken = vi.fn();
    const result = await makeService().chat([{ role: 'user', content: 'hi' }], onToken);
    expect(result).toBe('完整回答');
  });

  it('请求携带模型与消息', async () => {
    stubChatReply('ok');
    await makeService().chat([{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('test-model'),
      }),
    );
  });

  it('服务端错误时抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(makeService().chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('500');
  });

  it('无候选返回空串', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    expect(await makeService().chat([{ role: 'user', content: 'hi' }])).toBe('');
  });
});

describe('快捷方法', () => {
  it('summarize/explain/translate 走 chat 通道', async () => {
    stubChatReply('done');
    const svc = makeService();
    expect(await svc.summarize('长文本')).toBe('done');
    expect(await svc.explain('长文本', '什么意思？')).toBe('done');
    expect(await svc.translate('hello')).toBe('done');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('translate 提示词要求只输出译文（防小模型话痨）', async () => {
    stubChatReply('译文');
    await makeService().translate('hello');
    const body = (fetch as any).mock.calls[0][1].body as string;
    expect(body).toMatch(/只输出译文/);
  });
});
