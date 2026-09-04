/** HTML 转义（配合 dangerouslySetInnerHTML 使用） */
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 取关键词前后摘要（检索结果用） */
export const excerptAround = (text: string, keyword: string, radius = 40) => {
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return '';
  const clean = text.replace(/\s+/g, ' ');
  return clean.slice(Math.max(0, idx - radius), idx + keyword.length + radius);
};

/** 秒数转中文时长 */
export const formatMinutes = (seconds: number) => {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};

/** 字节数转可读大小 */
export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** 页码钳制到 [1, total] */
export const clampPage = (page: number, total: number) => {
  if (total <= 0) return 1;
  if (Number.isNaN(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), total);
};
