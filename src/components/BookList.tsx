import { useState, useEffect, type CSSProperties } from 'react';
import { Book } from '../types';
import { formatFileSize } from '../utils/text';
import { coverHue } from '../utils/cover';
import { Icon, StarRating } from './Icon';

interface BookListProps {
  books: Book[];
  searchQuery: string;
  onSelectBook: (book: Book) => void;
  onShowDetail: (book: Book) => void;
  onRefresh: () => void;
  onImport: () => void;
}

type ViewMode = 'grid' | 'list';
type SortBy = SortByWithRating;
type Filter = 'all' | 'reading' | 'finished' | 'favorite' | 'shelved' | 'idle';
type SortByWithRating = 'recent' | 'title' | 'author' | 'rating';

/**
 * 书架编辑弹窗。Electron 的渲染进程不支持 window.prompt（调用即抛
 * "prompt() is not supported."），所以改名、分类、系列、批量设置这些入口
 * 必须自绘弹窗，否则点下去毫无反应。
 */
type EditDialog =
  | {
      kind: 'text';
      title: string;
      hint?: string;
      value: string;
      placeholder?: string;
      /** 已有的分类/系列，点一下直接填入，省得手打 */
      options?: string[];
      confirmLabel: string;
      onSubmit: (value: string) => Promise<void> | void;
    }
  | { kind: 'status'; book: Book }
  | { kind: 'rating'; book: Book };

export function BookList({ books, searchQuery, onSelectBook, onShowDetail, onRefresh, onImport }: BookListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  /** Markdown 正文里的 #标签，点一下按标签筛书 */
  const [tagList, setTagList] = useState<{ tag: string; bookIds: number[]; count: number }[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  /** frontmatter 属性（键: 值），同样点一下筛书 */
  const [propList, setPropList] = useState<
    { key: string; value: string; bookIds: number[]; count: number }[]
  >([]);
  const [propFilter, setPropFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [seriesList, setSeriesList] = useState<string[]>([]);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ book: Book; x: number; y: number } | null>(null);
  const [editDialog, setEditDialog] = useState<EditDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 闲置判定天数（设置页可调，默认 90 天） */
  const [idleDays, setIdleDays] = useState(90);
  // 批量管理：勾选态与所选 id
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  /** 批量操作的进行中类型（导出 TXT / EPUB、提取图片）；非空时相关按钮一并禁用，避免重复点两遍 */
  const [batchExporting, setBatchExporting] = useState<'txt' | 'epub' | 'images' | null>(null);
  /** 源文件已改动或已移走的书：导入是复制，书库不主动看就发现不了 */
  const [sourceIssues, setSourceIssues] = useState<
    { id: number; title: string; status: 'changed' | 'missing'; sourcePath: string }[]
  >([]);
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);

  const loadSourceIssues = async () => {
    try {
      setSourceIssues((await window.electronAPI?.checkBookSources()) ?? []);
    } catch { /* 体检失败不打扰用户 */ }
  };

  const handleRefreshFromSource = async (id: number) => {
    try {
      await window.electronAPI?.refreshBookFromSource(id);
      setSourceIssues(prev => prev.filter(b => b.id !== id));
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新失败');
    }
  };

  useEffect(() => {
    onRefresh();
    void loadSourceIssues();
    window.electronAPI?.getCategories().then(setCategories).catch(() => {});
    window.electronAPI?.getAllTags?.().then(setTagList).catch(() => {});
    window.electronAPI?.getAllProps?.().then(setPropList).catch(() => {});
    window.electronAPI?.getSeriesList().then(setSeriesList).catch(() => {});
    window.electronAPI?.getSetting('idleDays').then(v => {
      const d = Number(v);
      if (Number.isFinite(d) && d > 0) setIdleDays(d);
    }).catch(() => {});
  }, []);

  const filteredBooks = books
    .filter(book => {
      switch (filter) {
        case 'reading':
          if (!(book.progress > 0 && book.progress < 0.95)) return false;
          break;
        case 'finished':
          if (!(book.progress >= 0.95)) return false;
          break;
        case 'favorite':
          if (!book.favorite) return false;
          break;
        case 'shelved':
          if (book.status !== 'shelved') return false;
          break;
        case 'idle': {
          // 从未读过则看加入时间；都没有时间戳的保守放行
          const raw = book.last_read_at || book.created_at;
          const t = raw ? new Date(raw).getTime() : NaN;
          if (!Number.isNaN(t) && t > Date.now() - idleDays * 86400_000) return false;
          break;
        }
        default:
          break;
      }
      if (categoryFilter && book.category !== categoryFilter) return false;
      if (tagFilter) {
        const entry = tagList.find(t => t.tag === tagFilter);
        if (entry && !entry.bookIds.includes(book.id)) return false;
      }
      if (propFilter) {
        const entry = propList.find(p => `${p.key} ${p.value}` === propFilter);
        if (entry && !entry.bookIds.includes(book.id)) return false;
      }
      if (seriesFilter && book.series !== seriesFilter) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        book.title.toLowerCase().includes(q) ||
        book.author?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'title':
          return a.title.localeCompare(b.title);
        case 'author':
          return (a.author || '').localeCompare(b.author || '');
        case 'rating':
          return (b.rating ?? 0) - (a.rating ?? 0);
        case 'recent':
        default:
          return (b.last_read_at || '').localeCompare(a.last_read_at || '');
      }
    });

  // 继续阅读：最近读过且未读完的第一本
  const continueBook = books
    .filter(b => b.progress > 0 && b.progress < 0.95 && b.last_read_at)
    .sort((a, b) => (b.last_read_at || '').localeCompare(a.last_read_at || ''))[0];

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ book, x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setContextMenu(null);

  const handleDelete = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    // 锁定书在右键菜单里是明确「不能删」的，先拦下来，别让用户确认一通却什么都没发生
    if (book.locked) {
      alert(`《${book.title}》已锁定，无法删除。\n可在右键菜单点「解锁书籍」后再删除。`);
      return;
    }
    if (!confirm(`确定从书架删除《${book.title}》？\n书签、笔记、阅读记录与书库内的文件副本将一并删除，此操作无法撤销。`)) return;
    try {
      await window.electronAPI?.deleteBook(book.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败，请重试');
    }
    onRefresh();
  };

  const handleRefreshMetadata = async () => {
    if (contextMenu) {
      try {
        await window.electronAPI?.refreshBookMetadata(contextMenu.book.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '识别失败');
      }
      closeMenu();
      onRefresh();
    }
  };

  /** 右键菜单：点别处、滚动或窗口失焦就收起，免得菜单一直挂在屏幕上挡路 */
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  const handleRename = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    setEditDialog({
      kind: 'text',
      title: '重命名书名',
      hint: '只改书架里显示的名字，不会改动磁盘上的文件',
      value: book.title,
      confirmLabel: '保存',
      onSubmit: async value => {
        const name = value.trim();
        if (!name || name === book.title) return;
        try {
          await window.electronAPI?.renameBook(book.id, name);
          onRefresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : '重命名失败，请重试');
        }
      },
    });
  };

  const handleToggleFavorite = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    try {
      await window.electronAPI?.toggleFavorite(book.id);
      onRefresh();
    } catch (err) {
      // 锁定书会被主进程拦下，必须给提示：否则菜单收起、界面无变化，像点空了
      alert(err instanceof Error ? err.message : '操作没有完成，请重试');
    }
  };

  const handleToggleLock = async () => {
    if (contextMenu) {
      try {
        const locked = await window.electronAPI?.toggleBookLock(contextMenu.book.id);
        if (locked) {
          alert('已锁定：删除、改名、分类、收藏、批注等编辑操作将被阻止；阅读与进度保存不受影响。');
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '操作失败');
      }
      closeMenu();
      onRefresh();
    }
  };

  const handleSetCategory = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    setEditDialog({
      kind: 'text',
      title: '设置分类',
      hint: '留空表示清除分类；已有分类点一下就填进去',
      value: book.category || '',
      options: categories,
      confirmLabel: '保存',
      onSubmit: async value => {
        try {
          await window.electronAPI?.setCategory(book.id, value.trim());
          const updated = await window.electronAPI?.getCategories();
          if (updated) setCategories(updated as string[]);
          onRefresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : '设置分类失败，请重试');
        }
      },
    });
  };

  const STATUS_OPTIONS = [
    { v: '', label: '清除标记（按进度推断）' },
    { v: 'reading', label: '在读' },
    { v: 'finished', label: '已读完' },
    { v: 'shelved', label: '搁置（暂时不读）' },
  ];

  const handleSetStatus = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    setEditDialog({ kind: 'status', book });
  };

  const handleSetRating = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    setEditDialog({ kind: 'rating', book });
  };

  const handleExportList = async () => {
    try {
      const r = await window.electronAPI?.exportBookList();
      if (r) alert(`已导出 ${r.count} 本书的清单
${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
  };

  const handleExportOne = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.exportOneBook(contextMenu.book.id);
      if (r) alert(`已导出《${contextMenu.book.title}》的批注与笔记（${r.count} 条）
${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
    closeMenu();
  };

  const handleImportOne = async () => {
    try {
      const r = await window.electronAPI?.importOneBook();
      if (r) {
        alert(`已恢复《${r.title}》：批注与笔记 ${r.restored} 条、阅读位置 ${r.positions} 条。`);
        onRefresh();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '恢复失败');
    }
    closeMenu();
  };

  const handleSaveAs = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.saveBookAs(contextMenu.book.id);
      if (r) alert(`已另存为：\n${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '另存失败');
    }
    closeMenu();
  };

  const handleExportText = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.exportBookText(contextMenu.book.id);
      if (r) alert(`已导出正文 ${r.chars.toLocaleString()} 字：\n${r.filePath}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
    closeMenu();
  };

  const handleExportEpub = async () => {
    if (!contextMenu) return;
    try {
      const r = await window.electronAPI?.exportEpub(contextMenu.book.id);
      if (r) {
        alert(`已导出 EPUB（${r.chapters} 章，${formatFileSize(r.bytes)}）：\n${r.filePath}`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    }
    closeMenu();
  };

  const handleSetSeries = async () => {
    const book = contextMenu?.book;
    if (!book) return;
    closeMenu();
    setEditDialog({
      kind: 'text',
      title: '设置所属系列',
      hint: '留空表示取消分组；已有系列点一下就填进去',
      value: book.series || '',
      options: seriesList,
      confirmLabel: '保存',
      onSubmit: async value => {
        try {
          await window.electronAPI?.setBookSeries(book.id, value.trim());
          setSeriesList((await window.electronAPI?.getSeriesList()) ?? []);
          onRefresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : '设置系列失败，请重试');
        }
      },
    });
  };

  const handleReveal = async () => {
    if (contextMenu) {
      try {
        await window.electronAPI?.revealBookFile(contextMenu.book.id);
      } catch (err) {
        alert(err instanceof Error ? err.message : '打开失败');
      }
      closeMenu();
    }
  };

  /** 复制文件路径：分享给别的软件或人时最常用的一步 */
  const handleCopyPath = async () => {
    if (!contextMenu) return;
    try {
      const p = await window.electronAPI?.copyBookPath(contextMenu.book.id);
      if (p) alert(`已复制文件路径：\n${p}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '复制失败');
    }
    closeMenu();
  };

  /** 交给系统默认程序打开（Windows 没有通用分享面板，这是最接近「发送到」的做法） */
  const handleOpenWithSystem = async () => {
    if (!contextMenu) return;
    try {
      await window.electronAPI?.openBookWithSystem(contextMenu.book.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '打开失败');
    }
    closeMenu();
  };

  const handleFileInfo = async () => {
    if (contextMenu) {
      try {
        const info = await window.electronAPI?.getBookFileInfo(contextMenu.book.id);
        if (info) {
          alert(
            `书名：${info.title}\n作者：${info.author}\n文件名：${info.fileName}\n格式：${info.fileType.toUpperCase()}\n大小：${formatFileSize(info.size)}\n修改时间：${info.mtime}\n进度：${Math.round(info.progress * 100)}%`,
          );
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '获取失败');
      }
      closeMenu();
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('确定清除全部阅读记录吗？\n所有书的进度归零、阅读时长清空，书籍与笔记保留。此操作无法撤销。')) return;
    try {
      await window.electronAPI?.clearReadingHistory();
      onRefresh();
      alert('已清除全部阅读记录，书籍与笔记不受影响。');
    } catch (err) {
      alert(err instanceof Error ? err.message : '清除阅读记录失败，请重试');
    }
  };

  // ---------- 批量管理 ----------

  const toggleSelect = (id: number) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 锁定书籍不参与任何批量写操作 */
  const batchTargets = () => books.filter(b => selectedIds.has(b.id) && !b.locked);

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  /**
   * 批量操作的回执。成功也要说一声，否则用户分不清「执行了」还是「被取消了」；
   * 写入失败与锁定跳过要分开报，不能把失败混进「被跳过」里。
   */
  const reportBatchResult = (done: number, failed: number) => {
    const locked = selectedIds.size - batchTargets().length;
    const parts = [`已处理 ${done - failed} 本`];
    if (failed > 0) parts.push(`${failed} 本写入失败，可重试`);
    if (locked > 0) parts.push(`${locked} 本因锁定被跳过`);
    alert(parts.join('；') + '。');
  };

  const handleBatchSeries = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    setEditDialog({
      kind: 'text',
      title: `把所选的 ${selectedIds.size} 本归入系列`,
      hint: '留空表示取消分组；已有系列点一下就填进去',
      value: '',
      options: seriesList,
      confirmLabel: '确定',
      onSubmit: async value => {
        const name = value.trim();
        const targets = batchTargets();
        let failed = 0;
        for (const b of targets) {
          try {
            await api.setBookSeries(b.id, name);
          } catch {
            failed++;
          }
        }
        reportBatchResult(targets.length, failed);
        setSeriesList((await api.getSeriesList()) ?? []);
        exitBatch();
        onRefresh();
      },
    });
  };

  const handleBatchCategory = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    setEditDialog({
      kind: 'text',
      title: `批量为 ${selectedIds.size} 本书设置分类`,
      hint: '留空表示清除分类；已有分类点一下就填进去',
      value: '',
      options: categories,
      confirmLabel: '确定',
      onSubmit: async value => {
        const name = value.trim();
        const targets = batchTargets();
        let failed = 0;
        for (const b of targets) {
          try {
            await api.setCategory(b.id, name);
          } catch {
            failed++;
          }
        }
        reportBatchResult(targets.length, failed);
        const updated = await api.getCategories();
        if (updated) setCategories(updated as string[]);
        exitBatch();
        onRefresh();
      },
    });
  };

  const handleBatchLock = async (locked: boolean) => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const targets = books.filter(b => selectedIds.has(b.id) && !!b.locked !== locked);
    let failed = 0;
    for (const b of targets) {
      try {
        await api.setBookLock(b.id, locked);
      } catch {
        failed++;
      }
    }
    exitBatch();
    onRefresh();
    alert(
      `已${locked ? '锁定' : '解锁'} ${targets.length - failed} 本` +
        (failed > 0 ? `；${failed} 本失败，可重试` : '') +
        (locked ? '。锁定后这些书不能被删除或批量修改，随时可解锁。' : '。'),
    );
  };

  /** 重置所选书籍的专属排版，回到全局默认 */
  const handleBatchResetPrefs = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    if (!confirm(`清除所选 ${selectedIds.size} 本书的专属排版，恢复全局默认？\n下次打开这些书会用全局排版设置。`)) return;
    for (const id of selectedIds) {
      try {
        await api.setSetting(`bookPrefs:${id}`, '');
      } catch { /* 忽略 */ }
    }
    exitBatch();
    alert('已重置，下次打开这些书籍将使用全局默认排版。');
  };

  /**
   * 批量导出为 TXT / EPUB。目录只选一次，逐本写入由主进程完成。
   *
   * 这里刻意不用 batchTargets()——锁定的书也一并导出。锁的语义是「不能被删除或批量修改」，
   * 导出是纯读操作，把锁定书排除掉没有道理。
   */
  const handleBatchExport = async (format: 'txt' | 'epub') => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    setBatchExporting(format);
    try {
      const r = await api.exportBatch([...selectedIds], format);
      if (!r) return; // 用户取消了目录选择：静默返回，不再弹一次提示打断
      // 跳过原因先归类再报。整批都是扫描版时逐个列书名会糊满一屏，
      // 归并后一眼能看出该去修哪一类书；每类最多举 3 本做样子。
      const byReason = new Map<string, string[]>();
      for (const s of r.skipped) {
        byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.title]);
      }
      const lines = [`已导出 ${r.done} 本到：\n${r.dir}`];
      for (const [reason, titles] of byReason) {
        const sample = titles.slice(0, 3).join('、');
        lines.push(`跳过 ${titles.length} 本——${reason}\n　${sample}${titles.length > 3 ? ' 等' : ''}`);
      }
      alert(lines.join('\n\n'));
      exitBatch();
    } catch (err) {
      alert(err instanceof Error ? err.message : '批量导出失败');
    } finally {
      setBatchExporting(null);
    }
  };

  /**
   * 批量提取内嵌图片。与批量导出同理：锁定的书也照抽——抽图同样是纯读操作。
   * 每本书在所选目录里单独占一个子目录，所以回执报的是「N 本 / M 张」两个数。
   */
  const handleBatchExtractImages = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    setBatchExporting('images');
    try {
      const r = await api.extractBookImages([...selectedIds]);
      if (!r) return; // 用户取消了目录选择
      const byReason = new Map<string, string[]>();
      for (const s of r.skipped) {
        byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.title]);
      }
      const lines = [`已从 ${r.books} 本里提取 ${r.images} 张图片到：\n${r.dir}`];
      for (const [reason, titles] of byReason) {
        const sample = titles.slice(0, 3).join('、');
        lines.push(`跳过 ${titles.length} 本——${reason}\n　${sample}${titles.length > 3 ? ' 等' : ''}`);
      }
      alert(lines.join('\n\n'));
      exitBatch();
    } catch (err) {
      alert(err instanceof Error ? err.message : '提取图片失败');
    } finally {
      setBatchExporting(null);
    }
  };

  const handleBatchDelete = async () => {
    const api = window.electronAPI;
    if (!api || selectedIds.size === 0) return;
    const targets = batchTargets();
    const lockedCount = selectedIds.size - targets.length;
    const msg = `确定删除所选 ${targets.length} 本书？` +
      (lockedCount > 0 ? `（另有 ${lockedCount} 本因锁定被跳过，可在书架右键「解锁书籍」后再试）` : '') +
      '\n书签、笔记、阅读记录与书库内的文件副本将一并删除，此操作无法撤销。';
    if (!confirm(msg)) return;
    let failed = 0;
    for (const b of targets) {
      try {
        await api.deleteBook(b.id);
      } catch {
        failed++;
      }
    }
    exitBatch();
    onRefresh();
    alert(
      `已删除 ${targets.length - failed} 本` +
        (failed > 0 ? `；${failed} 本失败，请重试` : '') +
        (lockedCount > 0 ? `；${lockedCount} 本因锁定被跳过` : '') + '。',
    );
  };

  // 拖拽导入
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const api = window.electronAPI;
    if (!api) return;
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const p = api.getPathForFile(f);
        if (p) paths.push(p);
      } catch { /* 单个文件取路径失败不影响其余 */ }
    }
    if (paths.length === 0) {
      alert('没有读到可导入的文件。请把书籍文件（EPUB / TXT / PDF / DOCX / 漫画压缩包）拖进来，文件夹请先打开再拖其中的文件。');
      return;
    }
    try {
      const r = await api.importPaths(paths);
      const updated = await api.getCategories();
      if (updated) setCategories(updated as string[]);
      onRefresh();
      // 失败原因要说清楚：拖了没反应，用户只会一遍遍重拖
      const imported = r?.imported?.length ?? 0;
      if (r?.failed?.length) {
        alert(
          [`已导入 ${imported} 本，以下文件未导入：`, ...r.failed.map(f => `· ${f.name}：${f.reason}`)].join('\n'),
        );
      } else if (imported > 0) {
        alert(`已导入 ${imported} 本书，可在书架中打开。`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '导入失败，请重试');
    }
  };

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'reading', label: '正在读' },
    { key: 'finished', label: '已读完' },
    { key: 'favorite', label: '收藏' },
    { key: 'shelved', label: '搁置' },
    { key: 'idle', label: `闲置 ${idleDays} 天以上` },
  ];

  /** 文本弹窗提交：期间禁用按钮，避免连点写成两条 */
  const submitTextDialog = async (dialog: Extract<EditDialog, { kind: 'text' }>) => {
    setDialogBusy(true);
    try {
      await dialog.onSubmit(dialog.value);
      setEditDialog(null);
    } finally {
      setDialogBusy(false);
    }
  };

  const applyStatus = async (book: Book, value: string) => {
    setDialogBusy(true);
    try {
      await window.electronAPI?.setBookStatus(book.id, value);
      setEditDialog(null);
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : '设置阅读状态失败，请重试');
    } finally {
      setDialogBusy(false);
    }
  };

  const applyRating = async (book: Book, value: number) => {
    setDialogBusy(true);
    try {
      await window.electronAPI?.setBookRating(book.id, value);
      setEditDialog(null);
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : '评分失败，请重试');
    } finally {
      setDialogBusy(false);
    }
  };

  return (
    <div
      className="book-list"
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">
            <Icon name="download" size={20} />
            松开导入 EPUB / TXT / PDF / DOCX
          </div>
        </div>
      )}

      <div className="book-list-header">
        <h1>我的书架</h1>        <div className="book-list-controls">
          <button
            className={`btn-secondary small${batchMode ? ' active-preset' : ''}`}
            onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
            title="批量管理书架"
          >
            {batchMode ? '退出批量' : '批量管理'}
          </button>
          <button className="btn-secondary small" onClick={handleExportList} title="导出全部书籍的清单（Markdown）">
            导出清单
          </button>
          <button className="btn-secondary small" onClick={handleClearHistory} title="清除全部阅读进度">
            清除记录
          </button>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
            <option value="recent">最近阅读</option>
            <option value="title">按书名</option>
            <option value="author">按作者</option>
            <option value="rating">按评分</option>
          </select>
          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="网格视图"
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="列表视图"
          >
            <Icon name="menu" size={15} />
          </button>
        </div>
      </div>

      {sourceIssues.length > 0 && (
        <div className="source-banner">
          <div className="source-banner-head">
            <span>
              <Icon name="alert" size={15} />
              有 {sourceIssues.length} 本书的源文件已被改动或移走，书库里的还是导入时的版本
            </span>
            <button className="link-btn" onClick={() => setSourcePanelOpen(o => !o)}>
              {sourcePanelOpen ? '收起' : '查看'}
            </button>
          </div>
          {sourcePanelOpen && (
            <div className="source-banner-list">
              {sourceIssues.map(b => (
                <div key={b.id} className="source-banner-row">
                  <div className="source-banner-info">
                    <strong>{b.title}</strong>
                    <em className="privacy-hint">
                      {b.status === 'missing' ? '源文件已不在原位置' : '源文件内容已变化'} · {b.sourcePath}
                    </em>
                  </div>
                  {b.status === 'changed' && (
                    <button className="btn-secondary small" onClick={() => handleRefreshFromSource(b.id)}>
                      用源文件更新
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {continueBook && (
        <div className="continue-card" onClick={() => onSelectBook(continueBook)}>
          <div className="continue-icon"><Icon name="book-open" size={20} /></div>
          <div className="continue-info">
            <p className="continue-label">继续阅读</p>
            <h3>{continueBook.title}</h3>
            <div className="book-progress">
              <div className="progress-bar">
                <div style={{ width: `${continueBook.progress * 100}%` }} />
              </div>
              <span className="progress-text">{Math.round(continueBook.progress * 100)}%</span>
            </div>
          </div>
          <span className="continue-go"><Icon name="arrow-right" size={18} /></span>
        </div>
      )}

      <div className="filter-row">
        {filters.map(f => (
          <button
            key={f.key}
            className={`filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        {seriesList.length > 0 && (
          <select
            value={seriesFilter}
            onChange={e => setSeriesFilter(e.target.value)}
            className="category-select"
          >
            <option value="">全部系列</option>
            {seriesList.map(x => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        )}
        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="category-select"
          >
            <option value="">全部分类</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {/* 标签行：来自 Markdown 正文里的 #标签，点一下按标签筛书 */}
      {tagList.length > 0 && (
        <div className="tag-filter tag-row" style={{ marginTop: 8 }}>
          <button
            className={`tag-chip${tagFilter === '' ? ' active' : ''}`}
            onClick={() => setTagFilter('')}
          >
            全部标签
          </button>
          {tagList.slice(0, 24).map(t => (
            <button
              key={t.tag}
              className={`tag-chip${tagFilter === t.tag ? ' active' : ''}`}
              title={`${t.count} 本书里有这个标签`}
              onClick={() => setTagFilter(cur => (cur === t.tag ? '' : t.tag))}
            >
              #{t.tag}
              <span className="tag-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 属性行：来自 Markdown 的 frontmatter，同样点一下筛书 */}
      {propList.length > 0 && (
        <div className="tag-filter tag-row" style={{ marginTop: 8 }}>
          <button
            className={`tag-chip${propFilter === '' ? ' active' : ''}`}
            onClick={() => setPropFilter('')}
          >
            全部属性
          </button>
          {propList.slice(0, 12).map(p => {
            const id = `${p.key} ${p.value}`;
            return (
              <button
                key={id}
                className={`tag-chip${propFilter === id ? ' active' : ''}`}
                title={`frontmatter：${p.key}: ${p.value}`}
                onClick={() => setPropFilter(cur => (cur === id ? '' : id))}
              >
                {p.key}: {p.value}
                <span className="tag-count">{p.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {batchMode && (
        <div className="batch-bar">
          <span className="batch-count">已选 {selectedIds.size} 本</span>
          <button
            className="btn-secondary small"
            onClick={() => setSelectedIds(new Set(filteredBooks.map(b => b.id)))}
          >
            全选当前
          </button>
          <button className="btn-secondary small" onClick={() => setSelectedIds(new Set())}>
            清空
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchCategory}
            disabled={selectedIds.size === 0}
          >
            设分类
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchSeries}
            disabled={selectedIds.size === 0}
          >
            设系列
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchLock(true)}
            disabled={selectedIds.size === 0}
          >
            锁定
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchLock(false)}
            disabled={selectedIds.size === 0}
          >
            解锁
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchResetPrefs}
            disabled={selectedIds.size === 0}
          >
            重置排版
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchExport('txt')}
            disabled={selectedIds.size === 0 || batchExporting !== null}
            title="把所选书籍的正文导出为 TXT（只需选一次目录）"
          >
            {batchExporting === 'txt' ? '导出中…' : '导出TXT'}
          </button>
          <button
            className="btn-secondary small"
            onClick={() => handleBatchExport('epub')}
            disabled={selectedIds.size === 0 || batchExporting !== null}
            title="把所选书籍重新打包为 EPUB（只需选一次目录）"
          >
            {batchExporting === 'epub' ? '导出中…' : '导出EPUB'}
          </button>
          <button
            className="btn-secondary small"
            onClick={handleBatchExtractImages}
            disabled={selectedIds.size === 0 || batchExporting !== null}
            title="把所选书籍的内嵌图片提取到文件夹（每本一个子目录，只需选一次目录）"
          >
            {batchExporting === 'images' ? '提取中…' : '提取图片'}
          </button>
          <button
            className="btn-danger small"
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
          >
            删除
          </button>
        </div>
      )}

      {filteredBooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="library" size={24} /></div>
          <h2>书架空空如也</h2>
          <p>支持 EPUB、TXT、PDF、DOCX，可直接拖入窗口</p>
          <button className="btn-primary empty-cta" onClick={onImport}>
            <Icon name="plus" size={15} />
            导入第一本书
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="book-grid">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className={`book-card${batchMode ? ' selectable' : ''}${selectedIds.has(book.id) ? ' selected' : ''}`}
              onClick={() => (batchMode ? toggleSelect(book.id) : onShowDetail(book))}
              onContextMenu={(e) => handleContextMenu(e, book)}
            >
              <div className="book-cover">
                {book.cover_path ? (
                  <img src={book.cover_path} alt={book.title} />
                ) : (
                  <div
                    className="book-cover-placeholder"
                    style={{ '--cover-h': coverHue(book.title) } as CSSProperties}
                  >
                    <span className="cover-title">{book.title}</span>
                    <span className="cover-foot">{book.file_type.toUpperCase()}</span>
                  </div>
                )}
                {batchMode && (
                  <span className={`pick-box${selectedIds.has(book.id) ? ' on' : ''}`}>
                    {selectedIds.has(book.id) ? <Icon name="check" size={13} strokeWidth={2.6} /> : ''}
                  </span>
                )}
                {book.favorite ? <span className="fav-badge"><Icon name="star-fill" size={12} /></span> : null}
                {book.locked ? <span className="lock-badge" title="已锁定"><Icon name="lock" size={11} /></span> : null}
                {book.status === 'shelved' ? <span className="shelf-badge" title="已搁置"><Icon name="package" size={11} /></span> : null}
              </div>
              <div className="book-info">
                <h3 className="book-title">{book.title}</h3>
                {book.author && <p className="book-author">{book.author}</p>}
                {book.rating ? (
                  <p className="book-rating" title={`评分 ${book.rating}/5`}>
                    <StarRating value={book.rating} />
                  </p>
                ) : null}
                {(book.series || book.category) && (
                  <p className="book-category">
                    {book.series || ''}
                    {book.series && book.category ? ' · ' : ''}
                    {book.category || ''}
                  </p>
                )}
                {book.progress > 0 && (
                  <div className="book-progress">
                    <div className="progress-bar">
                      <div style={{ width: `${book.progress * 100}%` }} />
                    </div>
                    <span className="progress-text">{Math.round(book.progress * 100)}%</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="book-list-view">
          {filteredBooks.map(book => (
            <div
              key={book.id}
              className="book-list-item"
              onClick={() => onShowDetail(book)}
              onContextMenu={(e) => handleContextMenu(e, book)}
            >
              <div className="book-list-cover">
                {book.cover_path ? (
                  <img src={book.cover_path} alt={book.title} />
                ) : (
                  <div
                    className="book-cover-placeholder small"
                    style={{ '--cover-h': coverHue(book.title) } as CSSProperties}
                  >
                    <span className="cover-foot">{book.file_type.toUpperCase()}</span>
                  </div>
                )}
              </div>
              <div className="book-list-info">
                <h3>
                  {book.favorite ? <Icon name="star-fill" size={11} className="list-fav" /> : null}
                  <span className="list-title-text">{book.title}</span>
                </h3>
                <p>{book.author || '未知作者'}{book.category ? ` · ${book.category}` : ''}</p>
                <p className="book-meta">{book.file_type.toUpperCase()} · {book.progress > 0 ? `已读 ${Math.round(book.progress * 100)}%` : '未读'}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {editDialog && (
        <div
          className="modal-mask"
          onClick={() => {
            if (!dialogBusy) setEditDialog(null);
          }}
        >
          <div className="note-modal" onClick={e => e.stopPropagation()}>
            {editDialog.kind === 'text' && (
              <>
                <h3>{editDialog.title}</h3>
                {editDialog.hint && <p className="section-desc">{editDialog.hint}</p>}
                <input
                  className="tag-input"
                  style={{ width: '100%' }}
                  value={editDialog.value}
                  placeholder={editDialog.placeholder ?? ''}
                  autoFocus
                  onChange={e => setEditDialog({ ...editDialog, value: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void submitTextDialog(editDialog);
                  }}
                />
                {editDialog.options && editDialog.options.length > 0 && (
                  <div className="tag-filter" style={{ marginTop: 10, marginBottom: 0 }}>
                    {editDialog.options.map(o => (
                      <button
                        key={o}
                        className="tag-chip"
                        onClick={() => setEditDialog({ ...editDialog, value: o })}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <div className="form-actions">
                  <button className="btn-secondary" disabled={dialogBusy} onClick={() => setEditDialog(null)}>
                    取消
                  </button>
                  <button
                    className="btn-primary"
                    disabled={dialogBusy}
                    onClick={() => void submitTextDialog(editDialog)}
                  >
                    {dialogBusy ? '处理中…' : editDialog.confirmLabel}
                  </button>
                </div>
              </>
            )}

            {editDialog.kind === 'status' && (
              <>
                <h3>阅读状态</h3>
                <p className="section-desc">《{editDialog.book.title}》</p>
                <div className="tag-filter" style={{ marginBottom: 0 }}>
                  {STATUS_OPTIONS.map(o => (
                    <button
                      key={o.v || 'auto'}
                      className={`tag-chip${(editDialog.book.status ?? '') === o.v ? ' active' : ''}`}
                      disabled={dialogBusy}
                      onClick={() => void applyStatus(editDialog.book, o.v)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="form-actions">
                  <button className="btn-secondary" disabled={dialogBusy} onClick={() => setEditDialog(null)}>
                    取消
                  </button>
                </div>
              </>
            )}

            {editDialog.kind === 'rating' && (
              <>
                <h3>评分</h3>
                <p className="section-desc">
                  《{editDialog.book.title}》当前 {editDialog.book.rating ?? 0} 星，点星星即可打分
                </p>
                <div className="rating-picker">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      className={`rating-star${(editDialog.book.rating ?? 0) >= n ? ' on' : ''}`}
                      disabled={dialogBusy}
                      title={`${n} 星`}
                      onClick={() => void applyRating(editDialog.book, n)}
                    >
                      ★
                    </button>
                  ))}
                </div>
                <div className="form-actions">
                  <button
                    className="btn-secondary"
                    disabled={dialogBusy}
                    onClick={() => void applyRating(editDialog.book, 0)}
                  >
                    清除评分
                  </button>
                  <button className="btn-secondary" disabled={dialogBusy} onClick={() => setEditDialog(null)}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={closeMenu}
        >
          <div className="context-menu-item" onClick={() => onShowDetail(contextMenu.book)}>详情</div>
          <div className="context-menu-item" onClick={handleToggleFavorite}>
            {contextMenu.book.favorite ? '取消收藏' : '加入收藏'}
          </div>
          <div className="context-menu-item" onClick={handleToggleLock}>
            {contextMenu.book.locked ? '解锁书籍' : '锁定书籍'}
          </div>
          <div className="context-menu-item" onClick={handleSetCategory}>设置分类</div>
          <div className="context-menu-item" onClick={handleSetSeries}>设置系列</div>
          <div className="context-menu-item" onClick={handleSetStatus}>阅读状态</div>
          <div className="context-menu-item" onClick={handleSetRating}>评分</div>
          <div className="context-menu-item" onClick={handleRename}>重命名书名</div>
          <div className="context-menu-item" onClick={handleRefreshMetadata}>重新识别标题</div>
          <div className="context-menu-item" onClick={handleFileInfo}>属性</div>
          <div className="context-menu-item" onClick={handleExportOne}>导出批注与笔记</div>
          <div className="context-menu-item" onClick={handleImportOne}>恢复批注与笔记</div>
          <div className="context-menu-item" onClick={handleSaveAs}>另存为副本</div>
          <div className="context-menu-item" onClick={handleExportText}>导出正文为 TXT</div>
          <div className="context-menu-item" onClick={handleExportEpub}>导出为 EPUB</div>
          <div className="context-menu-item" onClick={handleReveal}>打开所在位置</div>
          <div className="context-menu-item" onClick={handleCopyPath}>复制文件路径</div>
          <div className="context-menu-item" onClick={handleOpenWithSystem}>用默认程序打开</div>
          <div className="context-menu-item danger" onClick={handleDelete}>删除</div>
        </div>
      )}
    </div>
  );
}
