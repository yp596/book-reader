/**
 * 文本检测的后处理：把 DB（Differentiable Binarization）模型输出的概率图，
 * 还原成一张张文本框。
 *
 * 流程是「阈值二值化 → 连通域 → 外接矩形 → 按面积与长宽比过滤 → 按比例外扩」。
 * 这里用轴对齐外接矩形而非最小面积矩形：斜排文本会框得略大，
 * 但省掉了轮廓提取与旋转卡壳，普通扫描件足够用。
 */

export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 框内平均置信度 */
  score: number;
}

export interface DetOptions {
  /** 二值化阈值，低于此值视为背景 */
  threshold?: number;
  /** 最小框面积（像素²），滤掉噪点 */
  minArea?: number;
  /** 最小长宽（像素），滤掉细碎块 */
  minSide?: number;
  /** 外扩比例：DB 输出的框比实际文字窄，按高度比例扩一圈 */
  unclipRatio?: number;
  /** 置信度低于此值的框直接丢掉 */
  minScore?: number;
}

const DEFAULTS: Required<DetOptions> = {
  threshold: 0.3,
  minArea: 16,
  minSide: 3,
  unclipRatio: 0.4,
  minScore: 0.5,
};

/**
 * @param prob 概率图，长度必须为 w * h，取值 0~1
 * @param w    概率图宽
 * @param h    概率图高
 */
export function boxesFromProbabilityMap(
  prob: Float32Array | number[],
  w: number,
  h: number,
  options: DetOptions = {},
): TextBox[] {
  const { threshold, minArea, minSide, unclipRatio, minScore } = { ...DEFAULTS, ...options };
  const total = w * h;
  if (prob.length < total || total === 0) return [];

  // 先二值化，避免在连通域里反复比较浮点
  const binary = new Uint8Array(total);
  for (let i = 0; i < total; i++) binary[i] = prob[i] >= threshold ? 1 : 0;

  const visited = new Uint8Array(total);
  const stack: number[] = [];
  const boxes: TextBox[] = [];

  for (let start = 0; start < total; start++) {
    if (binary[start] === 0 || visited[start]) continue;

    // 迭代式洪水填充：递归在大图上会爆栈
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let count = 0;
    let scoreSum = 0;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      count++;
      scoreSum += prob[idx];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 8 邻域：斜向断开的笔画也该连成一块
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;
          if (binary[nIdx] === 1 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    if (boxW * boxH < minArea) continue;
    if (boxW < minSide || boxH < minSide) continue;
    const score = scoreSum / count;
    if (score < minScore) continue;

    // 外扩：按短边的一定比例向四周放，贴近真实文字边缘
    const pad = Math.round(Math.min(boxW, boxH) * unclipRatio);
    boxes.push({
      x0: Math.max(minX - pad, 0),
      y0: Math.max(minY - pad, 0),
      x1: Math.min(maxX + pad, w - 1),
      y1: Math.min(maxY + pad, h - 1),
      score,
    });
  }

  return sortBoxes(boxes);
}

/** 按阅读顺序排：先自上而下分行，同一行内自左向右 */
export function sortBoxes(boxes: TextBox[]): TextBox[] {
  if (boxes.length <= 1) return boxes;
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0);
  const lines: TextBox[][] = [];
  for (const box of sorted) {
    const height = box.y1 - box.y0;
    // 与已有行的纵向重叠超过半行高，就归入该行
    const line = lines.find(l => {
      const ref = l[0];
      const overlap = Math.min(ref.y1, box.y1) - Math.max(ref.y0, box.y0);
      return overlap > Math.min(ref.y1 - ref.y0, height) * 0.5;
    });
    if (line) line.push(box);
    else lines.push([box]);
  }
  return lines.flatMap(line => line.sort((a, b) => a.x0 - b.x0));
}
