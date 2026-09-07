import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import JSZip from 'jszip';
import { MODELS, LLAMA_CPU_ZIP_URL, LLAMA_BIN_NAME, ModelDef } from './model-registry';
import { DatabaseService } from './db.service';

export interface ModelStatus {
  id: string;
  name: string;
  desc: string;
  sizeMB: number;
  port: number;
  downloaded: boolean;
  running: boolean;
  binReady: boolean;
}

let _instance: ModelService | null = null;

/** 本地模型边车：GGUF 下载 + llama-server 子进程管理 */
export class ModelService {
  private procs = new Map<string, ChildProcess>();
  private downloading = new Set<string>();
  private win: BrowserWindow | null = null;

  static getInstance(): ModelService {
    if (!_instance) _instance = new ModelService();
    return _instance;
  }

  setWindow(win: BrowserWindow | null) {
    this.win = win;
  }

  modelsDir(): string {
    const dir = path.join(app.getPath('userData'), 'models');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  binDir(): string {
    const dir = path.join(app.getPath('userData'), 'bin');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  modelPath(def: ModelDef): string {
    return path.join(this.modelsDir(), def.file);
  }

  isModelDownloaded(def: ModelDef): boolean {
    try {
      const stat = fs.statSync(this.modelPath(def));
      // 允许 5% 误差（断点续传/镜像差异）
      return stat.size >= def.sizeMB * 1024 * 1024 * 0.95;
    } catch {
      return false;
    }
  }

  /** 按优先级找 llama-server：用户目录 > 安装资源 > 开发机路径 */
  resolveBin(): string | null {
    const candidates = [
      path.join(this.binDir(), LLAMA_BIN_NAME),
      // 打包后资源目录
      path.join(process.resourcesPath, 'bin', LLAMA_BIN_NAME),
      // 开发机约定路径
      'D:/llama.cpp/llama-server.exe',
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch { /* 忽略 */ }
    }
    return null;
  }

  isRunning(id: string): boolean {
    const proc = this.procs.get(id);
    return !!proc && proc.exitCode === null && !proc.killed;
  }

  status(): ModelStatus[] {
    const binReady = this.resolveBin() !== null;
    return MODELS.map(def => ({
      id: def.id,
      name: def.name,
      desc: def.desc,
      sizeMB: def.sizeMB,
      port: def.port,
      downloaded: this.isModelDownloaded(def),
      running: this.isRunning(def.id),
      binReady,
    }));
  }

  private emitProgress(id: string, extra: Record<string, unknown>) {
    try {
      this.win?.webContents.send('models:progress', { id, ...extra });
    } catch { /* 窗口已关则忽略 */ }
  }

  private fetchToFile(url: string, dest: string, id: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmp = dest + '.part';
      const file = fs.createWriteStream(tmp);
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'book-reader' } },
        res => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            fs.unlink(tmp, () => {});
            this.fetchToFile(res.headers.location, dest, id, label).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlink(tmp, () => {});
            reject(new Error(`${label}下载失败：HTTP ${res.statusCode}`));
            return;
          }
          const total = Number(res.headers['content-length'] || 0);
          let done = 0;
          res.on('data', chunk => {
            done += chunk.length;
            if (total > 0) {
              this.emitProgress(id, {
                kind: 'download',
                percent: Math.round((done / total) * 100),
                done,
                total,
              });
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.rename(tmp, dest, err => (err ? reject(err) : resolve()));
          });
        },
      );
      req.on('error', err => {
        file.close();
        fs.unlink(tmp, () => {});
        reject(err);
      });
      req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
    });
  }

  /** 确保有 llama-server 二进制（没有则下载解压） */
  async ensureBin(): Promise<string> {
    const found = this.resolveBin();
    if (found) return found;
    if (process.platform !== 'win32') {
      throw new Error('当前仅支持 Windows 自动下载，请手动安装 llama.cpp');
    }
    const id = '__bin__';
    if (this.downloading.has(id)) throw new Error('下载进行中，请稍候');
    this.downloading.add(id);
    try {
      this.emitProgress(id, { kind: 'download', percent: 0 });
      const zipPath = path.join(this.binDir(), 'llama-cpu.zip');
      await this.fetchToFile(LLAMA_CPU_ZIP_URL, zipPath, id, 'llama-server');
      const buf = fs.readFileSync(zipPath);
      const zip = await JSZip.loadAsync(buf);
      const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
      const exeEntry = names.find(n => n.toLowerCase().endsWith('llama-server.exe')) ?? names[0];
      if (!exeEntry) throw new Error('压缩包内未找到 llama-server');
      const data = await zip.file(exeEntry)!.async('nodebuffer');
      const dest = path.join(this.binDir(), LLAMA_BIN_NAME);
      fs.writeFileSync(dest, data);
      fs.unlink(zipPath, () => {});
      this.emitProgress(id, { kind: 'download', percent: 100 });
      return dest;
    } finally {
      this.downloading.delete(id);
    }
  }

  async downloadModel(id: string): Promise<void> {
    const def = MODELS.find(m => m.id === id);
    if (!def) throw new Error('未知模型');
    if (this.downloading.has(id)) throw new Error('下载进行中，请稍候');
    this.downloading.add(id);
    try {
      await this.fetchToFile(def.url, this.modelPath(def), id, def.name);
      this.emitProgress(id, { kind: 'download', percent: 100 });
    } finally {
      this.downloading.delete(id);
    }
  }

  private async waitHealthy(port: number, timeoutMs = 120000): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch { /* 未就绪继续等 */ }
      if (Date.now() - start > timeoutMs) throw new Error('模型服务启动超时');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async start(id: string): Promise<void> {
    if (this.isRunning(id)) return;
    const def = MODELS.find(m => m.id === id);
    if (!def) throw new Error('未知模型');
    if (!this.isModelDownloaded(def)) throw new Error('模型文件缺失，请先下载');
    const bin = await this.ensureBin();
    const proc = spawn(
      bin,
      ['-m', this.modelPath(def), '--port', String(def.port), ...def.args],
      { stdio: 'ignore', windowsHide: true },
    );
    this.procs.set(id, proc);
    proc.on('exit', () => {
      if (this.procs.get(id) === proc) this.procs.delete(id);
    });
    this.emitProgress(id, { kind: 'starting' });
    await this.waitHealthy(def.port);
    this.emitProgress(id, { kind: 'running' });
    this.fillDefaultAddresses(def);
  }

  /** 首次启动成功后回填默认地址（不覆盖用户手填） */
  private fillDefaultAddresses(def: ModelDef) {
    try {
      const db = DatabaseService.getInstance();
      if (def.id === 'chat' && !db.getSetting('aiBaseUrl')) {
        db.setSetting('aiBaseUrl', `http://localhost:${def.port}`);
      }
      if (def.id === 'embed' && !db.getSetting('aiEmbedUrl')) {
        db.setSetting('aiEmbedUrl', `http://localhost:${def.port}`);
      }
    } catch { /* 忽略 */ }
  }

  stop(id: string) {
    const proc = this.procs.get(id);
    if (!proc) return;
    try {
      proc.kill();
    } catch { /* 忽略 */ }
    this.procs.delete(id);
    this.emitProgress(id, { kind: 'stopped' });
  }

  stopAll() {
    for (const id of [...this.procs.keys()]) this.stop(id);
  }

  /** 开机自启：已下载的模型全部拉起（失败不阻塞窗口） */
  async autoStart() {
    for (const def of MODELS) {
      try {
        if (this.isModelDownloaded(def)) await this.start(def.id);
      } catch (err) {
        console.error(`模型自启失败 [${def.id}]:`, err);
      }
    }
  }
}
