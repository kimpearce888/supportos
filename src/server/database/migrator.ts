import type { DB } from './connection.js';

export interface Migration {
  id: number;
  name: string;
  up: (db: DB) => void;
}

/**
 * Real migration system with history. Migrations are numbered and run in order
 * inside a transaction. Schema changes NEVER happen ad hoc.
 */
export function runMigrations(db: DB, migrations: Migration[]): { applied: number; total: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  let count = 0;

  for (const m of sorted) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    });
    run();
    count++;
  }
  return { applied: count, total: sorted.length };
}

export function migrationsApplied(db: DB): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
  } catch {
    return 0;
  }
}
