import { useState } from 'react';

interface OnboardingProps {
  onImport: () => void;
  onClose: () => void;
}

const HIGHLIGHTS = [
  {
    icon: '🔒',
    title: '纯本地离线',
    desc: '书籍、笔记、阅读记录全部存在本机，不需要账号，也不上传任何文件。',
  },
  {
    icon: '📚',
    title: '多种格式',
    desc: 'EPUB、TXT、PDF、DOCX、CBZ 漫画都能读，导入后自动识别书名与目录。',
  },
  {
    icon: '🖍',
    title: '标注与笔记',
    desc: '选中正文即可高亮、加下划线、写笔记；笔记跨书汇总，可按标签归类。',
  },
  {
    icon: '🔍',
    title: '检索与智能辅助',
    desc: '书内关键词检索、跨书语义检索；可选装本地模型做翻译摘要，全程不联网。',
  },
];

/**
 * 首次启动引导：只在新装首次打开时出现，关闭后写入标记不再打扰。
 * 内容只讲用户能得到什么，不涉及实现细节。
 */
export function Onboarding({ onImport, onClose }: OnboardingProps) {
  const [closing, setClosing] = useState(false);

  const finish = (after?: () => void) => {
    setClosing(true);
    after?.();
    // 留出淡出时间再真正卸载，避免闪一下
    setTimeout(onClose, 180);
  };

  return (
    <div className={`modal-mask onboarding-mask${closing ? ' closing' : ''}`}>
      <div className="onboarding" onClick={e => e.stopPropagation()}>
        <div className="onboarding-head">
          <h1>📖 欢迎使用</h1>
          <p>一款纯离线、本地优先的电子书阅读器</p>
        </div>

        <div className="onboarding-grid">
          {HIGHLIGHTS.map(h => (
            <div key={h.title} className="onboarding-card">
              <div className="onboarding-icon">{h.icon}</div>
              <div className="onboarding-text">
                <h3>{h.title}</h3>
                <p>{h.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="onboarding-foot">
          <span className="onboarding-hint">
            随时可在「帮助与关于」中查看完整说明
          </span>
          <div className="onboarding-actions">
            <button className="btn-secondary" onClick={() => finish()}>
              随便看看
            </button>
            <button className="btn-primary" onClick={() => finish(onImport)}>
              导入第一本书
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
