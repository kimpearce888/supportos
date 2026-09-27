import type { Migration } from '../migrator.js';

/**
 * v1.4.0 -> v1.5.0 (Client Segmentation & Outreach, ticket vector search,
 * SLA alerts, encrypted multi-device sync):
 *
 * 1. Segmentation + outreach tables: segments (structured condition trees,
 *    never raw SQL), outreach_campaigns / recipients / attempts / events
 *    (full audit lineage: campaign -> segment -> condition -> matching
 *    conversation -> customer -> created Help Scout conversation), and a
 *    do_not_contact list that every campaign respects.
 *
 * 2. conversation_chunks: chunked ticket/thread text with local embedding
 *    storage, mirroring the docs_chunks pattern (v1.4.0) so semantic ticket
 *    search works with OR without Qdrant.
 *
 * 3. customers gains background/age/gender/location columns: Help Scout
 *    exposes them on the customer resource; storing them makes contact-first
 *    segmentation honest (the data exists locally, not just in raw_json).
 *
 * 4. encrypted_sync_log: ledger of exported/imported .sosync bundles.
 *
 * 5. Join-friendly indexes for the segment engine (customer -> conversations
 *    -> tags is the hot path; spec #46 of the segmentation spec).
 *
 * Safe to re-run: table DDL is IF NOT EXISTS; column adds check first.
 */
export const migration009: Migration = {
  id: 9,
  name: 'outreach_semantic_sync',
  up: (db) => {
    // --- contact-first fields on customers (idempotent column adds) ---
    const customerCols = (db.prepare('PRAGMA table_info(customers)').all() as { name: string }[]).map((c) => c.name);
    for (const [col, ddl] of [
      ['background', "ALTER TABLE customers ADD COLUMN background TEXT"],
      ['age', "ALTER TABLE customers ADD COLUMN age TEXT"],
      ['gender', "ALTER TABLE customers ADD COLUMN gender TEXT"],
      ['location', "ALTER TABLE customers ADD COLUMN location TEXT"]
    ] as const) {
      if (!customerCols.includes(col)) db.exec(ddl);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        condition_tree TEXT NOT NULL DEFAULT '{"combinator":"all","conditions":[],"exclude":[]}',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outreach_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        mailbox_local_id INTEGER REFERENCES mailboxes(id),
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        segment_id INTEGER REFERENCES segments(id),
        segment_snapshot TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        queued_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outreach_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
        customer_local_id INTEGER NOT NULL REFERENCES customers(id),
        customer_remote_id INTEGER,
        email TEXT,
        snapshot TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'selected',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        hs_conversation_remote_id INTEGER,
        hs_conversation_number INTEGER,
        sent_at TEXT,
        replied_at TEXT,
        UNIQUE (campaign_id, customer_local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outreach_recipients_campaign ON outreach_recipients(campaign_id, state);

      CREATE TABLE IF NOT EXISTS outreach_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_id INTEGER NOT NULL REFERENCES outreach_recipients(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        result TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS outreach_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        recipient_id INTEGER,
        event TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_outreach_events_campaign ON outreach_events(campaign_id);

      CREATE TABLE IF NOT EXISTS do_not_contact (
        customer_local_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversation_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        embedding_state TEXT NOT NULL DEFAULT 'not_indexed',
        chunk_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_chunks_conv ON conversation_chunks(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_chunks_state ON conversation_chunks(embedding_state);

      CREATE TABLE IF NOT EXISTS encrypted_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        conversations INTEGER,
        customers INTEGER,
        sha256 TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_customer_status ON conversations(customer_local_id, status);
      CREATE INDEX IF NOT EXISTS idx_customer_properties_def ON customer_properties(definition_id);
    `);
  }
};
