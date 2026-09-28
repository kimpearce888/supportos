import type { Migration } from '../migrator.js';

/**
 * v2.1.0 -> v2.2.0 (M6: support graph, agent coaching, customer support
 * memory, performance polish - plan phases 34, 35, 36 + 41).
 *
 * 1. Products registry (plan Phase 34): a product is any non-empty product
 *    string already stored on incidents, known issues, issue clusters or
 *    support cases. The registry is INSERT-OR-IGNORE derived data - it never
 *    overwrites, never deletes, and a rebuild only ever ADDS names. The
 *    `pinned` flag protects a human-curated entry from registry hygiene.
 *
 * 2. Support graph edges (plan Phase 34): ONLY human-asserted edges are
 *    persisted (a human judgment is information the database does not already
 *    contain). All derived relationships stay derived at read time from the
 *    existing mirror/link tables - zero drift by construction. Node kinds form
 *    a CLOSED 12-kind union; endpoints are validated against real rows.
 *
 * 3. Coaching reviews (plan Phase 35): the LAST review per conversation is
 *    upserted on demand (draft sha256 + deterministic JSON + optional AI
 *    JSON). Coaching is advisory-only; nothing here gates the send path.
 *
 * 4. Customer memory (plan Phase 36): the existing customer_memories table
 *    gains a closed `kind` column for human-written entries (default 'fact'
 *    keeps every pre-existing row valid). Composed memory sections stay
 *    read-time derivations - no copied fact tables.
 *
 * 5. Performance (plan Phase 41): targeted indexes for the hot per-customer
 *    paths (observation ordering, outreach recipient lookups, issue/cluster
 *    reverse links, customer-ordered conversation history).
 */
export const migration016: Migration = {
  id: 16,
  name: 'm6_graph_coaching_memory',
  up: (db) => {
    // --- idempotent column add (same PRAGMA guard pattern as migration 009) ---
    const memoryCols = (db.prepare('PRAGMA table_info(customer_memories)').all() as { name: string }[]).map((c) => c.name);
    if (!memoryCols.includes('kind')) {
      db.exec("ALTER TABLE customer_memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'");
    }

    db.exec(`
      -- ------------------------------------------------------------------
      -- Phase 34: products registry (derived, INSERT-OR-IGNORE only)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'derived'
          CHECK (source IN ('derived','human')),
        first_seen_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'deterministic_local'
      );
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);

      -- ------------------------------------------------------------------
      -- Phase 34: human-asserted graph edges (closed 12-kind union)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS support_graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_kind TEXT NOT NULL
          CHECK (source_kind IN (
            'customer','organization','conversation','known_issue','issue_cluster',
            'incident','knowledge_document','agent','campaign','product',
            'custom_object','connector_data'
          )),
        source_local_id INTEGER NOT NULL,
        target_kind TEXT NOT NULL
          CHECK (target_kind IN (
            'customer','organization','conversation','known_issue','issue_cluster',
            'incident','knowledge_document','agent','campaign','product',
            'custom_object','connector_data'
          )),
        target_local_id INTEGER NOT NULL,
        relation TEXT NOT NULL
          CHECK (relation IN ('related_to','depends_on','blocks','mentions','duplicate_of')),
        note TEXT,
        created_by_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'human_local',
        UNIQUE (source_kind, source_local_id, target_kind, target_local_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_support_graph_edges_source
        ON support_graph_edges(source_kind, source_local_id);
      CREATE INDEX IF NOT EXISTS idx_support_graph_edges_target
        ON support_graph_edges(target_kind, target_local_id);

      -- ------------------------------------------------------------------
      -- Phase 35: last coaching review per conversation (on-demand upsert)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS coaching_reviews (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        draft_sha256 TEXT NOT NULL,
        draft_excerpt TEXT NOT NULL,
        deterministic TEXT NOT NULL DEFAULT '{}',
        ai TEXT,
        ai_run_id INTEGER,
        draft_chars INTEGER NOT NULL DEFAULT 0,
        draft_words INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'deterministic_local'
      );

      -- ------------------------------------------------------------------
      -- Phase 41: performance indexes for hot paths
      -- ------------------------------------------------------------------
      CREATE INDEX IF NOT EXISTS idx_conversations_customer_created
        ON conversations(customer_local_id, remote_created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_client_observations_customer_observed
        ON client_behavior_observations(customer_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outreach_recipients_customer
        ON outreach_recipients(customer_local_id);
      CREATE INDEX IF NOT EXISTS idx_known_issue_conversations_conversation
        ON known_issue_conversations(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_issue_cluster_conversations_conversation
        ON issue_cluster_conversations(conversation_id);
    `);

    // ------------------------------------------------------------------
    // Phase 34: deterministic products backfill (INSERT OR IGNORE, idempotent;
    // a rebuild can only ever ADD names, never overwrite or remove).
    // ------------------------------------------------------------------
    db.exec(`
      INSERT OR IGNORE INTO products (name, source, first_seen_at, last_seen_at, provenance)
      SELECT DISTINCT TRIM(p.product), 'derived', datetime('now'), datetime('now'), 'deterministic_local'
        FROM (
          SELECT product FROM incidents WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM known_issues WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM issue_clusters WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM support_cases WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
        ) AS p
      WHERE TRIM(p.product) != '';
    `);
  }
};
