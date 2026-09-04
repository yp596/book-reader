/** 思维导图：Markdown 列表解析为树（容错 1B 小模型的不规范输出） */

export interface MindNode {
  text: string;
  children: MindNode[];
  /** 章节跳转目标（懒加载子分支用）：EPUB {href}，TXT {page,endPage} */
  target?: { href?: string; page?: number; endPage?: number };
}

/** Markdown 缩进列表解析为树，可容错小模型的不规范输出 */
export function parseMindmap(text: string): MindNode[] {
  const roots: MindNode[] = [];
  const stack: { node: MindNode; level: number }[] = [];

  for (const raw of text.split('\n')) {
    // 去掉代码块围栏
    const line = raw.replace(/`/g, '');
    if (!line.trim()) continue;
    const m = /^(\s*)(?:[-*•]|\d+[.)、])\s+(.+)$/.exec(line);
    let level: number;
    let content: string;
    if (m) {
      const indent = m[1].replace(/\t/g, '  ');
      level = Math.floor(indent.length / 2);
      content = m[2].trim();
    } else {
      // 非列表行：作为顶层节点兜底
      level = 0;
      content = line.trim();
    }
    if (!content) continue;
    const node: MindNode = { text: content.slice(0, 200), children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, level });
  }
  return roots;
}

/** 树节点数（测试与空态判断用） */
export const countNodes = (nodes: MindNode[]): number =>
  nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
