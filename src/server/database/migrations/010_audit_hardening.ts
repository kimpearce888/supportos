import type { Migration } from '../migrator.js';

/**
 * v1.5.0 -> v1.6.0 (second neutral audit hardening).
 *
 * 1. docs_articles.content_hash: SHA-256 of the chunked text (title + body).
 *    Until v1.6.0 every incremental sync re-chunked EVERY article even when
 *    its text had not changed, destroying all stored embeddings (DELETE +
 *    re-insert at 'not_indexed'). With the hash, upsertArticle only re-chunks
 *    when content actually changes - the corpus re-embeds once, not every
 *    5-minute sync tick (found by the v1.6.0 neutral audit).
 *
 * Safe to re-run: column adds check first; backfill is idempotent.
 */
export const migration010: Migration = {
  id: 10,
  name: 'audit_v16_hardening',
  up: (db) => {
    const cols = (db.prepare("PRAGMA table_info('docs_articles')").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('content_hash')) {
      db.exec('ALTER TABLE docs_articles ADD COLUMN content_hash TEXT');
    }
    // v1.6.0 audit fix: failed embedding chunks retried forever on every
    // embedding job with no cap. Attempt counters cap retries at 5; chunks
    // beyond that stay 'failed' and are skipped until content changes.
    const docCols = (db.prepare("PRAGMA table_info('docs_chunks')").all() as { name: string }[]).map((c) => c.name);
    if (!docCols.includes('embedding_attempts')) {
      db.exec('ALTER TABLE docs_chunks ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0');
    }
    const convCols = (db.prepare("PRAGMA table_info('conversation_chunks')").all() as { name: string }[]).map((c) => c.name);
    if (!convCols.includes('embedding_attempts')) {
      db.exec('ALTER TABLE conversation_chunks ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0');
    }
  }
};
