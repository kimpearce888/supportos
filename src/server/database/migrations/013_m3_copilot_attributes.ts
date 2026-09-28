import type { Migration } from '../migrator.js';

/**
 * v1.8.0 -> v1.9.0 (M3: Local Copilot, General AI Attribute Layer,
 * AI escalation rules - plan phases 15-17).
 *
 * 1. ai_attributes: first-class LOCAL AI attributes (plan Phase 16).
 *    VERSIONED: every recompute inserts new rows and stamps superseded_at on
 *    the previous ones, so full history is preserved and "current" always
 *    means `superseded_at IS NULL`. Attributes never overwrite Help Scout
 *    source data - they live in their own table, always labeled with source
 *    ('deterministic' | 'ai'), confidence and schema_version. A MISSING row
 *    IS the honest 'unknown' (no fabrication).
 *
 * 2. copilot_sessions + copilot_messages: the interactive Local Copilot
 *    (plan Phase 15). Chat history with machine-generated citations (the
 *    citation list is derived from the tools the server actually executed,
 *    never from what the model claims). Copilot is read-only by construction:
 *    it can only call the allowlisted read tools, so no write-side columns
 *    exist at all. Sessions can be conversation-scoped (conversation_id) or
 *    global (NULL).
 *
 * No backfill: attributes are computed going forward (deterministic layer on
 * next sweep/analysis, AI layer on next analysis run). Pre-1.9.0 history has
 * no attribute rows, which reads honestly as 'unknown'.
 *
 * Escalation rules (plan Phase 17) need NO new tables: they reuse
 * automation_rules with the extended condition vocabulary (ai_attribute /
 * ai_verification fields) and the existing approval queue.
 *
 * Safe to re-run: everything is CREATE TABLE IF NOT EXISTS.
 */
export const migration013: Migration = {
  id: 13,
  name: 'm3_copilot_attributes',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_attributes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        value_type TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source TEXT NOT NULL,
        evidence TEXT,
        run_id INTEGER REFERENCES ai_runs(id) ON DELETE SET NULL,
        schema_version TEXT NOT NULL,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_attributes_current
        ON ai_attributes(conversation_id, attribute, superseded_at);
      CREATE INDEX IF NOT EXISTS idx_ai_attributes_value
        ON ai_attributes(attribute, value, superseded_at);
      CREATE INDEX IF NOT EXISTS idx_ai_attributes_run ON ai_attributes(run_id);

      CREATE TABLE IF NOT EXISTS copilot_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_copilot_sessions_conversation
        ON copilot_sessions(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_copilot_sessions_updated
        ON copilot_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS copilot_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES copilot_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations TEXT,
        tool_name TEXT,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_copilot_messages_session
        ON copilot_messages(session_id, created_at);
    `);
  }
};
