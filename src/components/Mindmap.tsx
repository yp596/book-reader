import { useState } from 'react';
import { MindNode, countNodes } from '../utils/mindmap';
import { Icon } from './Icon';

function TreeNode({
  node,
  depth,
  onExpand,
}: {
  node: MindNode;
  depth: number;
  onExpand?: (node: MindNode) => Promise<MindNode[]>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [children, setChildren] = useState<MindNode[]>(node.children);
  const expandable = children.length === 0 && !!node.target && !!onExpand;
  const hasChildren = children.length > 0 || expandable;

  const handleClick = async () => {
    if (children.length > 0) {
      setCollapsed(c => !c);
      return;
    }
    if (expandable && onExpand && !loading) {
      setLoading(true);
      try {
        const sub = await onExpand(node);
        setChildren(sub);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="mind-node-wrap">
      <div
        className={`mind-node depth-${Math.min(depth, 3)}${hasChildren ? ' parent' : ''}`}
        onClick={handleClick}
      >
        {children.length > 0 && (
          <span className="mind-toggle">
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          </span>
        )}
        {loading && <span className="mind-toggle"><Icon name="clock" size={13} /></span>}
        <span>{node.text}</span>
        {expandable && !loading && <span className="mind-expand-hint">生成子分支</span>}
      </div>
      {children.length > 0 && !collapsed && (
        <div className="mind-children">
          {children.map((ch, i) => (
            <TreeNode key={i} node={ch} depth={depth + 1} onExpand={onExpand} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MindmapView({
  nodes,
  title,
  onClose,
  onExpand,
}: {
  nodes: MindNode[];
  title?: string;
  onClose: () => void;
  onExpand?: (node: MindNode) => Promise<MindNode[]>;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="mindmap-modal" onClick={e => e.stopPropagation()}>
        <div className="mindmap-header">
          <h3>
            <Icon name="network" size={16} />
            {title || `思维导图（${countNodes(nodes)} 个节点）`}
          </h3>
          <button className="back-btn" onClick={onClose}>关闭</button>
        </div>
        <div className="mindmap-body">
          {nodes.length === 0 ? (
            <p className="empty-text">未能解析出大纲，换一段正文试试</p>
          ) : (
            nodes.map((n, i) => <TreeNode key={i} node={n} depth={0} onExpand={onExpand} />)
          )}
        </div>
      </div>
    </div>
  );
}
