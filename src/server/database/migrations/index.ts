import { runMigrations } from '../migrator.js';
import type { DB } from '../connection.js';
import { migration001 } from './001_core.js';
import { migration002 } from './002_sync_jobs.js';
import { migration003 } from './003_ai_knowledge.js';
import { migration004 } from './004_fts.js';
import { migration005 } from './005_interaction_intelligence.js';
import { migration006 } from './006_interaction_integrity.js';
import { migration007 } from './007_channels_docs.js';
import { migration008 } from './008_semantic_docs_sla.js';
import { migration009 } from './009_outreach_semantic_sync.js';

export const migrations = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009];

export function applyMigrations(db: DB): { applied: number; total: number } {
  return runMigrations(db, migrations);
}

export { runMigrations };
