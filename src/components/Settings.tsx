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
}

export function Settings() {
  const [settings, setSettings] = useState<SettingsData>({
    aiProvider: 'ollama',
    aiBaseUrl: 'http://localhost:11434',
    aiModel: 'qwen2.5:7b',
    aiApiKey: '',
    webdavUrl: '',
    webdavUser: '',
    webdavPass: '',
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const keys = Object.keys(settings) as (keyof SettingsData)[];
    const loaded = { ...settings };
    for (const key of keys) {
      const value = await window.electronAPI.getSetting(key);
      if (value !== null) {
        (loaded as any)[key] = isNaN(Number(value)) ? value : Number(value);
      }
    }
    setSettings(loaded);
  };

  const handleSave = async () => {
    const entries = Object.entries(settings) as [keyof SettingsData, any][];
    for (const [key, value] of entries) {
      await window.electronAPI.setSetting(key, String(value));
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleChange = (key: keyof SettingsData, value: any) => {
    setSettings(s => ({ ...s, [key]: value }));
  };

  return (
    <div className="settings">
      <h1>设置</h1>

      <section className="settings-section">
        <h2>阅读设置</h2>
        <div className="form-row">
          <label>默认字号</label>
          <input
            type="number"
            value={settings.fontSize}
            onChange={e => handleChange('fontSize', Number(e.target.value))}
            min={12}
            max={32}
          />
        </div>
        <div className="form-row">
          <label>行间距</label>
          <input
            type="number"
            value={settings.lineHeight}
            onChange={e => handleChange('lineHeight', Number(e.target.value))}
            min={1}
            max={3}
            step={0.1}
          />
        </div>
        <div className="form-row">
          <label>默认主题</label>
          <select
            value={settings.theme}
            onChange={e => handleChange('theme', e.target.value)}
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="sepia">护眼</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2>AI 设置</h2>
        <p className="section-desc">配置本地 Ollama 或其他 AI 服务用于阅读辅助</p>
        <div className="form-row">
          <label>AI 服务</label>
          <select
            value={settings.aiProvider}
            onChange={e => handleChange('aiProvider', e.target.value)}
          >
            <option value="ollama">Ollama (本地)</option>
            <option value="openai">OpenAI</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div className="form-row">
          <label>服务地址</label>
          <input
            value={settings.aiBaseUrl}
            onChange={e => handleChange('aiBaseUrl', e.target.value)}
            placeholder="http://localhost:11434"
          />
        </div>
        <div className="form-row">
          <label>模型名称</label>
          <input
            value={settings.aiModel}
            onChange={e => handleChange('aiModel', e.target.value)}
            placeholder="qwen2.5:7b"
          />
        </div>
        {settings.aiProvider !== 'ollama' && (
          <div className="form-row">
            <label>API Key</label>
            <input
              type="password"
              value={settings.aiApiKey}
              onChange={e => handleChange('aiApiKey', e.target.value)}
              placeholder="sk-..."
            />
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>WebDAV 同步</h2>
        <p className="section-desc">配置 WebDAV 服务器同步书架、进度和笔记</p>
        <div className="form-row">
          <label>服务器地址</label>
          <input
            value={settings.webdavUrl}
            onChange={e => handleChange('webdavUrl', e.target.value)}
            placeholder="https://dav.example.com"
          />
        </div>
        <div className="form-row">
          <label>用户名</label>
          <input
            value={settings.webdavUser}
            onChange={e => handleChange('webdavUser', e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>密码</label>
          <input
            type="password"
            value={settings.webdavPass}
            onChange={e => handleChange('webdavPass', e.target.value)}
          />
        </div>
      </section>

      <div className="settings-footer">
        <button className="btn-primary" onClick={handleSave}>
          {saved ? '✓ 已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
