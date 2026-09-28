import type { Migration } from '../migrator.js';

/**
 * v1.9.0 -> v2.0.0 (M4: incident workspace, issue impact, Issue Radar
 * enhancement, custom objects, local data connectors, customer event
 * timeline, customer support health, knowledge freshness - plan phases
 * 18-25).
 *
 * 1. Incidents (plan Phase 18): first-class LOCAL master-issue workspace.
 *    Everything is local-only SupportOS data (never synced to Help Scout):
 *    the incident record itself, conversation links, related entities
 *    (known issues / knowledge docs / campaigns / custom objects),
 *    engineering references, releases, notes and an append-only timeline
 *    (incident_events, dedup_key UNIQUE - idempotent by construction).
 *    Affected customers/organizations are DERIVED from linked conversations,
 *    never stored as denormalized copies that can drift.
 *
 * 2. Custom objects (plan Phase 21): user-defined local object types with
 *    typed field definitions. Property VALUES live in a JSON column
 *    validated by a Zod schema built from the field definitions at every
 *    write - user input never becomes SQL. Relationships are edge rows
 *    (custom_object_links) to customers/orgs/conversations/issues/
 *    incidents/campaigns. Full-text search via fts_custom_objects.
 *
 * 3. Connectors (plan Phase 22): approved local data sources (local JSON,
 *    CSV, SQLite file, HTTP endpoint). Config + auth are JSON columns; the
 *    HTTP kind is guarded by the SSRF rules in src/server/security/ssrfGuard
 *    (approved plan adjustment #4: private networks, localhost and cloud
 *    metadata endpoints are refused). Refreshed rows land in connector_rows
 *    with stable row keys (idempotent re-sync). allowed_ai is OFF by
 *    default: the AI sees connector data ONLY where explicitly allowed
 *    (plan Phase 22: "The AI must only access explicitly allowed connector
 *    data").
 *
 * 4. Customer event timeline (plan Phase 23): customer_events is an
 *    append-only local event log per customer with a CLOSED kind union and
 *    stable dedup keys. The migration backfills observable history
 *    (signup, conversation created/closed, first customer message,
 *    campaign sent/replied, ratings) - all idempotent INSERT OR IGNORE, so
 *    re-running or upgrading twice can never duplicate. Kinds with no
 *    observable source yet (subscription/account/product/integration
 *    events) simply stay absent until a connector or custom object
 *    produces them - absence is the honest state.
 *
 * 5. Knowledge freshness (plan Phase 25): last_reviewed_at /
 *    last_verified_at columns (PRAGMA-guarded ALTERs, the v1.7.0 pattern)
 *    + knowledge_doc_usage counters bumped by local knowledge searches.
 *    Review/verify are human-only actions; nothing auto-publishes.
 *
 * Indexes follow plan Phase 40 (event time, customer, conversation,
 * incidents, custom objects). Safe to re-run: everything CREATE IF NOT
 * EXISTS / INSERT OR IGNORE.
 */
export const migration014: Migration = {
  id: 14,
  name: 'm4_intelligence_workspace',
  up: (db) => {
    db.exec(`
      -- ------------------------------------------------------------------
      -- Phase 18: incidents / master-issue workspace
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'investigating'
          CHECK (status IN ('investigating','identified','fix_in_progress','monitoring','resolved')),
        severity TEXT NOT NULL DEFAULT 'sev3'
          CHECK (severity IN ('sev1','sev2','sev3','sev4')),
        owner_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product TEXT,
        feature TEXT,
        description TEXT,
        internal_explanation TEXT,
        customer_safe_explanation TEXT,
        known_cause TEXT,
        workaround TEXT,
        resolution TEXT,
        started_at TEXT,
        resolved_at TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        provenance TEXT NOT NULL DEFAULT 'human_local',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, severity);
      CREATE INDEX IF NOT EXISTS idx_incidents_updated ON incidents(updated_at DESC);

      CREATE TABLE IF NOT EXISTS incident_conversations (
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        linked_by TEXT NOT NULL DEFAULT 'human',
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (incident_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incident_conversations_conversation
        ON incident_conversations(conversation_id);

      CREATE TABLE IF NOT EXISTS incident_related (
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL
          CHECK (target_kind IN ('known_issue','knowledge_doc','campaign','custom_object')),
        target_local_id INTEGER NOT NULL,
        note TEXT,
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (incident_id, target_kind, target_local_id)
      );

      CREATE TABLE IF NOT EXISTS incident_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        system TEXT NOT NULL,
        reference TEXT NOT NULL,
        url TEXT,
        title TEXT,
        status TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_incident_refs_incident ON incident_refs(incident_id);

      CREATE TABLE IF NOT EXISTS incident_releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        version_label TEXT NOT NULL,
        notes TEXT,
        released_at TEXT,
        correlation TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_incident_releases_incident ON incident_releases(incident_id);

      CREATE TABLE IF NOT EXISTS incident_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        author_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_incident_notes_incident ON incident_notes(incident_id, created_at);

      CREATE TABLE IF NOT EXISTS incident_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        detail TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        dedup_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id, occurred_at);

      -- ------------------------------------------------------------------
      -- Phase 21: custom objects
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS custom_object_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'human_local'
      );

      CREATE TABLE IF NOT EXISTS custom_object_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id INTEGER NOT NULL REFERENCES custom_object_types(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        field_type TEXT NOT NULL
          CHECK (field_type IN ('text','long_text','number','date','boolean','select')),
        required INTEGER NOT NULL DEFAULT 0,
        options TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (type_id, key)
      );

      CREATE TABLE IF NOT EXISTS custom_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id INTEGER NOT NULL REFERENCES custom_object_types(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        search_text TEXT NOT NULL DEFAULT '',
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'human_local'
      );
      CREATE INDEX IF NOT EXISTS idx_custom_objects_type ON custom_objects(type_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS custom_object_links (
        object_id INTEGER NOT NULL REFERENCES custom_objects(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL
          CHECK (target_kind IN ('customer','organization','conversation','known_issue','incident','campaign')),
        target_local_id INTEGER NOT NULL,
        note TEXT,
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (object_id, target_kind, target_local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_custom_object_links_target ON custom_object_links(target_kind, target_local_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_custom_objects USING fts5(
        title,
        search_text,
        object_id UNINDEXED
      );

      -- ------------------------------------------------------------------
      -- Phase 22: local data connectors
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS connectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL
          CHECK (kind IN ('local_json','csv','sqlite','http')),
        config TEXT NOT NULL DEFAULT '{}',
        auth TEXT NOT NULL DEFAULT '{"mode":"none"}',
        refresh_method TEXT NOT NULL DEFAULT 'manual'
          CHECK (refresh_method IN ('manual','interval')),
        refresh_seconds INTEGER NOT NULL DEFAULT 3600,
        allowed_ai INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        schema_json TEXT,
        last_sync_at TEXT,
        last_sync_status TEXT,
        last_sync_error TEXT,
        last_sync_rows INTEGER,
        health TEXT NOT NULL DEFAULT 'never'
          CHECK (health IN ('never','ok','error')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'human_local'
      );

      CREATE TABLE IF NOT EXISTS connector_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id INTEGER NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        row_key TEXT NOT NULL,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (connector_id, row_key)
      );
      CREATE INDEX IF NOT EXISTS idx_connector_rows_connector ON connector_rows(connector_id);

      -- ------------------------------------------------------------------
      -- Phase 23: customer event timeline
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS customer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_local_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        event_kind TEXT NOT NULL
          CHECK (event_kind IN (
            'signup','support_conversation','customer_message','campaign','campaign_reply',
            'rating','incident_exposure','custom_object_event',
            'subscription_event','account_event','product_event','integration_event'
          )),
        occurred_at TEXT,
        title TEXT NOT NULL,
        detail TEXT,
        source TEXT NOT NULL DEFAULT 'local_derived',
        source_ref TEXT,
        dedup_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_customer_events_customer
        ON customer_events(customer_local_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_customer_events_kind ON customer_events(event_kind);

      -- ------------------------------------------------------------------
      -- Phase 25: knowledge freshness usage counters
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS knowledge_doc_usage (
        document_id INTEGER PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        search_hits INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT
      );
    `);

    // Phase 25: freshness columns (PRAGMA-guarded ALTER, the v1.7.0 pattern).
    const docCols = (db.prepare("PRAGMA table_info('knowledge_documents')").all() as { name: string }[]).map((c) => c.name);
    for (const [name, ddl] of [
      ['last_reviewed_at', "ALTER TABLE knowledge_documents ADD COLUMN last_reviewed_at TEXT"],
      ['last_verified_at', "ALTER TABLE knowledge_documents ADD COLUMN last_verified_at TEXT"]
    ] as const) {
      if (!docCols.includes(name)) db.exec(ddl);
    }

    // ------------------------------------------------------------------
    // Phase 23 backfill: derive observable customer history. All
    // INSERT OR IGNORE with stable dedup keys - idempotent, and honest:
    // kinds without an observable source stay absent (nothing fabricated).
    // ------------------------------------------------------------------
    // Customer signup (from the Help Scout mirror's remote_created_at).
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.id, 'signup', c.remote_created_at, 'Customer created in Help Scout',
             json_object('remote_id', c.remote_id), 'hs_sync', 'customers:' || c.remote_id,
             'signup:' || c.id
      FROM customers c
      WHERE c.remote_created_at IS NOT NULL AND c.deleted_at IS NULL
    `);

    // Conversation created + closed per customer.
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.customer_local_id, 'support_conversation', c.remote_created_at,
             'Support conversation #' || c.number || ' started',
             json_object('conversation_id', c.id, 'number', c.number, 'subject', c.subject, 'status', c.status),
             'hs_sync', 'conversations:' || c.remote_id,
             'conv_created:' || c.id
      FROM conversations c
      WHERE c.customer_local_id IS NOT NULL AND c.remote_created_at IS NOT NULL AND c.deleted_at IS NULL
    `);
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.customer_local_id, 'support_conversation', c.closed_at,
             'Support conversation #' || c.number || ' closed',
             json_object('conversation_id', c.id, 'number', c.number, 'subject', c.subject, 'status', 'closed'),
             'hs_sync', 'conversations:' || c.remote_id,
             'conv_closed:' || c.id
      FROM conversations c
      WHERE c.customer_local_id IS NOT NULL AND c.closed_at IS NOT NULL AND c.deleted_at IS NULL
    `);

    // First customer message of every conversation (subsequent replies are
    // visible in the conversation detail - the timeline stays signal-dense
    // without duplicating the thread log).
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.customer_local_id, 'customer_message', t.remote_created_at,
             'Customer wrote in: ' || substr(COALESCE(c.subject, ''), 1, 80),
             json_object('conversation_id', c.id, 'number', c.number, 'subject', c.subject,
                         'excerpt', substr(COALESCE(t.body_text, ''), 1, 300)),
             'hs_sync', 'threads:' || t.remote_id,
             'conv_first_message:' || c.id
      FROM conversations c
      JOIN threads t ON t.conversation_id = c.id AND t.type = 'customer'
        AND t.deleted_at IS NULL AND t.state = 'published'
        AND t.remote_created_at = (
          SELECT MIN(t2.remote_created_at) FROM threads t2
          WHERE t2.conversation_id = c.id AND t2.type = 'customer'
            AND t2.deleted_at IS NULL AND t2.state = 'published'
        )
      WHERE c.customer_local_id IS NOT NULL AND c.deleted_at IS NULL
    `);

    // Campaign sent + replied (from the outreach mirror).
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign', r.sent_at,
             'Outreach campaign sent: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name, 'conversation_number', r.hs_conversation_number),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_sent:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r
      JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.sent_at IS NOT NULL
    `);
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign_reply', r.replied_at,
             'Customer replied to outreach: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_replied:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r
      JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.replied_at IS NOT NULL
    `);

    // Ratings (observable support outcomes).
    db.exec(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'rating', r.remote_created_at,
             'Customer rated the support ' || r.rating,
             json_object('rating', r.rating, 'comments', r.comments, 'conversation_id', r.conversation_id),
             'hs_sync', 'ratings:' || r.remote_id,
             'rating:' || r.id
      FROM ratings r
      WHERE r.customer_local_id IS NOT NULL AND r.remote_created_at IS NOT NULL
    `);
  }
};
