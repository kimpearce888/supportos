import type { Migration } from '../migrator.js';

/**
 * v1.7.0 -> v1.8.0 (M2: Operations Center, workload/capacity,
 * Notification Center, mentions, side collaboration threads).
 *
 * 1. notifications: persistent LOCAL notification center. Rows are produced
 *    exclusively by the notification sweep (single funnel) with dedup keys,
 *    so re-syncs and sweep re-runs can never duplicate. Targeting: a specific
 *    local user (assignee/mention) or NULL = broadcast. Retention-pruned
 *    together with other local operational data; never sent to Help Scout.
 *
 * 2. notification_prefs: per-type on/off switches. Missing row = type default
 *    (all on). Preferences are per-installation: SupportOS is a local
 *    single-operator tool - "me" is the connected Help Scout user
 *    (me_remote_id), falling back to the first synced user like the
 *    my-tickets view already does.
 *
 * 3. side_threads + participants + messages: the internal-only collaboration
 *    layer (plan Phase 14). Never customer-visible, never written to Help
 *    Scout, never merged into the thread mirror. Bodies are plain text.
 *
 * 4. side_thread_mentions: resolved @mentions per message (user or team),
 *    the backing store for the "mentions for me" queue and for highlight
 *    rendering. Mentions in internal notes are parsed from the thread mirror
 *    at sweep time instead (threads already exist) - no extra table needed.
 *
 * No backfill: notifications begin from the moment v1.8.0 first runs (the
 * sweep cursor initializes to "now"), which is the honest behavior - history
 * did not notify anyone. Capacity model + thresholds live in
 * application_settings (key/value), not new tables.
 *
 * Safe to re-run: everything is CREATE TABLE IF NOT EXISTS.
 */
export const migration012: Migration = {
  id: 12,
  name: 'm2_collaboration',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT,
        target_user_local_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        actor_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        conversation_number INTEGER,
        customer_local_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        issue_id INTEGER,
        campaign_id INTEGER,
        job_id INTEGER,
        side_thread_id INTEGER,
        dedup_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        read_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_notifications_target_unread ON notifications(target_user_local_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_conversation ON notifications(conversation_id);

      CREATE TABLE IF NOT EXISTS notification_prefs (
        notification_type TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS side_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        team_local_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_by_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_side_threads_conversation ON side_threads(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_side_threads_status ON side_threads(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS side_thread_participants (
        side_thread_id INTEGER NOT NULL REFERENCES side_threads(id) ON DELETE CASCADE,
        user_local_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (side_thread_id, user_local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_side_thread_participants_user ON side_thread_participants(user_local_id);

      CREATE TABLE IF NOT EXISTS side_thread_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        side_thread_id INTEGER NOT NULL REFERENCES side_threads(id) ON DELETE CASCADE,
        author_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_side_thread_messages_thread ON side_thread_messages(side_thread_id, created_at);

      CREATE TABLE IF NOT EXISTS side_thread_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        side_thread_id INTEGER NOT NULL REFERENCES side_threads(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES side_thread_messages(id) ON DELETE CASCADE,
        user_local_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        team_local_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_side_thread_mentions_user ON side_thread_mentions(user_local_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_side_thread_mentions_team ON side_thread_mentions(team_local_id);
    `);
  }
};
