import { useState, useEffect } from 'react';
import { WordEntry } from '../types';
import { Icon } from './Icon';

export function Vocab() {
  const [words, setWords] = useState<WordEntry[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => { load(); }, []);

  const load = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setWords(await api.getAllWords());
  };

  const handleDelete = async (id: number) => {
    if (!confirm('从生词本删除？')) return;
    await window.electronAPI?.deleteWord(id);
    load();
  };

  const filtered = words.filter(w => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return w.word.toLowerCase().includes(q) || w.definition.toLowerCase().includes(q);
  });

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>生词本（{words.length}）</h1>
        <div className="search-box" style={{ width: 280, marginBottom: 0 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索生词..."
          />
        </div>
      </div>

      <div className="info-bar">
        <Icon name="info" size={15} />
        <p>阅读时选中生词 → 查词 → 存入生词本，随时回来复习。</p>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state small">
          <p>{words.length === 0 ? '生词本还是空的' : '没有匹配的生词'}</p>
        </div>
      ) : (
        <div className="source-list">
          {filtered.map(w => (
            <div key={w.id} className="source-card">
              <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
                <h3>{w.word}</h3>
                <p className="mark-note" style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{w.definition}</p>
                {w.context && <p className="mark-quote">{w.context.slice(0, 200)}</p>}
                <p className="source-url">
                  {w.book_title ? `《${w.book_title}》` : ''}
                  {w.created_at ? ` · ${new Date(w.created_at).toLocaleDateString()}` : ''}
                </p>
              </div>
              <div className="source-actions">
                <button className="btn-danger small" onClick={() => handleDelete(w.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
