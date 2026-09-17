import { useState, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatFileSize } from '../utils/text';
import { THEMES } from '../utils/reader-options';
import { DEFAULT_AUTO_THEME, isDaytime } from '../utils/auto-theme';
import { Icon } from './Icon';

import {
  SHORTCUT_PRESETS,
  getPreset,
  DEFAULT_SHORTCUT_PRESET,
  ACTION_LABELS,
  keyLabel,
  normalizeKey,
  buildKeyMap,
  findKeyConflict,
  keyForAction,
  parseShortcutOverrides,
  type ShortcutAction,
  type ShortcutOverrides,
} from '../utils/shortcuts';


/** 0-23 整点选项 */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * 常用 OpenAI 兼容服务：只预填地址与建议模型，密钥仍需自己填。
 * 地址都实测过（无密钥请求返回 401，说明端点存在、路径正确）。
 * OpenAI 与 LM Studio 在本机连不通、没能核实，因此不入列表，需要时手动填地址即可。
 */
const AI_PRESETS = [
  {
    key: 'deepseek',
    name: 'DeepSeek（深度求索）',
    provider: 'openai' as const,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  {
    key: 'moonshot',
    name: 'Kimi（月之暗面）',
    provider: 'openai' as const,
    baseUrl: 'https://api.moonshot.cn',
    model: 'moonshot-v1-8k',
  },
  {
    key: 'dashscope',
    name: '通义千问（阿里云）',
    provider: 'openai' as const,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    provider: 'openai' as const,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  {
    key: 'ollama',
    name: 'Ollama（本机）',
    provider: 'ollama' as const,
    baseUrl: 'http://localhost:11434',
    model: '',
  },
];
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
  /** 关闭窗口时最小化到托盘，应用继续驻留 */
  closeToTray: boolean;
  /** 防截屏：窗口内容在截图/录屏中不显示 */
  screenProtection: boolean;
  /** 当前快捷键预设 key */
  shortcutPreset: string;
  /** 全局强制统一字体（压过电子书自带字体） */
  forceFont: boolean;
  /** 批注只读：禁止新增/删除批注 */
  annotationsReadonly: boolean;
  /** 闲置判定天数（书架「闲置」筛选用） */
  idleDays: number;
  /** 每日阅读目标（分钟，0=不设目标） */
  dailyGoalMinutes: number;
  /** TXT 目录解析方式：默认择优 / 关键字 / 自定义正则 */
  txtTocMode: 'default' | 'keyword' | 'regex';
  /** 关键字解析时的关键字，多个用 | 或换行分隔 */
  txtTocKeyword: string;
  /** 自定义正则解析时的表达式 */
  txtTocRegex: string;
  /** 导入时遇到重复书籍：跳过 / 各留一本 / 覆盖已有记录 */
  importConflictPolicy: 'skip' | 'keep' | 'replace';
  /** 联网附加能力总开关：关闭时不发起任何出站请求 */
  onlineFeaturesEnabled: boolean;
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
    closeToTray: false,
    screenProtection: false,
    shortcutPreset: DEFAULT_SHORTCUT_PRESET,
    forceFont: false,
    annotationsReadonly: false,
    idleDays: 90,
    dailyGoalMinutes: 30,
    txtTocMode: 'default',
    txtTocKeyword: '',
    txtTocRegex: '',
    importConflictPolicy: 'skip',
    onlineFeaturesEnabled: false,
  });
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('');
  /** 自定义快捷键：动作 → 归一化按键（空串=显式不绑定），与预设合成后生效 */
  const [shortcutCustom, setShortcutCustom] = useState<ShortcutOverrides>({});
  /** 正在录制新键的动作 */
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  /** 改绑提示（例如「这个键原本属于谁」） */
  const [keyNotice, setKeyNotice] = useState('');

  useEffect(() => {
    loadSettings();
    loadLastSync();
    loadSnapshots();
    loadLastBackup();
    loadCacheStats();
    loadWatch();
    loadFonts();
  }, []);

  const loadLastSync = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const v = await api.getSetting('lastSyncAt');
      if (v) setLastSync(v);
    } catch { /* 读不到就保持空，不影响其它设置项 */ }
  };

  /** 备份里挂不上书的条目会被丢弃，不说明白用户会以为数据全回来了 */
  const describeDropped = (dropped?: { books: number; bookmarks: number; notes: number }) => {
    if (!dropped) return '';
    const parts: string[] = [];
    if (dropped.books > 0) parts.push(`${dropped.books} 本书`);
    if (dropped.bookmarks > 0) parts.push(`${dropped.bookmarks} 条书签`);
    if (dropped.notes > 0) parts.push(`${dropped.notes} 条笔记`);
    if (parts.length === 0) return '';
    return `\n注意：有 ${parts.join('、')}在本地找不到对应书籍，未能恢复。`;
  };

  const loadSettings = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const BOOL_KEYS: (keyof SettingsData)[] = ['autoTheme', 'privacyAutoClear', 'forceFont', 'annotationsReadonly', 'closeToTray', 'screenProtection', 'onlineFeaturesEnabled'];
    const NUM_KEYS: (keyof SettingsData)[] = [
      'fontSize', 'lineHeight', 'ttsRate', 'autoThemeDayStart', 'autoThemeNightStart', 'idleDays', 'dailyGoalMinutes',
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
    setShortcutCustom(parseShortcutOverrides(await api.getSetting('shortcutCustom')));
  };

  const handleSave = async (silent = false) => {
    const api = window.electronAPI;
    if (!api) return;
    const entries = Object.entries(settings) as [keyof SettingsData, any][];
    try {
      for (const [key, value] of entries) {
        // 布尔设置统一落成 '1'/'0'：主进程按同一口径判断，
        // 若写成 String(true) 会出现「界面已开启、功能仍报未开启」的错位
        await api.setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
      }
    } catch (err) {
      // 逐项写入，中途失败会让后面的设置默默没保存，必须让用户知道
      alert(`设置有部分没能保存：${err instanceof Error ? err.message : '写入失败'}\n请重试。`);
      return;
    }
    if (silent) return;
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  /**
   * 单项即时落库。用于「改完立刻要生效」的设置（目前是联网开关）：
   * 布尔统一落 '1'/'0'，与 handleSave 保持同一编码口径。
   */
  const persistSettings = async (patch: Partial<SettingsData>) => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      for (const [key, value] of Object.entries(patch)) {
        await api.setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
      }
    } catch (err) {
      // 写失败必须回读，否则界面显示已开启、实际仍是关闭
      alert(`设置未能保存：${err instanceof Error ? err.message : '写入失败'}\n已恢复为磁盘上的实际值。`);
      await loadSettings();
    }
  };

  const handleChange = (key: keyof SettingsData, value: any) => {
    setSettings(s => ({ ...s, [key]: value }));
  };

  // ---------- 快捷键自定义 ----------

  /** 改完立即落盘：录制手感上不该还要记得点底部的保存 */
  const persistShortcutCustom = (next: ShortcutOverrides) => {
    setShortcutCustom(next);
    window.electronAPI?.setSetting('shortcutCustom', JSON.stringify(next)).catch(() => {});
  };

  /**
   * 录制新键。撞键时不静默覆盖，而是把该键从原动作身上摘掉并显式告知：
   * 原动作变成「未设置」，用户看得见，比留下一个不生效的假键位强。
   */
  const captureShortcutKey = (e: ReactKeyboardEvent, action: ShortcutAction) => {
    if (recording !== action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      setKeyNotice('');
      return;
    }
    const key = normalizeKey(e);
    const preset = getPreset(settings.shortcutPreset);
    const next: ShortcutOverrides = { ...shortcutCustom };
    const owner = findKeyConflict(buildKeyMap(preset, shortcutCustom), key, action);
    if (owner) {
      next[owner] = '';
      setKeyNotice(
        `「${keyLabel(key)}」原本属于「${ACTION_LABELS[owner]}」，已改绑到「${ACTION_LABELS[action]}」`,
      );
    } else {
      setKeyNotice('');
    }
    next[action] = key;
    persistShortcutCustom(next);
    setRecording(null);
  };

  /** 单个动作恢复预设键位 */
  const resetShortcut = (action: ShortcutAction) => {
    const next = { ...shortcutCustom };
    delete next[action];
    setKeyNotice('');
    persistShortcutCustom(next);
  };

  // ---------- 本地字体 ----------

  const [localFonts, setLocalFonts] = useState<{ name: string; family: string }[]>([]);

  const loadFonts = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setLocalFonts(await api.listFonts());
    } catch { /* 读取失败按无字体处理 */ }
  };

  const handleImportFont = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setLocalFonts(await api.importFonts());
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const handleRemoveFont = async (name: string) => {
    const api = window.electronAPI;
    if (!api) return;
    if (!confirm(`删除字体「${name}」？已使用该字体的书会回退到默认字体。`)) return;
    try {
      setLocalFonts(await api.removeFont(name));
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  // ---------- 本地备份（纯离线） ----------

  const [snapshots, setSnapshots] = useState<
    { file: string; name: string; createdAt: string; sizeKB: number }[]
  >([]);
  const [backupBusy, setBackupBusy] = useState(false);
  /** AI 服务连通性测试：外接大模型时先试一下，别等用的时候才发现填错 */
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState('');
  const [lastBackup, setLastBackup] = useState('');

  const loadSnapshots = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setSnapshots(await api.listSnapshots());
    } catch { /* 列表读不到不影响其它内容 */ }
  };

  const loadLastBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const v = await api.getSetting('lastLocalBackupAt');
      if (v) setLastBackup(new Date(v).toLocaleString());
    } catch { /* 同上 */ }
  };

  const handleExportBackup = async (full: boolean) => {
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.exportBackup(full);
      if (r) {
        await loadLastBackup();
        const fileText = r.bookFiles > 0 ? `，含 ${r.bookFiles} 个书籍文件` : '';
        const skipText =
          r.skippedFiles > 0
            ? `\n有 ${r.skippedFiles} 本书的源文件已不在本机，没能打包（恢复后需重新导入）`
            : '';
        alert(
          `已导出${r.kind === 'incremental' ? '增量' : '全量'}备份：${r.count} 条记录${fileText}，共 ${formatFileSize(r.sizeBytes)}。\n${r.filePath}${skipText}`,
        );
      }
    } catch (err) {
      alert(`导出失败：${err instanceof Error ? err.message : '请确认目标位置可写后重试'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (
      !confirm(
        '从备份恢复会把备份中的书籍、书签、笔记、进度与设置合并进当前书库。\n' +
          '备份里带着书籍文件的，书会一起重建；没有文件的只合并批注与设置。\n' +
          '现有笔记不会被删除；同一条记录以备份里的版本为准。\n\n' +
          '下一步选择备份文件，选完立即开始恢复。',
      )
    )
      return;
    setBackupBusy(true);
    try {
      const r = await api.importBackup();
      if (r) {
        // 设置项也在备份里：必须重新读一遍，否则用户接着点保存会把刚恢复的配置写回旧值
        await loadSettings();
        await loadSnapshots();
        await loadLastBackup();
        alert(
          `恢复完成：合并 ${r.restored} 条数据` +
            (r.books > 0 ? `，重建 ${r.books} 本书` : '') +
            `（备份时间：${new Date(r.createdAt).toLocaleString()}）。` +
            describeDropped(r.dropped),
        );
      }
    } catch (err) {
      alert(`恢复失败：${err instanceof Error ? err.message : '备份文件可能已损坏或不完整'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  /** 测试 AI 服务连通性：地址、密钥、模型名任一项填错都会在这里暴露出来 */
  const handleTestAi = async () => {
    const api = window.electronAPI;
    if (!api?.testAi) return;
    setAiTesting(true);
    setAiTestResult('');
    try {
      const r = await api.testAi({
        baseUrl: settings.aiBaseUrl,
        model: settings.aiModel,
        apiKey: settings.aiApiKey,
      });
      setAiTestResult(r.ok ? `连接成功，服务返回「${r.message}」` : `连接失败：${r.message}`);
    } catch (err) {
      setAiTestResult(`连接失败：${err instanceof Error ? err.message : '请重试'}`);
    } finally {
      setAiTesting(false);
    }
  };

  const handleSnapshot = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.createSnapshot();
      await loadSnapshots();
      alert(`已生成一份备份存档${r.pruned > 0 ? `，并清理了 ${r.pruned} 份最旧的存档` : ''}。`);
    } catch (err) {
      alert(`生成备份存档失败：${err instanceof Error ? err.message : '请重试'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreSnapshot = async (file: string) => {
    if (
      !confirm(
        '从这份存档回退会把存档里的书签、笔记、进度与设置合并回来。\n' +
          '回退只做合并，不会删除现有记录。确定继续？',
      )
    )
      return;
    const api = window.electronAPI;
    if (!api) return;
    setBackupBusy(true);
    try {
      const r = await api.restoreSnapshot(file);
      await loadSettings();
      alert(`回退完成，合并 ${r.restored} 条数据。${describeDropped(r.dropped)}`);
    } catch (err) {
      alert(`回退失败：${err instanceof Error ? err.message : '存档文件可能已损坏'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  // ---------- 文件夹监视 ----------

  const [watch, setWatch] = useState({ watching: false, dir: '', savedDir: '' });
  const [watchBusy, setWatchBusy] = useState(false);

  const loadWatch = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setWatch(await api.watchStatus());
    } catch { /* 忽略 */ }
  };

  const handlePickWatch = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const dir = await api.pickWatchDir();
    if (!dir) return;
    setWatchBusy(true);
    try {
      await api.startWatch(dir);
      await loadWatch();
    } catch (err) {
      alert(err instanceof Error ? err.message : '无法监视该目录');
    } finally {
      setWatchBusy(false);
    }
  };

  const handleStopWatch = async () => {
    setWatchBusy(true);
    try {
      await window.electronAPI?.stopWatch();
      await loadWatch();
    } finally {
      setWatchBusy(false);
    }
  };

  // ---------- 缓存管理 ----------

  const [cacheStats, setCacheStats] = useState<{
    chapterCount: number;
    snapshotBytes: number;
    booksBytes: number;
  } | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

  const loadCacheStats = async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setCacheStats(await api.getCacheStats());
    } catch { /* 统计失败不阻塞页面 */ }
  };

  const handleClearCache = async (opts: { snapshots?: boolean; chapterCache?: boolean }) => {
    const api = window.electronAPI;
    if (!api) return;
    if (!confirm('确定清理所选缓存？此操作不可撤销。')) return;
    setCacheBusy(true);
    try {
      const r = await api.clearCache(opts);
      await loadCacheStats();
      await loadSnapshots();
      const parts: string[] = [];
      if (r.snapshots) parts.push(`备份存档 ${r.snapshots} 份`);
      if (r.chapterCache) parts.push(`章节缓存 ${r.chapterCache} 条`);
      alert(`已清理：${parts.length > 0 ? parts.join('、') : '没有需要清理的内容'}`);
    } catch (err) {
      alert(`清理失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setCacheBusy(false);
    }
  };

  // ---------- 隐私清理 ----------

  const [privacyOpts, setPrivacyOpts] = useState({
    // 默认只勾最无害的在线章节缓存：剪贴板与阅读位置一旦清掉无法恢复，
    // 让用户自己勾，别替他决定
    positions: false,
    chapterCache: true,
    timestamps: false,
    clipboard: false,
  });
  const [privacyBusy, setPrivacyBusy] = useState(false);

  const handlePrivacyClear = async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (!Object.values(privacyOpts).some(Boolean)) {
      alert('请至少选择一项要清理的内容');
      return;
    }
    if (!confirm('确定清理所选隐私数据？清理后无法恢复。')) return;
    setPrivacyBusy(true);
    try {
      const r = await api.clearPrivacy(privacyOpts);
      const parts: string[] = [];
      if (r.positions) parts.push(`阅读位置记录 ${r.positions} 条`);
      if (r.chapterCache) parts.push(`章节缓存 ${r.chapterCache} 条`);
      if (r.timestamps) parts.push(`阅读时间戳 ${r.timestamps} 本`);
      if (r.clipboard) parts.push('系统剪贴板已清空');
      alert(`清理完成：${parts.length > 0 ? parts.join('、') : '没有需要清理的数据'}`);
    } catch (err) {
      alert(`清理失败：${err instanceof Error ? err.message : '请重试'}`);
    } finally {
      setPrivacyBusy(false);
    }
  };

  const handleBackup = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setSyncing(true);
    try {
      // 先保存当前配置再同步；保存失败也要有反馈，不能按钮点了没动静
      await handleSave(true);
      await api.syncBackup();
      await loadLastSync();
      alert('已备份到云端。');
    } catch (err) {
      alert(`备份失败：${err instanceof Error ? err.message : '请检查云端地址与账号后重试'}`);
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
          <label>闲置判定天数（书架「闲置」筛选）</label>
          <input
            type="number"
            min={1}
            max={3650}
            value={settings.idleDays}
            onChange={e => handleChange('idleDays', Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="form-row">
          <label>每日阅读目标（分钟，0 表示不设目标）</label>
          <input
            type="number"
            min={0}
            max={1440}
            value={settings.dailyGoalMinutes}
            onChange={e => handleChange('dailyGoalMinutes', Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
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
        <h2>本地字体</h2>
        <p className="section-desc">
          导入本机字体文件后，可在阅读器的字体下拉里选用。字体只存在本机，不随书库同步。
        </p>
        <div className="form-row">
          <button className="btn-secondary" onClick={handleImportFont}>导入字体文件</button>
        </div>
        {localFonts.length === 0 ? (
          <p className="section-desc">尚未导入字体</p>
        ) : (
          localFonts.map(f => (
            <div className="form-row" key={f.name}>
              <label style={{ fontFamily: `'${f.family}'` }}>{f.family}</label>
              <button className="danger" onClick={() => handleRemoveFont(f.name)}>删除</button>
            </div>
          ))
        )}
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
        <h2>联网附加能力</h2>
        <p className="section-desc" style={{ lineHeight: 1.9 }}>
          软件默认纯离线运行，解析、显示、检索、存储全部在本机完成，不发起任何网络请求。
          只有下面这一道开关打开后，需要联网的能力才会生效：在线书源与在线阅读、WebDAV 同步、
          本地模型的下载、以及 AI 助手与语义检索连接外部服务时。
        </p>
        <p className="section-desc" style={{ lineHeight: 1.9 }}>
          指向本机的服务（localhost / 127.0.0.1）不受此开关限制，只在需要访问外部地址时才要求打开。
          已下载到本机的模型、已缓存的在线章节不受影响，关闭联网后依然可用。
        </p>
        <div className="form-row" style={{ marginTop: 10 }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.onlineFeaturesEnabled}
              onChange={e => {
                const next = e.target.checked;
                if (next && !confirm('开启后软件会访问网络（在线书源、WebDAV 同步、模型下载、远端 AI 服务）。确定开启？')) {
                  return;
                }
                handleChange('onlineFeaturesEnabled', next);
                // 立即落盘：这个开关是「不建立任何出站连接」承诺的唯一闸门，
                // 若还要用户再点一次保存，就会出现「界面已开、功能仍报未联网」的错位
                void persistSettings({ onlineFeaturesEnabled: next });
              }}
            />
            <span>
              允许联网
              <em className="privacy-hint">默认关闭；关闭时不会建立任何出站连接</em>
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h2>AI 设置</h2>
        <p className="section-desc">
          用来做总结、问答、翻译与思维导图。留空的本地模型够用；要接外部的 OpenAI 兼容服务
          （DeepSeek、Kimi、通义、智谱等），把地址与密钥填上，并先在「联网附加能力」里打开联网开关。
        </p>
        <div className="form-row">
          <label>常用服务</label>
          <select
            value=""
            onChange={e => {
              const p = AI_PRESETS.find(x => x.key === e.target.value);
              if (!p) return;
              handleChange('aiProvider', p.provider);
              handleChange('aiBaseUrl', p.baseUrl);
              if (p.model) handleChange('aiModel', p.model);
            }}
          >
            <option value="">选择后自动填入地址与模型…</option>
            {AI_PRESETS.map(p => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>
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
        <div className="form-actions" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 10 }}>
          <button className="btn-secondary" onClick={handleTestAi} disabled={aiTesting}>
            {aiTesting ? '测试中…' : '测试连接'}
          </button>
          {aiTestResult && <span className="section-desc" style={{ margin: 0 }}>{aiTestResult}</span>}
        </div>
        <div className="form-row">
          <label>语义检索服务地址（高级，一般留默认）</label>
          <input value={settings.aiEmbedUrl} onChange={e => handleChange('aiEmbedUrl', e.target.value)} placeholder="http://localhost:8081" />
        </div>
      </section>

      <section className="settings-section">
        <h2>导入</h2>
        <div className="form-row">
          <label>遇到重复书籍</label>
          <select
            value={settings.importConflictPolicy}
            onChange={e => handleChange('importConflictPolicy', e.target.value)}
          >
            <option value="skip">跳过，不导入</option>
            <option value="keep">保留，书架上留两本</option>
            <option value="replace">替换，覆盖已有那本</option>
          </select>
        </div>
        <p className="section-desc">
          按文件内容或书名判定重复。选「替换」时只更新文件，书签、笔记、阅读进度都保留；
          文件夹监视自动入库的一律跳过重复，不受此项影响。
        </p>
      </section>

      <section className="settings-section">
        <h2>文件夹监视</h2>
        <p className="section-desc">
          指定一个文件夹，往里放新的电子书会自动入库，不用每次手动导入。
          重复的书自动跳过（同一个文件被改动会反复触发，不适合用保留/替换）；
          正在下载的半截文件不会被导入。
        </p>
        <div className="info-table" style={{ marginBottom: 16 }}>
          <div className="info-row">
            <span style={{ width: 90 }}>当前状态</span>
            <span>
              {watch.watching ? `监视中：${watch.dir}` : '未开启'}
            </span>
          </div>
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start', gap: 10 }}>
          <button className="btn-secondary" onClick={handlePickWatch} disabled={watchBusy}>
            {watch.watching ? '更换目录' : '选择目录并开启'}
          </button>
          {watch.watching && (
            <button className="btn-secondary" onClick={handleStopWatch} disabled={watchBusy}>
              停止监视
            </button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2>缓存管理</h2>
        <p className="section-desc">
          缓存都是可再生的临时数据，清理不影响书籍、笔记与阅读进度。
        </p>
        <div className="info-table" style={{ marginBottom: 16 }}>
          <div className="info-row">
            <span style={{ width: 110 }}>书籍文件</span>
            <span>{cacheStats ? formatFileSize(cacheStats.booksBytes) : '统计中...'}</span>
          </div>
          <div className="info-row">
            <span style={{ width: 110 }}>备份存档</span>
            <span>{cacheStats ? formatFileSize(cacheStats.snapshotBytes) : '统计中...'}</span>
          </div>
          <div className="info-row">
            <span style={{ width: 110 }}>章节缓存</span>
            <span>{cacheStats ? `${cacheStats.chapterCount} 条` : '统计中...'}</span>
          </div>
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start', gap: 10 }}>
          <button
            className="btn-secondary"
            onClick={() => handleClearCache({ snapshots: true })}
            disabled={cacheBusy}
          >
            清理备份存档
          </button>
          <button
            className="btn-secondary"
            onClick={() => handleClearCache({ chapterCache: true })}
            disabled={cacheBusy}
          >
            清理章节缓存
          </button>
          <button
            className="btn-secondary"
            onClick={loadCacheStats}
            disabled={cacheBusy}
          >
            重新统计
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>本地备份（离线）</h2>
        <p className="section-desc">
          数据只写入你自己选择的文件，不上传任何服务器。
          全量备份是 zip 归档，连书籍文件与封面一起打包（换机器恢复时书能一起回来，体积取决于书库大小）；
          增量备份只含上次导出后变更的笔记、书签、生词与设置，体积很小。
        </p>
        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn-primary" onClick={() => handleExportBackup(false)} disabled={backupBusy}>
            {backupBusy ? '处理中…' : '导出增量备份'}
          </button>
          <button className="btn-secondary" onClick={() => handleExportBackup(true)} disabled={backupBusy}>
            导出全量（含书籍）
          </button>
          <button className="btn-secondary" onClick={handleImportBackup} disabled={backupBusy}>
            从文件恢复
          </button>
          <button className="btn-secondary" onClick={handleSnapshot} disabled={backupBusy}>
            {backupBusy ? '处理中…' : '立即生成备份存档'}
          </button>
        </div>
        {lastBackup && (
          <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
            上次导出：{lastBackup}
          </p>
        )}

        {snapshots.length > 0 && (
          <div className="snapshot-list">
            <div className="snapshot-title">备份存档（自动保留最近 14 份，可随时回退）</div>
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
          三套预设一键切换，每套都保留翻页与首末页基础键。想改单个键：点一下键位，再按新键，Esc 取消。
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
          {(Object.keys(ACTION_LABELS) as ShortcutAction[]).map(action => {
            const current = keyForAction(getPreset(settings.shortcutPreset), shortcutCustom, action);
            const isCustom = shortcutCustom[action] !== undefined;
            return (
              <div key={action} className="keymap-row">
                <kbd
                  tabIndex={0}
                  className={recording === action ? 'recording' : ''}
                  title="点一下，再按新键；Esc 取消"
                  onClick={() => {
                    setRecording(action);
                    setKeyNotice('');
                  }}
                  onKeyDown={e => captureShortcutKey(e, action)}
                >
                  {recording === action ? '按下新键…' : current ? keyLabel(current) : '未设置'}
                </kbd>
                <span>{ACTION_LABELS[action]}</span>
                {isCustom && (
                  <button className="link-btn" onClick={() => resetShortcut(action)}>
                    恢复预设
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {keyNotice && (
          <p className="section-desc" style={{ marginTop: 8, color: 'var(--accent)' }}>
            {keyNotice}
          </p>
        )}
        <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
          点键位后按下新键即可改绑，Esc 取消；抢了别的动作的键时会明确告知。
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
            ['clipboard', '系统剪贴板', '会清掉你在其它软件里复制的内容，无法恢复'],
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

        <div className="form-row" style={{ marginTop: 10 }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.closeToTray}
              onChange={e => handleChange('closeToTray', e.target.checked)}
            />
            <span>
              关闭窗口时最小化到托盘
              <em className="privacy-hint">开启后关窗口不退出，从托盘菜单「退出」才真正退出</em>
            </span>
          </label>
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.screenProtection}
              onChange={e => {
                handleChange('screenProtection', e.target.checked);
                window.electronAPI?.setContentProtection(e.target.checked);
              }}
            />
            <span>
              防截屏保护
              <em className="privacy-hint">开启后截图与录屏中不显示窗口内容，立即生效</em>
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
            {syncing ? '同步中...' : <><Icon name="cloud-up" size={15} /> 备份到云端</>}
          </button>
          <button className="btn-secondary" onClick={handleRestore} disabled={syncing}>
            {syncing ? '同步中...' : <><Icon name="cloud-down" size={15} /> 从云端恢复</>}
          </button>
          {lastSync && <span className="book-meta">上次同步：{lastSync}</span>}
        </div>
        <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>
          同步进度、书签、笔记、书源和阅读偏好，不含书籍文件（各设备需各自导入同名书籍）。
        </p>
      </section>

      <div className="settings-footer">
        <button className="btn-primary" onClick={() => handleSave()}>
          {saved ? <><Icon name="check" size={15} /> 已保存</> : '保存设置'}
        </button>
      </div>
    </div>
  );
}
