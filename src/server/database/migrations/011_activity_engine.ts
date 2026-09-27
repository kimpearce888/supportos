import type { Migration } from '../migrator.js';

/**
 * v1.6.0 -> v1.7.0 (conversation activity engine).
 *
 * 1. conversation_events: normalized local event history for Help Scout
 *    conversation activity. Events are derived from three honest sources:
 *    - threads (messages/notes/lineitem action records) - EXACT timestamps
 *    - sync observation diffs (status/assignee/tags/fields changed between two
 *      observations - occurred_at is the observation time, honestly labeled)
 *    - local writes through ConversationOperations (we caused them, exact time)
 *    Dedup keys make re-sync idempotent: INSERT OR IGNORE everywhere.
 *
 * 2. Derived activity columns on conversations (indexed) so date/activity
 *    filtering is an index range scan. Backfilled from threads in SQL.
 *    activity_history_complete flags conversations whose full thread history
 *    is NOT locally known (pre-sync, no threads) - their message-derived
 *    fields may be underestimates, never presented as exact.
 *
 * 3. supportos_priority: local-only ticket priority (never Help Scout data;
 *    optional custom-field mapping is a runtime setting, default off).
 *
 * 4. ticket_states + ticket_state_transitions: the SupportOS custom state
 *    layer. Distinct from Help Scout status; six built-in states seeded.
 *
 * 5. inbox_views: saved Inbox Views as structured condition trees (JSON),
 *    never SQL. Evaluated dynamically at open time.
 *
 * Safe to re-run: column adds check first; backfills are idempotent
 * (INSERT OR IGNORE + pure UPDATE recompute).
 */
export const migration011: Migration = {
  id: 11,
  name: 'conversation_activity_engine',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        thread_local_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT,
        actor_local_id INTEGER,
        occurred_at TEXT,
        source TEXT NOT NULL DEFAULT 'sync',
        metadata TEXT,
        dedup_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_dedup ON conversation_events(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_conv ON conversation_events(conversation_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_type_time ON conversation_events(event_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_time ON conversation_events(occurred_at DESC);

      CREATE TABLE IF NOT EXISTS ticket_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_resolved INTEGER NOT NULL DEFAULT 0,
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ticket_state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        previous_state_id INTEGER REFERENCES ticket_states(id),
        new_state_id INTEGER REFERENCES ticket_states(id),
        actor_type TEXT NOT NULL DEFAULT 'user',
        actor_local_id INTEGER,
        reason TEXT,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_state_transitions_conv ON ticket_state_transitions(conversation_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_state_transitions_new ON ticket_state_transitions(new_state_id, occurred_at);

      CREATE TABLE IF NOT EXISTS inbox_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        definition TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        folder TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO ticket_states (key, name, color, sort_order, is_resolved, built_in) VALUES
        ('new', 'New', '#3b82f6', 10, 0, 1),
        ('investigating', 'Investigating', '#f59e0b', 20, 0, 1),
        ('waiting-customer', 'Waiting on Customer', '#8b5cf6', 30, 0, 1),
        ('waiting-engineering', 'Waiting on Engineering', '#ef4444', 40, 0, 1),
        ('ready-verify', 'Ready to Verify', '#06b6d4', 50, 0, 1),
        ('resolved', 'Resolved', '#22c55e', 60, 1, 1);
    `);

    // ---- conversations column adds (checked, forward-only) ----
    const convCols = (db.prepare("PRAGMA table_info('conversations')").all() as { name: string }[]).map((c) => c.name);
    const addColumn = (name: string, ddl: string): void => {
      if (!convCols.includes(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${ddl}`);
    };
    addColumn('first_customer_message_at', 'first_customer_message_at TEXT');
    addColumn('first_response_at', 'first_response_at TEXT');
    addColumn('last_customer_reply_at', 'last_customer_reply_at TEXT');
    addColumn('last_human_agent_response_at', 'last_human_agent_response_at TEXT');
    addColumn('last_system_response_at', 'last_system_response_at TEXT');
    addColumn('last_note_at', 'last_note_at TEXT');
    addColumn('customer_waiting_since', 'customer_waiting_since TEXT');
    addColumn('last_status_change_at', 'last_status_change_at TEXT');
    addColumn('last_assignment_change_at', 'last_assignment_change_at TEXT');
    addColumn('last_tag_change_at', 'last_tag_change_at TEXT');
    addColumn('last_custom_field_change_at', 'last_custom_field_change_at TEXT');
    addColumn('activity_history_complete', 'activity_history_complete INTEGER NOT NULL DEFAULT 0');
    addColumn('supportos_priority', "supportos_priority TEXT NOT NULL DEFAULT 'none'");
    addColumn('supportos_state_id', 'supportos_state_id INTEGER REFERENCES ticket_states(id)');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_first_response ON conversations(first_response_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_waiting_since ON conversations(customer_waiting_since);
      CREATE INDEX IF NOT EXISTS idx_conversations_last_customer ON conversations(last_customer_reply_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(supportos_priority);
      CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(supportos_state_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status_change ON conversations(last_status_change_at);
    `);

    // ---- Backfill: rebuild events from the thread mirror ----
    // Thread-derived events carry exact occurred_at (thread remote_created_at).
    // Lineitem threads (action records) map conservatively; raw action text is
    // preserved in metadata so nothing is lost by an imperfect mapping.
    db.exec(`
      INSERT OR IGNORE INTO conversation_events (conversation_id, thread_local_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
      SELECT t.conversation_id, t.id,
        CASE
          WHEN t.type = 'note' THEN 'internal_note'
          WHEN t.type = 'lineitem' AND t.action_text LIKE '%status%' THEN 'status_changed'
          WHEN t.type = 'lineitem' AND (t.action_text LIKE '%assign%' OR t.action_text LIKE '%assigned%') THEN 'assignment_changed'
          WHEN t.type = 'lineitem' AND t.action_text LIKE '%moved%' THEN 'moved'
          WHEN t.type = 'lineitem' AND t.action_text LIKE '%tag%' THEN 'tag_added'
          WHEN t.type = 'lineitem' THEN 'lineitem_action'
          WHEN t.from_type = 'customer' THEN 'customer_message'
          WHEN t.from_type = 'system_user' THEN 'system_agent_message'
          WHEN t.from_type = 'user' THEN 'human_agent_message'
          ELSE 'customer_message'
        END,
        CASE
          WHEN t.from_type = 'customer' THEN 'customer'
          WHEN t.from_type = 'user' THEN 'user'
          WHEN t.from_type = 'system_user' THEN 'system_user'
          WHEN t.type = 'lineitem' THEN 'system_user'
          ELSE 'unknown'
        END,
        CASE
          WHEN t.from_type = 'user' THEN t.created_by_user_id
          WHEN t.from_type = 'customer' THEN t.created_by_customer_id
          WHEN t.from_type = 'system_user' THEN t.created_by_system_user_id
          ELSE NULL
        END,
        t.remote_created_at,
        'rebuild',
        json_object('thread_remote_id', t.remote_id, 'thread_type', t.type, 'action_type', t.action_type, 'action_text', t.action_text, 'derived', 'thread_mirror'),
        'thread:' || t.remote_id
      FROM threads t
      WHERE t.deleted_at IS NULL AND t.remote_id IS NOT NULL AND t.state = 'published'
        AND t.type IN ('customer', 'reply', 'note', 'lineitem');

      INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
      SELECT c.id, 'conversation_created', 'customer', c.customer_local_id, c.remote_created_at, 'rebuild',
        json_object('number', c.number, 'mailbox_local_id', c.mailbox_local_id, 'derived', 'conversation_row'),
        'conversation_created:' || c.remote_id
      FROM conversations c
      WHERE c.remote_created_at IS NOT NULL AND c.deleted_at IS NULL;

      INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
      SELECT c.id, 'closed', 'unknown', c.closed_by, c.closed_at, 'rebuild',
        json_object('number', c.number, 'derived', 'conversation_row'),
        'closed:' || c.remote_id || ':' || COALESCE(c.closed_at, '')
      FROM conversations c
      WHERE c.closed_at IS NOT NULL AND c.status = 'closed' AND c.deleted_at IS NULL;

      INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, occurred_at, source, metadata, dedup_key)
      SELECT a.conversation_id, 'attachment_added', 'unknown', a.downloaded_at, 'rebuild',
        json_object('filename', a.filename, 'mime_type', a.mime_type, 'size', a.size, 'derived', 'attachment_row'),
        'attachment:' || a.remote_id
      FROM attachments a
      WHERE a.remote_id IS NOT NULL AND a.conversation_id IS NOT NULL;
    `);

    // ---- Backfill: derived activity columns from the thread mirror ----
    db.exec(`
      UPDATE conversations SET
        first_customer_message_at = (SELECT MIN(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND type = 'customer' AND deleted_at IS NULL AND state = 'published'),
        first_response_at = (SELECT MIN(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND type = 'reply' AND from_type = 'user' AND deleted_at IS NULL AND state = 'published'),
        last_customer_reply_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND type = 'customer' AND deleted_at IS NULL AND state = 'published'),
        last_human_agent_response_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND type = 'reply' AND from_type = 'user' AND deleted_at IS NULL AND state = 'published'),
        last_system_response_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND from_type = 'system_user' AND deleted_at IS NULL AND state = 'published'),
        last_note_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = conversations.id AND type = 'note' AND deleted_at IS NULL AND state = 'published'),
        activity_history_complete = CASE
          WHEN EXISTS (SELECT 1 FROM threads WHERE conversation_id = conversations.id AND deleted_at IS NULL)
            OR (remote_created_at IS NOT NULL AND local_created_at <= remote_created_at)
          THEN 1 ELSE 0 END;

      UPDATE conversations SET customer_waiting_since = CASE
        WHEN status = 'active'
          AND last_customer_reply_at IS NOT NULL
          AND (last_human_agent_response_at IS NULL OR last_customer_reply_at > last_human_agent_response_at)
        THEN last_customer_reply_at ELSE NULL END;

      UPDATE conversations SET last_status_change_at = (
        SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = conversations.id AND event_type IN ('status_changed', 'closed', 'reopened'));
      UPDATE conversations SET last_assignment_change_at = (
        SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = conversations.id AND event_type = 'assignment_changed');
      UPDATE conversations SET last_tag_change_at = (
        SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = conversations.id AND event_type IN ('tag_added', 'tag_removed'));
      UPDATE conversations SET last_custom_field_change_at = (
        SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = conversations.id AND event_type = 'custom_field_changed');
    `);
  }
};
