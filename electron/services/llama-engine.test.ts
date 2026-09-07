import { describe, it, expect, vi } from 'vitest';
import { buildPromptText, chatStreamViaLocal } from './llama-engine';

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

describe('chatStreamViaLocal（无模型时）', () => {
  it('模型文件缺失返回 null（不抛错，供调用方回退）', async () => {
    // vitest 下无 electron app，modelFile 直接失败，全程不碰原生模块
    const onToken = vi.fn();
    const result = await chatStreamViaLocal(
      [{ role: 'user', content: 'hi' }],
      onToken,
    );
    expect(result).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });
});
