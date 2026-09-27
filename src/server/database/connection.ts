import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

let db: DB | null = null;

export function getDatabasePath(): string {
  const env = process.env.DATABASE_PATH;
  const root = process.cwd();
  if (env && env.trim()) {
    return path.isAbsolute(env) ? env : path.resolve(root, env);
  }
  return path.resolve(root, 'data', 'supportos.db');
}

export function openDatabase(dbPath?: string): DB {
  if (db) return db;
  const p = dbPath ?? getDatabasePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  return db;
}

/** For tests: open an isolated in-memory database. */
export function openTestDatabase(): DB {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDb(): DB {
  if (!db) throw new Error('Database not opened yet');
  return db;
}

export function dbFilePath(): string {
  return getDatabasePath();
}

/** Table row counts for the health screen. */
export function tableStats(dbo: DB): { table: string; rows: number }[] {
  const rows = dbo
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%' ORDER BY name`)
    .all() as { name: string }[];
  const out: { table: string; rows: number }[] = [];
  for (const r of rows) {
    const c = (dbo.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get() as { n: number }).n;
    out.push({ table: r.name, rows: c });
  }
  return out;
}
