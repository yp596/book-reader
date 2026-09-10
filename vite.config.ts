import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // 主进程原生/外部依赖保持 require，不打进 bundle。
              // libarchive 必须外部：它顶层用 import.meta.url 算 worker 路径，
              // 打成 CJS 后 import.meta 失效，会在模块加载阶段抛 Invalid URL。
              external: ['sql.js', 'node-llama-cpp', 'libarchive.js/dist/libarchive-node.mjs'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
});
