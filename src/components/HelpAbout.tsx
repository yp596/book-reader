import { useState, useEffect } from 'react';
import {
  ACTION_LABELS,
  DEFAULT_SHORTCUT_PRESET,
  keyForAction,
  keyLabel,
  getPreset,
  parseShortcutOverrides,
  type ShortcutAction,
  type ShortcutOverrides,
} from '../utils/shortcuts';

interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  dataDir: string;
  booksDir: string;
}

type Tab = 'help' | 'about';

/** 支持格式与说明 */
const FORMATS = [
  { ext: 'EPUB', note: '最佳体验：目录、字体、高亮、检索全支持' },
  { ext: 'TXT', note: '支持 UTF-8 / GBK / Big5 等自动识别与手动切换，可一键规整排版' },
  { ext: 'PDF', note: '支持缩放、跳页；有文字层的可切换流式重排，扫描版可用本机 OCR 取字' },
  { ext: 'DOCX', note: '导入时自动转换为 EPUB，阅读体验同为 EPUB' },
  { ext: 'CBZ', note: '漫画压缩包，免解压逐页读取' },
];

/** 随包开源组件与许可，取值与各依赖 package.json 的 license 字段一致 */
const OPEN_SOURCE = [
  { name: 'Electron', license: 'MIT' },
  { name: 'React / React DOM', license: 'MIT' },
  { name: 'epub.js', license: 'BSD-2-Clause' },
  { name: 'PDF.js', license: 'Apache-2.0' },
  { name: 'sql.js', license: 'MIT' },
  { name: 'mammoth', license: 'BSD-2-Clause' },
  { name: 'cheerio', license: 'MIT' },
  { name: 'pdf-lib', license: 'MIT' },
  { name: 'JSZip', license: 'MIT（双许可 MIT 或 GPL-3.0，本项目按 MIT 使用）' },
  { name: 'marked', license: 'MIT' },
  { name: 'zod', license: 'MIT' },
  { name: 'node-llama-cpp', license: 'MIT' },
  { name: 'ONNX Runtime Web', license: 'MIT' },
];

const FAQ = [
  {
    q: '软件需要联网吗？',
    a: '不需要。书库、笔记、阅读记录全部存在本机。只有当你主动下载本地 AI 模型，或把 AI 助手、语义检索指向外部服务时才会联网，这些都可以不用。',
  },
  {
    q: '扫描版 PDF 为什么不能重排？',
    a: '重排依赖 PDF 里的文字层，扫描版本质是图片，没有文字可提取。可以点阅读工具栏的「识别」，用本机 OCR 取出当前页文字并复制，但识别结果不参与重排。',
  },
  {
    q: 'AI 功能怎么开启？',
    a: '在「本地模型」页下载模型并启动即可，全程离线运行。也可以指向你自己的 Ollama 等服务地址。',
  },
  {
    q: '数据存在哪里？可以备份吗？',
    a: '书籍文件与阅读数据都保存在本机数据目录（见「关于」页）。设置页的「本地备份」可导出连书籍文件一起打包的全量归档，也能只导出上次之后的变更。',
  },
  {
    q: '怎么防止误改整理好的书？',
    a: '右键书籍选择「锁定」后，删除、改名、分类、批注等编辑操作都会被阻止，阅读不受影响。',
  },
];

export function HelpAbout() {
  const [tab, setTab] = useState<Tab>('help');
  const [info, setInfo] = useState<AppInfo | null>(null);
  /** 用户当前的键位方案与改键；速查表要反映实际生效的键，而不是预设默认值 */
  const [presetKey, setPresetKey] = useState(DEFAULT_SHORTCUT_PRESET);
  const [overrides, setOverrides] = useState<ShortcutOverrides>({});

  useEffect(() => {
    window.electronAPI?.getAppInfo().then(setInfo).catch(() => {});
    const api = window.electronAPI;
    if (!api) return;
    Promise.all([api.getSetting('shortcutPreset'), api.getSetting('shortcutCustom')])
      .then(([savedPreset, savedOverrides]) => {
        setPresetKey(getPreset(savedPreset ?? DEFAULT_SHORTCUT_PRESET).key);
        setOverrides(parseShortcutOverrides(savedOverrides));
      })
      .catch(() => {});
  }, []);

  const preset = getPreset(presetKey);
  const actions = Object.keys(ACTION_LABELS) as ShortcutAction[];
  const customCount = actions.filter(a => overrides[a] !== undefined).length;

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>{tab === 'help' ? '使用帮助' : '关于本软件'}</h1>
        <div className="detail-tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
          <button
            className={`detail-tab${tab === 'help' ? ' active' : ''}`}
            onClick={() => setTab('help')}
          >
            使用帮助
          </button>
          <button
            className={`detail-tab${tab === 'about' ? ' active' : ''}`}
            onClick={() => setTab('about')}
          >
            关于
          </button>
        </div>
      </div>

      {tab === 'help' && (
        <>
          <section className="settings-section">
            <h2>快速上手</h2>
            <ol className="help-steps">
              <li><strong>导入</strong>：点侧栏「导入书籍」，或直接把文件拖进窗口</li>
              <li><strong>阅读</strong>：书架点封面进入阅读器；工具栏可调字体、主题、版式</li>
              <li><strong>标注</strong>：选中正文弹出操作条，可高亮、写笔记、朗读、翻译</li>
              <li><strong>回顾</strong>：「我的笔记」跨书汇总所有标注，可打标签、跳回原文</li>
            </ol>
          </section>

          <section className="settings-section">
            <h2>支持格式</h2>
            <div className="info-table">
              {FORMATS.map(f => (
                <div key={f.ext} className="info-row">
                  <span style={{ width: 70 }}>{f.ext}</span>
                  <span>{f.note}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h2>快捷键速查</h2>
            <p className="section-desc">
              {`当前方案：${preset.name}${customCount > 0 ? `（其中 ${customCount} 项已自定义）` : ''}。可在设置页切换方案或逐项改键。`}
            </p>
            <div className="keymap-list" style={{ borderTop: 'none', paddingTop: 0 }}>
              {actions.map(action => {
                const key = keyForAction(preset, overrides, action);
                return (
                  <div key={action} className="keymap-row">
                    <kbd>{key ? keyLabel(key) : '未绑定'}</kbd>
                    <span>
                      {ACTION_LABELS[action]}
                      {overrides[action] !== undefined && (
                        <span className="privacy-hint" style={{ display: 'inline', marginLeft: 8 }}>
                          已自定义
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="section-desc" style={{ marginTop: 14, marginBottom: 0 }}>
              固定键位：Esc 收起面板或返回书架；Alt + ← / → 在跳转历史中前进后退。
            </p>
          </section>

          <section className="settings-section">
            <h2>常见问题</h2>
            {FAQ.map((item, i) => (
              <div key={i} className="faq-item">
                <div className="faq-q">{item.q}</div>
                <div className="faq-a">{item.a}</div>
              </div>
            ))}
          </section>
        </>
      )}

      {tab === 'about' && (
        <>
          <section className="settings-section">
            <h2>离线阅读器</h2>
            <p className="section-desc" style={{ lineHeight: 1.9 }}>
              一款纯离线、本地优先的电子书阅读器。所有文档解析、显示、检索与存储均在本机完成，
              不需要账号，也不会上传任何文件。
            </p>
          </section>

          <section className="settings-section">
            <h2>版本信息</h2>
            <div className="info-table">
              <div className="info-row"><span>软件版本</span><span>{info?.version ?? '—'}</span></div>
              <div className="info-row"><span>运行环境</span><span>{info ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}` : '—'}</span></div>
              <div className="info-row"><span>操作系统</span><span>{info?.platform ?? '—'}</span></div>
            </div>
          </section>

          <section className="settings-section">
            <h2>数据位置</h2>
            <p className="section-desc">数据都在本机，可直接复制路径到文件管理器查看。</p>
            <div className="info-table">
              <div className="info-row"><span style={{ width: 90 }}>数据目录</span><span className="mono-cell">{info?.dataDir ?? '—'}</span></div>
              <div className="info-row"><span style={{ width: 90 }}>书籍目录</span><span className="mono-cell">{info?.booksDir ?? '—'}</span></div>
            </div>
          </section>

          <section className="settings-section">
            <h2>开源许可</h2>
            <p className="section-desc" style={{ lineHeight: 1.9 }}>
              本软件基于以下开源项目构建，各组件版权归其各自作者所有，遵循对应许可协议：
            </p>
            <div className="info-table">
              {OPEN_SOURCE.map(d => (
                <div key={d.name} className="info-row">
                  <span style={{ width: 170 }}>{d.name}</span>
                  <span>{d.license}</span>
                </div>
              ))}
            </div>
            <p className="section-desc" style={{ lineHeight: 1.9, marginTop: 12, marginBottom: 0 }}>
              软件不内置任何书源，仅提供导入功能；请仅用于阅读你拥有合法版权的内容。
            </p>
          </section>

          <section className="settings-section">
            <h2>RAR 解压声明</h2>
            <p className="section-desc" style={{ lineHeight: 1.9, marginBottom: 0 }}>
              漫画压缩包（CBR / CB7）的解压能力由随包附带的 7-Zip 提供。7-Zip 主体遵循 GNU LGPL，
              其 RAR 解压引擎基于 unRAR 源码构建，按 unRAR 许可要求在此声明：
              <strong>该代码不得用于开发 RAR（WinRAR）兼容压缩器</strong>。
              本软件仅使用其解压能力，不提供任何 RAR 压缩功能。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
