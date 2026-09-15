import fs from 'fs';
import path from 'path';

/**
 * 可自动入库的扩展名。
 * 漫画三种压缩包必须与 ipc 里 importOneFile 的白名单一致，否则拖进监视目录的
 * CBR/CBT/CB7 会永远等不到入库，用户也看不到任何提示。
 * 不含 .md：Markdown 常和说明文档混在同一个文件夹里，一并入库会把书架搞脏，
 * 需要时手动导入即可（这是有意与导入对话框不同的地方）。
 */
export const IMPORTABLE_EXTS = ['.epub', '.txt', '.pdf', '.docx', '.cbz', '.cbr', '.cbt', '.cb7'];

/** 是否为可导入文件（纯函数，便于单测） */
export function isImportableFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return IMPORTABLE_EXTS.includes(ext);
}

/** 文件名是否应跳过（隐藏文件、临时文件、同步盘的中间态） */
export function isSkippableFile(name: string): boolean {
  if (!name || name.startsWith('.')) return true;
  // 下载/同步工具的中间态：xxx.epub.part、xxx.tmp、xxx.crdownload
  return /\.(part|tmp|crdownload|download|partial)$/i.test(name);
}

/**
 * 目录监视：目录内出现新的可导入文件时回调。
 *
 * 关键点是防抖——文件是逐步写入的，刚出现时可能只有 0 字节或写了一半。
 * 这里按「文件大小连续两次不变」判定写完，避免导入到半截文件。
 */
export class FolderWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSize = new Map<string, number>();
  private dir = '';

  /** 文件就绪回调（由调用方注入；单例场景下可随时替换） */
  onReady: (filePath: string) => void = () => {};

  constructor(private settleMs = 1200) {}

  isWatching(): boolean {
    return this.watcher !== null;
  }

  watchingDir(): string {
    return this.dir;
  }

  start(dir: string): void {
    this.stop();
    if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在');
    this.dir = dir;
    this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (isSkippableFile(name) || !isImportableFile(name)) return;
      this.schedule(path.join(dir, name));
    });
  }

  /**
   * 等到文件大小连续两次不变才回调，最多检查 10 轮。
   * 首轮只记录大小不回调——文件是逐步写入的，第一次看到就导入会拿到半截内容。
   */
  private schedule(filePath: string, round = 0): void {
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          return; // 文件消失（被移走）就放弃
        }
        const prev = this.lastSize.get(filePath);
        const stable = size > 0 && prev !== undefined && prev === size;
        if (!stable) {
          if (round < 10) {
            this.lastSize.set(filePath, size);
            this.schedule(filePath, round + 1);
          } else {
            this.lastSize.delete(filePath);
          }
          return;
        }
        this.lastSize.delete(filePath);
        try {
          this.onReady(filePath);
        } catch { /* 单文件失败不影响继续监视 */ }
      }, this.settleMs),
    );
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.lastSize.clear();
    try {
      this.watcher?.close();
    } catch { /* 忽略 */ }
    this.watcher = null;
    this.dir = '';
  }
}

let _instance: FolderWatcher | null = null;

/** 全局单例：主进程同一时刻只监视一个目录，也便于退出时统一停掉 */
export function folderWatcher(): FolderWatcher {
  if (!_instance) _instance = new FolderWatcher();
  return _instance;
}
