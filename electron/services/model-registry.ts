/** 本地模型注册表（纯数据，可单测；下载与进程管理见 model-service） */

export interface ModelDef {
  id: 'chat' | 'embed';
  name: string;
  desc: string;
  file: string;
  /** 下载地址（镜像优先） */
  url: string;
  sizeMB: number;
  port: number;
  /** llama-server 额外参数 */
  args: string[];
  /** llama-server 发型包（zip，Windows CPU） */
  serverZip?: undefined;
}

export const LLAMA_CPU_ZIP_URL =
  'https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b10731/llama-b10731-bin-win-cpu-x64.zip';

export const LLAMA_BIN_NAME =
  process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

export const MODELS: ModelDef[] = [
  {
    id: 'chat',
    name: 'MiniCPM5-1B（对话）',
    desc: '688MB，划词翻译/短解释/总结问答',
    file: 'MiniCPM5-1B-Q4_K_M.gguf',
    url: 'https://hf-mirror.com/openbmb/MiniCPM5-1B-GGUF/resolve/main/MiniCPM5-1B-Q4_K_M.gguf',
    sizeMB: 688,
    port: 8080,
    args: ['-c', '4096'],
  },
  {
    id: 'embed',
    name: 'nomic-embed（向量）',
    desc: '146MB，语义检索 embedding',
    file: 'nomic-embed-text-v1.5.Q8_0.gguf',
    url: 'https://hf-mirror.com/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf',
    sizeMB: 146,
    port: 8081,
    args: ['--embedding', '-c', '2048'],
  },
];
