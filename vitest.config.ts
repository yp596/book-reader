import { defineConfig } from 'vitest/config';

// 注意：不复用 vite.config.ts 作为主配置——electron / renderer 插件会劫持 node 内置模块，
// 主进程测试跑不起来。所以这里只把 vite.config.ts 借给需要 JSX 的渲染进程 project。
export default defineConfig({
  test: {
    // 默认按文件并发 fork worker，每个 worker 都是一整个 node 进程。
    // 本机内存不够时 worker 会被系统直接杀掉，表现为 Worker exited unexpectedly /
    // Zone Allocation failed / WebAssembly Out of memory，而且**退出码仍是 0**、
    // 报告写成「Test Files no tests」——看着像跑过了，其实一个用例都没跑。
    // 串行执行慢一点，但结果是可信的。
    fileParallelism: false,
    // 写死堆上限，避免每个 worker 都按默认值申请、加起来超过物理内存。
    // 主进程测试会加载 wasm，堆开太大反而在 wasm 实例化时 OOM。
    // 放在顶层是因为 test.poolOptions 在 vitest 4 已被移除（放在 test 里只会得到一句
    // DEPRECATED 警告，然后被静默忽略——堆上限根本不生效）。
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=2048'] },
    },
    // 不写 projects 的话顶层这份就是唯一测试环境；两份测试要的环境不同（node / jsdom），
    // 只能拆成 project——放同一个环境里，不是组件测试拿不到 DOM，就是主进程测试被 jsdom 拖慢、被插件劫持。
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['electron/**/*.test.ts'],
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
