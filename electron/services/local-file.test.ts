import { describe, it, expect } from 'vitest';
import { localFileUrl, filePathFromUrl, LOCAL_FILE_SCHEME } from './local-file';

describe('本机文件 URL 编解码', () => {
  it('路径整段编码进路径段，主机名固定且不含可变内容', () => {
    const url = localFileUrl('C:\\Users\\a\\books\\x-cover.jpg');
    expect(url.startsWith(`${LOCAL_FILE_SCHEME}://local/`)).toBe(true);
    const parsed = new URL(url);
    // 主机名会被 Chromium 转小写，路径不能放在那里
    expect(parsed.host).toBe('local');
    // 盘符冒号、路径分隔符若出现在 URL 里，会被 Chromium 规整掉
    expect(url).not.toContain('C:');
    expect(url).not.toContain('\\');
    expect(parsed.pathname.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(filePathFromUrl(url)).toBe('C:\\Users\\a\\books\\x-cover.jpg');
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

  it('编码后不含裸路径分隔符，避免被 URL 规整折叠', () => {
    expect(localFileUrl('C:\\a\\b')).not.toContain('\\');
  });
});
