import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

let _instance: DatabaseService | null = null;

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
      this.save();
      this.saveTimer = null;
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
      `CREATE TABLE IF NOT EXISTS book_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        search_url TEXT NOT NULL DEFAULT '',
        chapters_url TEXT NOT NULL DEFAULT '',
        content_url TEXT NOT NULL DEFAULT '',
        enabled INTEGER DEFAULT 1,
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
      // 在线书源章节缓存
      `CREATE TABLE IF NOT EXISTS cached_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        book_url TEXT NOT NULL,
        chapter_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        idx INTEGER DEFAULT 0,
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cached_book ON cached_chapters(book_url)`,
      // 生词本
      `CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER,
        word TEXT NOT NULL,
        definition TEXT NOT NULL DEFAULT '',
        context TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 文本净化规则（全局正则替换）
      `CREATE TABLE IF NOT EXISTS text_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pattern TEXT NOT NULL,
        replacement TEXT NOT NULL DEFAULT '',
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 追更订阅
      `CREATE TABLE IF NOT EXISTS followed_books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        book_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        last_chapter TEXT DEFAULT '',
        last_count INTEGER DEFAULT 0,
        last_check DATETIME,
        has_update INTEGER DEFAULT 0
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
    // 存量库迁移：书源表加规则列
    try {
      this.db.run(`ALTER TABLE book_sources ADD COLUMN rules TEXT DEFAULT ''`);
    } catch { /* 列已存在则忽略 */ }
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

  insertBook(book: { title: string; author?: string; cover_path?: string; file_path: string; file_type: string }) {
    this.run(
      'INSERT INTO books (title, author, cover_path, file_path, file_type) VALUES (?, ?, ?, ?, ?)',
      [book.title, book.author ?? null, book.cover_path ?? null, book.file_path, book.file_type],
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

  setCategory(id: number, category: string) {
    this.assertUnlocked(id, '修改分类');
    this.run('UPDATE books SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [category.trim(), id]);
  }

  getCategories(): string[] {
    const rows = this.all(
      `SELECT DISTINCT category FROM books WHERE category IS NOT NULL AND category != '' ORDER BY category`,
    );
    return rows.map(r => r.category as string);
  }

  setBookToc(id: number, tocJson: string) {
    this.run('UPDATE books SET toc = ? WHERE id = ?', [tocJson, id]);
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

  // ============ Sources ============

  getAllSources() {
    return this.all('SELECT * FROM book_sources WHERE enabled = 1');
  }

  getSourceById(id: number) {
    return this.get('SELECT * FROM book_sources WHERE id = ?', [id]);
  }

  insertSource(source: { name: string; url: string; search_url: string; chapters_url: string; content_url: string; rules?: string }) {
    this.run(
      'INSERT INTO book_sources (name, url, search_url, chapters_url, content_url, rules) VALUES (?, ?, ?, ?, ?, ?)',
      [source.name, source.url, source.search_url, source.chapters_url, source.content_url, source.rules ?? ''],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteSource(id: number) {
    this.run('DELETE FROM book_sources WHERE id = ?', [id]);
  }

  updateSourceRules(id: number, rules: string) {
    this.run('UPDATE book_sources SET rules = ? WHERE id = ?', [rules, id]);
  }

  // ============ 在线章节缓存 ============

  getCachedChapter(chapterUrl: string) {
    return this.get('SELECT * FROM cached_chapters WHERE chapter_url = ?', [chapterUrl]);
  }

  getCachedChapters(bookUrl: string) {
    return this.all('SELECT chapter_url FROM cached_chapters WHERE book_url = ?', [bookUrl]);
  }

  saveCachedChapter(c: {
    source_id: number;
    book_url: string;
    chapter_url: string;
    title: string;
    content: string;
    idx: number;
  }) {
    this.run(
      `INSERT OR REPLACE INTO cached_chapters
        (source_id, book_url, chapter_url, title, content, idx) VALUES (?, ?, ?, ?, ?, ?)`,
      [c.source_id, c.book_url, c.chapter_url, c.title, c.content, c.idx],
    );
  }

  // ============ Notes ============

  getNotesByBookId(bookId: number) {
    return this.all('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC', [bookId]);
  }

  insertNote(note: { book_id: number; position: string; selected_text?: string; note?: string }) {
    this.assertUnlocked(note.book_id, '新增笔记');
    this.run(
      'INSERT INTO notes (book_id, position, selected_text, note) VALUES (?, ?, ?, ?)',
      [note.book_id, note.position, note.selected_text ?? null, note.note ?? null],
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

  insertBookmark(bookmark: { book_id: number; position: string; text?: string; color?: string }) {
    this.assertUnlocked(bookmark.book_id, '新增书签');
    this.run(
      'INSERT INTO bookmarks (book_id, position, text, color) VALUES (?, ?, ?, ?)',
      [bookmark.book_id, bookmark.position, bookmark.text ?? null, bookmark.color ?? 'yellow'],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
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

  // ============ 文本净化 ============

  getEnabledFilters(): { pattern: string; replacement: string }[] {
    return this.all('SELECT pattern, replacement FROM text_filters WHERE enabled = 1 ORDER BY id');
  }

  getAllFilters() {
    return this.all('SELECT * FROM text_filters ORDER BY id');
  }

  insertFilter(f: { name: string; pattern: string; replacement: string }) {
    // 校验正则合法性
    new RegExp(f.pattern);
    this.run('INSERT INTO text_filters (name, pattern, replacement) VALUES (?, ?, ?)', [
      f.name,
      f.pattern,
      f.replacement ?? '',
    ]);
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  toggleFilter(id: number, enabled: number) {
    this.run('UPDATE text_filters SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  }

  deleteFilter(id: number) {
    this.run('DELETE FROM text_filters WHERE id = ?', [id]);
  }

  // ============ 追更订阅 ============

  getFollowedBooks() {
    return this.all('SELECT * FROM followed_books ORDER BY has_update DESC, last_check DESC');
  }

  followBook(f: { source_id: number; book_url: string; title: string }) {
    this.run(
      'INSERT OR IGNORE INTO followed_books (source_id, book_url, title) VALUES (?, ?, ?)',
      [f.source_id, f.book_url, f.title],
    );
  }

  unfollowBook(id: number) {
    this.run('DELETE FROM followed_books WHERE id = ?', [id]);
  }

  updateFollowResult(id: number, lastChapter: string, count: number, hasUpdate: boolean) {
    this.run(
      `UPDATE followed_books SET last_chapter = ?, last_count = ?, has_update = ?, last_check = CURRENT_TIMESTAMP WHERE id = ?`,
      [lastChapter, count, hasUpdate ? 1 : 0, id],
    );
  }

  clearFollowUpdate(id: number) {
    this.run('UPDATE followed_books SET has_update = 0 WHERE id = ?', [id]);
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

  // ============ 增量备份支持 ============

  /**
   * 取指定表自 since 起有变更的行（since 为 null 时全量）。
   * 表名来自内部白名单，不接受外部输入。
   */
  exportRowsSince(
    table: 'books' | 'bookmarks' | 'notes' | 'words' | 'book_sources',
    since: string | null,
  ): any[] {
    if (!since) return this.all(`SELECT * FROM ${table}`);
    return this.all(
      `SELECT * FROM ${table} WHERE COALESCE(updated_at, created_at) > ?`,
      [since],
    );
  }

  /** 各表最近一次变更时间（用于增量基线） */
  latestChangeAt(table: 'books' | 'bookmarks' | 'notes' | 'words' | 'book_sources'): string | null {
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
