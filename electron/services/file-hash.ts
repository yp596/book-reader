import fs from 'fs';
import crypto from 'crypto';

/** 采样窗口：首尾各 1MB */
const SAMPLE = 1024 * 1024;

/**
 * 内容指纹：文件大小 + 首尾各 1MB 的 SHA-256。
 *
 * 不做全量哈希——几百 MB 的书全量读一遍会明显拖慢导入，
 * 而「大小 + 首尾」已足以识别重复：同一本书的不同副本不会
 * 只在中间部分不同。代价是极小概率把「同大小且首尾相同、仅中间不同」
 * 的文件误判为重复，这种场景在电子书里基本不存在。
 */
export function contentHash(filePath: string): string {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const headLen = Math.min(SAMPLE, stat.size);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) fs.readSync(fd, head, 0, headLen, 0);

    const tailLen = Math.min(SAMPLE, stat.size);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) fs.readSync(fd, tail, 0, tailLen, Math.max(0, stat.size - tailLen));

    return crypto
      .createHash('sha256')
      .update(String(stat.size))
      .update(head)
      .update(tail)
      .digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
