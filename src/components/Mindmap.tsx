import { useState } from 'react';
import { MindNode, countNodes } from '../utils/mindmap';

function TreeNode({ node, depth }: { node: MindNode; depth: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  return (
    <div className="mind-node-wrap">
      <div
        className={`mind-node depth-${Math.min(depth, 3)}${hasChildren ? ' parent' : ''}`}
        onClick={() => hasChildren && setCollapsed(c => !c)}
      >
        {hasChildren && <span className="mind-toggle">{collapsed ? '▶' : '▼'}</span>}
        <span>{node.text}</span>
      </div>
      {hasChildren && !collapsed && (
        <div className="mind-children">
          {node.children.map((ch, i) => (
            <TreeNode key={i} node={ch} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MindmapView({ nodes, onClose }: { nodes: MindNode[]; onClose: () => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="mindmap-modal" onClick={e => e.stopPropagation()}>
        <div className="mindmap-header">
          <h3>🧠 思维导图（{countNodes(nodes)} 个节点）</h3>
          <button className="back-btn" onClick={onClose}>关闭</button>
        </div>
        <div className="mindmap-body">
          {nodes.length === 0 ? (
            <p className="empty-text">未能解析出大纲，换一段正文试试</p>
          ) : (
            nodes.map((n, i) => <TreeNode key={i} node={n} depth={0} />)
          )}
        </div>
      </div>
    </div>
  );
}
