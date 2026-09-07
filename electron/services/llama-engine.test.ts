import { describe, it, expect } from 'vitest';
import { buildPromptText } from './llama-engine';

describe('buildPromptText', () => {
  it('system 与 user 分段拼接', () => {
    const out = buildPromptText([
      { role: 'system', content: '你是翻译' },
      { role: 'user', content: 'hello' },
    ]);
    expect(out).toContain('指令：你是翻译');
    expect(out).toContain('输入：hello');
  });

  it('空消息返回空串', () => {
    expect(buildPromptText([])).toBe('');
  });

  it('未知 role 原样保留内容', () => {
    expect(buildPromptText([{ role: 'tool', content: 'x' }])).toBe('x');
  });
});
