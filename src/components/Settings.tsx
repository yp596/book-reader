import { useState, useEffect } from 'react';
import { THEMES } from '../utils/reader-options';
import { DEFAULT_AUTO_THEME, isDaytime } from '../utils/auto-theme';
import { SHORTCUT_PRESETS, getPreset, DEFAULT_SHORTCUT_PRESET, type ShortcutAction } from '../utils/shortcuts';

/** 动作的中文名，用于键位表展示 */
const ACTION_LABELS: Record<ShortcutAction, string> = {
  next: '下一页', prev: '上一页', first: '跳到首页', last: '跳到末页',
  toggleTheme: '切换主题', fontUp: '放大字号', fontDown: '缩小字号',
  openToc: '打开目录', openSearch: '书内检索', openNotes: '我的笔记', openPositions: '阅读位置',
  highlight: '高亮选中文字', addNote: '为选中文字写笔记',
  toggleDualColumn: '单双栏切换', toggleFullscreen: '全屏切换',
};

const KEY_LABELS: Record<string, string> = {
  ' ': '空格', ArrowRight: '→', ArrowLeft: '←', PageDown: 'PgDn', PageUp: 'PgUp',
};
const keyLabel = (k: string) => KEY_LABELS[k] ?? (k.length === 1 ? k.toUpperCase() : k);

/** 0-23 整点选项 */
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const fmtHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

interface SettingsData {
  aiProvider: 'ollama' | 'openai' | 'custom';
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  aiEmbedUrl: string;
  fontSize: number;
  lineHeight: number;
  theme: 'dark' | 'light' | 'sepia';
  fontFamily: string;
  ttsRate: number;
  /** 自动护眼：按本机时钟切换日/夜间主题（纯本地） */
  autoTheme: boolean;
  autoThemeDayStart: number;
  autoThemeNightStart: number;
  autoThemeDay: 'dark' | 'light' | 'sepia';
  autoThemeNight: 'dark' | 'light' | 'sepia';
  /** 退出软件时自动清理临时隐私数据 */
  privacyAutoClear: boolean;
  /** 当前快捷键预设 key */
  shortcutPreset: string;
  /** 全局强制统一字体（压过电子书自带字体） */
  forceFont: boolean;
  /** 批注只读：禁止新增/删除批注 */
  annotationsReadonly: boolean;
  /** TXT 目录解析方式：默认择优 / 关键字 / 自定义正则 */
  txtTocMode: 'default' | 'keyword' | 'regex';
  /** 关键字解析时的关键字，多个用 | 或换行分隔 */
  txtTocKeyword: string;
  /** 自定义正则解析时的表达式 */
  txtTocRegex: string;
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
    aiEmbedUrl: 'http://localhost:8081',
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'dark',
    fontFamily: 'system',
    ttsRate: 1,
    autoTheme: DEFAULT_AUTO_THEME.enabled,
    autoThemeDayStart: DEFAULT_AUTO_THEME.dayStart,
    autoThemeNightStart: DEFAULT_AUTO_THEME.nightStart,
    autoThemeDay: DEFAULT_AUTO_THEME.dayTheme,
    autoThemeNight: DEFAULT_AUTO_THEME.nightTheme,
    privacyAutoClear: false,
    shortcutPreset: DEFAULT_SHORTCUT_PRESET,
    forceFont: false,
    annotationsReadonly: false,
    txtTocMode: 'default',
    txtTocKeyword: '',
    txtTocRegex: '',
  });
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('');

  useEffect(() => { loadSettings(); loadLastSync(); loadSnapshots(); loadLastBackup(); }, []);

  const loadLastSync = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const v = await api.getSetting('lastSyncAt');
    if (v) setLastSync(v);
  };

  const loadSettings = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const BOOL_KEYS: (keyof SettingsData)[] = ['autoTheme', 'privacyAutoClear', 'forceFont', 'annotationsReadonly'];
    const NUM_KEYS: (keyof SettingsData)[] = [
      'fontSize', 'lineHeight', 'ttsRate', 'autoThemeDayStart', 'autoThemeNightStart',
    ];
    const keys = Object.keys(settings) as (keyof SettingsData)[];
    const loaded = { ...settings };
    for (const key of keys) {
      const value = await api.getSetting(key);
      if (value === null) continue;
      if (BOOL_KEYS.includes(key)) {
        (loaded as any)[key] = value === 'true' || value === '1';
      } else if (NUM_KEYS.includes(key)) {
        const n = Number(value);
        if (!Number.isNaN(n)) (loaded as any)[key] = n;
      } else {
        (loaded as any)[key] = value;
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

  // ---------- 本地备份（纯离线） ----------

  const [snapshots, setSnapshots] = useState<
    { file: string; name: string; createdAt: string; sizeKB: number }[]
  >([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState('');

  const loadSnapshots = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setSnapshots(await api.listSnapshots());
  };

  const loadLastBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const v = await api.getSetting('lastLocalBackupAt');
    if (v) setLastBackup(new Date(v).toLocaleString());
  };

  const handleExportBackup = async (full: boolean) => {
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.exportBackup(full);
      if (r) {
        await loadLastBackup();
        alert(`已导出${r.kind === 'incremental' ? '增量' : '全量'}备份（${r.count} 条记录）\n${r.filePath}`);
      }
    } catch (err) {
      alert(`导出失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.importBackup();
      if (r) alert(`恢复完成，合并 ${r.restored} 条数据（备份时间：${new Date(r.createdAt).toLocaleString()}）`);
    } catch (err) {
      alert(`恢复失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleSnapshot = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.createSnapshot();
      await loadSnapshots();
      alert(`快照已生成${r.pruned > 0 ? `，清理旧快照 ${r.pruned} 份` : ''}`);
    } catch (err) {
      alert(`快照失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreSnapshot = async (file: string) => {
    if (!confirm('从该快照回退会合并历史数据，确定继续？')) return;
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.restoreSnapshot(file);
      alert(`回退完成，合并 ${r.restored} 条数据`);
    } catch (err) {
      alert(`回退失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  // ---------- 隐私清理 ----------

  const [privacyOpts, setPrivacyOpts] = useState({
    positions: true,
    chapterCache: true,
    timestamps: false,
    clipboard: true,
  });
  const [privacyBusy, setPrivacyBusy] = useState(false);

  const handlePrivacyClear = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (!Object.values(privacyOpts).some(Boolean)) {
      alert('请至少选择一项要清理的内容');
      return;
    }
    if (!confirm('确定清理所选隐私数据？此操作不可撤销。')) return;
    setPrivacyBusy(true);
    try {
      const r = await api.clearPrivacy(privacyOpts);
      const parts: string[] = [];
      if (r.positions) parts.push(`阅读位置记录 ${r.positions} 条`);
      if (r.chapterCache) parts.push(`章节缓存 ${r.chapterCache} 条`);
      if (r.timestamps) parts.push(`阅读时间戳 ${r.timestamps} 本`);
      if (r.clipboard) parts.push('剪贴板已清空');
      alert(`清理完成：${parts.length > 0 ? parts.join('、') : '没有需要清理的数据'}`);
    } catch (err) {
      alert(`清理失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPrivacyBusy(false);
    }
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

  /** 自动护眼预览：按当前本机时钟算出此刻会使用哪套主题 */
  const autoThemePreview = (() => {
    if (!settings.autoTheme) return '';
    const day = isDaytime(
      new Date().getHours(),
      settings.autoThemeDayStart,
      settings.autoThemeNightStart,
    );
    const key = day ? settings.autoThemeDay : settings.autoThemeNight;
    const label = THEMES.find(t => t.key === key)?.label ?? key;
    return `当前本机时间判定：${day ? '日间' : '夜间'} → ${label}`;
  })();

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
            {THEMES.map(t => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.autoTheme}
              onChange={e => handleChange('autoTheme', e.target.checked)}
            />
            <span>自动护眼（按本机时钟切换主题，全程离线）</span>
          </label>
        </div>

        {settings.autoTheme && (
          <div className="auto-theme-panel">
            <div className="form-row">
              <label>日间时段</label>
              <div className="hour-range">
                <select
                  value={settings.autoThemeDayStart}
                  onChange={e => handleChange('autoThemeDayStart', Number(e.target.value))}
                >
                  {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
                <span className="range-sep">起，至</span>
                <select
                  value={settings.autoThemeNightStart}
                  onChange={e => handleChange('autoThemeNightStart', Number(e.target.value))}
                >
                  {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
                <span className="range-sep">止</span>
              </div>
            </div>
            <div className="form-row">
              <label>日间主题</label>
              <select value={settings.autoThemeDay} onChange={e => handleChange('autoThemeDay', e.target.value)}>
                {THEMES.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>夜间主题</label>
              <select value={settings.autoThemeNight} onChange={e => handleChange('autoThemeNight', e.target.value)}>
                {THEMES.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>
            <p className="section-desc" style={{ marginBottom: 0 }}>
              {autoThemePreview}
            </p>
          </div>
        )}
        <div className="form-row">
          <label>默认字体</label>
          <select value={settings.fontFamily} onChange={e => handleChange('fontFamily', e.target.value)}>
            <option value="system">系统默认</option>
            <option value="serif">宋体</option>
            <option value="sans">黑体</option>
            <option value="kai">楷体</option>
            <option value="mono">等宽</option>
          </select>
        </div>
        <div className="form-row" style={{ marginBottom: 8 }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.forceFont}
              onChange={e => handleChange('forceFont', e.target.checked)}
            />
            <span>
              全局强制统一字体
              <em className="privacy-hint">覆盖电子书自带的异体字/缺字，全部使用上面选定的字体</em>
            </span>
          </label>
        </div>

        <div className="form-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.annotationsReadonly}
              onChange={e => handleChange('annotationsReadonly', e.target.checked)}
            />
            <span>
              批注只读模式
              <em className="privacy-hint">禁止新增/删除高亮与笔记，防止误操作；已有批注照常显示</em>
            </span>
          </label>
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
        <h2>TXT 目录解析</h2>
        <p className="section-desc">
          决定 TXT 书籍如何识别章节标题。改动对之后导入的书生效；已导入的书可在书籍详情页重新解析。
        </p>
        <div className="form-row">
          <label>解析方式</label>
          <select
            value={settings.txtTocMode}
            onChange={e => handleChange('txtTocMode', e.target.value)}
          >
            <option value="default">默认（内置规则自动择优）</option>
            <option value="keyword">关键字</option>
            <option value="regex">正则表达式</option>
          </select>
        </div>

        {settings.txtTocMode === 'keyword' && (
          <>
            <div className="form-row">
              <label>关键字</label>
              <input
                value={settings.txtTocKeyword}
                onChange={e => handleChange('txtTocKeyword', e.target.value)}
                placeholder="章|节|卷　（多个用 | 或换行分隔）"
              />
            </div>
            <p className="section-desc">行首命中任一关键字的行视为章节标题，标题长度不超过 30 字。</p>
          </>
        )}

        {settings.txtTocMode === 'regex' && (
          <>
            <div className="form-row">
              <label>正则表达式</label>
              <input
                value={settings.txtTocRegex}
                onChange={e => handleChange('txtTocRegex', e.target.value)}
                placeholder="^第[0-9]+章.*$"
              />
            </div>
            <p className="section-desc">按多行模式匹配，命中位置即为章节起点；表达式非法时自动回退到默认方式。</p>
          </>
        )}
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
        <div className="form-row">
          <label>向量服务地址（语义检索用）</label>
          <input value={settings.aiEmbedUrl} onChange={e => handleChange('aiEmbedUrl', e.target.value)} placeholder="http://localhost:8081" />
        </div>
      </section>

      <section className="settings-section">
        <h2>本地备份（离线）</h2>
        <p className="section-desc">
          数据只写入你自己选择的文件，不上传任何服务器。增量导出仅包含上次导出后变更的笔记、书签、生词与设置。
        </p>
        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn-primary" onClick={() => handleExportBackup(false)} disabled={backupBusy}>
            导出增量备份
          </button>
          <button className="btn-secondary" onClick={() => handleExportBackup(true)} disabled={backupBusy}>
            导出全量
          </button>
          <button className="btn-secondary" onClick={handleImportBackup} disabled={backupBusy}>
            从文件恢复
          </button>
          <button className="btn-secondary" onClick={handleSnapshot} disabled={backupBusy}>
            立即生成快照
          </button>
        </div>
        {lastBackup && (
          <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
            上次导出：{lastBackup}
          </p>
        )}

        {snapshots.length > 0 && (
          <div className="snapshot-list">
            <div className="snapshot-title">本地快照（自动保留最近 14 份）</div>
            {snapshots.slice(0, 6).map(s => (
              <div key={s.file} className="snapshot-row">
                <span className="snapshot-time">{new Date(s.createdAt).toLocaleString()}</span>
                <span className="snapshot-size">{s.sizeKB} KB</span>
                <button
                  className="btn-secondary small"
                  onClick={() => handleRestoreSnapshot(s.file)}
                  disabled={backupBusy}
                >
                  回退
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>快捷键方案</h2>
        <p className="section-desc">
          三套预设一键切换。每套都保留翻页与首末页基础键，不会出现切过去翻不了页的情况。
        </p>
        <div className="preset-row">
          {SHORTCUT_PRESETS.map(p => (
            <button
              key={p.key}
              className={`preset-card${settings.shortcutPreset === p.key ? ' active' : ''}`}
              onClick={() => handleChange('shortcutPreset', p.key)}
            >
              <strong>{p.name}</strong>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
        <div className="keymap-list">
          {Object.entries(getPreset(settings.shortcutPreset).map).map(([key, action]) => (
            <div key={key} className="keymap-row">
              <kbd>{keyLabel(key)}</kbd>
              <span>{ACTION_LABELS[action as ShortcutAction]}</span>
            </div>
          ))}
        </div>
        <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
          固定键位：Esc 收起面板 / 返回书架；Alt+← → 前进后退。
        </p>
      </section>

      <section className="settings-section">
        <h2>隐私清理（纯本地）</h2>
        <p className="section-desc">
          清除本机留下的使用痕迹。不涉及书籍文件、笔记与书签本身。
        </p>

        <div className="privacy-opts">
          {([
            ['positions', '阅读位置记录', '正常退出/异常退出自动留下的断点（手动标记的保留）'],
            ['chapterCache', '在线章节缓存', '在线书源抓取的正文缓存，需要时可重新抓取'],
            ['timestamps', '阅读时间戳', '抹掉「什么时候读过」，阅读进度不受影响'],
            ['clipboard', '剪贴板', '清空系统剪贴板中的内容'],
          ] as [keyof typeof privacyOpts, string, string][]).map(([key, label, hint]) => (
            <label key={key} className="checkbox-row" title={hint}>
              <input
                type="checkbox"
                checked={privacyOpts[key]}
                onChange={e => setPrivacyOpts(p => ({ ...p, [key]: e.target.checked }))}
              />
              <span>
                {label}
                <em className="privacy-hint">{hint}</em>
              </span>
            </label>
          ))}
        </div>

        <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: 16 }}>
          <button className="btn-secondary" onClick={handlePrivacyClear} disabled={privacyBusy}>
            {privacyBusy ? '清理中...' : '立即清理'}
          </button>
        </div>

        <div className="form-row" style={{ marginTop: 18, marginBottom: 0 }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.privacyAutoClear}
              onChange={e => handleChange('privacyAutoClear', e.target.checked)}
            />
            <span>
              退出软件时自动清理
              <em className="privacy-hint">仅清章节缓存与剪贴板；笔记、书签、进度一律保留</em>
            </span>
          </label>
        </div>
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
