/**
 * 临时验证脚本（跑完即删）：在真实 Electron 运行时里验证封面链路。
 * 覆盖：封面提取→落盘、bookfile:// 协议注册、渲染进程取回图片字节、越界访问被拒。
 */
import { app, BrowserWindow, protocol, net } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import JSZip from 'jszip';
import { extractCover } from './electron/services/cover';
import { LOCAL_FILE_SCHEME, filePathFromUrl, isInsideBooksDir, localFileUrl } from './electron/services/local-file';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cover-'));
app.setPath('userData', tmp);

// 与 main.ts 完全一致的注册方式：必须在 ready 之前
protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// 最小合法 PNG 头 + 自定义尾字节，便于确认取回的是同一份数据
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
]);

async function main() {
  const booksDir = path.join(tmp, 'books');
  fs.mkdirSync(booksDir, { recursive: true });

  // 造一个 CBZ：01.png 应为自然序首页（02 故意排在前面，验证自然序生效）
  const cbzPath = path.join(booksDir, 'test.cbz');
  const zip = new JSZip();
  zip.file('02.png', Buffer.from([0xaa]));
  zip.file('01.png', PNG);
  fs.writeFileSync(cbzPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const coverUrl = await extractCover(cbzPath, '.cbz', 'verifyhash');
  const coverPath = coverUrl ? filePathFromUrl(coverUrl) : '';
  const coverBytes = coverPath && fs.existsSync(coverPath) ? fs.readFileSync(coverPath) : Buffer.alloc(0);
  console.log('[1] 封面 URL      :', coverUrl);
  console.log('[1] 落盘字节数    :', coverBytes.length, '与首页一致:', coverBytes.equals(PNG));

  // 协议处理器：与 main.ts 一致（此处额外打印收到的 URL 以便定位问题）
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const p = filePathFromUrl(request.url);
    const ok = isInsideBooksDir(p) && fs.existsSync(p);
    console.log('[调试] 收到 URL   :', request.url);
    console.log('[调试] 还原路径   :', p);
    console.log('[调试] 库内/存在  :', isInsideBooksDir(p), fs.existsSync(p));
    if (!ok) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });

  // 用书库内的 HTML 作为页面，保证与封面同源，避免被 CORS 干扰
  const pagePath = path.join(booksDir, 'harness.html');
  fs.writeFileSync(pagePath, '<!doctype html><html><body>verify</body></html>');
  const outsidePath = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outsidePath, 'secret');

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL(localFileUrl(pagePath));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const inside = await fetch(${JSON.stringify(coverUrl ?? '')});
      const buf = inside.ok ? await inside.arrayBuffer() : new ArrayBuffer(0);
      let outsideStatus = 0;
      try { outsideStatus = (await fetch(${JSON.stringify(localFileUrl(outsidePath))})).status; }
      catch (e) { outsideStatus = -1; }
      let missingStatus = 0;
      try { missingStatus = (await fetch(${JSON.stringify(localFileUrl(path.join(booksDir, 'nope.png')))} )).status; }
      catch (e) { missingStatus = -1; }
      return { insideStatus: inside.status, bytes: buf.byteLength, contentType: inside.headers.get('content-type'), outsideStatus, missingStatus };
    })()
  `);
  console.log('[2] 渲染进程取封面 :', JSON.stringify(result));
  console.log('[3] 边界校验 库内  :', isInsideBooksDir(path.join(booksDir, 'a.png')));
  console.log('[3] 边界校验 库外  :', isInsideBooksDir(outsidePath));

  win.destroy();
  // 临时目录交给系统清理：Electron 的缓存文件可能仍被占用，强删会报 EPERM
  app.exit(0);
}

app
  .whenReady()
  .then(main)
  .catch(err => {
    console.error('[失败]', err);
    app.exit(1);
  });
