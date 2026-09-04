import { useState, useEffect } from 'react';
import { BookSource, OnlineBook } from '../types';
import { OnlineReader } from './OnlineReader';

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

  useEffect(() => { loadSources(); }, []);

  const loadSources = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const allSources = await api.getAllSources();
    setSources(allSources as BookSource[]);
  };

  const set = (key: keyof typeof emptyForm, value: string) =>
    setForm(s => ({ ...s, [key]: value }));

  const handleAdd = async () => {
    if (!form.name || !form.url) return;
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

      <div className="source-info">
        <p>💡 支持导入 Legado 格式的 JSON 书源。不内置任何书源，由用户自行导入。</p>
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
          <div className="form-row">
            <label>搜索地址（用 {"{{keyword}}"} 替代关键词）</label>
            <input value={form.search_url} onChange={e => set('search_url', e.target.value)} placeholder="https://example.com/s?q={{keyword}}" />
          </div>
          <div className="form-row">
            <label>结果列表选择器（CSS）</label>
            <input value={form.search_list} onChange={e => set('search_list', e.target.value)} placeholder=".result-list .item" />
          </div>
          <div className="form-row">
            <label>书名 / 作者 / 详情链接选择器（CSS，逗号分隔）</label>
            <div className="form-inline">
              <input value={form.search_name} onChange={e => set('search_name', e.target.value)} placeholder="书名：.title" />
              <input value={form.search_author} onChange={e => set('search_author', e.target.value)} placeholder="作者：.author" />
              <input value={form.search_detail} onChange={e => set('search_detail', e.target.value)} placeholder="链接：a" />
            </div>
          </div>
          <h4 className="form-sub">章节与正文规则</h4>
          <div className="form-row">
            <label>章节列表 / 章节名选择器（CSS）</label>
            <div className="form-inline">
              <input value={form.chapters_list} onChange={e => set('chapters_list', e.target.value)} placeholder="列表：.chapter-list a" />
              <input value={form.chapters_name} onChange={e => set('chapters_name', e.target.value)} placeholder="留空取链接文本" />
            </div>
          </div>
          <div className="form-row">
            <label>正文内容选择器（CSS）</label>
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
                {!source.rules && <p className="source-warn">⚠ 缺少抓取规则，无法搜索</p>}
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
