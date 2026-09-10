/**
 * TXT 文本规整：纯本地处理，无联网、无外部词库依赖。
 * 针对网文常见的乱排版：硬换行折断、冗余空行、行尾空白、零宽字符、行首缩进。
 */

export interface NormalizeOptions {
  /** 过滤控制字符与零宽字符（保留换行） */
  stripInvisible: boolean;
  /** 清理行尾空白 */
  trimLineEnds: boolean;
  /** 去掉行首缩进空格（网文常见整段带前导空格） */
  stripIndent: boolean;
  /** 合并被硬换行折断的段落（价值最高的一项） */
  reflowParagraphs: boolean;
  /** 把连续 3+ 空行压成 1 个空行 */
  collapseBlankLines: boolean;
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  stripInvisible: true,
  trimLineEnds: true,
  stripIndent: true,
  reflowParagraphs: true,
  collapseBlankLines: true,
};

/**
 * 行以此结尾 → 视为完整收尾，不与下一行合并。
 * 只收「终结性」标点：逗号/顿号/分号/冒号恰恰是硬折行的高频断点，
 * 把它们算作结尾会导致该合并的行永远合不上。
 */
const SENTENCE_END = /[。！？…」』】）》〉）)”’\]]$/;
/** 行以此开头 → 视为新段落/标题，不并入上一行 */
const PARA_START =
  /^(第[零一二三四五六七八九十百千万两\d]+[章节回卷篇集部]|序章|序言|楔子|引子|尾声|终章|后记|番外|【|《|「|『|“|")/;

/** 零宽字符、控制字符（保留 \n \t 由后续步骤处理） */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;

export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE, '');
}

export function normalizeLineEnds(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t　]+$/, ''))
    .join('\n');
}

export function stripIndent(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/^[ \t　]+/, ''))
    .join('\n');
}

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/** 判断下一行是否应与上一行合并为同一段 */
export function shouldJoin(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  // 上一行已经正常收尾 → 是段落边界
  if (SENTENCE_END.test(prev)) return false;
  // 下一行是标题/新段落起始 → 是段落边界
  if (PARA_START.test(next)) return false;
  // 下一行本身就是很短的行（疑似标题） → 保守不合并
  if (next.length <= 2) return false;
  return true;
}

export function reflowParagraphs(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      out.push('');
      continue;
    }
    const prevIdx = out.length - 1;
    const prev = prevIdx >= 0 ? out[prevIdx] : '';
    if (prev && shouldJoin(prev, line)) {
      out[prevIdx] = prev + line;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** 按固定顺序执行规整；顺序会影响结果（先清理再重排） */
export function normalizeText(
  text: string,
  options: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): string {
  let out = text;
  if (options.stripInvisible) out = stripInvisibleChars(out);
  if (options.trimLineEnds) out = normalizeLineEnds(out);
  if (options.stripIndent) out = stripIndent(out);
  if (options.reflowParagraphs) out = reflowParagraphs(out);
  if (options.collapseBlankLines) out = collapseBlankLines(out);
  return out.trim();
}

export interface TextStats {
  lines: number;
  blankLines: number;
  chars: number;
}

export function summarizeText(text: string): TextStats {
  const lines = text.split('\n');
  return {
    lines: lines.length,
    blankLines: lines.filter(l => l.trim() === '').length,
    chars: text.length,
  };
}
