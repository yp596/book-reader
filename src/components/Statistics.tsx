import { useState, useEffect } from 'react';
import { Book } from '../types';
import { formatMinutes } from '../utils/text';
import { buildWeekSeries, DayStat } from '../utils/stats';

interface StatsData {
  totalBooks: number;
  readingBooks: number;
  finishedBooks: number;
  recentBooks: Book[];
  todayMinutes: number;
  totalMinutes: number;
}

export function Statistics() {
  const [stats, setStats] = useState<StatsData>({
    totalBooks: 0,
    readingBooks: 0,
    finishedBooks: 0,
    recentBooks: [],
    todayMinutes: 0,
    totalMinutes: 0,
  });
  const [weekSeries, setWeekSeries] = useState<DayStat[]>([]);

  useEffect(() => { loadStats(); }, []);

  const loadStats = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const books = await api.getAllBooks() as Book[];
    const reading = books.filter(b => b.progress > 0 && b.progress < 1);
    const finished = books.filter(b => b.progress >= 0.95);
    const recent = books
      .filter(b => b.last_read_at)
      .sort((a, b) => (b.last_read_at || '').localeCompare(a.last_read_at || ''))
      .slice(0, 5);
    const time = await api.getReadingTimeStats();

    setStats({
      totalBooks: books.length,
      readingBooks: reading.length,
      finishedBooks: finished.length,
      recentBooks: recent,
      todayMinutes: time.today,
      totalMinutes: time.total,
    });
    const week = await api.getWeeklyStats(7);
    setWeekSeries(buildWeekSeries(week as { date: string; duration: number }[]));
  };

  const handleExportAll = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const filePath = await api.exportNotes();
      if (filePath) alert(`已导出到：${filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
  };

  return (
    <div className="statistics">
      <div className="stats-header-row">
        <h1>阅读统计</h1>
        <button className="btn-secondary" onClick={handleExportAll}>导出全部笔记</button>
      </div>

      <div className="stats-grid">
        <div className="stats-card">
          <div className="stats-icon">📚</div>
          <div className="stats-value">{stats.totalBooks}</div>
          <div className="stats-label">总书籍数</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon">📖</div>
          <div className="stats-value">{stats.readingBooks}</div>
          <div className="stats-label">正在阅读</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon">✅</div>
          <div className="stats-value">{stats.finishedBooks}</div>
          <div className="stats-label">已读完</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon">📊</div>
          <div className="stats-value">
            {stats.totalBooks > 0 ? Math.round((stats.finishedBooks / stats.totalBooks) * 100) : 0}%
          </div>
          <div className="stats-label">完读率</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon">⏱️</div>
          <div className="stats-value small">{formatMinutes(stats.todayMinutes)}</div>
          <div className="stats-label">今日阅读</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon">⌛</div>
          <div className="stats-value small">{formatMinutes(stats.totalMinutes)}</div>
          <div className="stats-label">累计阅读</div>
        </div>
      </div>

      <section className="stats-section">
        <h2>近 7 天阅读趋势（分钟）</h2>
        {weekSeries.length === 0 ? (
          <p className="empty-text">暂无数据</p>
        ) : (
          <div className="week-chart">
            {weekSeries.map(d => {
              const max = Math.max(...weekSeries.map(x => x.minutes), 1);
              return (
                <div key={d.fullDate} className="week-bar-wrap" title={`${d.fullDate}：${d.minutes} 分钟`}>
                  <div className="week-bar-track">
                    <div
                      className={`week-bar ${d.isToday ? 'today' : ''}`}
                      style={{ height: `${Math.max(4, (d.minutes / max) * 100)}%` }}
                    />
                  </div>
                  <span className="week-label">{d.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="stats-section">
        <h2>最近阅读</h2>
        {stats.recentBooks.length === 0 ? (
          <p className="empty-text">暂无阅读记录</p>
        ) : (
          <div className="recent-list">
            {stats.recentBooks.map(book => (
              <div key={book.id} className="recent-item">
                <div className="recent-info">
                  <h3>{book.title}</h3>
                  <p>{book.author || '未知作者'}</p>
                </div>
                <div className="recent-progress">
                  <div className="progress-bar">
                    <div style={{ width: `${book.progress * 100}%` }} />
                  </div>
                  <span>{Math.round(book.progress * 100)}%</span>
                </div>
                <div className="recent-date">
                  {book.last_read_at ? new Date(book.last_read_at).toLocaleDateString() : '-'}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
