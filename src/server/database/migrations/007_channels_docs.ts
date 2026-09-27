import type { Migration } from '../migrator.js';

/**
 * v1.2.0 -> v1.3.0 (channels + docs + realtime groundwork):
 *
 * 1. Conversations gain channel attribution columns: `source_type` and
 *    `source_via` (from the v3 `source` object). Beacon chat sessions arrive
 *    as type='chat' + source {type:'chat', via:'beacon'}; email arrives as
 *    type='email'. The `type` column already existed since 001; we only add
 *    an index so the Inbox channel filter stays O(index).
 *
 * 2. Docs API mirror: docs_collections, docs_categories, docs_articles and
 *    a docs_fts index. Help Scout Docs (docsapi.helpscout.net) are now part
 *    of the local mirror, searchable offline.
 *
 * Safe to re-run: all statements are IF NOT EXISTS / additive ALTERs guarded
 * by a column existence check (SQLite has no IF NOT EXISTS for ADD COLUMN).
 */
export const migration007: Migration = {
  id: 7,
  name: 'channels_docs_mirror',
  up: (db) => {
    const cols = (db.prepare(`PRAGMA table_info(conversations)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('source_type')) db.exec('ALTER TABLE conversations ADD COLUMN source_type TEXT');
    if (!cols.includes('source_via')) db.exec('ALTER TABLE conversations ADD COLUMN source_via TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);
      CREATE INDEX IF NOT EXISTS idx_conversations_source_via ON conversations(source_via);

      CREATE TABLE IF NOT EXISTS docs_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        slug TEXT,
        description TEXT,
        visibility TEXT,
        article_count INTEGER,
        last_synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS docs_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER NOT NULL UNIQUE,
        collection_local_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        sort_order INTEGER,
        last_synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_categories_collection ON docs_categories(collection_local_id);

      CREATE TABLE IF NOT EXISTS docs_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER NOT NULL UNIQUE,
        collection_local_id INTEGER NOT NULL,
        category_local_id INTEGER,
        number INTEGER,
        slug TEXT,
        name TEXT NOT NULL,
        status TEXT,
        preview TEXT,
        text TEXT,
        views INTEGER,
        words INTEGER,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        last_synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_articles_collection ON docs_articles(collection_local_id);
      CREATE INDEX IF NOT EXISTS idx_docs_articles_status ON docs_articles(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        name, text,
        article_id UNINDEXED
      );
    `);
  }
};
