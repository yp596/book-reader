import { describe, it, expect } from 'vitest';
import {
  stripInvisibleChars,
  normalizeLineEnds,
  stripIndent,
  collapseBlankLines,
  shouldJoin,
  reflowParagraphs,
  normalizeText,
  summarizeText,
  DEFAULT_NORMALIZE_OPTIONS,
} from './text-normalize';

describe('stripInvisibleChars', () => {
  it('移除零宽字符', () => {
    expect(stripInvisibleChars('三​体﻿')).toBe('三体');
  });

  it('移除控制字符但保留换行与制表符', () => {
    expect(stripInvisibleChars('ab\nc\td')).toBe('ab\nc\td');
  });

  it('普通文本不受影响', () => {
    expect(stripInvisibleChars('正常文本')).toBe('正常文本');
  });
});

describe('normalizeLineEnds', () => {
  it('清理行尾空白（含全角空格）', () => {
    expect(normalizeLineEnds('第一行   \n第二行　　\n')).toBe('第一行\n第二行\n');
  });

  it('保留行首空白（由 stripIndent 负责）', () => {
    expect(normalizeLineEnds('  缩进内容  ')).toBe('  缩进内容');
  });
});

describe('stripIndent', () => {
  it('去掉行首空格/制表/全角空格', () => {
    expect(stripIndent('　　第一段\n  第二段\n\t第三段')).toBe('第一段\n第二段\n第三段');
  });

  it('空行保持不变', () => {
    expect(stripIndent('a\n\nb')).toBe('a\n\nb');
  });
});

describe('collapseBlankLines', () => {
  it('连续 3+ 空行压成 1 个空行', () => {
    expect(collapseBlankLines('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('单个空行保留', () => {
    expect(collapseBlankLines('a\n\nb')).toBe('a\n\nb');
  });
});

describe('shouldJoin', () => {
  it('上行以逗号结尾 → 应合并（硬折行高频场景）', () => {
    expect(shouldJoin('他说：“今天天气不错，', '我们走走吧。”')).toBe(true);
  });

  it('上行以句号结尾 → 不合并', () => {
    expect(shouldJoin('他点点头。', '然后离开了。')).toBe(false);
  });

  it('上行以右引号结尾 → 不合并', () => {
    expect(shouldJoin('“你来了。”', '他抬起头。')).toBe(false);
  });

  it('下行是章节标题 → 不合并', () => {
    expect(shouldJoin('正文内容还没结束', '第三章 重逢')).toBe(false);
  });

  it('下行以左引号开头 → 不合并', () => {
    expect(shouldJoin('他慢慢说道', '“我不去。”')).toBe(false);
  });

  it('下行过短（疑似标题）→ 不合并', () => {
    expect(shouldJoin('上一行还没结束', '尾声')).toBe(false);
  });

  it('上下行皆空 → 不合并', () => {
    expect(shouldJoin('', '正文')).toBe(false);
    expect(shouldJoin('正文', '')).toBe(false);
  });
});

describe('reflowParagraphs', () => {
  it('把被硬折行打断的段落合并回一行', () => {
    const input = ['他说：“今天天气不错，', '我们出去走走吧。”'].join('\n');
    expect(reflowParagraphs(input)).toBe('他说：“今天天气不错，我们出去走走吧。”');
  });

  it('正常的段落边界保持不变', () => {
    const input = ['他点点头。', '然后转身离开。'].join('\n');
    expect(reflowParagraphs(input)).toBe('他点点头。\n然后转身离开。');
  });

  it('标题不会被并入上一段', () => {
    const input = ['上一段没有句号结尾', '第二章 相遇'].join('\n');
    expect(reflowParagraphs(input)).toBe('上一段没有句号结尾\n第二章 相遇');
  });

  it('空行作为强制段落边界', () => {
    const input = ['第一段没写完', '', '第二段开头'].join('\n');
    expect(reflowParagraphs(input)).toBe('第一段没写完\n\n第二段开头');
  });
});

describe('normalizeText 整体管线', () => {
  it('网文乱排版：缩进+硬折行+多空行 一次规整', () => {
    const input = [
      '第一章 开端',
      '',
      '',
      '　　他说：“今天天气不错，',
      '　　我们出去走走吧。”',
      '',
      '',
      '',
      '　　然后他走了。',
    ].join('\n');

    const out = normalizeText(input);
    expect(out).toBe([
      '第一章 开端',
      '',
      '他说：“今天天气不错，我们出去走走吧。”',
      '',
      '然后他走了。',
    ].join('\n'));
  });

  it('可单独关闭项：关掉 reflow 后不合并', () => {
    const input = ['他点头，', '然后走了。'].join('\n');
    const out = normalizeText(input, { ...DEFAULT_NORMALIZE_OPTIONS, reflowParagraphs: false });
    expect(out).toBe('他点头，\n然后走了。');
  });

  it('空文本返回空串', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   \n\n  ')).toBe('');
  });

  it('已是良好排版时保持不变', () => {
    const good = '第一段。\n\n第二段。';
    expect(normalizeText(good)).toBe(good);
  });
});

describe('summarizeText', () => {
  it('统计行数/空行数/字符数', () => {
    const s = summarizeText('a\n\nb');
    expect(s.lines).toBe(3);
    expect(s.blankLines).toBe(1);
    expect(s.chars).toBe(4);
  });
});
