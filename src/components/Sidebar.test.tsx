import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Sidebar } from './Sidebar';

/**
 * 侧栏是纯 props 驱动的组件，测的就是「点了有没有反应」：
 * 现有测试全停在「函数算得对不对」，一旦 onClick 接错、active 类挂错，
 * 逻辑测试照样全绿，用户点下去却没动静。
 */
function renderSidebar(currentView: any = 'library') {
  const onNavigate = vi.fn();
  const onOpenFile = vi.fn();
  const onSearch = vi.fn();
  render(
    <Sidebar
      currentView={currentView}
      onNavigate={onNavigate}
      onOpenFile={onOpenFile}
      onSearch={onSearch}
    />,
  );
  return { onNavigate, onOpenFile, onSearch };
}

afterEach(cleanup);

describe('Sidebar 交互', () => {
  it('每个导航项都渲染出来，且每个都能点', () => {
    const { onNavigate } = renderSidebar();
    const items = document.querySelectorAll('.nav-item');
    // 分组标题不算导航项，这里只要求「有」，具体分组内容不作为契约
    expect(items.length).toBeGreaterThan(0);

    const expected: Record<string, string> = {
      书架: 'library',
      生词本: 'vocab',
      语义检索: 'rag',
      设置: 'settings',
    };
    for (const [label, view] of Object.entries(expected)) {
      const btn = screen.getByText(label).closest('button')!;
      fireEvent.click(btn);
      expect(onNavigate).toHaveBeenLastCalledWith(view);
    }
  });

  it('当前视图对应的导航项挂 active，其余不挂', () => {
    renderSidebar('vocab');
    const active = document.querySelectorAll('.nav-item.active');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain('生词本');
  });

  it('切换 currentView 后 active 跟着走（复用同一份点击逻辑也不会漏）', () => {
    const { rerender } = render(
      <Sidebar currentView="library" onNavigate={vi.fn()} onOpenFile={vi.fn()} onSearch={vi.fn()} />,
    );
    expect(document.querySelector('.nav-item.active')!.textContent).toContain('书架');

    rerender(
      <Sidebar currentView="settings" onNavigate={vi.fn()} onOpenFile={vi.fn()} onSearch={vi.fn()} />,
    );
    expect(document.querySelector('.nav-item.active')!.textContent).toContain('设置');
  });

  it('导入按钮触发 onOpenFile', () => {
    const { onOpenFile } = renderSidebar();
    fireEvent.click(document.querySelector('.import-btn')!);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('搜索框逐字回传（受控与否都要把值送出去）', () => {
    const { onSearch } = renderSidebar();
    const input = screen.getByPlaceholderText('搜索书籍...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '庄' } });
    expect(onSearch).toHaveBeenLastCalledWith('庄');
    fireEvent.change(input, { target: { value: '庄子' } });
    expect(onSearch).toHaveBeenLastCalledWith('庄子');
  });
});
