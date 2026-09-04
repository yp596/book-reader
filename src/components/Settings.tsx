import { useState, useEffect } from 'react';

interface SettingsData {
  aiProvider: 'ollama' | 'openai' | 'custom';
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  fontSize: number;
  lineHeight: number;
  theme: 'dark' | 'light' | 'sepia';
  ttsRate: number;
}

export function Settings() {
  const [settings, setSettings] = useState<SettingsData>({
    aiProvider: 'ollama',
    aiBaseUrl: 'http://localhost:11434',
    aiModel: 'minicpm5-1b',
    aiApiKey: '',
    webdavUrl: '',
    webdavUser: '',
    webdavPass: '',
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark',
    ttsRate: 1,
  });
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('');

  useEffect(() => { loadSettings(); loadLastSync(); }, []);

  const loadLastSync = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const v = await api.getSetting('lastSyncAt');
    if (v) setLastSync(v);
  };

  const loadSettings = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const keys = Object.keys(settings) as (keyof SettingsData)[];
    const loaded = { ...settings };
    for (const key of keys) {
      const value = await api.getSetting(key);
      if (value !== null) {
        (loaded as any)[key] = isNaN(Number(value)) ? value : Number(value);
      }
    }
    setSettings(loaded);
  };

  const handleSave = async (silent = false) => {
    const api = window.electronAPI;
    if (!api) return;
    const entries = Object.entries(settings) as [keyof SettingsData, any][];
    for (const [key, value] of entries) {
      await api.setSetting(key, String(value));
    }
    if (silent) return;
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleChange = (key: keyof SettingsData, value: any) => {
    setSettings(s => ({ ...s, [key]: value }));
  };

  const handleBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    // 先保存当前配置再同步
    await handleSave(true);
    setSyncing(true);
    try {
      await api.syncBackup();
      await loadLastSync();
      alert('备份成功');
    } catch (err) {
      alert(`备份失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    if (!confirm('从 WebDAV 恢复会合并远端数据，确定继续？')) return;
    const api = window.electronAPI;
    if (!api) return;
    setSyncing(true);
    try {
      const count = await api.syncRestore();
      await loadLastSync();
      alert(`恢复完成，合并 ${count} 条数据`);
    } catch (err) {
      alert(`恢复失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="settings">
      <h1>设置</h1>

      <section className="settings-section">
        <h2>阅读设置</h2>
        <div className="form-row">
          <label>默认字号</label>
          <input type="number" value={settings.fontSize} onChange={e => handleChange('fontSize', Number(e.target.value))} min={12} max={32} />
        </div>
        <div className="form-row">
          <label>行间距</label>
          <input type="number" value={settings.lineHeight} onChange={e => handleChange('lineHeight', Number(e.target.value))} min={1} max={3} step={0.1} />
        </div>
        <div className="form-row">
          <label>默认主题</label>
          <select value={settings.theme} onChange={e => handleChange('theme', e.target.value)}>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="sepia">护眼</option>
          </select>
        </div>
        <div className="form-row">
          <label>朗读速度（{settings.ttsRate.toFixed(2)} 倍）</label>
          <input
            type="range"
            value={settings.ttsRate}
            onChange={e => handleChange('ttsRate', Number(e.target.value))}
            min={0.5}
            max={2}
            step={0.25}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>AI 设置</h2>
        <p className="section-desc">配置本地 Ollama 或其他 AI 服务用于阅读辅助</p>
        <div className="form-row">
          <label>AI 服务</label>
          <select value={settings.aiProvider} onChange={e => handleChange('aiProvider', e.target.value)}>
            <option value="ollama">Ollama（本地）</option>
            <option value="openai">OpenAI</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div className="form-row">
          <label>服务地址</label>
          <input value={settings.aiBaseUrl} onChange={e => handleChange('aiBaseUrl', e.target.value)} placeholder="http://localhost:11434" />
        </div>
        <div className="form-row">
          <label>模型名称</label>
          <input value={settings.aiModel} onChange={e => handleChange('aiModel', e.target.value)} placeholder="minicpm5-1b" />
        </div>
        {settings.aiProvider !== 'ollama' && (
          <div className="form-row">
            <label>API 密钥</label>
            <input type="password" value={settings.aiApiKey} onChange={e => handleChange('aiApiKey', e.target.value)} placeholder="sk-..." />
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>WebDAV 同步</h2>
        <p className="section-desc">配置 WebDAV 服务器同步书架、进度和笔记</p>
        <div className="form-row">
          <label>服务器地址</label>
          <input value={settings.webdavUrl} onChange={e => handleChange('webdavUrl', e.target.value)} placeholder="https://dav.example.com" />
        </div>
        <div className="form-row">
          <label>用户名</label>
          <input value={settings.webdavUser} onChange={e => handleChange('webdavUser', e.target.value)} />
        </div>
        <div className="form-row">
          <label>密码</label>
          <input type="password" value={settings.webdavPass} onChange={e => handleChange('webdavPass', e.target.value)} />
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn-secondary" onClick={handleBackup} disabled={syncing}>
            {syncing ? '同步中...' : '⬆ 备份到云端'}
          </button>
          <button className="btn-secondary" onClick={handleRestore} disabled={syncing}>
            {syncing ? '同步中...' : '⬇ 从云端恢复'}
          </button>
          {lastSync && <span className="book-meta">上次同步：{lastSync}</span>}
        </div>
        <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
          同步进度、书签、笔记、书源和阅读偏好，不含书籍文件（各设备需各自导入同名书籍）。
        </p>
      </section>

      <div className="settings-footer">
        <button className="btn-primary" onClick={() => handleSave()}>
          {saved ? '✓ 已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
