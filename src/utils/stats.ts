/** 周统计：把按日时长补齐为连续 7 天序列（今天在末位） */
export interface DayStat {
  date: string; // MM-DD
  fullDate: string; // YYYY-MM-DD
  minutes: number;
  isToday: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

export const buildWeekSeries = (
  rows: { date: string; duration: number }[],
  today: Date = new Date(),
): DayStat[] => {
  const map = new Map(rows.map(r => [r.date, Number(r.duration) || 0]));
  const out: DayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const full = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out.push({
      date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      fullDate: full,
      minutes: Math.round((map.get(full) ?? 0) / 60),
      isToday: i === 0,
    });
  }
  return out;
};
