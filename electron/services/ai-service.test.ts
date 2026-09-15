import { describe, it, expect, vi, afterEach } from 'vitest';
import { AiService, apiUrl, describeHttpError } from './ai-service';

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

describe('外接大模型：地址归一与错误提示', () => {
  it('各家地址写法都能拼出正确端点（含带 /v1 与带 /v4 两种）', () => {
    const chat = (b: string) => apiUrl(b, '/chat/completions');
    // 根地址 → 补 /v1
    expect(chat('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
    // 已带 /v1 → 不再叠加（这是外接模型最常踩的坑）
    expect(chat('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(chat('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions');
    // 通义：路径里带 /compatible-mode/v1
    expect(chat('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    // 智谱是 v4，不能当成没有版本段而补 /v1
    expect(chat('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    );
    // 本机服务与空格
    expect(chat('  http://127.0.0.1:11434/  ')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    // 向量端点同理
    expect(apiUrl('http://localhost:8081/v1', '/embeddings')).toBe('http://localhost:8081/v1/embeddings');
  });

  it('带 /v1 的地址也能正常请求（外接模型最常踩的坑）', async () => {
    stubChatReply('回答');
    const svc = new AiService({
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    await svc.chat([{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('401 说清是密钥问题，404 说清是地址或模型问题', () => {
    expect(describeHttpError(401, 'AI 服务')).toContain('密钥');
    expect(describeHttpError(403, 'AI 服务')).toContain('密钥');
    expect(describeHttpError(404, 'AI 服务')).toContain('模型名');
    expect(describeHttpError(429, 'AI 服务')).toContain('频繁');
  });

  it('非 2xx 时抛出的错误带可操作提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(makeService().chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/密钥/);
  });
});
