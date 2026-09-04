import { describe, it, expect } from 'vitest';
import { parseMindmap, countNodes } from './mindmap';

describe('parseMindmap', () => {
  it('解析两级列表', () => {
    const nodes = parseMindmap('- 主旨\n  - 分论点一\n  - 分论点二\n- 结论');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].children.map(c => c.text)).toEqual(['分论点一', '分论点二']);
    expect(nodes[1].children).toHaveLength(0);
  });

  it('兼容数字编号与 Tab 缩进', () => {
    const nodes = parseMindmap('1. 第一\n\t1) 子项\n2. 第二');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].children[0].text).toBe('子项');
  });

  it('去掉代码块围栏', () => {
    const nodes = parseMindmap('```\n- A\n  - B\n```');
    expect(countNodes(nodes)).toBe(2);
  });

  it('非列表行兜底为顶层', () => {
    const nodes = parseMindmap('核心观点：坚持\n- 论据一');
    expect(nodes[0].text).toBe('核心观点：坚持');
    expect(nodes[1].text).toBe('论据一');
  });

  it('空输入返回空数组', () => {
    expect(parseMindmap('  \n\n')).toEqual([]);
  });

  it('countNodes 统计全树', () => {
    const nodes = parseMindmap('- A\n  - B\n    - C\n- D');
    expect(countNodes(nodes)).toBe(4);
  });
});
