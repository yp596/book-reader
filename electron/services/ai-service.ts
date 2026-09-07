export interface AiConfig {
  provider: 'ollama' | 'openai' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class AiService {
  private config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
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
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
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
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) throw new Error(`AI 服务返回 ${response.status}`);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
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
