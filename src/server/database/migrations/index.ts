import { runMigrations } from '../migrator.js';
import type { DB } from '../connection.js';
import { migration001 } from './001_core.js';
import { migration002 } from './002_sync_jobs.js';
import { migration003 } from './003_ai_knowledge.js';
import { migration004 } from './004_fts.js';

export const migrations = [migration001, migration002, migration003, migration004];

export function applyMigrations(db: DB): { applied: number; total: number } {
  return runMigrations(db, migrations);
}

export { runMigrations };
