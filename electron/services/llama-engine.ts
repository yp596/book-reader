import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { MODELS } from './model-registry';

export interface ChatMessage {
  role: string;
  content: string;
}

/** 把多轮消息压成单段提示词（1B 小模型短提示场景，避免 chat-wrapper 复杂度） */
export function buildPromptText(messages: ChatMessage[]): string {
  return messages
    .map(m => {
      if (m.role === 'system') return `指令：${m.content}`;
      if (m.role === 'user') return `输入：${m.content}`;
      return `${m.content}`;
    })
    .join('\n');
}

type LlamaModule = typeof import('node-llama-cpp');

let _llamaMod: LlamaModule | null = null;
let _llama: any = null;
let _chatChain: {
  model: any;
  context: any;
  sequence: any;
  session: any;
} | null = null;
let _embedChain: { model: any; context: any } | null = null;
// 串行化推理调用（session 不支持并发 prompt）
let _tail: Promise<unknown> = Promise.resolve();

async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _tail;
  let release!: () => void;
  _tail = new Promise<void>(r => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

function modelFile(id: 'chat' | 'embed'): string | null {
  const def = MODELS.find(m => m.id === id);
  if (!def) return null;
  const p = path.join(modelsDir(), def.file);
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p;
  } catch { /* 忽略 */ }
  return null;
}

async function loadModule(): Promise<LlamaModule | null> {
  if (_llamaMod) return _llamaMod;
  try {
    // 动态导入：保持 vitest/tsc 下可解析，缺二进制时抛错由上层回退
    _llamaMod = (await Function('return import("node-llama-cpp")')()) as LlamaModule;
    return _llamaMod;
  } catch (err) {
    console.error('进程内推理不可用（node-llama-cpp 加载失败），回退边车:', err);
    _llamaMod = null;
    return null;
  }
}

async function getLlamaInstance(): Promise<any | null> {
  if (_llama) return _llama;
  const mod = await loadModule();
  if (!mod) return null;
  try {
    _llama = await mod.getLlama();
    return _llama;
  } catch (err) {
    console.error('getLlama 失败，回退边车:', err);
    return null;
  }
}

async function ensureChatChain(): Promise<typeof _chatChain> {
  if (_chatChain) return _chatChain;
  const file = modelFile('chat');
  if (!file) return null;
  const llama = await getLlamaInstance();
  if (!llama) return null;
  const model = await llama.loadModel({ modelPath: file });
  const context = await model.createContext({ contextSize: 4096 });
  const sequence = context.getSequence();
  const { LlamaChatSession } = (await loadModule())!;
  const session = new LlamaChatSession({
    contextSequence: sequence,
    chatWrapper: 'auto',
  });
  _chatChain = { model, context, sequence, session };
  return _chatChain;
}

async function ensureEmbedChain(): Promise<typeof _embedChain> {
  if (_embedChain) return _embedChain;
  const file = modelFile('embed');
  if (!file) return null;
  const llama = await getLlamaInstance();
  if (!llama) return null;
  const model = await llama.loadModel({ modelPath: file });
  const context = await model.createEmbeddingContext();
  _embedChain = { model, context };
  return _embedChain;
}

/** 进程内对话，返回 null 表示不可用（调用方回退 HTTP 边车） */
export async function chatViaLocal(messages: ChatMessage[]): Promise<string | null> {
  try {
    const chain = await ensureChatChain();
    if (!chain) return null;
    const prompt = buildPromptText(messages);
    const result = await runExclusive(() => chain.session.prompt(prompt) as Promise<string>);
    return result || null;
  } catch (err) {
    console.error('进程内对话失败，回退边车:', err);
    return null;
  }
}

/** 进程内 embedding，返回 null 表示不可用 */
export async function embedViaLocal(texts: string[]): Promise<number[][] | null> {
  try {
    const chain = await ensureEmbedChain();
    if (!chain) return null;
    const out: number[][] = [];
    for (const t of texts) {
      const emb = await chain.context.getEmbeddingFor(t);
      out.push(Array.from(emb.vector as readonly number[]));
    }
    return out;
  } catch (err) {
    console.error('进程内 embedding 失败，回退边车:', err);
    return null;
  }
}

/** 退出时释放（失败忽略） */
export async function disposeEngine(): Promise<void> {
  const prev = _tail;
  let release!: () => void;
  _tail = new Promise<void>(r => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    await _chatChain?.session?.dispose?.();
  } catch { /* 忽略 */ }
  try {
    await _chatChain?.context?.dispose?.();
  } catch { /* 忽略 */ }
  try {
    await _chatChain?.model?.dispose?.();
  } catch { /* 忽略 */ }
  try {
    await _embedChain?.context?.dispose?.();
  } catch { /* 忽略 */ }
  try {
    await _embedChain?.model?.dispose?.();
  } catch { /* 忽略 */ }
  _chatChain = null;
  _embedChain = null;
  try {
    await _llama?.dispose?.();
  } catch { /* 忽略 */ }
  _llama = null;
  _llamaMod = null;
  release();
}
