/**
 * libarchive.js 的 Node 入口（dist/libarchive-node.mjs）没有随附类型声明，
 * 包里给的是另一套编译产物的 d.ts，路径对不上，这里按实际用到的接口补一份。
 */
declare module 'libarchive.js/dist/libarchive-node.mjs' {
  export interface ArchiveEntry {
    /** 压缩包内的完整路径 */
    path: string;
    file: {
      name: string;
      size: number;
      extract(): Promise<File>;
    };
  }

  export interface ArchiveInstance {
    getFilesArray(): Promise<ArchiveEntry[]>;
    close(): Promise<void>;
  }

  export const Archive: {
    /** getWorker 是官方扩展点：不传则按其模块位置自行拼接 worker 路径 */
    init(options?: { getWorker?: () => unknown; workerUrl?: string }): void;
    open(file: string | File | Blob): Promise<ArchiveInstance>;
  };
}
