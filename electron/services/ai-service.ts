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

  async chat(messages: { role: string; content: string }[]): Promise<string> {
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

  async summarize(text: string): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的书籍摘要助手。请用简洁的语言总结以下内容，保留关键信息。',
      },
      {
        role: 'user',
        content: `请总结以下内容：\n\n${text}`,
      },
    ]);
  }

  async explain(text: string, question: string): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的书籍解读助手。请根据提供的文本内容回答用户的问题。',
      },
      {
        role: 'user',
        content: `基于以下内容：\n\n${text}\n\n请回答：${question}`,
      },
    ]);
  }

  async translate(text: string, targetLang: string = 'zh-CN'): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: `你是一个专业的翻译助手。请将以下内容翻译成${targetLang === 'zh-CN' ? '中文' : '英文'}。`,
      },
      {
        role: 'user',
        content: text,
      },
    ]);
  }

  async generateNotes(text: string): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: '你是一个专业的读书笔记助手。请为以下内容生成结构化的读书笔记，包括：\n1. 核心观点\n2. 关键概念\n3. 个人思考',
      },
      {
        role: 'user',
        content: text,
      },
    ]);
  }
}
