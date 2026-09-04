type View = 'library' | 'reader' | 'sources' | 'settings' | 'stats';

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onOpenFile: () => void;
  onSearch: (query: string) => void;
}

export function Sidebar({ currentView, onNavigate, onOpenFile, onSearch }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="app-title">📖 阅读书架</h1>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="搜索书籍..."
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${currentView === 'library' ? 'active' : ''}`}
          onClick={() => onNavigate('library')}
        >
          <span className="nav-icon">📚</span>
          <span className="nav-label">书架</span>
        </button>
        <button
          className={`nav-item ${currentView === 'sources' ? 'active' : ''}`}
          onClick={() => onNavigate('sources')}
        >
          <span className="nav-icon">🌐</span>
          <span className="nav-label">书源</span>
        </button>
        <button
          className={`nav-item ${currentView === 'stats' ? 'active' : ''}`}
          onClick={() => onNavigate('stats')}
        >
          <span className="nav-icon">📊</span>
          <span className="nav-label">统计</span>
        </button>
        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span className="nav-label">设置</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <button className="import-btn" onClick={onOpenFile}>
          <span className="nav-icon">➕</span>
          <span className="nav-label">导入书籍</span>
        </button>
      </div>
    </aside>
  );
}
