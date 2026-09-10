/**
 * 临时验证脚本（跑完即删）：验证 libarchive 在真实 Electron 主进程里可用。
 * 覆盖：worker 路径改写是否生效、RAR4/RAR5 能否列出条目并解出字节。
 */
import { app } from 'electron';
import path from 'path';
import { listComicPages, clearComicCache } from './electron/services/comic';

const SAMPLES = 'C:/Users/13772/AppData/Local/Temp/research';

async function main() {
  console.log('[0] appPath       :', app.getAppPath());

  for (const name of ['sample-rar4.rar', 'sample-rar5.rar']) {
    const p = path.join(SAMPLES, name);
    try {
      // 走漫画服务：内部会先 init libarchive（用改写后的 worker 路径）
      const pages = await listComicPages(p);
      console.log(`[1] ${name} 服务调用成功，图片页数:`, pages.length, '（样本无图片，0 属正常）');
    } catch (err) {
      console.log(`[1] ${name} 失败:`, err instanceof Error ? err.message : err);
      continue;
    }
    try {
      const archive = await (Archive as any).open(p);
      const entries = await archive.getFilesArray();
      console.log(`[2] ${name} 原始条目:`, entries.map((e: any) => e.path).join(', '));
      const first = await entries[0].file.extract();
      const buf = Buffer.from(await first.arrayBuffer());
      console.log(`[3] ${name} 解出首文件字节:`, buf.length);
      await archive.close();
    } catch (err) {
      console.log(`[2] ${name} 直连失败:`, err instanceof Error ? err.message : err);
    }
  }

  clearComicCache();
  app.exit(0);
}

app
  .whenReady()
  .then(main)
  .catch(err => {
    console.error('[失败]', err);
    app.exit(1);
  });
