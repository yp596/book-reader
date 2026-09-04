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

  updateBookInfo(id: number, title: string, author: string | null) {
    this.run('UPDATE books SET title = ?, author = ? WHERE id = ?', [title, author, id]);
  }

  renameBook(id: number, title: string) {
    this.run('UPDATE books SET title = ? WHERE id = ?', [title.trim(), id]);
  }

  toggleFavorite(id: number): number {
    const row = this.get('SELECT favorite FROM books WHERE id = ?', [id]) as
      | { favorite: number }
      | undefined;
    const next = row?.favorite ? 0 : 1;
    this.run('UPDATE books SET favorite = ? WHERE id = ?', [next, id]);
    return next;
  }

  setCategory(id: number, category: string) {
    this.run('UPDATE books SET category = ? WHERE id = ?', [category.trim(), id]);
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

  deleteBook(id: number) {
    this.run('DELETE FROM books WHERE id = ?', [id]);
  }

  /** 清除全部阅读记录（保留书籍） */
  clearReadingHistory() {
    this.run('UPDATE books SET progress = 0, last_read_at = NULL');
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
    this.run(
      'INSERT INTO notes (book_id, position, selected_text, note) VALUES (?, ?, ?, ?)',
      [note.book_id, note.position, note.selected_text ?? null, note.note ?? null],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteNote(id: number) {
    this.run('DELETE FROM notes WHERE id = ?', [id]);
  }

  // ============ Bookmarks ============

  getBookmarksByBookId(bookId: number) {
    return this.all('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY created_at DESC', [bookId]);
  }

  insertBookmark(bookmark: { book_id: number; position: string; text?: string; color?: string }) {
    this.run(
      'INSERT INTO bookmarks (book_id, position, text, color) VALUES (?, ?, ?, ?)',
      [bookmark.book_id, bookmark.position, bookmark.text ?? null, bookmark.color ?? 'yellow'],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteBookmark(id: number) {
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
    this.run('UPDATE bookmarks SET text = ? WHERE id = ?', [text.trim(), id]);
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

  // ============ Window ============

  getWindowBounds(): { x: number; y: number; width: number; height: number } | null {
    const raw = this.getSetting('windowBounds');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}
