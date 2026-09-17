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

/**
 * 清掉 onnxruntime 带出来的 wasm 资产。
 * ort 对若干用不到的后端仍写了 new URL(..., import.meta.url)，Vite 会照着把
 * .wasm 复制进 dist（jsep 那份 27MB）。本项目的 wasm 二进制由主进程读好、
 * 经 IPC 送进渲染进程，这些资产永远不会被取用。
 */
function dropOrtWasmAssets() {
  return {
    name: 'drop-ort-wasm-assets',
    closeBundle() {
      const dir = path.resolve(process.cwd(), 'dist/assets');
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (/^ort-wasm-.*\.wasm$/.test(file)) fs.unlinkSync(path.join(dir, file));
      }
    },
  };
}

/**
 * 清掉历次构建留下的失效分块。
 * vite-plugin-electron 每次构建都按内容哈希写新文件名，旧文件既不覆盖也不删除；
 * 而 electron-builder 的 files 是整目录收录，不清的话安装包里会塞进几百 MB 的死代码
 * （实测曾累积到 406MB / 348 个文件，其中只有 4 个是活的）。
 *
 * 做法：从入口 main.js / preload.js 出发做可达性闭包，只删 .js 里没人引用的。
 * 不用「按文件名删除」是因为分块命名由构建器决定，写死了迟早失配。
 */
function pruneStaleElectronChunks() {
  return {
    name: 'prune-stale-electron-chunks',
    closeBundle() {
      const dir = path.resolve(process.cwd(), 'dist-electron');
      if (!fs.existsSync(dir)) return;
      const entries = ['main.js', 'preload.js'].filter(f => fs.existsSync(path.join(dir, f)));
      if (entries.length === 0) return;

      // 可达性闭包：静态 require / import 逐层展开
      const alive = new Set<string>(entries);
      const queue = [...entries];
      while (queue.length > 0) {
        const name = queue.pop() as string;
        const full = path.join(dir, name);
        if (!fs.existsSync(full)) continue;
        const code = fs.readFileSync(full, 'utf-8');
        const refs = [
          ...code.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g),
          ...code.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+)["']/g),
        ];
        for (const m of refs) {
          if (!alive.has(m[1])) {
            alive.add(m[1]);
            queue.push(m[1]);
          }
        }
      }

      // 刚写出来的文件不碰：万一两个子构建有并发，删到正在写的分块会把包打坏，
      // 留到下次构建再清没有代价
      const guardMs = 5000;
      let removed = 0;
      let freed = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || alive.has(f)) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs < guardMs) continue;
          freed += st.size;
          fs.unlinkSync(full);
          removed++;
        } catch { /* 删不掉就跳过 */ }
      }
      if (removed > 0) {
        console.log(`[prune] 清理失效分块 ${removed} 个，释放 ${(freed / 1048576).toFixed(1)} MB`);
      }
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
              //
              // 下面这批重型解析库同样必须外部：内联它们会让 rollup 展开整棵依赖树，
              // 构建期内存溢出（实测 dev 崩在 transforming 阶段，把 Node 堆抬到 4GB
              // 也只是从「JS heap 溢出」变成「Zone 分配失败」）。用正则而非字符串，
              // 是为了同时命中子路径（cheerio/slim、pdfjs-dist/build/...）。
              //
              // ⚠️ 改这里必须同步改 electron-builder.yml 的 files 白名单——
              // external 的包运行时靠 require 从 node_modules 取，打包时不在包里就会
              // 一启动就 Cannot find module。
              external: [
                'sql.js',
                'node-llama-cpp',
                'libarchive.js/dist/libarchive-node.mjs',
                /^pdfjs-dist/,
                /^epubjs/,
                /^mammoth/,
                /^marked/,
                /^katex/,
                /^jszip/,
                /^pdf-lib/,
                /^cheerio/,
                /^webdav/,
              ],
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
          // 清理挂在第二个入口上：等两个子构建都写完再算可达性，避免删到正在写的分块
          build: { outDir: 'dist-electron' },
          plugins: [pruneStaleElectronChunks()],
        },
      },
    ]),
    renderer(),
    dropOrtWasmAssets(),
  ],
});
