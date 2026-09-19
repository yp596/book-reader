import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

let _instance: DatabaseService | null = null;

/**
 * 请求目标是否为本机回环地址。
 *
 * 只有回环才算「不出机器」；局域网地址（如 192.168.x.x）虽然也在内网，
 * 但确实发生了网络请求，仍归联网总开关管辖。
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    // 解析不出来的地址不当作本机，交由开关决定
    return false;
  }
}

export class DatabaseService {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {
    this.dbPath = path.join(app.getPath('userData'), 'book-reader.db');
  }

  static async create(): Promise<DatabaseService> {
    if (_instance) return _instance;
    const svc = new DatabaseService();

    const SQL = await initSqlJs({
      locateFile: (file: string) => path.join(path.dirname(require.resolve('sql.js')), file),
    });

    if (fs.existsSync(svc.dbPath)) {
      const buffer = fs.readFileSync(svc.dbPath);
      svc.db = new SQL.Database(buffer);
    } else {
      svc.db = new SQL.Database();
    }
    svc.db.run('PRAGMA foreign_keys = ON');
    svc.initTables();
    svc.scheduleSave();
    _instance = svc;
    return svc;
  }

  static getInstance(): DatabaseService {
    if (!_instance) throw new Error('DatabaseService 未初始化，请先调用 create()');
    return _instance;
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      // 先清定时器再落盘：save() 失败时（磁盘满、文件被占用）如果定时器还留着，
      // 之后所有写入都会被上面的 if 拦住，自动保存会静默停摆，只有退出才可能再写一次。
      this.saveTimer = null;
      try {
        this.save();
      } catch (err) {
        // 本次失败不致命：下次写入会重新排一次落盘
        console.error('数据库落盘失败，将在下次写入时重试', err);
      }
    }, 5000);
  }

  save() {
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.save();
    this.db.close();
  }

  private initTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT,
        cover_path TEXT,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        progress REAL DEFAULT 0,
        last_read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        position TEXT NOT NULL,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        position TEXT NOT NULL,
        selected_text TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS reading_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        duration INTEGER DEFAULT 0,
        pages_read INTEGER DEFAULT 0,
        date DATE DEFAULT CURRENT_DATE,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      // 生词本
      `CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER,
        word TEXT NOT NULL,
        definition TEXT NOT NULL DEFAULT '',
        context TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // RAG 向量
      `CREATE TABLE IF NOT EXISTS book_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        chunk_idx INTEGER NOT NULL,
        chapter TEXT DEFAULT '',
        target TEXT DEFAULT '',
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_vectors_book ON book_vectors(book_id)`,
      // 多进度断点：一本书可保存多个阅读位置
      `CREATE TABLE IF NOT EXISTS reading_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        position TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        progress REAL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_positions_book ON reading_positions(book_id)`,
    ];
    for (const sql of tables) this.db.run(sql);
    // 存量库迁移：书籍表加收藏/分类/目录缓存列
    for (const ddl of [
      `ALTER TABLE books ADD COLUMN favorite INTEGER DEFAULT 0`,
      `ALTER TABLE books ADD COLUMN category TEXT DEFAULT ''`,
      `ALTER TABLE books ADD COLUMN toc TEXT DEFAULT ''`,
      `ALTER TABLE bookmarks ADD COLUMN color TEXT DEFAULT 'yellow'`,
      `ALTER TABLE books ADD COLUMN locations TEXT DEFAULT ''`,
      // 增量备份：变更时间戳（未更新过时回退 created_at）
      `ALTER TABLE books ADD COLUMN updated_at DATETIME`,
      `ALTER TABLE bookmarks ADD COLUMN updated_at DATETIME`,
      `ALTER TABLE notes ADD COLUMN updated_at DATETIME`,
      `ALTER TABLE words ADD COLUMN updated_at DATETIME`,
      // 书籍锁定：防误删、防误改（仅保留阅读权限）
      `ALTER TABLE books ADD COLUMN locked INTEGER DEFAULT 0`,
      // 笔记标签（逗号分隔存储，无需额外建表）
      `ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ''`,
      // 内容指纹：导入查重
      `ALTER TABLE books ADD COLUMN hash TEXT DEFAULT ''`,
      // 标注样式：highlight=高亮底色 / underline=下划线
      `ALTER TABLE bookmarks ADD COLUMN style TEXT DEFAULT 'highlight'`,
      // 系列分组（同一套书 / 同一作者的作品集）
      `ALTER TABLE books ADD COLUMN series TEXT DEFAULT ''`,
      // 阅读状态（''=按进度推断 / reading / finished / shelved）与星级评分
      `ALTER TABLE books ADD COLUMN status TEXT DEFAULT ''`,
      `ALTER TABLE books ADD COLUMN rating INTEGER DEFAULT 0`,
      // 本书指定的 TXT 目录规则名，空串表示自动择优
      `ALTER TABLE books ADD COLUMN toc_rule TEXT DEFAULT ''`,
      // 目录来源：auto 自动解析 / manual 用户手动编辑
      `ALTER TABLE books ADD COLUMN toc_source TEXT DEFAULT ''`,
    ]) {
      try {
        this.db.run(ddl);
      } catch { /* 列已存在则忽略 */ }
    }
    this.save();
  }

  // ---- 查询辅助 ----

  private all(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  private get(sql: string, params: any[] = []): any | undefined {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    let row: any = undefined;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  private run(sql: string, params: any[] = []) {
    this.db.run(sql, params);
    this.scheduleSave();
  }

  // ============ Books ============

  getAllBooks() {
    return this.all('SELECT * FROM books ORDER BY last_read_at DESC');
  }

  getBookById(id: number) {
    return this.get('SELECT * FROM books WHERE id = ?', [id]);
  }

  insertBook(book: {
    title: string;
    author?: string;
    cover_path?: string;
    file_path: string;
    file_type: string;
    hash?: string;
  }) {
    this.run(
      'INSERT INTO books (title, author, cover_path, file_path, file_type, hash) VALUES (?, ?, ?, ?, ?, ?)',
      [book.title, book.author ?? null, book.cover_path ?? null, book.file_path, book.file_type, book.hash ?? ''],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  updateBookProgress(id: number, progress: number) {
    this.run('UPDATE books SET progress = ?, last_read_at = CURRENT_TIMESTAMP WHERE id = ?', [progress, id]);
  }

  // ============ 书籍锁定（防误删误改） ============

  /**
   * 锁定守卫：锁定的书籍拒绝一切编辑类写入。
   * 仅拦截写操作，阅读（翻页/进度）不受影响。
   */
  private assertUnlocked(bookId: number, action: string) {
    const row = this.get('SELECT locked FROM books WHERE id = ?', [bookId]) as
      | { locked?: number }
      | undefined;
    if (row?.locked) {
      throw new Error(`该书籍已锁定，无法${action}。请先在书架右键解锁。`);
    }
  }

  /** 切换锁定状态，返回切换后的值（1=已锁定） */
  toggleBookLock(id: number): number {
    const row = this.get('SELECT locked FROM books WHERE id = ?', [id]) as
      | { locked: number }
      | undefined;
    if (!row) throw new Error('书籍不存在');
    const next = row.locked ? 0 : 1;
    this.run('UPDATE books SET locked = ? WHERE id = ?', [next, id]);
    return next;
  }

  /** 按内容指纹查重，命中返回已有书籍（用于导入时跳过重复） */
  findBookByHash(hash: string) {
    if (!hash) return undefined;
    return this.get('SELECT id, title FROM books WHERE hash = ?', [hash]);
  }

  /**
   * 书库属性汇总（Markdown frontmatter）：每个 `键: 值` 出现在哪些书里。
   * 只按原样汇总，不猜语义——用户写 `status: 待整理` 还是 `状态: 待整理` 由他自己定。
   */
  getAllBookProps(): { key: string; value: string; bookIds: number[]; count: number }[] {
    const byPair = new Map<string, { key: string; value: string; bookIds: number[] }>();
    for (const b of this.all('SELECT id FROM books') as { id: number }[]) {
      const raw = this.getSetting(`mdProps:${b.id}`);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (!obj || typeof obj !== 'object') continue;
        for (const [key, vals] of Object.entries(obj)) {
          if (!Array.isArray(vals)) continue;
          for (const v of vals) {
            if (typeof v !== 'string' || !v.trim()) continue;
            const id = `${key} ${v}`;
            const cur = byPair.get(id) ?? { key, value: v, bookIds: [] };
            // 同一本书里重复写了同一个值只算一次：count 的语义是「多少本书有它」
            if (!cur.bookIds.includes(b.id)) cur.bookIds.push(b.id);
            byPair.set(id, cur);
          }
        }
      } catch { /* 脏值忽略 */ }
    }
    return [...byPair.values()]
      .map(p => ({ ...p, count: p.bookIds.length }))
      .sort(
        (a, b) =>
          b.count - a.count || a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
      );
  }

  /**
   * 引用关系（Markdown 的 `[[目标]]`）。
   * outgoing = 本书引用了哪些书；incoming = 哪些书引用了本书。
   *
   * 先建一张「名字 → 书」的索引再逐个链接比对——直接对每个链接调 findBookByWikilink
   * 会在书多、链接多时退化成反复全表扫。sourceNameOf 提供「导入时的原文件名」，
   * 与 findBookByWikilink 的口径保持一致。
   */
  getBookLinks(
    bookId: number,
    sourceNameOf?: (id: number) => string | null,
  ): {
    outgoing: { id: number; title: string; via: string }[];
    incoming: { id: number; title: string; via: string }[];
  } {
    const key = (s: string) => (s || '').trim().toLowerCase();
    const books = this.all('SELECT id, title FROM books') as { id: number; title: string }[];
    const byName = new Map<string, { id: number; title: string }>();
    for (const b of books) {
      if (b.title) byName.set(key(b.title), b);
      const name = sourceNameOf?.(b.id);
      if (name) byName.set(key(name), b);
    }

    const linksOf = (id: number): string[] => {
      const raw = this.getSetting(`mdLinks:${id}`);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr)
          ? arr.filter((t): t is string => typeof t === 'string' && !!t.trim())
          : [];
      } catch {
        return [];
      }
    };

    const outgoing: { id: number; title: string; via: string }[] = [];
    for (const t of linksOf(bookId)) {
      const hit = byName.get(key(t));
      if (hit && hit.id !== bookId) outgoing.push({ id: hit.id, title: hit.title, via: t });
    }

    const incoming: { id: number; title: string; via: string }[] = [];
    const seen = new Set<number>();
    for (const b of books) {
      if (b.id === bookId || seen.has(b.id)) continue;
      for (const t of linksOf(b.id)) {
        const hit = byName.get(key(t));
        if (hit?.id === bookId) {
          incoming.push({ id: b.id, title: b.title, via: t });
          seen.add(b.id);
          break;
        }
      }
    }

    return { outgoing, incoming };
  }

  /**
   * wiki 链接解析（Markdown 的 `[[目标]]`）：先按书名匹配，再按「导入时的原文件名」匹配。
   * 后者是必需的——Markdown 的书名取自首个一级标题，与文件名经常不一样，
   * 而链接里写的通常是文件名。
   */
  findBookByWikilink(
    target: string,
    sourceNameOf?: (id: number) => string | null,
  ): { id: number; title: string } | undefined {
    const t = (target || '').trim();
    if (!t) return undefined;
    const byTitle = this.findBookByTitle(t) as { id: number; title: string } | undefined;
    if (byTitle) return byTitle;
    if (!sourceNameOf) return undefined;
    const rows = this.all('SELECT id, title FROM books') as { id: number; title: string }[];
    for (const row of rows) {
      const name = sourceNameOf(row.id);
      if (name && name.toLowerCase() === t.toLowerCase()) return row;
    }
    return undefined;
  }

  /** 按书名查重（忽略大小写与首尾空白）：同一本书的另一个版本或格式 */
  findBookByTitle(title: string) {
    const t = (title || '').trim();
    if (!t) return undefined;
    return this.get('SELECT id, title FROM books WHERE LOWER(TRIM(title)) = LOWER(?)', [t]);
  }

  /**
   * 用新文件替换已有记录（导入冲突策略「替换」）。
   * 只改文件相关字段，id 保持不变——书签、笔记、阅读进度、统计都挂在 id 上。
   * 位置索引（locations）随文件一起作废：换了文件，旧的 CFI 映射不再成立，
   * 阅读器发现缺失会自己重建。
   */
  replaceBookFile(
    id: number,
    book: {
      title: string;
      author?: string;
      cover_path?: string;
      file_path: string;
      file_type: string;
      hash: string;
    },
  ) {
    this.assertUnlocked(id, '替换文件');
    this.run(
      `UPDATE books SET title = ?, author = ?, cover_path = ?, file_path = ?, file_type = ?,
         hash = ?, locations = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        book.title,
        book.author ?? null,
        book.cover_path ?? null,
        book.file_path,
        book.file_type,
        book.hash,
        id,
      ],
    );
  }

  /** 补写指纹（存量书籍首次导入时可能为空） */
  setBookHash(id: number, hash: string) {
    this.run('UPDATE books SET hash = ? WHERE id = ?', [hash, id]);
  }

  /**
   * 正常退出时清掉全部会话标记。
   * 关窗时渲染进程是直接被销毁的，React 的清理函数不一定跑得到，
   * 只靠渲染进程清会留下标记，下次启动误报「上次异常退出」。
   */
  clearReadingSessions() {
    this.run("UPDATE settings SET value = '' WHERE key LIKE 'readingSession:%'");
  }

  /** 批量场景：显式设置锁定态（toggleBookLock 依赖当前值，不适合批量） */
  setBookLock(id: number, locked: boolean) {
    this.run('UPDATE books SET locked = ? WHERE id = ?', [locked ? 1 : 0, id]);
  }

  updateBookInfo(id: number, title: string, author: string | null) {
    this.assertUnlocked(id, '修改书籍信息');
    this.run('UPDATE books SET title = ?, author = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, author, id]);
  }

  renameBook(id: number, title: string) {
    this.assertUnlocked(id, '重命名');
    this.run('UPDATE books SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title.trim(), id]);
  }

  toggleFavorite(id: number): number {
    this.assertUnlocked(id, '修改收藏');
    const row = this.get('SELECT favorite FROM books WHERE id = ?', [id]) as
      | { favorite: number }
      | undefined;
    const next = row?.favorite ? 0 : 1;
    this.run('UPDATE books SET favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [next, id]);
    return next;
  }

  /** 显式设置收藏态。恢复备份时用，toggle 依赖当前值不适合重复执行 */
  setFavorite(id: number, favorite: boolean) {
    this.assertUnlocked(id, '修改收藏');
    this.run('UPDATE books SET favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      favorite ? 1 : 0,
      id,
    ]);
  }

  setCategory(id: number, category: string) {
    this.assertUnlocked(id, '修改分类');
    this.run('UPDATE books SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [category.trim(), id]);
  }

  /** 阅读状态：'' 表示按进度自动推断，其余为用户显式标记 */
  setBookStatus(id: number, status: string) {
    this.assertUnlocked(id, '修改阅读状态');
    // 'unread' 是显式「未读」标记，与 '' 的「按进度推断」语义不同，必须放行，
    // 否则它会被规整成空串，用户显式标的未读会被悄悄改成自动推断。
    const allowed = ['', 'unread', 'reading', 'finished', 'shelved'];
    this.run('UPDATE books SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      allowed.includes(status) ? status : '',
      id,
    ]);
  }

  /** 星级评分：0 表示未评分，1-5 为有效值 */
  setBookRating(id: number, rating: number) {
    this.assertUnlocked(id, '修改评分');
    const r = Math.max(0, Math.min(5, Math.floor(Number(rating) || 0)));
    this.run('UPDATE books SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [r, id]);
  }

  /** 设置所属系列（空串=取消分组） */
  setBookSeries(id: number, series: string) {
    this.assertUnlocked(id, '修改系列');
    this.run('UPDATE books SET series = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      series.trim(),
      id,
    ]);
  }

  /** 已使用的系列列表 */
  getSeriesList(): string[] {
    const rows = this.all(
      `SELECT DISTINCT series FROM books WHERE series IS NOT NULL AND series != '' ORDER BY series`,
    );
    return rows.map(r => r.series as string);
  }

  getCategories(): string[] {
    const rows = this.all(
      `SELECT DISTINCT category FROM books WHERE category IS NOT NULL AND category != '' ORDER BY category`,
    );
    return rows.map(r => r.category as string);
  }

  setBookToc(id: number, tocJson: string, source: 'auto' | 'manual' = 'auto') {
    this.run('UPDATE books SET toc = ?, toc_source = ? WHERE id = ?', [tocJson, source, id]);
  }

  /** 目录来源：auto 自动解析 / manual 用户手动编辑；空串表示尚未解析 */
  getBookTocSource(id: number): string {
    const row = this.get('SELECT toc_source FROM books WHERE id = ?', [id]) as
      | { toc_source?: string }
      | undefined;
    return row?.toc_source ?? '';
  }

  /** 读取本书指定的目录规则名，空串表示自动择优 */
  getBookTocRule(id: number): string {    const row = this.get('SELECT toc_rule FROM books WHERE id = ?', [id]) as
      | { toc_rule?: string }
      | undefined;
    return row?.toc_rule ?? '';
  }

  setBookTocRule(id: number, ruleName: string) {
    this.run('UPDATE books SET toc_rule = ? WHERE id = ?', [ruleName, id]);
  }

  /**
   * 写入封面地址。
   * 存的是 bookfile:// 协议 URL 而非磁盘路径——渲染进程直接用它做 <img src>，
   * 磁盘路径在 loadFile 的页面里解析不成图片。
   */
  setBookCover(id: number, coverUrl: string) {
    this.run('UPDATE books SET cover_path = ? WHERE id = ?', [coverUrl, id]);
  }

  /** 尚无封面的书籍，供启动后异步补全 */
  getBooksWithoutCover(): { id: number; file_path: string; file_type: string; hash: string }[] {
    return this.all(
      `SELECT id, file_path, file_type, COALESCE(hash, '') AS hash
       FROM books WHERE cover_path IS NULL OR cover_path = ''`,
    );
  }

  setBookLocations(id: number, locationsJson: string) {
    this.run('UPDATE books SET locations = ? WHERE id = ?', [locationsJson, id]);
  }

  deleteBook(id: number) {
    this.assertUnlocked(id, '删除');
    // 显式清理关联数据：实测 ON DELETE CASCADE 在 sql.js 下未生效，
    // 不清理会留下孤儿书签/笔记/断点，污染后续查询与备份
    for (const t of ['bookmarks', 'notes', 'reading_positions', 'book_vectors', 'reading_stats']) {
      this.run(`DELETE FROM ${t} WHERE book_id = ?`, [id]);
    }
    this.run('DELETE FROM books WHERE id = ?', [id]);
  }

  /** 清除全部阅读记录（保留书籍） */
  clearReadingHistory() {
    this.run('UPDATE books SET progress = 0, last_read_at = NULL');
    // 阅读位置存在 settings 表，一并清掉，否则重开仍会跳回上次位置
    this.run("DELETE FROM settings WHERE key LIKE 'lastPos:%'");
  }

  // ============ Notes ============

  /** 跨书籍笔记：带书名，供「我的笔记」页汇总与筛选 */
  getAllNotes() {
    return this.all(`
      SELECT n.*, b.title AS book_title, b.file_type AS book_type,
             COALESCE(n.tags, '') AS tags
      FROM notes n LEFT JOIN books b ON b.id = n.book_id
      ORDER BY n.created_at DESC
    `);
  }

  /** 更新笔记标签（调用方传入已归一化的逗号分隔串） */
  updateNoteTags(id: number, tags: string) {
    const row = this.get('SELECT book_id FROM notes WHERE id = ?', [id]) as
      | { book_id: number }
      | undefined;
    if (row) this.assertUnlocked(row.book_id, '修改笔记标签');
    this.run('UPDATE notes SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [tags, id]);
  }

  /** 更新笔记正文与标签。集中管理面板一次落库，避免正文与标签分两次写导致不同步 */
  updateNote(id: number, content: string, tags: string) {
    const row = this.get('SELECT book_id FROM notes WHERE id = ?', [id]) as
      | { book_id: number }
      | undefined;
    if (row) this.assertUnlocked(row.book_id, '修改笔记');
    this.run('UPDATE notes SET note = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      content,
      tags,
      id,
    ]);
  }

  getNotesByBookId(bookId: number) {
    return this.all('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC', [bookId]);
  }

  insertNote(note: { book_id: number; position: string; selected_text?: string; note?: string; tags?: string }) {
    this.assertUnlocked(note.book_id, '新增笔记');
    this.run(
      'INSERT INTO notes (book_id, position, selected_text, note, tags) VALUES (?, ?, ?, ?, ?)',
      [note.book_id, note.position, note.selected_text ?? null, note.note ?? null, note.tags ?? ''],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteNote(id: number) {
    const row = this.get('SELECT book_id FROM notes WHERE id = ?', [id]) as { book_id: number } | undefined;
    if (row) this.assertUnlocked(row.book_id, '删除笔记');
    this.run('DELETE FROM notes WHERE id = ?', [id]);
  }

  // ============ Bookmarks ============

  getBookmarksByBookId(bookId: number) {
    return this.all('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY created_at DESC', [bookId]);
  }

  insertBookmark(bookmark: {
    book_id: number;
    position: string;
    text?: string;
    color?: string;
    style?: string;
  }) {
    this.assertUnlocked(bookmark.book_id, '新增书签');
    const style = bookmark.style === 'underline' ? 'underline' : 'highlight';
    this.run(
      'INSERT INTO bookmarks (book_id, position, text, color, style) VALUES (?, ?, ?, ?, ?)',
      [bookmark.book_id, bookmark.position, bookmark.text ?? null, bookmark.color ?? 'yellow', style],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  getBookmarkByPosition(bookId: number, position: string) {
    return this.get('SELECT * FROM bookmarks WHERE book_id = ? AND position = ?', [bookId, position]);
  }

  deleteBookmark(id: number) {
    const row = this.get('SELECT book_id FROM bookmarks WHERE id = ?', [id]) as { book_id: number } | undefined;
    if (row) this.assertUnlocked(row.book_id, '删除书签');
    this.run('DELETE FROM bookmarks WHERE id = ?', [id]);
  }

  // ============ 生词本 ============

  getAllWords() {
    return this.all('SELECT w.*, b.title as book_title FROM words w LEFT JOIN books b ON b.id = w.book_id ORDER BY w.created_at DESC');
  }

  insertWord(w: { book_id?: number | null; word: string; definition: string; context?: string }) {
    this.run('INSERT INTO words (book_id, word, definition, context) VALUES (?, ?, ?, ?)', [
      w.book_id ?? null,
      w.word.trim(),
      w.definition,
      w.context ?? null,
    ]);
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteWord(id: number) {
    this.run('DELETE FROM words WHERE id = ?', [id]);
  }

  // ============ 书签改名 ============

  updateBookmarkText(id: number, text: string) {
    const row = this.get('SELECT book_id FROM bookmarks WHERE id = ?', [id]) as { book_id: number } | undefined;
    if (row) this.assertUnlocked(row.book_id, '修改书签');
    this.run('UPDATE bookmarks SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [text.trim(), id]);
  }

  // ============ 按日阅读时长（周统计用） ============

  getDailyDurations(days: number): { date: string; duration: number }[] {
    return this.all(
      `SELECT date, SUM(duration) as duration FROM reading_stats
       WHERE date >= date('now', 'localtime', ?) GROUP BY date`,
      [`-${days - 1} days`],
    );
  }

  // ============ RAG 向量 ============

  clearBookVectors(bookId: number) {
    this.run('DELETE FROM book_vectors WHERE book_id = ?', [bookId]);
  }

  saveVectors(
    rows: { book_id: number; chunk_idx: number; chapter: string; target: string; text: string; embedding: string }[],
  ) {
    for (const r of rows) {
      this.run(
        'INSERT INTO book_vectors (book_id, chunk_idx, chapter, target, text, embedding) VALUES (?, ?, ?, ?, ?, ?)',
        [r.book_id, r.chunk_idx, r.chapter, r.target, r.text, r.embedding],
      );
    }
  }

  getAllVectors(): { id: number; book_id: number; chapter: string; target: string; text: string; embedding: string }[] {
    return this.all('SELECT id, book_id, chapter, target, text, embedding FROM book_vectors');
  }

  getVectorStats(): { book_id: number; title: string; chunks: number; updated_at: string }[] {
    return this.all(`
      SELECT v.book_id, b.title, COUNT(*) as chunks, MAX(v.created_at) as updated_at
      FROM book_vectors v LEFT JOIN books b ON b.id = v.book_id
      GROUP BY v.book_id ORDER BY updated_at DESC
    `);
  }

  // ============ 阅读计时 ============

  private todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  recordReadingTime(bookId: number, seconds: number) {
    if (seconds < 5) return;
    const today = this.todayStr();
    const row = this.get('SELECT id FROM reading_stats WHERE book_id = ? AND date = ?', [bookId, today]) as
      | { id: number }
      | undefined;
    if (row) {
      this.run('UPDATE reading_stats SET duration = duration + ? WHERE id = ?', [Math.round(seconds), row.id]);
    } else {
      this.run('INSERT INTO reading_stats (book_id, duration, date) VALUES (?, ?, ?)', [
        bookId,
        Math.round(seconds),
        today,
      ]);
    }
  }

  getReadingTimeStats(): { today: number; total: number } {
    const today = this.todayStr();
    const t = this.get('SELECT COALESCE(SUM(duration), 0) as s FROM reading_stats WHERE date = ?', [today]) as any;
    const all = this.get('SELECT COALESCE(SUM(duration), 0) as s FROM reading_stats') as any;
    return { today: Number(t?.s ?? 0), total: Number(all?.s ?? 0) };
  }

  // ============ Settings ============
  getSetting(key: string): string | null {
    const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }

  // ============ 联网附加能力总开关 ============

  /**
   * 布尔型设置的统一读法。
   *
   * 约定：写入一律用 '1'/'0'；但历史版本里设置页保存写过 'true'/'false'，
   * 宽松读取是为了让这批存量数据继续生效（否则界面显示已开启、功能仍报未开启）。
   * 其余无法识别的值一律当关闭，保持「不认识就不放行」的保守立场。
   */
  isSettingOn(key: string): boolean {
    const value = this.getSetting(key);
    return value === '1' || value === 'true';
  }

  /**
   * 出站请求的总闸门。纯离线定位要求默认关闭，
   * 关闭状态下 AI 回退、模型下载都不许发出请求。
   */
  isOnlineEnabled(): boolean {
    return this.isSettingOn('onlineFeaturesEnabled');
  }

  /**
   * 出站请求的总闸门。纯离线定位要求默认关闭，
   * 关闭状态下 AI 回退、模型下载都不许发出请求。
   *
   * 传入 targetUrl 且目标为本机服务时直接放行：回环地址不离开这台机器，
   * 不属于「联网附加能力」该管的范围。否则默认配置里指向 localhost 的
   * 向量服务与 AI 服务会连带被拦，变成「装了本机模型却要求先允许联网」。
   */
  assertOnlineEnabled(feature: string, targetUrl?: string) {
    if (targetUrl && isLoopbackUrl(targetUrl)) return;
    if (this.isOnlineEnabled()) return;
    throw new Error(`「${feature}」需要联网，当前未开启。请到「设置 → 联网附加能力」中开启后再试。`);
  }

  /**
   * 首次初始化开关（只在没写过值时执行一次）。新装默认关闭。
   */
  initOnlineSwitch() {
    if (this.getSetting('onlineFeaturesEnabled') !== null) return;
    this.setSetting('onlineFeaturesEnabled', '0');
  }

  /**
   * 上次没走正常退出流程时留下的会话标记。
   * 离开阅读器会把标记清空，所以「值非空」就等于异常退出；
   * 同时开着多本书时取时间戳最新的那个。
   */
  findDanglingReadingSession(): { bookId: number; at: number } | null {
    // 取全部再逐个校验：光靠 SQL 排序，一条畸形 key 会挡住后面正常的记录
    const rows = this.all(
      "SELECT key, value FROM settings WHERE key LIKE 'readingSession:%' AND value <> '' ORDER BY CAST(value AS INTEGER) DESC",
    ) as { key?: string; value?: string }[];
    for (const row of rows) {
      const bookId = Number((row.key ?? '').slice('readingSession:'.length));
      if (Number.isInteger(bookId) && bookId > 0) return { bookId, at: Number(row.value) || 0 };
    }
    return null;
  }

  // ============ 多进度断点 ============

  /**
   * 记录阅读位置。同书同位置视为一条（刷新而非堆叠）。
   * source：manual=手动标记 / exit=正常退出 / crash=异常退出恢复
   */
  addReadingPosition(p: {
    book_id: number;
    position: string;
    label?: string;
    progress?: number;
    source?: 'manual' | 'exit' | 'crash';
  }): number {
    const dup = this.get(
      'SELECT id FROM reading_positions WHERE book_id = ? AND position = ?',
      [p.book_id, p.position],
    ) as { id: number } | undefined;
    if (dup) {
      this.run(
        'UPDATE reading_positions SET label = ?, progress = ?, source = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
        [p.label ?? '', p.progress ?? 0, p.source ?? 'manual', dup.id],
      );
      return dup.id;
    }
    this.run(
      'INSERT INTO reading_positions (book_id, position, label, progress, source) VALUES (?, ?, ?, ?, ?)',
      [p.book_id, p.position, p.label ?? '', p.progress ?? 0, p.source ?? 'manual'],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return Number(row?.id);
  }

  getReadingPositions(bookId: number, limit = 20) {
    return this.all(
      'SELECT * FROM reading_positions WHERE book_id = ? ORDER BY created_at DESC LIMIT ?',
      [bookId, limit],
    );
  }

  deleteReadingPosition(id: number) {
    this.run('DELETE FROM reading_positions WHERE id = ?', [id]);
  }

  /** 自动来源只保留最近若干条，避免退出记录无限堆积 */
  pruneReadingPositions(bookId: number, keepAuto = 5) {
    for (const src of ['exit', 'crash'] as const) {
      this.run(
        `DELETE FROM reading_positions
         WHERE book_id = ? AND source = ?
           AND id NOT IN (
             SELECT id FROM reading_positions
             WHERE book_id = ? AND source = ?
             ORDER BY created_at DESC LIMIT ?
           )`,
        [bookId, src, bookId, src, keepAuto],
      );
    }
  }

  // ============ 隐私清理 ============

  /**
   * 清理自动记录的阅读位置（正常退出/异常退出留下的），
   * 手动标记的位置属于用户主动保存，一律保留。
   * 返回清理条数。
   */
  clearAutoPositions(): number {
    const row = this.get(
      "SELECT COUNT(*) AS c FROM reading_positions WHERE source != 'manual'",
    ) as { c?: number } | undefined;
    this.run("DELETE FROM reading_positions WHERE source != 'manual'");
    return Number(row?.c ?? 0);
  }

  /** 抹掉「什么时候读过」的记录，保留阅读进度本身。返回影响的书籍数。 */
  clearReadingTimestamps(): number {
    const row = this.get('SELECT COUNT(*) AS c FROM books WHERE last_read_at IS NOT NULL') as
      | { c?: number }
      | undefined;
    this.run('UPDATE books SET last_read_at = NULL');
    return Number(row?.c ?? 0);
  }

  // ============ 增量备份支持 ============

  /**
   * 取指定表自 since 起有变更的行（since 为 null 时全量）。
   * 表名来自内部白名单，不接受外部输入。
   */
  exportRowsSince(
    table: 'books' | 'bookmarks' | 'notes' | 'words',
    since: string | null,
  ): any[] {
    if (!since) return this.all(`SELECT * FROM ${table}`);
    // 两个时间戳格式不一样：基线存的是 ISO（2026-09-12T10:00:00.000Z），
    // 库内是 SQLite 的 CURRENT_TIMESTAMP（2026-09-12 10:00:00，UTC、空格分隔）。
    // 字符串比较到第 10 位时 ' '(0x20) < 'T'(0x54)，当天产生的记录会被判成「没变过」而永久漏备，
    // 所以两边先统一成库内格式再比。
    const normalized = since.length >= 19 ? `${since.slice(0, 10)} ${since.slice(11, 19)}` : since;
    return this.all(
      `SELECT * FROM ${table} WHERE REPLACE(COALESCE(updated_at, created_at), 'T', ' ') > ?`,
      [normalized],
    );
  }

  /** 各表最近一次变更时间（用于增量基线） */
  latestChangeAt(table: 'books' | 'bookmarks' | 'notes' | 'words'): string | null {
    const row = this.get(
      `SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM ${table}`,
    ) as { t?: string } | undefined;
    return row?.t ?? null;
  }

  // ============ Window ============

  getWindowBounds(): { x: number; y: number; width: number; height: number } | null {
    const raw = this.getSetting('windowBounds');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}
