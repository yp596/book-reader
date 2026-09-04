import { useState, useEffect } from 'react';
import { Book } from '../types';

interface StatsData {
  totalBooks: number;
  readingBooks: number;
  finishedBooks: number;
  recentBooks: Book[];
}

export function Statistics() {
  const [stats, setStats] = useState<StatsData>({
    totalBooks: 0,
    readingBooks: 0,
    finishedBooks: 0,
    recentBooks: [],
  });

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    const books = await window.electronAPI.getAllBooks() as Book[];
    const reading = books.filter(b => b.progress > 0 && b.progress < 1);
    const finished = books.filter(b => b.progress >= 0.95);
    const recent = books
      .filter(b => b.last_read_at)
      .sort((a, b) => (b.last_read_at || '').localeCompare(a.last_read_at || ''))
      .slice(0, 5);

    setStats({
      totalBooks: books.length,
      readingBooks: reading.length,
      finishedBooks: finished.length,
      recentBooks: recent,
    });
  };

  return (
    <div className="statistics">
      <h1>阅读统计</h1>

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
      </div>

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
