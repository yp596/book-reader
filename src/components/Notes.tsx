import { useState, useEffect, useMemo } from 'react';
import { NoteWithBook } from '../types';
import { parseTags, matchesTags, countTags, normalizeTags } from '../utils/note-tags';
import { Icon } from './Icon';

interface NotesProps {
  /** 跳回原文：打开对应书籍并定位到批注位置 */
  onOpenNote: (bookId: number, position: string) => void;
}

export function Notes({ onOpenNote }: NotesProps) {
  const [notes, setNotes] = useState<NoteWithBook[]>([]);
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: number; tags: string; note: string } | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setNotes(await api.getAllNotes());
  };

  /** 标签云：按使用频次排序，复用已单测的纯函数 */
  const allTags = useMemo(() => countTags(notes.map(n => n.tags)), [notes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter(n => {
      if (!matchesTags(n.tags, selectedTags)) return false;
      if (!q) return true;
      return (
        (n.note ?? '').toLowerCase().includes(q) ||
        (n.selected_text ?? '').toLowerCase().includes(q) ||
        (n.book_title ?? '').toLowerCase().includes(q)
      );
    });
  }, [notes, query, selectedTags]);

  const toggleTag = (tag: string) =>
    setSelectedTags(s => (s.includes(tag) ? s.filter(t => t !== tag) : [...s, tag]));

  const saveNote = async () => {
    if (!editing) return;
    await window.electronAPI?.updateNote(editing.id, editing.note, normalizeTags(editing.tags));
    setEditing(null);
    await load();
  };

  const handleDelete = async (id: number) => {
    if (!confirm('删除这条笔记？')) return;
    await window.electronAPI?.deleteNote(id);
    await load();
  };

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>我的笔记（{filtered.length}/{notes.length}）</h1>
        <div className="search-box" style={{ width: 300, marginBottom: 0 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索笔记 / 原文 / 书名..."
          />
        </div>
      </div>

      <div className="info-bar">
        <Icon name="info" size={15} />
        <p>笔记不依附单本书：跨书汇总，打标签归类，点「跳转」回到原文位置。</p>
      </div>

      {allTags.length > 0 && (
        <div className="tag-filter">
          {selectedTags.length > 0 && (
            <button className="tag-chip clear" onClick={() => setSelectedTags([])}>
              清除筛选
              <Icon name="x" size={11} />
            </button>
          )}
          {allTags.map(t => (
            <button
              key={t.tag}
              className={`tag-chip${selectedTags.includes(t.tag) ? ' active' : ''}`}
              onClick={() => toggleTag(t.tag)}
            >
              {t.tag}
              <span className="tag-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state small">
          <p>{notes.length === 0 ? '还没有笔记，阅读时选中正文即可添加' : '没有匹配的笔记'}</p>
        </div>
      ) : (
        <div className="source-list">
          {filtered.map(n => (
            <div key={n.id} className="source-card">
              <div className="source-info" style={{ border: 'none', margin: 0, padding: 0, flex: 1, minWidth: 0 }}>
                <p className="mark-label">{n.book_title ?? '未知书籍'}</p>
                {n.selected_text && <p className="mark-quote">{n.selected_text}</p>}
                {n.note && (
                  <p className="mark-note" style={{ whiteSpace: 'pre-wrap' }}>{n.note}</p>
                )}
                <div className="tag-row">
                  {parseTags(n.tags).map(t => (
                    <span key={t} className="tag-chip small static">{t}</span>
                  ))}
                  <button
                    className="tag-chip small ghost"
                    onClick={() => setEditing({ id: n.id, tags: n.tags ?? '', note: n.note ?? '' })}
                  >
                    编辑
                  </button>
                </div>
                <p className="book-meta">{new Date(n.created_at).toLocaleString()}</p>
              </div>
              <div className="source-actions" style={{ display: 'flex', gap: 8, alignSelf: 'flex-start' }}>
                <button className="btn-secondary small" onClick={() => onOpenNote(n.book_id, n.position)}>
                  跳转
                </button>
                <button className="btn-danger small" onClick={() => handleDelete(n.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="note-modal" onClick={e => e.stopPropagation()}>
            <h3>编辑笔记</h3>
            <textarea
              className="note-textarea"
              value={editing.note}
              onChange={e => setEditing({ ...editing, note: e.target.value })}
              placeholder="写下你的想法..."
              rows={6}
              autoFocus
            />
            <p className="section-desc" style={{ margin: '12px 0' }}>多个标签用逗号或空格分隔</p>
            <input
              className="tag-input"
              value={editing.tags}
              onChange={e => setEditing({ ...editing, tags: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && saveNote()}
              placeholder="例如：小说, 科幻, 待整理"
            />
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setEditing(null)}>取消</button>
              <button className="btn-primary" onClick={saveNote}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
