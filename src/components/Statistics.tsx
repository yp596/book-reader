import { useState, useEffect, useRef } from 'react';
import { Book } from '../types';
import { formatMinutes } from '../utils/text';
import { buildWeekSeries, DayStat } from '../utils/stats';
import { Icon } from './Icon';

/** Markdown 笔记里收集来的未完成任务 */
interface OpenTask {
  bookId: number;
  bookTitle: string;
  text: string;
  chapter: string;
  href: string;
}

interface StatsData {
  totalBooks: number;
  readingBooks: number;
  finishedBooks: number;
  recentBooks: Book[];
  todayMinutes: number;
  totalMinutes: number;
}

export function Statistics({ onOpenBook }: { onOpenBook: (book: Book) => void }) {
  /** 每日目标（分钟），0 表示未设目标 */
  const [goalMinutes, setGoalMinutes] = useState(0);
  /** 读取失败的原因：不为空时页面明确报错并可重试，而不是假装「没有数据」 */
  const [loadError, setLoadError] = useState('');
  /** 书库里的未完成任务（来自 Markdown 笔记） */
  const [tasks, setTasks] = useState<OpenTask[]>([]);
  /** 打开任务时要拿到完整的书对象，这里留一份最近一次读到的书库 */
  const booksRef = useRef<Book[]>([]);

  const [stats, setStats] = useState<StatsData>({
    totalBooks: 0,
    readingBooks: 0,
    finishedBooks: 0,
    recentBooks: [],
    todayMinutes: 0,
    totalMinutes: 0,
  });
  const [weekSeries, setWeekSeries] = useState<DayStat[]>([]);

  useEffect(() => {
    loadStats();
    window.electronAPI?.getSetting('dailyGoalMinutes').then(v => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setGoalMinutes(n);
    }).catch(() => {});
  }, []);

  const loadStats = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setLoadError('');
    try {
      const books = await api.getAllBooks() as Book[];
      booksRef.current = books;
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
      setTasks((await api.getAllTasks?.()) ?? []);
    } catch (err) {
      // 不吭声的话页面停在 0，用户分不清「真没数据」和「没读出来」
      setLoadError(err instanceof Error ? err.message : '统计读取失败，请重试');
    }
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

      {loadError && (
        <div className="info-bar">
          <p>统计数据没能读出来：{loadError}</p>
          <button className="btn-secondary small" onClick={() => void loadStats()}>重试</button>
        </div>
      )}

      <div className="stats-grid">
        <div className="stats-card">
          <div className="stats-icon"><Icon name="library" size={18} /></div>
          <div className="stats-value">{stats.totalBooks}</div>
          <div className="stats-label">总书籍数</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon"><Icon name="book-open" size={18} /></div>
          <div className="stats-value">{stats.readingBooks}</div>
          <div className="stats-label">正在阅读</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon"><Icon name="check" size={18} /></div>
          <div className="stats-value">{stats.finishedBooks}</div>
          <div className="stats-label">已读完</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon"><Icon name="target" size={18} /></div>
          <div className="stats-value">
            {stats.totalBooks > 0 ? Math.round((stats.finishedBooks / stats.totalBooks) * 100) : 0}%
          </div>
          <div className="stats-label">完读率</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon"><Icon name="clock" size={18} /></div>
          <div className="stats-value small">{formatMinutes(stats.todayMinutes)}</div>
          <div className="stats-label">今日阅读</div>
        </div>
        <div className="stats-card">
          <div className="stats-icon"><Icon name="chart" size={18} /></div>
          <div className="stats-value small">{formatMinutes(stats.totalMinutes)}</div>
          <div className="stats-label">累计阅读</div>
        </div>
      </div>

      {goalMinutes > 0 && (() => {
        const todayMin = Math.round(stats.todayMinutes / 60);
        const pct = Math.min(100, Math.round((todayMin / goalMinutes) * 100));
        const done = todayMin >= goalMinutes;
        return (
          <section className="stats-section">
            <h2>
              今日目标
              {done ? <><Icon name="check" size={14} /> 已达成</> : null}
            </h2>
            <div className="goal-row">
              <div className="goal-bar">
                <div className="goal-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="goal-text">
                {todayMin} / {goalMinutes} 分钟 · {pct}%
              </span>
            </div>
            {!done && (
              <p className="section-desc" style={{ marginTop: 10, marginBottom: 0 }}>
                还差 {goalMinutes - todayMin} 分钟达成今日目标
              </p>
            )}
          </section>
        );
      })()}

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
              <div
                key={book.id}
                className="recent-item clickable"
                onClick={() => onOpenBook(book)}
                title="继续阅读"
              >
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

      {/* 未完成任务：来自各本 Markdown 笔记里的 - [ ]，点一下跳到它所在的章节 */}
      {tasks.length > 0 && (
        <section className="stats-section">
          <h2>待办（{tasks.length} 项，来自 Markdown 笔记）</h2>
          <div className="recent-list">
            {tasks.slice(0, 50).map((t, i) => (
              <div
                key={`${t.bookId}-${i}`}
                className="recent-item clickable"
                title="跳转到这一章"
                onClick={() => {
                  const b = booksRef.current.find(x => x.id === t.bookId);
                  if (!b) return;
                  // 带上目标章节，阅读器据此直接落到对应的那一章
                  onOpenBook(
                    t.href ? ({ ...b, _tocTarget: { label: t.chapter, href: t.href } } as Book) : b,
                  );
                }}
              >
                <div className="recent-info">
                  <h3>{t.text}</h3>
                  <p>
                    《{t.bookTitle}》{t.chapter ? ` · ${t.chapter}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
          {tasks.length > 50 && <p className="empty-text">只显示前 50 项，其余可在各本笔记里查看</p>}
        </section>
      )}
    </div>
  );
}
