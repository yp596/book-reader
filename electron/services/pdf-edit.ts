import fs from 'fs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/**
 * 解析页码范围："1-3,5,7-" → 0 起下标（去重、升序）。
 * 空串表示全部页；"7-" 表示从第 7 页到末页；超出实际页数的部分会被丢掉。
 */
export function parsePageRange(input: string, totalPages: number): number[] {
  const text = (input ?? '').trim();
  if (!text) return Array.from({ length: totalPages }, (_, i) => i);
  const picked = new Set<number>();
  for (const part of text.split(/[,，、\s]+/).filter(Boolean)) {
    const range = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : totalPages;
      for (let i = from; i <= to; i++) {
        if (i >= 1 && i <= totalPages) picked.add(i - 1);
      }
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= totalPages) picked.add(n - 1);
    } else {
      throw new Error(`无法识别的页码：${part}`);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** 读取 PDF；加密文档 pdf-lib 无法处理，这里翻译成人话 */
async function loadPdf(filePath: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(fs.readFileSync(filePath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(msg)) throw new Error('该 PDF 已加密，无法编辑');
    throw new Error(`无法读取 PDF：${msg}`);
  }
}

/**
 * 原子写出 PDF。
 *
 * 直接 writeFileSync 到目标路径有两个坑：写到一半失败（磁盘满、进程被杀）会留下
 * 一个截断的坏 PDF；而用户是可以在保存对话框里挑一个已存在的 PDF 覆盖的，
 * 那原来的文件就永久没了。
 * 先写同目录的 .part、再 rename：同分区 rename 是原子的，失败也只会留下 .part，
 * 目标文件要么是旧的完整版、要么是新的完整版，不存在中间态。
 */
async function savePdfAtomic(doc: PDFDocument, outputPath: string): Promise<void> {
  const buf = await doc.save();
  const tmp = `${outputPath}.part`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
    throw err;
  }
}

/** 合并多个 PDF，返回合并后的总页数 */
export async function mergePdfs(paths: string[], outputPath: string): Promise<number> {
  if (paths.length === 0) throw new Error('没有可合并的文件');
  const out = await PDFDocument.create();
  for (const filePath of paths) {
    const src = await loadPdf(filePath);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  await savePdfAtomic(out, outputPath);
  return out.getPageCount();
}

/** 抽取指定页另存为新 PDF，返回新文档页数 */
export async function extractPages(
  filePath: string,
  pages: string,
  outputPath: string,
): Promise<number> {
  const src = await loadPdf(filePath);
  const indices = parsePageRange(pages, src.getPageCount());
  if (indices.length === 0) throw new Error('页码范围为空');
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);
  await savePdfAtomic(out, outputPath);
  return out.getPageCount();
}

/** 删除指定页另存为新 PDF，返回剩余页数 */
export async function deletePages(
  filePath: string,
  pages: string,
  outputPath: string,
): Promise<number> {
  const src = await loadPdf(filePath);
  const total = src.getPageCount();
  const removing = new Set(parsePageRange(pages, total));
  if (removing.size === 0) throw new Error('页码范围为空');
  if (removing.size >= total) throw new Error('不能删除全部页面');
  // 从后往前删，避免下标偏移
  for (const idx of [...removing].sort((a, b) => b - a)) src.removePage(idx);
  await savePdfAtomic(src, outputPath);
  return src.getPageCount();
}

/** 旋转指定页（空串=全部页），角度为 90 / 180 / 270 */
export async function rotatePages(
  filePath: string,
  pages: string,
  angle: number,
  outputPath: string,
): Promise<number> {
  if (![90, 180, 270].includes(angle)) throw new Error('旋转角度只支持 90 / 180 / 270');
  const src = await loadPdf(filePath);
  const indices = parsePageRange(pages, src.getPageCount());
  for (const idx of indices) {
    const page = src.getPage(idx);
    const current = page.getRotation().angle ?? 0;
    page.setRotation(degrees(((current + angle) % 360 + 360) % 360));
  }
  await savePdfAtomic(src, outputPath);
  return src.getPageCount();
}

/** 缩放到目标裁剪框（按比例留白，单位取页面自身尺寸的百分比） */
export async function cropPages(
  filePath: string,
  pages: string,
  marginPercent: number,
  outputPath: string,
): Promise<number> {
  const ratio = Math.min(Math.max(marginPercent, 0), 45) / 100;
  const src = await loadPdf(filePath);
  const indices = parsePageRange(pages, src.getPageCount());
  for (const idx of indices) {
    const page = src.getPage(idx);
    const { width, height } = page.getSize();
    const dx = width * ratio;
    const dy = height * ratio;
    page.setCropBox(dx, dy, Math.max(width - dx * 2, 1), Math.max(height - dy * 2, 1));
  }
  await savePdfAtomic(src, outputPath);
  return src.getPageCount();
}

/**
 * 加水印：每页居中绘制斜排文字。
 * 注意：内嵌字体用的是 pdf-lib 自带的标准字体，只支持 Latin-1 字符；
 * 中文会抛错，此处翻译为可理解的提示。
 */
export async function addWatermark(
  filePath: string,
  text: string,
  outputPath: string,
): Promise<number> {
  if (!text.trim()) throw new Error('水印文字不能为空');
  const src = await loadPdf(filePath);
  let font;
  try {
    font = await src.embedFont(StandardFonts.Helvetica);
  } catch {
    throw new Error('内嵌字体失败');
  }
  const pages = src.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const size = Math.max(Math.min(width, height) / 12, 14);
    let textWidth: number;
    try {
      textWidth = font.widthOfTextAtSize(text, size);
    } catch {
      throw new Error('水印文字含内置字体不支持的字符（如中文），请改用英文或数字');
    }
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size,
      font,
      color: rgb(0.6, 0.6, 0.6),
      opacity: 0.35,
      rotate: degrees(45),
    });
  }
  await savePdfAtomic(src, outputPath);
  return pages.length;
}

/** 加页码：右下角绘制「当前页 / 总页数」 */
export async function addPageNumbers(filePath: string, outputPath: string): Promise<number> {
  const src = await loadPdf(filePath);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pages = src.getPages();
  pages.forEach((page, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const size = 10;
    const { width } = page.getSize();
    page.drawText(label, {
      x: width - font.widthOfTextAtSize(label, size) - 24,
      y: 18,
      size,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  });
  await savePdfAtomic(src, outputPath);
  return pages.length;
}
