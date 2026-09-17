/** RAG：文本切分 + embedding 调用 + 余弦检索（纯函数可单测） */
import { apiUrl } from './ai-service';

export interface TextSection {
  /** 章节名 */
  label: string;
  /** 跳转目标 JSON：{href?} 或 {page?} */
  target: string;
  text: string;
}

export interface TextChunk extends TextSection {
  chunkIdx: number;
}

/** 按字切分，overlap 重叠防断句 */
export function splitText(
  section: TextSection,
  size = 500,
  overlap = 100,
): Omit<TextChunk, 'chunkIdx'>[] {
  const clean = section.text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) {
    return [{ label: section.label, target: section.target, text: clean }];
  }
  const out: Omit<TextChunk, 'chunkIdx'>[] = [];
  let start = 0;
  while (start < clean.length) {
    out.push({
      label: section.label,
      target: section.target,
      text: clean.slice(start, start + size),
    });
    if (start + size >= clean.length) break;
    start += size - overlap;
  }
  return out;
}

/** 余弦相似度 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 批量 embedding（优先进程内，失败回退 llama-server /v1/embeddings，兼容 Ollama） */
export async function embedTexts(
  texts: string[],
  baseUrl: string,
  onlineGuard: () => void = () => {},
  signal?: AbortSignal,
): Promise<number[][]> {
  // 优先进程内推理
  try {
    const { embedViaLocal } = await import('./llama-engine');
    const local = await embedViaLocal(texts);
    if (local) return local;
  } catch { /* 回退 HTTP */ }
  // 进程内不可用才会发请求，先过联网闸门
  onlineGuard();
  const out: number[][] = [];
  // 分批防超限
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const response = await fetch(apiUrl(baseUrl, '/embeddings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed', input: batch }),
      // 挂上调用方信号，与 ai-service 的 HTTP 回退保持一致：
      // 缺了它，请求在调用方已经放弃之后仍会跑满超时。
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`向量服务返回 ${response.status}`);
    const data = await response.json();
    const sorted = [...(data.data as { index: number; embedding: number[] }[])].sort(
      (x, y) => x.index - y.index,
    );
    for (const item of sorted) out.push(item.embedding);
  }
  return out;
}
