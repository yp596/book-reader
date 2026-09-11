import { useMemo, useState } from 'react';
import { Book } from '../types';

interface PdfToolsProps {
  books: Book[];
}

type PdfOp = 'merge' | 'extract' | 'deletePages' | 'rotate' | 'crop' | 'watermark' | 'pageNumbers';

const OPS: { key: PdfOp; label: string; hint: string }[] = [
  { key: 'merge', label: '合并', hint: '把选中的多个 PDF 按顺序拼成一个' },
  { key: 'extract', label: '抽取页面', hint: '只保留指定页，另存为新文件' },
  { key: 'deletePages', label: '删除页面', hint: '删掉指定页，另存为新文件' },
  { key: 'rotate', label: '旋转页面', hint: '按 90° 递加，可多次执行叠加' },
  { key: 'crop', label: '裁剪边距', hint: '四周按比例内缩，裁掉多余留白' },
  { key: 'watermark', label: '加水印', hint: '整页斜排文字，适合标「内部资料」' },
  { key: 'pageNumbers', label: '加页码', hint: '右下角写「当前页 / 总页数」' },
];

/** 需要填页码的操作 */
const NEEDS_PAGES: PdfOp[] = ['extract', 'deletePages', 'rotate', 'crop'];

export function PdfTools({ books }: PdfToolsProps) {
  const pdfs = useMemo(() => books.filter(b => b.file_type === 'pdf'), [books]);
  const [selected, setSelected] = useState<number[]>([]);
  const [op, setOp] = useState<PdfOp>('merge');
  const [pages, setPages] = useState('');
  const [angle, setAngle] = useState(90);
  const [margin, setMargin] = useState(5);
  const [text, setText] = useState('内部资料');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const current = OPS.find(o => o.key === op)!;
  const toggle = (id: number) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const run = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (selected.length === 0) {
      setError('请先勾选要处理的 PDF');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.runPdfOp({
        op,
        sourceIds: selected,
        pages,
        angle,
        marginPercent: margin,
        text,
      });
      if (result) setMessage(`已生成 ${result.pages} 页：${result.filePath}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '处理失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pdf-tools">
      <h1>PDF 工具</h1>
      <p className="section-desc">
        对书库里的 PDF 做页面级处理，结果另存为新文件，不改动原件。
      </p>

      {pdfs.length === 0 ? (
        <p className="empty-text">书库里还没有 PDF 文件</p>
      ) : (
        <>
          <div className="pdf-pick">
            <div className="pdf-pick-head">
              选择文件<em>（合并用勾选的全部，其余操作只处理第一个）</em>
            </div>
            {pdfs.map(b => (
              <label className="pdf-pick-item" key={b.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(b.id)}
                  onChange={() => toggle(b.id)}
                />
                <span>{b.title}</span>
              </label>
            ))}
          </div>

          <div className="pdf-op-row">
            {OPS.map(o => (
              <button
                key={o.key}
                className={`pdf-op ${op === o.key ? 'active' : ''}`}
                onClick={() => setOp(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="section-desc">{current.hint}</p>

          <div className="pdf-params">
            {NEEDS_PAGES.includes(op) && (
              <div className="form-row">
                <label>页码范围</label>
                <input
                  value={pages}
                  onChange={e => setPages(e.target.value)}
                  placeholder="留空表示全部页；支持 1-3,5,7-"
                />
              </div>
            )}
            {op === 'rotate' && (
              <div className="form-row">
                <label>旋转角度</label>
                <select value={angle} onChange={e => setAngle(Number(e.target.value))}>
                  <option value={90}>顺时针 90°</option>
                  <option value={180}>180°</option>
                  <option value={270}>逆时针 90°</option>
                </select>
              </div>
            )}
            {op === 'crop' && (
              <div className="form-row">
                <label>内缩比例（{margin}%）</label>
                <input
                  type="range"
                  min={0}
                  max={45}
                  value={margin}
                  onChange={e => setMargin(Number(e.target.value))}
                />
              </div>
            )}
            {op === 'watermark' && (
              <div className="form-row">
                <label>水印文字</label>
                <input
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder="内置字体只支持英文与数字"
                />
              </div>
            )}
          </div>

          <div className="pdf-run">
            <button className="btn-primary" onClick={run} disabled={busy}>
              {busy ? '处理中…' : '选择位置并生成'}
            </button>
          </div>

          {message && <p className="pdf-result">{message}</p>}
          {error && <p className="empty-text">{error}</p>}
        </>
      )}
    </div>
  );
}
