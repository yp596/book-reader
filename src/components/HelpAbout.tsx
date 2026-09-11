import { useState, useEffect } from 'react';
import { SHORTCUT_PRESETS, ACTION_LABELS, keyLabel, type ShortcutAction } from '../utils/shortcuts';

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
  { ext: 'TXT', note: '支持 UTF-8 / GBK 自动识别，可一键规整排版' },
  { ext: 'PDF', note: '支持缩放、跳页；有文字层的可切换流式重排' },
  { ext: 'DOCX', note: '导入时自动转换为 EPUB，阅读体验同为 EPUB' },
  { ext: 'CBZ', note: '漫画压缩包，免解压逐页读取' },
];

const FAQ = [
  {
    q: '软件需要联网吗？',
    a: '不需要。书库、笔记、阅读记录全部存在本机。只有当你主动使用在线书源、WebDAV 同步或下载本地 AI 模型时才会联网，这些都可以不用。',
  },
  {
    q: '扫描版 PDF 为什么不能重排？',
    a: '重排依赖 PDF 里的文字层，扫描版本质是图片，没有文字可提取。需要 OCR 识别才能实现，当前版本尚未支持。',
  },
  {
    q: 'AI 功能怎么开启？',
    a: '在「本地模型」页下载模型并启动即可，全程离线运行。也可以指向你自己的 Ollama 等服务地址。',
  },
  {
    q: '数据存在哪里？可以备份吗？',
    a: '书籍文件与数据库都在本机数据目录（见「关于」页）。设置页的「本地备份」支持增量导出与快照回退。',
  },
  {
    q: '怎么防止误改整理好的书？',
    a: '右键书籍选择「锁定」后，删除、改名、分类、批注等编辑操作都会被阻止，阅读不受影响。',
  },
];

export function HelpAbout() {
  const [tab, setTab] = useState<Tab>('help');
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    window.electronAPI?.getAppInfo().then(setInfo).catch(() => {});
  }, []);

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
              可在设置页切换三套方案并逐项改键；以下为各方案的默认键位。
            </p>
            {SHORTCUT_PRESETS.map(p => (
              <div key={p.key} className="help-preset">
                <div className="help-preset-title">
                  {p.name}
                  <span className="privacy-hint" style={{ display: 'inline', marginLeft: 10 }}>{p.desc}</span>
                </div>
                <div className="keymap-list" style={{ borderTop: 'none', paddingTop: 0 }}>
                  {Object.entries(p.map).map(([key, action]) => (
                    <div key={key} className="keymap-row">
                      <kbd>{keyLabel(key)}</kbd>
                      <span>{ACTION_LABELS[action as ShortcutAction]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
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
              一款纯离线、本地优先的电子书阅读器。所有文档解析、渲染、检索与存储均在本机完成，
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
            <p className="section-desc" style={{ lineHeight: 1.9, marginBottom: 0 }}>
              本项目基于 Electron、React、epub.js、pdf.js、sql.js、mammoth、cheerio 等开源软件构建，
              各组件遵循其各自的许可协议。软件不内置任何书源，仅提供导入功能；
              请仅用于阅读你拥有合法版权的内容。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
