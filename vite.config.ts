import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import fs from 'fs';
import path from 'path';

/**
 * 主进程用 pdfjs 解析 PDF 时需要 worker 伴随文件。
 * vite 只打包代码，不会把这个文件带出来；缺了它 PDF 目录会静默变成空数组。
 */
function copyPdfWorker() {
  return {
    name: 'copy-pdf-worker',
    closeBundle() {
      const from = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
      const to = path.resolve(process.cwd(), 'dist-electron/pdf.worker.mjs');
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyPdfWorker()],
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
