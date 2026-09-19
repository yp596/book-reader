import { useState, useEffect, type CSSProperties } from 'react';
import { Book, Bookmark, Note, TocEntry } from '../types';
import { formatFileSize, formatPdfPermissions } from '../utils/text';
import { coverHue } from '../utils/cover';
import { Icon, StarRating } from './Icon';

interface BookDetailProps {
  book: Book;
  onBack: () => void;
  onRead: (book: Book) => void;
}

type Tab = 'toc' | 'notes' | 'marks' | 'info';

/** 图谱里一个节点的位置与归属；side 决定它在中心的哪一侧 */
export interface EgoNode {
  id: number;
  title: string;
  x: number;
  y: number;
  side: 'out' | 'in';
  /** 标签相对节点的位置与对齐方式：沿半径朝外，避免压住连线、也避免贴到中心 */
  labelX: number;
  labelY: number;
  labelAnchor: 'start' | 'middle' | 'end';
}

export const EGO_MAX_PER_SIDE = 6;
const EGO_CENTER = { x: 200, y: 100 };
const EGO_RADIUS = 70;
/** 每侧展开的角度：±45°。给得窄了节点挤成一条横线，给得宽了标签会顶到画布边缘 */
const EGO_SPAN = Math.PI / 2;

/**
 * 本地图谱的节点排布：中心是本书，引用的放右弧、被引用的放左弧。
 *
 * 用固定坐标系（不读容器尺寸）是为了让结果只由数据决定：同一本书永远画出同样的图。
 * 标签沿半径朝外摆——早先统一放在节点下方，上弧的标签会压住连线，看着像别人的标签。
 */
export function layoutEgoGraph(
  outgoing: { id: number; title: string }[],
  incoming: { id: number; title: string }[],
): EgoNode[] {
  const place = (list: { id: number; title: string }[], side: 'out' | 'in'): EgoNode[] => {
    const picked = list.slice(0, EGO_MAX_PER_SIDE);
    return picked.map((item, i) => {
      // 一侧只有一个就放正中间；多个则在该侧 ±45° 的扇面里均分
      const t = picked.length === 1 ? 0.5 : i / (picked.length - 1);
      const angle = side === 'out' ? -EGO_SPAN / 2 + t * EGO_SPAN : Math.PI - EGO_SPAN / 2 + t * EGO_SPAN;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = EGO_CENTER.x + EGO_RADIUS * cos;
      const y = EGO_CENTER.y + EGO_RADIUS * sin;
      return {
        id: item.id,
        title: item.title,
        side,
        x,
        y,
        labelX: x + 15 * cos,
        labelY: y + 15 * sin + 3.5,
        labelAnchor: cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle',
      };
    });
  };
  return [...place(outgoing, 'out'), ...place(incoming, 'in')];
}

export function BookDetail({ book, onBack, onRead }: BookDetailProps) {
  const [tab, setTab] = useState<Tab>('toc');
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  /** 目录读取失败的原因：为空说明这次是「确实没有目录」，不是「读不出来」 */
  const [tocError, setTocError] = useState('');
  /** Markdown 笔记之间的引用关系（两个方向） */
  const [links, setLinks] = useState<{
    outgoing: { id: number; title: string; via: string }[];
    incoming: { id: number; title: string; via: string }[];
  }>({ outgoing: [], incoming: [] });
  /** frontmatter 属性（键 → 值），Markdown 笔记的结构化元信息 */
  const [props, setProps] = useState<[string, string][]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [fileSize, setFileSize] = useState(0);
  /** 页数与文档权限：只有 PDF 有固定含义，其余格式为 null，界面显示「—」 */
  const [pdfInfo, setPdfInfo] = useState<{ pageCount: number | null; deniedPermissions: string[] | null } | null>(null);
  // TXT 目录解析：可选规则、本书指定规则、目录来源（auto/manual）
  const [ruleNames, setRuleNames] = useState<string[]>([]);
  const [tocRule, setTocRule] = useState('');
  const [tocSource, setTocSource] = useState('');
  const [tocEditing, setTocEditing] = useState(false);
  const [tocBusy, setTocBusy] = useState(false);

  useEffect(() => {
    loadAll();
  }, [book.id]);

  const loadAll = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setTocLoading(true);
    setTocError('');
    try {
      const [t, n, m, info, rules] = await Promise.all([
        api.getBookToc(book.id) as Promise<TocEntry[]>,
        api.getNotes(book.id),
        api.getBookmarks(book.id),
        api.getBookFileInfo(book.id),
        api.getTocRules(book.id),
      ]);
      setToc(t);
      setNotes(n as Note[]);
      setMarks(m as Bookmark[]);
      setFileSize(info.size);
      setPdfInfo({ pageCount: info.pageCount, deniedPermissions: info.deniedPermissions });
      setRuleNames(rules.rules);
      setTocRule(rules.current);
      setTocSource(rules.source);
      // 引用关系单独取：它只对 Markdown 笔记有意义，失败也不该影响其它信息
      try {
        const l = await api.getBookLinks?.(book.id);
        if (l) setLinks(l);
      } catch { /* 没有引用关系就不显示这一块 */ }
      // frontmatter 属性：存在设置里，直接读，不必为它单开一个通道
      try {
        const raw = await api.getSetting(`mdProps:${book.id}`);
        if (raw) {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          if (obj && typeof obj === 'object') {
            setProps(
              Object.entries(obj)
                .filter(([, v]) => Array.isArray(v) && v.length > 0)
                .map(([k, v]) => [k, (v as string[]).join('、')] as [string, string]),
            );
          }
        }
      } catch { /* 属性格式不对就不显示 */ }
    } catch (err) {
      // 失败不能退化成「本书无目录信息」：用户会以为这本书真的没有目录
      setTocError(err instanceof Error ? err.message : '目录读取失败');
      setToc([]);
    } finally {
      setTocLoading(false);
    }
  };

  const jumpToToc = (entry: TocEntry) => {
    // EPUB 用 href，TXT/PDF 用页码 — 交给阅读器处理，详情页只负责打开
    onRead({ ...book, _tocTarget: entry } as Book & { _tocTarget: TocEntry });
  };

  /** 点击引用关系里的一本书：取回完整记录后交给上层打开 */
  const openLinked = async (id: number) => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const b = (await api.getBookById(id)) as Book | null;
      if (b) onRead(b);
    } catch { /* 书可能刚被删掉，忽略 */ }
  };

  const graphNodes = layoutEgoGraph(links.outgoing, links.incoming);
  const hiddenLinks =
    Math.max(0, links.outgoing.length - EGO_MAX_PER_SIDE) +
    Math.max(0, links.incoming.length - EGO_MAX_PER_SIDE);
  const shortLabel = (s: string) => (s.length > 7 ? `${s.slice(0, 7)}…` : s);

  /** 切换本书使用的目录规则并重新解析（空串=恢复自动择优） */
  const applyTocRule = async (ruleName: string) => {
    const api = window.electronAPI;
    if (!api) return;
    setTocBusy(true);
    try {
      const entries = await api.reparseToc(book.id, ruleName);
      setToc(entries);
      setTocRule(ruleName);
      setTocSource('auto');
      setTocEditing(false);
    } catch (err) {
      alert(`重新解析失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTocBusy(false);
    }
  };

  /** 进入编辑态；退出时把改动写回（标记为手动编辑，不再被自动解析覆盖） */
  const toggleTocEdit = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (!tocEditing) {
      setTocEditing(true);
      return;
    }
    setTocBusy(true);
    try {
      await api.saveToc(book.id, toc);
      setTocSource('manual');
      setTocEditing(false);
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTocBusy(false);
    }
  };

  const renameTocEntry = (index: number, label: string) => {
    setToc(list => list.map((e, i) => (i === index ? { ...e, label } : e)));
  };

  const removeTocEntry = (index: number) => {
    setToc(list => list.filter((_, i) => i !== index));
  };

  return (
    <div className="book-detail">
      <button className="back-btn" onClick={onBack}>
        <Icon name="arrow-left" size={14} />
        返回书架
      </button>
      <button
        className="link-btn"
        style={{ marginLeft: 12 }}
        onClick={() => window.electronAPI?.openReaderWindow(book.id)}
      >
        <Icon name="external-link" size={13} />
        在新窗口打开
      </button>

      <div className="detail-hero">
        <div className="detail-cover">
          {book.cover_path ? (
            <img src={book.cover_path} alt={book.title} />
          ) : (
            <div
              className="book-cover-placeholder"
              style={{ '--cover-h': coverHue(book.title) } as CSSProperties}
            >
              <span className="cover-title">{book.title}</span>
              <span className="cover-foot">{book.file_type.toUpperCase()}</span>
            </div>
          )}
        </div>
        <div className="detail-info">
          <h1>
            {book.title}
            {book.favorite ? <Icon name="star-fill" size={16} className="detail-fav" /> : null}
          </h1>
          <p className="detail-author">{book.author || '未知作者'}</p>
          {book.rating ? <StarRating value={book.rating} size={14} /> : null}
          <p className="book-meta">
            {book.file_type.toUpperCase()} · {formatFileSize(fileSize)}
            {book.category ? ` · ${book.category}` : ''}
          </p>
          <div className="book-progress large">
            <div className="progress-bar">
              <div style={{ width: `${book.progress * 100}%` }} />
            </div>
            <span className="progress-text">
              {book.progress > 0 ? `已读 ${Math.round(book.progress * 100)}%` : '未开始'}
            </span>
          </div>
          <button className="btn-primary large" onClick={() => onRead(book)}>
            <Icon name="book-open" size={15} />
            {book.progress > 0 ? '继续阅读' : '开始阅读'}
          </button>
        </div>
      </div>

      <div className="detail-tabs">
        {([
          ['toc', `目录${toc.length > 0 ? `（${toc.length}）` : ''}`],
          ['notes', `笔记（${notes.length}）`],
          ['marks', `书签（${marks.length}）`],
          ['info', '信息'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`detail-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'toc' && (
          <>
            {book.file_type === 'txt' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, opacity: 0.75 }}>解析方式</label>
                  <select
                    value={tocRule}
                    disabled={tocBusy || tocEditing}
                    onChange={e => applyTocRule(e.target.value)}
                    style={{ flex: 1, minWidth: 160, maxWidth: 280 }}
                  >
                    <option value="">自动（内置规则择优）</option>
                    {ruleNames.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <button
                    className="link-btn"
                    disabled={tocBusy || tocEditing}
                    title={tocEditing ? '请先保存或取消当前的目录编辑' : undefined}
                    onClick={() => applyTocRule(tocRule)}
                  >
                    重新解析
                  </button>
                  <button className="link-btn" disabled={tocBusy} onClick={toggleTocEdit}>
                    {tocEditing ? '保存' : '编辑'}
                  </button>
                </div>
                {tocEditing && (
                  <p className="empty-text" style={{ marginBottom: 8 }}>
                    编辑中：保存前不能重新解析，改完记得点「保存」
                  </p>
                )}
                {tocSource === 'manual' && !tocEditing && (
                  <p className="empty-text" style={{ marginBottom: 8 }}>
                    目录已手动编辑过，重新解析会覆盖手动改动
                  </p>
                )}
              </>
            )}
            {tocLoading ? (
              <p className="empty-text">加载目录中…</p>
            ) : tocError ? (
              <>
                <p className="empty-text" style={{ marginBottom: 8 }}>
                  目录读取失败（{tocError}），这不代表这本书没有目录
                </p>
                <button className="link-btn" onClick={() => void loadAll()}>重试</button>
              </>
            ) : toc.length === 0 ? (
              <p className="empty-text">
                {book.file_type === 'txt'
                  ? '这本书没有解析出目录，可在上方换一种解析方式试试'
                  : '本书确实没有目录信息'}
              </p>
            ) : (
              <div className="toc-list">
                {toc.map((t, i) =>
                  tocEditing ? (
                    <div
                      key={i}
                      className="toc-item full"
                      style={{ display: 'flex', gap: 8, cursor: 'default' }}
                    >
                      <input
                        value={t.label}
                        onChange={e => renameTocEntry(i, e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button className="danger" onClick={() => removeTocEntry(i)}>删除</button>
                    </div>
                  ) : (
                    <div key={i} className="toc-item full" onClick={() => jumpToToc(t)}>
                      {t.label}
                    </div>
                  ),
                )}
              </div>
            )}
          </>
        )}

        {tab === 'notes' && (
          <>
            {notes.length === 0 ? (
              <p className="empty-text">暂无笔记，去阅读时选中正文添加</p>
            ) : (
              notes.map(n => (
                <div key={n.id} className="mark-item">
                  {n.selected_text && <p className="mark-quote">{n.selected_text}</p>}
                  {n.note && <p className="mark-note">{n.note}</p>}
                  <p className="book-meta">{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</p>
                </div>
              ))
            )}
          </>
        )}

        {tab === 'marks' && (
          <>
            {marks.length === 0 ? (
              <p className="empty-text">暂无书签，去阅读时选中正文高亮</p>
            ) : (
              marks.map(m => (
                <div key={m.id} className="mark-item">
                  {m.text && <p className="mark-quote">{m.text}</p>}
                  <p className="book-meta">{m.created_at ? new Date(m.created_at).toLocaleString() : ''}</p>
                </div>
              ))
            )}
          </>
        )}

        {tab === 'info' && (
          <>
            <div className="info-table">
              <div className="info-row"><span>书名</span><span>{book.title}</span></div>
              <div className="info-row"><span>作者</span><span>{book.author || '未知'}</span></div>
              <div className="info-row"><span>格式</span><span>{book.file_type.toUpperCase()}</span></div>
              <div className="info-row"><span>大小</span><span>{formatFileSize(fileSize)}</span></div>
              <div className="info-row">
                <span>页数</span>
                <span>{pdfInfo?.pageCount ? `${pdfInfo.pageCount} 页` : '—'}</span>
              </div>
              <div className="info-row">
                <span>权限</span>
                <span>{formatPdfPermissions(pdfInfo?.deniedPermissions ?? null)}</span>
              </div>
              <div className="info-row"><span>分类</span><span>{book.category || '未分类'}</span></div>
              <div className="info-row">
                <span>上次阅读</span>
                <span>{book.last_read_at ? new Date(book.last_read_at).toLocaleString() : '从未'}</span>
              </div>
              <div className="info-row">
                <span>加入时间</span>
                <span>{book.created_at ? new Date(book.created_at).toLocaleString() : '-'}</span>
              </div>
            </div>

            {/* frontmatter 属性：Markdown 笔记的结构化元信息，正文里的信息块仍完整保留 */}
            {props.length > 0 && (
              <div className="info-table" style={{ marginTop: 14 }}>
                {props.map(([k, v]) => (
                  <div className="info-row" key={k}>
                    <span>{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 引用关系：Markdown 笔记之间靠 [[目标]] 互链，这里把两个方向都列出来 */}
            {(links.outgoing.length > 0 || links.incoming.length > 0) && (
              <div className="link-panel">
                {/* 本地图谱：一眼看清这本书在笔记网络里的位置 */}
                {graphNodes.length > 0 && (
                  <>
                    <p className="link-panel-title">本地图谱（引用的在右、被引用的在左，点节点可打开）</p>
                    <svg className="ego-graph" viewBox="0 0 400 200" role="img" aria-label="笔记引用关系图">
                      {graphNodes.map(n => (
                        <line
                          key={`edge-${n.side}-${n.id}`}
                          className={`ego-edge ${n.side}`}
                          x1={200}
                          y1={100}
                          x2={n.x}
                          y2={n.y}
                        />
                      ))}
                      {graphNodes.map(n => (
                        <g
                          key={`node-${n.side}-${n.id}`}
                          className={`ego-node ${n.side}`}
                          onClick={() => void openLinked(n.id)}
                        >
                          <title>{n.title}</title>
                          <circle cx={n.x} cy={n.y} r={7} />
                          <text
                            x={n.labelX}
                            y={n.labelY}
                            textAnchor={n.labelAnchor}
                            dominantBaseline="middle"
                          >
                            {shortLabel(n.title)}
                          </text>
                        </g>
                      ))}
                      <g className="ego-center">
                        <circle cx={200} cy={100} r={11} />
                        <text x={200} y={130} textAnchor="middle">{shortLabel(book.title)}</text>
                      </g>
                    </svg>
                    {hiddenLinks > 0 && (
                      <p className="empty-text" style={{ marginBottom: 8 }}>
                        另有 {hiddenLinks} 条未画在图上，可看下面的列表
                      </p>
                    )}
                  </>
                )}

                {links.outgoing.length > 0 && (
                  <>
                    <p className="link-panel-title">本书引用（{links.outgoing.length}）</p>
                    {links.outgoing.map(l => (
                      <button key={`out-${l.id}`} className="link-row" onClick={() => openLinked(l.id)}>
                        <span className="link-title">{l.title}</span>
                        <span className="link-via">[[{l.via}]]</span>
                      </button>
                    ))}
                  </>
                )}
                {links.incoming.length > 0 && (
                  <>
                    <p className="link-panel-title">被引用（{links.incoming.length}）</p>
                    {links.incoming.map(l => (
                      <button key={`in-${l.id}`} className="link-row" onClick={() => openLinked(l.id)}>
                        <span className="link-title">{l.title}</span>
                        <span className="link-via">[[{l.via}]]</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
