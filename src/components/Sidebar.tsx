import { Icon, type IconName } from './Icon';

type View = 'library' | 'reader' | 'rag' | 'vocab' | 'notes' | 'models' | 'settings' | 'stats' | 'help' | 'compare' | 'pdf';

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onOpenFile: () => void;
  onSearch: (query: string) => void;
}

/** 侧栏导航分组：按使用场景分区，让十来个入口一眼能扫完 */
const NAV_GROUPS: { title: string; items: { view: View; icon: IconName; label: string }[] }[] = [
  {
    title: '书库',
    items: [
      { view: 'library', icon: 'library', label: '书架' },
    ],
  },
  {
    title: '阅读',
    items: [
      { view: 'vocab', icon: 'notebook', label: '生词本' },
      { view: 'notes', icon: 'note', label: '我的笔记' },
      { view: 'stats', icon: 'chart', label: '统计' },
    ],
  },
  {
    title: '工具',
    items: [
      { view: 'rag', icon: 'sparkles', label: '语义检索' },
      { view: 'compare', icon: 'scale', label: '文档比较' },
      { view: 'pdf', icon: 'ruler', label: 'PDF 工具' },
      { view: 'models', icon: 'cpu', label: '本地模型' },
    ],
  },
  {
    title: '系统',
    items: [
      { view: 'settings', icon: 'settings', label: '设置' },
      { view: 'help', icon: 'help', label: '帮助与关于' },
    ],
  },
];

export function Sidebar({ currentView, onNavigate, onOpenFile, onSearch }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="app-title">
          <Icon name="book-open" size={17} />
          阅读书架
        </h1>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="搜索书籍..."
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <nav className="sidebar-nav">
        {NAV_GROUPS.map(group => (
          <div key={group.title}>
            <div className="nav-group-title">{group.title}</div>
            {group.items.map(item => (
              <button
                key={item.view}
                className={`nav-item ${currentView === item.view ? 'active' : ''}`}
                onClick={() => onNavigate(item.view)}
              >
                <span className="nav-icon"><Icon name={item.icon} size={17} /></span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="import-btn" onClick={onOpenFile}>
          <Icon name="plus" size={15} />
          导入书籍
        </button>
      </div>
    </aside>
  );
}
