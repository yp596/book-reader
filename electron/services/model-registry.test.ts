import { describe, it, expect } from 'vitest';
import { MODELS, LLAMA_CPU_ZIP_URL, LLAMA_BIN_NAME } from './model-registry';

describe('model-registry', () => {
  it('两模型端口不冲突', () => {
    const ports = MODELS.map(m => m.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('下载地址均为 https', () => {
    for (const m of MODELS) {
      expect(m.url.startsWith('https://')).toBe(true);
      expect(m.file.endsWith('.gguf')).toBe(true);
      expect(m.sizeMB).toBeGreaterThan(0);
    }
    expect(LLAMA_CPU_ZIP_URL.endsWith('.zip')).toBe(true);
  });

  it('二进制名按平台区分', () => {
    expect(LLAMA_BIN_NAME).toBe(
      process.platform === 'win32' ? 'llama-server.exe' : 'llama-server',
    );
  });
});
