type View = 'library' | 'reader' | 'sources' | 'rag' | 'vocab' | 'notes' | 'models' | 'settings' | 'stats' | 'help';

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
          className={`nav-item ${currentView === 'vocab' ? 'active' : ''}`}
          onClick={() => onNavigate('vocab')}
        >
          <span className="nav-icon">📖</span>
          <span className="nav-label">生词本</span>
        </button>
        <button
          className={`nav-item ${currentView === 'notes' ? 'active' : ''}`}
          onClick={() => onNavigate('notes')}
        >
          <span className="nav-icon">📝</span>
          <span className="nav-label">我的笔记</span>
        </button>
        <button
          className={`nav-item ${currentView === 'rag' ? 'active' : ''}`}
          onClick={() => onNavigate('rag')}
        >
          <span className="nav-icon">🧠</span>
          <span className="nav-label">语义检索</span>
        </button>
        <button
          className={`nav-item ${currentView === 'models' ? 'active' : ''}`}
          onClick={() => onNavigate('models')}
        >
          <span className="nav-icon">🤖</span>
          <span className="nav-label">本地模型</span>
        </button>
        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span className="nav-label">设置</span>
        </button>
        <button
          className={`nav-item ${currentView === 'help' ? 'active' : ''}`}
          onClick={() => onNavigate('help')}
        >
          <span className="nav-icon">❓</span>
          <span className="nav-label">帮助与关于</span>
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
