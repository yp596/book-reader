export interface AiConfig {
  provider: 'ollama' | 'openai' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/**
 * 拼出 OpenAI 兼容接口的完整地址。
 *
 * 各家的写法不一样：DeepSeek / 通义给到 `…/v1`，智谱给到 `…/api/paas/v4`，
 * Ollama / LM Studio 习惯给根地址。所以这里按「有没有版本段」判断：
 * 已带 `/v1`、`/v4` 这类段就直接接端点，否则补一个 `/v1`。
 * 早先只会删掉结尾的 `/v1` 再拼，遇到智谱这种 v4 地址就拼错了。
 */
export function apiUrl(baseUrl: string, endpoint: '/chat/completions' | '/embeddings'): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return endpoint;
  return /\/v\d+[a-z]*$/i.test(base) ? `${base}${endpoint}` : `${base}/v1${endpoint}`;
}

/** 把 HTTP 状态翻译成用户能照着改的提示：说清是哪一环不对、该改哪里 */
export const describeHttpError = (status: number, what: string): string => {
  if (status === 401 || status === 403) {
    return `${what}拒绝了这次请求（${status}）：密钥不对或没有权限，请检查设置页的 API 密钥`;
  }
  if (status === 404) {
    return `${what}找不到接口或模型（404）：请检查服务地址与模型名，地址一般填到…/v1 之前即可`;
  }
  if (status === 429) {
    return `${what}提示请求过于频繁（429）：稍后再试，或在设置里改用本地模型`;
  }
  if (status >= 500) return `${what}内部出错（${status}）：稍后重试，或换一个服务地址`;
  return `${what}返回 ${status}`;
};

/** 调用方的中断信号 + 120 秒超时，合成一个；任一方 abort 都能真正停下请求 */
const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal => {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

export class AiService {
  private config: AiConfig;
  /**
   * 联网闸门，由调用方注入。
   * 服务层不直接引 electron / 数据库：既保持可单测，也让「能不能联网」
   * 这条策略留在组装处统一决定。
   */
  private onlineGuard: () => void;

  constructor(config: AiConfig, onlineGuard: () => void = () => {}) {
    this.config = config;
    this.onlineGuard = onlineGuard;
  }

  /**
   * 对话统一入口：有 onToken 则走进程内流式（逐 token 回调），
   * 否则走进程内整包；均不可用时回退 HTTP 边车。
   */
  async chat(
    messages: { role: string; content: string }[],
    onToken?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    // 优先进程内推理，失败回退 HTTP 边车（Ollama / llama-server）
    try {
      const engine = await import('./llama-engine');
      const local = onToken
        ? await engine.chatStreamViaLocal(messages, onToken, signal)
        : await engine.chatViaLocal(messages);
      if (local) return local;
    } catch { /* 回退 HTTP */ }
    try {
      // 进程内推理不可用才会走到这里，发请求前先过闸门
      this.onlineGuard();
      const response = await fetch(apiUrl(this.config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
        }),
        // 必须带上调用方的 signal：否则用户点了「停止」这个请求仍在后台跑到超时
        signal: withTimeout(signal, 120000),
      });

      if (!response.ok) throw new Error(describeHttpError(response.status, 'AI 服务'));
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        throw new Error('已停止');
      }
      if ((error as { name?: string } | null)?.name === 'TimeoutError') {
        throw new Error('AI 服务 120 秒内没有响应：请检查服务地址是否正确、模型是否已启动、网络是否可达');
      }
      console.error('AI 调用失败:', error);
      throw error;
    }
  }

  async summarize(text: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的书籍摘要助手。请用简洁的语言总结以下内容，保留关键信息。',
      },
      {
        role: 'user',
        content: `请总结以下内容：\n\n${text}`,
      },
    ], onToken, signal);
  }

  async explain(text: string, question: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的书籍解读助手。请根据提供的文本内容回答用户的问题。',
      },
      {
        role: 'user',
        content: `基于以下内容：\n\n${text}\n\n请回答：${question}`,
      },
    ], onToken, signal);
  }

  async translate(text: string, targetLang: string = 'zh-CN', onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    const target = targetLang === 'zh-CN' ? '中文' : '英文';
    return this.chat([
      {
        role: 'system',
        // 小模型易话痨：强制只输出译文
        content: `你是一个翻译助手。请将用户输入翻译成${target}。只输出译文，不要解释、不要注音、不要添加任何多余内容。`,
      },
      {
        role: 'user',
        content: text,
      },
    ], onToken, signal);
  }

  async generateNotes(text: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的读书笔记助手。请为以下内容生成结构化的读书笔记，包括：\n1. 核心观点\n2. 关键概念\n3. 个人思考',
      },
      {
        role: 'user',
        content: text,
      },
    ], onToken, signal);
  }

  async generateMindmap(text: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    return this.chat([
      {
        role: 'system',
        // 面向小模型：格式约束前置、层级封顶、禁废话
        content:
          '你是一个思维导图助手。把用户输入提炼为层级大纲，只输出Markdown无序列表：顶层用-开头，子级比父级多缩进两空格，最多3层，每行不超过20字。不要解释、不要代码块围栏。',
      },
      {
        role: 'user',
        content: text,
      },
    ], onToken, signal);
  }
}
