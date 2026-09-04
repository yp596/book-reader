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
    ];
    for (const sql of tables) this.db.run(sql);
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

  deleteBook(id: number) {
    this.run('DELETE FROM books WHERE id = ?', [id]);
  }

  // ============ Sources ============

  getAllSources() {
    return this.all('SELECT * FROM book_sources WHERE enabled = 1');
  }

  getSourceById(id: number) {
    return this.get('SELECT * FROM book_sources WHERE id = ?', [id]);
  }

  insertSource(source: { name: string; url: string; search_url: string; chapters_url: string; content_url: string }) {
    this.run(
      'INSERT INTO book_sources (name, url, search_url, chapters_url, content_url) VALUES (?, ?, ?, ?, ?)',
      [source.name, source.url, source.search_url, source.chapters_url, source.content_url],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteSource(id: number) {
    this.run('DELETE FROM book_sources WHERE id = ?', [id]);
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

  insertBookmark(bookmark: { book_id: number; position: string; text?: string }) {
    this.run(
      'INSERT INTO bookmarks (book_id, position, text) VALUES (?, ?, ?)',
      [bookmark.book_id, bookmark.position, bookmark.text ?? null],
    );
    const row = this.get('SELECT last_insert_rowid() as id');
    return row?.id;
  }

  deleteBookmark(id: number) {
    this.run('DELETE FROM bookmarks WHERE id = ?', [id]);
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
