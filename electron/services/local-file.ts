import path from 'path';
import { app } from 'electron';

/**
 * 本机文件的自定义协议。
 *
 * 渲染进程用 `loadFile` 加载，页面源是 file://，直接把 Windows 绝对路径塞进
 * `<img src>` 会当成相对地址解析、加载不出图片。封面这类本机资源统一走本协议。
 */
export const LOCAL_FILE_SCHEME = 'bookfile';

/** 固定主机名。主机段会被 Chromium 统一转小写，不能用来承载路径 */
const FILE_HOST = 'local';

/**
 * 本机路径 → 渲染进程可用的 URL。
 *
 * 两点约束来自实测（协议注册为 standard 后 Chromium 会按 URL 结构规整）：
 * 1. Windows 盘符的冒号无论是否编码都会被解码后当成主机名分隔符，必须整段编码掉；
 * 2. 主机段会被转小写，而 base64url 大小写敏感，所以路径必须放在路径段里。
 * 合起来就是：固定主机名 + 路径段放 base64url。代价是 URL 不可读。
 */
export const localFileUrl = (filePath: string) =>
  `${LOCAL_FILE_SCHEME}://${FILE_HOST}/${Buffer.from(filePath, 'utf8').toString('base64url')}`;

/** 协议请求 URL → 本机路径 */
export const filePathFromUrl = (url: string) =>
  Buffer.from(new URL(url).pathname.replace(/^\//, ''), 'base64url').toString('utf8');

/** 书库目录：封面等本机资源 */
export const booksDir = () => path.join(app.getPath('userData'), 'books');

/** 用户导入的字体目录 */
export const fontsDir = () => path.join(app.getPath('userData'), 'fonts');

/** 随包分发的资源目录（OCR 模型等）。与主进程产物同级，开发与打包后都能解析到 */
export const resourcesDir = () => path.join(__dirname, '../resources');

const isInside = (dir: string, filePath: string) => {
  const rel = path.relative(dir, path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 协议处理器的访问边界：只放行书库与字体两个目录。
 * 路径必须落在其中之一，否则等于把整个磁盘暴露给渲染进程。
 */
export const isInsideAllowedDir = (filePath: string) =>
  isInside(booksDir(), filePath) || isInside(fontsDir(), filePath) || isInside(resourcesDir(), filePath);

/**
 * 是否落在书库目录内。
 * 删除书籍时要回收的是应用自己拷进来的副本与封面，这个判断比 allowed 更窄，
 * 免得误删字体或随包资源。
 */
export const isInsideBooksDir = (filePath: string) => isInside(booksDir(), filePath);
