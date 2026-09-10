import { describe, it, expect } from 'vitest';
import { localFileUrl, filePathFromUrl, LOCAL_FILE_SCHEME } from './local-file';

describe('本机文件 URL 编解码', () => {
  it('Windows 路径转成协议 URL', () => {
    expect(localFileUrl('C:\\Users\\a\\books\\x-cover.jpg')).toBe(
      `${LOCAL_FILE_SCHEME}:///C:/Users/a/books/x-cover.jpg`,
    );
  });

  it('往返一致（含中文、空格与 # 等特殊字符）', () => {
    const cases = [
      'C:\\Users\\13772\\AppData\\Roaming\\book-reader\\books\\12-cover.jpg',
      'D:\\桌面\\book-reader\\封面 图.png',
      'C:\\a b\\c#d\\e%f.webp',
    ];
    for (const p of cases) {
      expect(filePathFromUrl(localFileUrl(p))).toBe(p);
    }
  });

  it('路径分隔符统一为 /', () => {
    expect(localFileUrl('C:\\a\\b')).not.toContain('\\');
  });
});
