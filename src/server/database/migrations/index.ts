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
import { migration010 } from './010_audit_hardening.js';
import { migration011 } from './011_activity_engine.js';
import { migration012 } from './012_m2_collaboration.js';
import { migration013 } from './013_m3_copilot_attributes.js';
import { migration014 } from './014_m4_intelligence_workspace.js';
import { migration015 } from './015_m5_quality_translation_reports.js';
import { migration016 } from './016_m6_graph_coaching_memory.js';

export const migrations = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013, migration014, migration015, migration016];

export function applyMigrations(db: DB): { applied: number; total: number } {
  return runMigrations(db, migrations);
}

export { runMigrations };
