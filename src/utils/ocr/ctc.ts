/**
 * CTC 贪心解码：把识别模型逐帧的输出还原成文本。
 *
 * PP-OCR 的识别头输出形状是 [1, T, C]，C = 字典长度 + 1（下标 0 是 CTC 的空白符）。
 * 规则是「去空白、并重复」：相邻同类别只算一次，空白符用来分隔重复字符。
 */

export interface CtcResult {
  text: string;
  /** 平均置信度（只统计真正产出字符的帧） */
  score: number;
}

/**
 * @param probs     形状 [T, C] 的概率（已过 softmax）
 * @param timesteps 时间步数 T
 * @param classes   类别数 C
 * @param dict      字符表，长度应为 C - 1（不含空白符）
 */
export function ctcGreedyDecode(
  probs: Float32Array | number[],
  timesteps: number,
  classes: number,
  dict: string[],
): CtcResult {
  const chars: string[] = [];
  let confSum = 0;
  let confCount = 0;
  let prev = -1;

  for (let t = 0; t < timesteps; t++) {
    const base = t * classes;
    let best = 0;
    let bestP = probs[base];
    for (let c = 1; c < classes; c++) {
      const p = probs[base + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    // 空白符（0）与紧邻重复都跳过
    if (best !== 0 && best !== prev) {
      chars.push(dict[best - 1] ?? '');
      confSum += bestP;
      confCount++;
    }
    prev = best;
  }

  return { text: chars.join(''), score: confCount > 0 ? confSum / confCount : 0 };
}
