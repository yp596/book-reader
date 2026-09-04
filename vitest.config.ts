import { defineConfig } from 'vitest/config';

// 注意：不复用 vite.config.ts，避免 electron / renderer 插件劫持 node 内置模块
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
