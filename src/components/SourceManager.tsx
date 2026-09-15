import { useState, useEffect } from 'react';
import { BookSource, OnlineBook, TextFilter, FollowedBook } from '../types';
import { OnlineReader } from './OnlineReader';
import { Icon } from './Icon';

const emptyForm = {
  name: '',
  url: '',
  search_url: '',
  search_list: '',
  search_name: '',
  search_author: '',
  search_detail: '',
  chapters_list: '',
  chapters_name: '',
  content_selector: '',
};

export function SourceManager() {
  const [sources, setSources] = useState<BookSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);

  // 在线搜索
  const [searchSourceId, setSearchSourceId] = useState<number | ''>('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<OnlineBook[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // 在线阅读
  const [reading, setReading] = useState<{ source: BookSource; book: OnlineBook } | null>(null);

  // 追更
  const [follows, setFollows] = useState<FollowedBook[]>([]);
  const [checking, setChecking] = useState(false);

  // 净化规则
  const [filters, setFilters] = useState<TextFilter[]>([]);
  const [showFilterForm, setShowFilterForm] = useState(false);
  const [filterForm, setFilterForm] = useState({ name: '', pattern: '', replacement: '' });

  useEffect(() => { loadSources(); loadFollows(); loadFilters(); }, []);

  const loadSources = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const allSources = await api.getAllSources();
    setSources(allSources as BookSource[]);
  };

  const loadFollows = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setFollows(await api.getFollows());
  };

  const loadFilters = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setFilters(await api.getFilters());
  };

  const handleCheckUpdates = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setChecking(true);
    try {
      const updated = await api.checkUpdates();
      await loadFollows();
      alert(updated.length > 0 ? `发现 ${updated.length} 本更新：${updated.map(u => `《${u.title}》`).join('、')}` : '暂无更新');
    } catch (err) {
      alert(err instanceof Error ? err.message : '检查失败');
    } finally {
      setChecking(false);
    }
  };

  const handleUnfollow = async (id: number) => {
    if (!confirm('取消追更？')) return;
    await window.electronAPI?.unfollowBook(id);
    loadFollows();
  };

  const handleClearUpdate = async (f: FollowedBook) => {
    await window.electronAPI?.clearFollowUpdate(f.id);
    loadFollows();
  };

  const handleAddFilter = async () => {
    if (!filterForm.name.trim() || !filterForm.pattern) {
      alert('名称和正则不能为空');
      return;
    }
    try {
      await window.electronAPI?.addFilter(filterForm);
      setFilterForm({ name: '', pattern: '', replacement: '' });
      setShowFilterForm(false);
      loadFilters();
    } catch (err) {
      alert(err instanceof Error ? err.message : '添加失败');
    }
  };

  const handleToggleFilter = async (f: TextFilter) => {
    await window.electronAPI?.toggleFilter(f.id, f.enabled ? 0 : 1);
    loadFilters();
  };

  const handleDeleteFilter = async (id: number) => {
    if (!confirm('删除这条规则？')) return;
    await window.electronAPI?.deleteFilter(id);
    loadFilters();
  };

  const set = (key: keyof typeof emptyForm, value: string) =>
    setForm(s => ({ ...s, [key]: value }));

  const handleAdd = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      alert('请先填写书源名称和书源主页地址。');
      return;
    }
    const api = window.electronAPI;
    if (!api) return;
    // 组装抓取规则
    const rules = JSON.stringify({
      search: {
        url: form.search_url,
        list: form.search_list,
        name: form.search_name,
        author: form.search_author,
        cover: '',
        detail: form.search_detail,
      },
      chapters: { list: form.chapters_list, name: form.chapters_name, url: '' },
      content: { content: form.content_selector },
    });
    try {
      await api.addSource({
        name: form.name,
        url: form.url,
        search_url: form.search_url,
        chapters_url: '',
        content_url: '',
        rules,
      });
      setForm(emptyForm);
      setShowAdd(false);
      loadSources();
    } catch (err) {
      alert(err instanceof Error ? err.message : '书源保存失败，请重试');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此书源？')) return;
    const api = window.electronAPI;
    if (!api) return;
    await api.deleteSource(id);
    loadSources();
  };

  const handleImportJson = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const json = JSON.parse(text);
        const sourceList = Array.isArray(json) ? json : [json];
        for (const s of sourceList) {
          // 兼容 Legado 字段
          const rules = JSON.stringify({
            search: {
              url: s.ruleSearch?.url || '',
              list: s.ruleSearch?.bookList || '',
              name: s.ruleSearch?.name || '',
              author: s.ruleSearch?.author || '',
              cover: s.ruleSearch?.coverUrl || '',
              detail: s.ruleSearch?.bookUrl || '',
            },
            chapters: {
              list: s.ruleToc?.chapterList || '',
              name: s.ruleToc?.chapterName || '',
              url: s.ruleToc?.chapterUrl || '',
            },
            content: { content: s.ruleContent?.content || '' },
          });
          await api.addSource({
            name: s.name || s.bookSourceName || '未命名书源',
            url: s.bookSourceUrl || s.bookSourceGroup || '',
            search_url: s.ruleSearch?.url || '',
            chapters_url: '',
            content_url: '',
            rules,
          });
        }
        loadSources();
        alert(`成功导入 ${sourceList.length} 个书源`);
      } catch {
        alert('书源格式错误');
      }
    };
    input.click();
  };

  const handleExportJson = () => {
    const data = sources.map(s => {
      let rules: any = {};
      try { rules = s.rules ? JSON.parse(s.rules) : {}; } catch { /* 忽略 */ }
      return {
        name: s.name,
        bookSourceUrl: s.url,
        ruleSearch: {
          url: s.search_url || rules.search?.url || '',
          bookList: rules.search?.list || '',
          name: rules.search?.name || '',
          author: rules.search?.author || '',
          bookUrl: rules.search?.detail || '',
        },
        ruleToc: {
          chapterList: rules.chapters?.list || '',
          chapterName: rules.chapters?.name || '',
        },
        ruleContent: { content: rules.content?.content || '' },
      };
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'book-sources.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSearch = async () => {
    if (!searchSourceId || !keyword.trim()) return;
    const api = window.electronAPI;
    if (!api) return;
    setSearching(true);
    setSearchError('');
    setResults([]);
    try {
      const list = await api.searchBooks(Number(searchSourceId), keyword.trim());
      setResults(list as OnlineBook[]);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  };

  if (reading) {
    return (
      <OnlineReader
        source={reading.source}
        book={reading.book}
        onBack={() => setReading(null)}
      />
    );
  }

  const activeSource = sources.find(s => s.id === searchSourceId);

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>书源管理</h1>
        <div className="source-actions">
          <button className="btn-secondary" onClick={handleImportJson}>导入书源</button>
          <button className="btn-secondary" onClick={handleExportJson}>导出书源</button>
          <button className="btn-primary" onClick={() => setShowAdd(true)}>添加书源</button>
        </div>
      </div>

      <div className="info-bar">
        <Icon name="info" size={15} />
        <p>支持导入 Legado 格式的 JSON 书源。不内置任何书源，由用户自行导入。</p>
      </div>

      {/* 在线搜索 */}
      <section className="settings-section">
        <h2>在线搜索</h2>
        <div className="search-box">
          <select
            value={searchSourceId}
            onChange={e => setSearchSourceId(e.target.value ? Number(e.target.value) : '')}
            style={{ maxWidth: 200 }}
          >
            <option value="">选择书源...</option>
            {sources.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="输入书名或作者..."
          />
          <button className="btn-primary" onClick={handleSearch} disabled={searching || !searchSourceId}>
            {searching ? '搜...' : '搜'}
          </button>
        </div>
        {searchError && <p className="search-error">{searchError}</p>}
        {results.length > 0 && activeSource && (
          <div className="book-list-view">
            {results.map((b, i) => (
              <div
                key={i}
                className="book-list-item"
                onClick={() => setReading({ source: activeSource, book: b })}
              >
                <div className="book-list-info">
                  <h3>{b.name}</h3>
                  <p>{b.author || '未知作者'}</p>
                </div>
                <span className="book-meta">查看章节 →</span>
              </div>
            ))}
          </div>
        )}
        {!searching && keyword && results.length === 0 && !searchError && (
          <p className="empty-text">没有找到相关书籍</p>
        )}
      </section>

      {/* 追更列表 */}
      <section className="settings-section">
        <div className="source-header" style={{ marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>追更（{follows.length}）</h2>
          <button className="btn-secondary" onClick={handleCheckUpdates} disabled={checking || follows.length === 0}>
            {checking ? '检查中...' : <><Icon name="refresh" size={15} /> 检查更新</>}
          </button>
        </div>
        {follows.length === 0 ? (
          <p className="empty-text">暂无追更，在书籍章节页点「追更」订阅</p>
        ) : (
          <div className="source-list">
            {follows.map(f => (
              <div key={f.id} className="source-card">
                <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
                  <h3>
                    {f.title}
                    {f.has_update ? <span className="update-dot" title="有更新" /> : null}
                  </h3>
                  <p className="source-url">
                    {f.last_chapter ? `最新：${f.last_chapter}（共 ${f.last_count} 章）` : '尚未检查'}
                    {f.last_check ? ` · ${new Date(f.last_check).toLocaleString()}` : ''}
                  </p>
                </div>
                <div className="source-actions" style={{ gap: 8, display: 'flex' }}>
                  {f.has_update ? (
                    <button className="btn-secondary small" onClick={() => handleClearUpdate(f)}>标为已读</button>
                  ) : null}
                  <button className="btn-danger small" onClick={() => handleUnfollow(f.id)}>取消</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 文本净化 */}
      <section className="settings-section">
        <div className="source-header" style={{ marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>文本净化（{filters.length}）</h2>
          <button className="btn-secondary" onClick={() => setShowFilterForm(true)}>添加规则</button>
        </div>
        <p className="section-desc">按规则替换在线章节里的广告、乱码（例：匹配内容填 <code>.*?小说网</code>，「替换为」留空即删除）。</p>
        {showFilterForm && (
          <div className="source-form" style={{ marginBottom: 16 }}>
            <div className="form-row">
              <label>规则名称</label>
              <input value={filterForm.name} onChange={e => setFilterForm(s => ({ ...s, name: e.target.value }))} placeholder="去广告" />
            </div>
            <div className="form-row">
              <label>匹配内容（正则）</label>
              <input value={filterForm.pattern} onChange={e => setFilterForm(s => ({ ...s, pattern: e.target.value }))} placeholder="广告.*?\n" />
            </div>
            <div className="form-row">
              <label>替换为（留空=删除）</label>
              <input value={filterForm.replacement} onChange={e => setFilterForm(s => ({ ...s, replacement: e.target.value }))} placeholder="留空表示删除匹配到的内容" />
            </div>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setShowFilterForm(false)}>取消</button>
              <button className="btn-primary" onClick={handleAddFilter}>确定</button>
            </div>
          </div>
        )}
        {filters.length === 0 ? (
          <p className="empty-text">暂无规则</p>
        ) : (
          <div className="source-list">
            {filters.map(f => (
              <div key={f.id} className="source-card">
                <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
                  <h3 style={{ opacity: f.enabled ? 1 : 0.5 }}>{f.name}{f.enabled ? '' : '（已停用）'}</h3>
                  <p className="source-url"><code>{f.pattern}</code> → {f.replacement ? <code>{f.replacement}</code> : '删除'}</p>
                </div>
                <div className="source-actions" style={{ gap: 8, display: 'flex' }}>
                  <button className="btn-secondary small" onClick={() => handleToggleFilter(f)}>
                    {f.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn-danger small" onClick={() => handleDeleteFilter(f.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showAdd && (
        <div className="source-form">
          <h3>添加书源</h3>
          <div className="form-row">
            <label>书源名称</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="例如：笔趣阁" />
          </div>
          <div className="form-row">
            <label>书源主页</label>
            <input value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://example.com" />
          </div>
          <h4 className="form-sub">搜索规则</h4>
          <p className="section-desc">以下「选择器」用来告诉软件去网页的哪个位置取内容，需要懂一点网页结构；不懂的话可以先留空，只填搜索地址。</p>
          <div className="form-row">
            <label>搜索地址（用 {"{{keyword}}"} 替代关键词）</label>
            <input value={form.search_url} onChange={e => set('search_url', e.target.value)} placeholder="https://example.com/s?q={{keyword}}" />
          </div>
          <div className="form-row">
            <label>搜索结果列表位置（CSS 选择器，高级）</label>
            <input value={form.search_list} onChange={e => set('search_list', e.target.value)} placeholder=".result-list .item" />
          </div>
          <div className="form-row">
            <label>书名 / 作者 / 详情链接位置（CSS 选择器，高级）</label>
            <div className="form-inline">
              <input value={form.search_name} onChange={e => set('search_name', e.target.value)} placeholder="书名：.title" />
              <input value={form.search_author} onChange={e => set('search_author', e.target.value)} placeholder="作者：.author" />
              <input value={form.search_detail} onChange={e => set('search_detail', e.target.value)} placeholder="链接：a" />
            </div>
          </div>
          <h4 className="form-sub">章节与正文规则</h4>
          <div className="form-row">
            <label>章节列表 / 章节名位置（CSS 选择器，高级）</label>
            <div className="form-inline">
              <input value={form.chapters_list} onChange={e => set('chapters_list', e.target.value)} placeholder="列表：.chapter-list a" />
              <input value={form.chapters_name} onChange={e => set('chapters_name', e.target.value)} placeholder="留空取链接文本" />
            </div>
          </div>
          <div className="form-row">
            <label>正文内容位置（CSS 选择器，高级）</label>
            <input value={form.content_selector} onChange={e => set('content_selector', e.target.value)} placeholder=".content" />
          </div>
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setShowAdd(false)}>取消</button>
            <button className="btn-primary" onClick={handleAdd}>确定</button>
          </div>
        </div>
      )}

      <div className="source-list">
        {sources.length === 0 ? (
          <div className="empty-state small">
            <p>暂无书源，点击「添加书源」或「导入书源」开始</p>
          </div>
        ) : (
          sources.map(source => (
            <div key={source.id} className="source-card">
              <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
                <h3>{source.name}</h3>
                <p className="source-url">{source.url}</p>
                {!source.rules && (
                  <p className="source-warn">
                    <Icon name="alert" size={13} />
                    缺少抓取规则，无法搜索
                  </p>
                )}
              </div>
              <div className="source-actions">
                <button className="btn-danger small" onClick={() => handleDelete(source.id)}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
