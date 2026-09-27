import type { Migration } from '../migrator.js';

/**
 * v1.3.0 -> v1.4.0 (semantic docs search + SLA/business hours + webhook push):
 *
 * 1. docs_chunks: chunked Docs-mirror articles with local embedding storage,
 *    mirroring the knowledge_chunks pattern (embedding BLOB + state machine +
 *    model tracking) so semantic search works with OR without Qdrant.
 *
 * 2. mailbox_business_hours: per-mailbox schedule (IANA timezone, active
 *    weekdays, start/end minute-of-day) plus optional SLA targets. Reports
 *    compute business-minutes response times against this configuration;
 *    absent configuration falls back to wall-clock minutes (honest default).
 *
 * Safe to re-run: all statements are IF NOT EXISTS.
 */
export const migration008: Migration = {
  id: 8,
  name: 'semantic_docs_sla',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        embedding_state TEXT NOT NULL DEFAULT 'not_indexed',
        chunk_version INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(article_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_docs_chunks_article ON docs_chunks(article_id);
      CREATE INDEX IF NOT EXISTS idx_docs_chunks_state ON docs_chunks(embedding_state);

      CREATE TABLE IF NOT EXISTS mailbox_business_hours (
        mailbox_local_id INTEGER PRIMARY KEY,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
        start_minute INTEGER NOT NULL DEFAULT 540,
        end_minute INTEGER NOT NULL DEFAULT 1020,
        first_response_target_min INTEGER,
        resolution_target_min INTEGER,
        updated_at TEXT NOT NULL
      );
    `);
  }
};
