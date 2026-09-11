import * as ort from 'onnxruntime-web';
import { boxesFromProbabilityMap, type TextBox } from './db-postprocess';
import { ctcGreedyDecode } from './ctc';

/** 检测输入的最长边与对齐步长：PP-OCR 要求边长是 32 的倍数 */
const DET_MAX_SIDE = 960;
const DET_ALIGN = 32;
/** 识别输入高度：PP-OCRv4 的识别模型固定 48 */
const REC_HEIGHT = 48;
/** 识别输入宽度上限，超过会被截断（超长行建议先切分） */
const REC_MAX_WIDTH = 1280;

/** 检测的归一化参数（ImageNet 统计量） */
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
/** 识别的归一化参数 */
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

export interface OcrLine {
  text: string;
  score: number;
  box: TextBox;
}

export interface OcrAssets {
  /** 检测模型 URL */
  detUrl: string;
  /** 识别模型 URL */
  recUrl: string;
  /** 字符表 URL */
  keysUrl: string;
  /**
   * onnxruntime 的 wasm 字节。
   * 不能只给它目录：bookfile:// 的路径没有目录层级，emscripten 加载器按自身 URL
   * 拼相对路径必然找不到，所以由调用方取好字节直接喂进去。
   */
  wasmBinary: ArrayBuffer;
}

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let detInputName = '';
let recInputName = '';
/** 字符表：下标 0 是 CTC 空白符，末尾补一个空格，与 PaddleOCR 的 CTCLabelDecode 对齐 */
let dict: string[] = [];

/** 单例初始化：模型只加载一次，重复调用直接返回 */
let initPromise: Promise<void> | null = null;

export function initOcr(assets: OcrAssets): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      ort.env.wasm.numThreads = 1; // 多线程 wasm 需要跨源隔离头，file:// 下拿不到
      (ort.env.wasm as unknown as { wasmBinary: ArrayBuffer }).wasmBinary = assets.wasmBinary;

      const [detBuf, recBuf, dictText] = await Promise.all([
        fetch(assets.detUrl).then(r => r.arrayBuffer()),
        fetch(assets.recUrl).then(r => r.arrayBuffer()),
        fetch(assets.keysUrl).then(r => r.text()),
      ]);
      detSession = await ort.InferenceSession.create(detBuf);
      recSession = await ort.InferenceSession.create(recBuf);
      detInputName = detSession.inputNames[0];
      recInputName = recSession.inputNames[0];
      dict = [
        ...dictText.split('\n').map(s => s.replace(/\r$/, '')).filter(s => s.length > 0),
        ' ',
      ];
    })().catch(err => {
      initPromise = null; // 失败后允许重试
      throw err;
    });
  }
  return initPromise;
}

export const isOcrReady = () => detSession !== null && recSession !== null;
export const ocrDictSize = () => dict.length;

/** 把画布内容转成 [1,3,H,W] 的归一化张量 */
function canvasToTensor(canvas: HTMLCanvasElement, mean: number[], std: number[]): Float32Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const area = width * height;
  const out = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const p = i * 4;
    out[i] = (data[p] / 255 - mean[0]) / std[0];
    out[area + i] = (data[p + 1] / 255 - mean[1]) / std[1];
    out[2 * area + i] = (data[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(Math.round(w), 1);
  canvas.height = Math.max(Math.round(h), 1);
  return canvas;
}

type ImageSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

function drawToCanvas(src: ImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(src as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const sourceSize = (src: ImageSource) =>
  src instanceof HTMLImageElement ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height };

/** 检测输入尺寸：最长边压到上限内，并向上取整到 32 的倍数 */
function detInputSize(w: number, h: number) {
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(w, h));
  const align = (v: number) => Math.max(DET_ALIGN, Math.ceil((v * scale) / DET_ALIGN) * DET_ALIGN);
  return { width: align(w), height: align(h), scale };
}

/** 识别单行：裁图 → 缩放到固定高度 → 跑模型 → CTC 解码 */
async function recognizeBox(full: HTMLCanvasElement, box: TextBox): Promise<{ text: string; score: number }> {
  const w = Math.max(box.x1 - box.x0 + 1, 1);
  const h = Math.max(box.y1 - box.y0 + 1, 1);
  const targetW = Math.min(Math.max(Math.round((REC_HEIGHT * w) / h), 8), REC_MAX_WIDTH);
  const canvas = createCanvas(targetW, REC_HEIGHT);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(full, box.x0, box.y0, w, h, 0, 0, targetW, REC_HEIGHT);

  const input = new ort.Tensor('float32', canvasToTensor(canvas, REC_MEAN, REC_STD), [
    1, 3, REC_HEIGHT, targetW,
  ]);
  const output = await recSession!.run({ [recInputName]: input });
  const first = output[recSession!.outputNames[0]];
  const dims = first.dims as number[];
  // 形状 [1, T, C]，C 含空白符
  const timesteps = dims[1];
  const classes = dims[2];
  return ctcGreedyDecode(first.data as Float32Array, timesteps, classes, dict);
}

/**
 * 识别整张图：检测文本框 → 逐框识别 → 按阅读顺序返回。
 * 图片会先按原尺寸画到画布，检测跑在缩放版上，识别再按原图裁剪，兼顾速度与清晰度。
 */
export async function recognizeImage(src: ImageSource): Promise<OcrLine[]> {
  if (!isOcrReady()) throw new Error('OCR 引擎尚未初始化');

  const { w, h } = sourceSize(src);
  if (w === 0 || h === 0) throw new Error('图片尺寸无效');
  const full = drawToCanvas(src, w, h);

  const { width: detW, height: detH, scale } = detInputSize(w, h);
  const detCanvas = drawToCanvas(full, detW, detH);
  const detOut = await detSession!.run({
    [detInputName]: new ort.Tensor('float32', canvasToTensor(detCanvas, DET_MEAN, DET_STD), [
      1, 3, detH, detW,
    ]),
  });
  const probTensor = detOut[detSession!.outputNames[0]];
  const boxes = boxesFromProbabilityMap(probTensor.data as Float32Array, detW, detH);
  if (boxes.length === 0) return [];

  // 检测坐标是缩放后的，按回原图的坐标裁切
  const toFull = (box: TextBox): TextBox => ({
    x0: Math.max(Math.round(box.x0 / scale), 0),
    y0: Math.max(Math.round(box.y0 / scale), 0),
    x1: Math.min(Math.round(box.x1 / scale), w - 1),
    y1: Math.min(Math.round(box.y1 / scale), h - 1),
    score: box.score,
  });

  const lines: OcrLine[] = [];
  for (const box of boxes) {
    const fullBox = toFull(box);
    if (fullBox.x1 <= fullBox.x0 || fullBox.y1 <= fullBox.y0) continue;
    const { text, score } = await recognizeBox(full, fullBox);
    if (text.trim()) lines.push({ text, score, box: fullBox });
  }
  return lines;
}

/** 释放会话（切换页面或关闭时调用） */
export async function disposeOcr(): Promise<void> {
  await detSession?.release();
  await recSession?.release();
  detSession = null;
  recSession = null;
  initPromise = null;
}
