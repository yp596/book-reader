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
