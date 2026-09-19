import { useMemo, useState } from 'react';
import { Book } from '../types';
import { diffLines, diffStats } from '../utils/diff';

interface CompareProps {
  books: Book[];
}

/** 支持比较的格式：与主进程 bookTextLines 保持一致 */
const COMPARABLE = ['txt', 'epub', 'md', 'docx'];

export function Compare({ books }: CompareProps) {
  const candidates = useMemo(() => books.filter(b => COMPARABLE.includes(b.file_type)), [books]);
  const [leftId, setLeftId] = useState<number | ''>('');
  const [rightId, setRightId] = useState<number | ''>('');
  const [result, setResult] = useState<Awaited<ReturnType<NonNullable<typeof window.electronAPI>['compareLoad']>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 只看差异：跳过两侧都没变的行，长文档更容易定位改动 */
  const [onlyDiff, setOnlyDiff] = useState(true);

  const run = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (leftId === '' || rightId === '') {
      setError('请先选择要比对的两本书');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setResult(await api.compareLoad(Number(leftId), Number(rightId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : '比较失败');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const lines = useMemo(
    () => (result ? diffLines(result.left.lines, result.right.lines) : []),
    [result],
  );
  const stats = useMemo(() => diffStats(lines), [lines]);
  const shown = onlyDiff ? lines.filter(l => l.op !== 'equal') : lines;

  return (
    <div className="compare-page">
      <h1>文档比较</h1>
      <p className="section-desc">比对两本书的正文差异，适合核对同一文档的不同版本。支持 TXT、EPUB、Markdown 与 Word 文档。</p>

      <div className="compare-toolbar">
        <select value={leftId} onChange={e => setLeftId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">选择原文档…</option>
          {candidates.map(b => (
            <option key={b.id} value={b.id}>{b.title}</option>
          ))}
        </select>
        <span className="compare-vs">对比</span>
        <select value={rightId} onChange={e => setRightId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">选择新文档…</option>
          {candidates.map(b => (
            <option key={b.id} value={b.id}>{b.title}</option>
          ))}
        </select>
        <button className="btn-primary" onClick={run} disabled={busy}>
          {busy ? '比较中…' : '开始比较'}
        </button>
        {result && (
          <label className="checkbox-row compare-only-diff">
            <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
            <span>只看差异</span>
          </label>
        )}
      </div>

      {error && <p className="empty-text">{error}</p>}

      {!result && !error && (
        <p className="empty-text">
          {candidates.length < 2 ? '书库里至少要有两本 TXT、EPUB、Markdown 或 Word 文档才能比较' : '选择两本书后点「开始比较」'}
        </p>
      )}

      {result && (
        <>
          <div className="compare-stats">
            <span className="diff-add">新增 {stats.added} 行</span>
            <span className="diff-del">删除 {stats.removed} 行</span>
            <span>未变 {stats.unchanged} 行</span>
            {(result.left.truncated || result.right.truncated) && (
              <span className="diff-warn">
                文档过长，仅比较了前 {Math.min(result.left.lines.length, result.right.lines.length)} 行
              </span>
            )}
          </div>

          <div className="compare-head">
            <div>{result.left.title}（原）</div>
            <div>{result.right.title}（新）</div>
          </div>

          <div className="compare-body">
            {shown.length === 0 ? (
              <p className="empty-text">两本文档正文完全一致</p>
            ) : (
              shown.map((l, i) => (
                <div className={`compare-row ${l.op}`} key={i}>
                  <div className="compare-cell compare-left">
                    {l.left !== null ? `${l.left + 1} ${l.text}` : ''}
                  </div>
                  <div className="compare-cell compare-right">
                    {l.right !== null ? `${l.right + 1} ${l.text}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
