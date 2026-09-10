import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { app } from 'electron';

/**
 * 本机文件的自定义协议。
 *
 * 渲染进程用 `loadFile` 加载，页面源是 file://，直接把 Windows 绝对路径塞进
 * `<img src>` 会当成相对地址解析、加载不出图片。封面这类本机资源统一走本协议。
 */
export const LOCAL_FILE_SCHEME = 'bookfile';

/** 本机路径 → 渲染进程可用的 URL（编码交给 Node，避免盘符冒号被误编码） */
export const localFileUrl = (filePath: string) =>
  pathToFileURL(filePath).href.replace(/^file:/, `${LOCAL_FILE_SCHEME}:`);

/** 协议请求 URL → 本机路径（平台本地分隔符，便于与其它路径直接比较） */
export const filePathFromUrl = (url: string) =>
  fileURLToPath(url.replace(new RegExp(`^${LOCAL_FILE_SCHEME}:`), 'file:'));

/** 书库目录：封面等本机资源只允许从这里读取 */
export const booksDir = () => path.join(app.getPath('userData'), 'books');

/** 路径是否位于书库目录内（协议处理器的访问边界） */
export const isInsideBooksDir = (filePath: string) => {
  const rel = path.relative(booksDir(), path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
