import { useState, useEffect } from 'react';
import { BookSource } from '../types';

export function SourceManager() {
  const [sources, setSources] = useState<BookSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newSource, setNewSource] = useState({
    name: '',
    url: '',
    search_url: '',
    chapters_url: '',
    content_url: '',
  });

  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    const allSources = await window.electronAPI.getAllSources();
    setSources(allSources as BookSource[]);
  };

  const handleAdd = async () => {
    if (!newSource.name || !newSource.url) return;
    await window.electronAPI.addSource(newSource);
    setNewSource({ name: '', url: '', search_url: '', chapters_url: '', content_url: '' });
    setShowAdd(false);
    loadSources();
  };

  const handleDelete = async (id: number) => {
    if (confirm('确定删除此书源？')) {
      await window.electronAPI.deleteSource(id);
      loadSources();
    }
  };

  const handleImportJson = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const json = JSON.parse(text);
        // 支持 Legado 格式书源导入
        const sourceList = Array.isArray(json) ? json : [json];
        for (const s of sourceList) {
          await window.electronAPI.addSource({
            name: s.name || s.bookSourceName || '未命名书源',
            url: s.bookSourceUrl || '',
            search_url: s.ruleSearch?.url || '',
            chapters_url: s.ruleToc?.url || '',
            content_url: s.ruleContent?.url || '',
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
    const data = sources.map(s => ({
      name: s.name,
      bookSourceUrl: s.url,
      ruleSearch: { url: s.search_url },
      ruleToc: { url: s.chapters_url },
      ruleContent: { url: s.content_url },
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'book-sources.json';
    a.click();
    URL.revokeObjectURL(url);
  };

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

      {showAdd && (
        <div className="source-form">
          <h3>添加书源</h3>
          <div className="form-row">
            <label>书源名称</label>
            <input
              value={newSource.name}
              onChange={e => setNewSource(s => ({ ...s, name: e.target.value }))}
              placeholder="例如：笔趣阁"
            />
          </div>
          <div className="form-row">
            <label>书源地址</label>
            <input
              value={newSource.url}
              onChange={e => setNewSource(s => ({ ...s, url: e.target.value }))}
              placeholder="https://example.com"
            />
          </div>
          <div className="form-row">
            <label>搜索地址</label>
            <input
              value={newSource.search_url}
              onChange={e => setNewSource(s => ({ ...s, search_url: e.target.value }))}
              placeholder="搜索 URL，用 {{keyword}} 替代关键词"
            />
          </div>
          <div className="form-row">
            <label>章节列表</label>
            <input
              value={newSource.chapters_url}
              onChange={e => setNewSource(s => ({ ...s, chapters_url: e.target.value }))}
              placeholder="章节列表 URL 或 CSS 选择器"
            />
          </div>
          <div className="form-row">
            <label>正文内容</label>
            <input
              value={newSource.content_url}
              onChange={e => setNewSource(s => ({ ...s, content_url: e.target.value }))}
              placeholder="正文内容 CSS 选择器"
            />
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
              <div className="source-info">
                <h3>{source.name}</h3>
                <p className="source-url">{source.url}</p>
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
