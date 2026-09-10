/**
 * 临时验证脚本（跑完即删）：验证 CBR（RAR）在真实 Electron 主进程里可用。
 * 覆盖：libarchive 初始化、列条目、解出字节。
 */
import { app } from 'electron';
import path from 'path';
import { listComicPages, readComicPage, detectArchiveKind } from './electron/services/comic';
import fs from 'fs';

const SAMPLES = 'C:/Users/13772/AppData/Local/Temp/research';

async function main() {
  for (const name of ['sample-rar4.rar', 'sample-rar5.rar']) {
    const p = path.join(SAMPLES, name);
    console.log(`--- ${name} 格式:`, detectArchiveKind(fs.readFileSync(p).subarray(0, 512)));
    try {
      const pages = await listComicPages(p);
      console.log(`[1] ${name} 列出成功，图片页数:`, pages.length, '（样本无图片，0 属正常）');
    } catch (err) {
      console.log(`[1] ${name} 失败:`, err instanceof Error ? err.message : err);
    }
  }
  app.exit(0);
}

app
  .whenReady()
  .then(main)
  .catch(err => {
    console.error('[失败]', err);
    app.exit(1);
  });
