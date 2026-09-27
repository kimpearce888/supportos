import type { DB } from '../connection.js';
import type { ConversationEvent, ConversationEventType, EventSource } from '../../../shared/activity.js';

export interface RecordEventInput {
  conversationId: number;
  threadLocalId?: number | null;
  eventType: ConversationEventType;
  actorType?: 'customer' | 'user' | 'team' | 'system_user' | 'automation' | 'unknown' | null;
  actorLocalId?: number | null;
  occurredAt?: string | null;
  source: EventSource;
  metadata?: Record<string, unknown>;
  /** Stable identity of the underlying fact; INSERT OR IGNORE makes re-syncs idempotent. */
  dedupKey: string;
}

/**
 * ActivityRepository (v1.7.0): normalized conversation event history + the
 * derived-activity recompute that keeps conversations.* activity columns
 * consistent with the thread mirror and the event log.
 *
 * Dedup contract:
 * - thread-derived events: `thread:<remoteId>` (one event per remote thread)
 * - conversation-row-derived events: `<type>:<remoteId>[:<stamp>]`
 * - live change observations: `<type>:<remoteId>:<nowIso()>` (one per action)
 *
 * The recompute is intentionally pure SQL over the threads + events tables -
 * it is the SAME logic migration 011 used for the backfill, so a fresh
 * database and an upgraded one converge on identical values.
 */
export class ActivityRepository {
  constructor(private db: DB) {}

  /** Record one event. Returns true when a NEW row was inserted (false = duplicate). */
  recordEvent(input: RecordEventInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_events
           (conversation_id, thread_local_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.conversationId,
        input.threadLocalId ?? null,
        input.eventType,
        input.actorType ?? null,
        input.actorLocalId ?? null,
        input.occurredAt ?? null,
        input.source,
        JSON.stringify(input.metadata ?? {}),
        input.dedupKey
      );
    return result.changes > 0;
  }

  /**
   * Derive + record the event for a newly-upserted thread. Returns the derived
   * event type (null when the thread yields no event, e.g. drafts).
   */
  recordThreadEvent(conversationLocalId: number, thread: {
    id: number;
    remote_id: number | null;
    type: string | null;
    state: string | null;
    from_type: string | null;
    created_by_user_id: number | null;
    created_by_customer_id: number | null;
    created_by_system_user_id: number | null;
    remote_created_at: string | null;
    action_type: string | null;
    action_text: string | null;
  }): ConversationEventType | null {
    if (!thread.remote_id) return null;
    // Drafts and scheduled replies are not history yet; deleted threads are not events.
    if (thread.state !== 'published') return null;
    const type = thread.type ?? '';
    const fromType = thread.from_type ?? '';

    let eventType: ConversationEventType;
    let actorType: RecordEventInput['actorType'] = 'unknown';
    let actorLocalId: number | null = null;

    if (type === 'note') {
      eventType = 'internal_note';
    } else if (type === 'lineitem') {
      // Help Scout action records. Map conservatively; keep the raw text in metadata.
      const text = (thread.action_text ?? '').toLowerCase();
      eventType = text.includes('status') ? 'status_changed'
        : text.includes('assign') ? 'assignment_changed'
        : text.includes('moved') ? 'moved'
        : text.includes('tag') ? 'tag_added'
        : 'lineitem_action';
      actorType = 'system_user';
    } else if (fromType === 'customer') {
      eventType = 'customer_message';
      actorType = 'customer';
      actorLocalId = thread.created_by_customer_id;
    } else if (fromType === 'system_user') {
      eventType = 'system_agent_message';
      actorType = 'system_user';
      actorLocalId = thread.created_by_system_user_id;
    } else if (fromType === 'user') {
      eventType = 'human_agent_message';
      actorType = 'user';
      actorLocalId = thread.created_by_user_id;
    } else {
      eventType = 'customer_message';
      if (thread.created_by_customer_id) {
        actorType = 'customer';
        actorLocalId = thread.created_by_customer_id;
      }
    }

    this.recordEvent({
      conversationId: conversationLocalId,
      threadLocalId: thread.id,
      eventType,
      actorType,
      actorLocalId,
      occurredAt: thread.remote_created_at,
      source: 'sync',
      metadata: {
        thread_remote_id: thread.remote_id,
        thread_type: thread.type,
        action_type: thread.action_type,
        action_text: thread.action_text
      },
      dedupKey: `thread:${thread.remote_id}`
    });
    return eventType;
  }

  /**
   * Recompute ALL derived activity columns for one conversation from the
   * thread mirror + event log. Cheap (single UPDATE with subqueries) and
   * idempotent; called after every thread/conversation upsert.
   */
  recomputeActivity(conversationLocalId: number): void {
    this.db
      .prepare(
        `UPDATE conversations SET
           first_customer_message_at = (SELECT MIN(remote_created_at) FROM threads WHERE conversation_id = ? AND type = 'customer' AND deleted_at IS NULL AND state = 'published'),
           first_response_at = (SELECT MIN(remote_created_at) FROM threads WHERE conversation_id = ? AND type = 'reply' AND from_type = 'user' AND deleted_at IS NULL AND state = 'published'),
           last_customer_reply_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = ? AND type = 'customer' AND deleted_at IS NULL AND state = 'published'),
           last_human_agent_response_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = ? AND type = 'reply' AND from_type = 'user' AND deleted_at IS NULL AND state = 'published'),
           last_system_response_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = ? AND from_type = 'system_user' AND deleted_at IS NULL AND state = 'published'),
           last_note_at = (SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = ? AND type = 'note' AND deleted_at IS NULL AND state = 'published'),
           activity_history_complete = CASE
             WHEN EXISTS (SELECT 1 FROM threads WHERE conversation_id = ? AND deleted_at IS NULL)
               OR (remote_created_at IS NOT NULL AND local_created_at <= remote_created_at)
             THEN 1 ELSE 0 END
         WHERE id = ?`
      )
      .run(conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId);

    this.db
      .prepare(
        `UPDATE conversations SET customer_waiting_since = CASE
           WHEN status = 'active'
             AND last_customer_reply_at IS NOT NULL
             AND (last_human_agent_response_at IS NULL OR last_customer_reply_at > last_human_agent_response_at)
           THEN last_customer_reply_at ELSE NULL END
         WHERE id = ?`
      )
      .run(conversationLocalId);

    this.db
      .prepare(
        `UPDATE conversations SET
           last_status_change_at = (SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = ? AND event_type IN ('status_changed', 'closed', 'reopened')),
           last_assignment_change_at = (SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = ? AND event_type = 'assignment_changed'),
           last_tag_change_at = (SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = ? AND event_type IN ('tag_added', 'tag_removed')),
           last_custom_field_change_at = (SELECT MAX(occurred_at) FROM conversation_events WHERE conversation_id = ? AND event_type = 'custom_field_changed')
         WHERE id = ?`
      )
      .run(conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId);
  }

  /** Full event timeline for one conversation (chronological, actor names resolved). */
  listEvents(conversationLocalId: number, limit = 500): ConversationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.conversation_id, e.thread_local_id, e.event_type, e.actor_type, e.actor_local_id,
                e.occurred_at, e.source, e.metadata, e.created_at,
                CASE
                  WHEN e.actor_type = 'user' THEN (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) FROM users u WHERE u.id = e.actor_local_id)
                  WHEN e.actor_type = 'customer' THEN (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu WHERE cu.id = e.actor_local_id)
                  WHEN e.actor_type = 'system_user' THEN (SELECT TRIM(COALESCE(su.first_name, '') || ' ' || COALESCE(su.last_name, '')) FROM system_users su WHERE su.id = e.actor_local_id)
                  ELSE NULL
                END AS actor_name
         FROM conversation_events e
         WHERE e.conversation_id = ?
         ORDER BY COALESCE(e.occurred_at, e.created_at) ASC, e.id ASC
         LIMIT ?`
      )
      .all(conversationLocalId, limit) as (Omit<ConversationEvent, 'metadata'> & { metadata: string })[];
    return rows.map((r) => ({ ...r, metadata: safeParse(r.metadata) }));
  }

  /** Count events per type for a conversation (UI summary chips). */
  eventCounts(conversationLocalId: number): Record<string, number> {
    const rows = this.db
      .prepare('SELECT event_type AS t, COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? GROUP BY event_type')
      .all(conversationLocalId) as { t: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.t, r.n]));
  }

  /** v1.7.0 stats for the dashboard/system page. */
  eventStats(): { events: number; conversations_with_events: number; derived_from_threads: number; observed_changes: number; local_writes: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS events,
                COUNT(DISTINCT conversation_id) AS convs,
                SUM(CASE WHEN source = 'rebuild' THEN 1 ELSE 0 END) AS rebuilt,
                SUM(CASE WHEN source IN ('sync', 'webhook') THEN 1 ELSE 0 END) AS observed,
                SUM(CASE WHEN source = 'local' THEN 1 ELSE 0 END) AS local
         FROM conversation_events`
      )
      .get() as { events: number; convs: number; rebuilt: number | null; observed: number | null; local: number | null };
    return {
      events: r.events ?? 0,
      conversations_with_events: r.convs ?? 0,
      derived_from_threads: r.rebuilt ?? 0,
      observed_changes: r.observed ?? 0,
      local_writes: r.local ?? 0
    };
  }

  /**
   * Global rebuild (System -> Rebuild activity): re-derives thread events,
   * conversation-row events (created/closed) and derived columns for every
   * conversation. Idempotent; safe to re-run after import/restore. Bounded
   * batches keep each transaction short. Mirrors migration 011's backfill.
   */
  rebuildAll(batchSize = 500): { conversations: number; events_inserted: number } {
    let conversations = 0;
    let eventsInserted = 0;
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL').get() as { n: number }).n;
    for (let offset = 0; offset < total; offset += batchSize) {
      const ids = (this.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?').all(batchSize, offset) as { id: number }[]).map((r) => r.id);
      const tx = this.db.transaction(() => {
        for (const id of ids) {
          const before = (this.db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(id) as { n: number }).n;
          // Thread events (same conservative mapping as migration 011)
          this.db
            .prepare(
              `INSERT OR IGNORE INTO conversation_events (conversation_id, thread_local_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
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
                 t.remote_created_at, 'rebuild',
                 json_object('thread_remote_id', t.remote_id, 'thread_type', t.type, 'action_type', t.action_type, 'action_text', t.action_text, 'derived', 'thread_mirror'),
                 'thread:' || t.remote_id
               FROM threads t
               WHERE t.conversation_id = ? AND t.deleted_at IS NULL AND t.remote_id IS NOT NULL AND t.state = 'published'
                 AND t.type IN ('customer', 'reply', 'note', 'lineitem')`
            )
            .run(id);
          // Conversation-row events (same as migration 011's backfill)
          this.db
            .prepare(
              `INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
               SELECT c.id, 'conversation_created', 'customer', c.customer_local_id, c.remote_created_at, 'rebuild',
                 json_object('number', c.number, 'mailbox_local_id', c.mailbox_local_id, 'derived', 'conversation_row'),
                 'conversation_created:' || c.remote_id
               FROM conversations c WHERE c.id = ? AND c.remote_created_at IS NOT NULL`
            )
            .run(id);
          this.db
            .prepare(
              `INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
               SELECT c.id, 'closed', 'unknown', c.closed_by, c.closed_at, 'rebuild',
                 json_object('number', c.number, 'derived', 'conversation_row'),
                 'closed:' || c.remote_id || ':' || COALESCE(c.closed_at, '')
               FROM conversations c WHERE c.id = ? AND c.closed_at IS NOT NULL AND c.status = 'closed'`
            )
            .run(id);
          this.db
            .prepare(
              `INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, occurred_at, source, metadata, dedup_key)
               SELECT a.conversation_id, 'attachment_added', 'unknown', a.downloaded_at, 'rebuild',
                 json_object('filename', a.filename, 'mime_type', a.mime_type, 'size', a.size, 'derived', 'attachment_row'),
                 'attachment:' || a.remote_id
               FROM attachments a WHERE a.conversation_id = ? AND a.remote_id IS NOT NULL`
            )
            .run(id);
          const after = (this.db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(id) as { n: number }).n;
          eventsInserted += after - before;
          this.recomputeActivity(id);
          conversations++;
        }
      });
      tx();
    }
    return { conversations, events_inserted: eventsInserted };
  }
}

function safeParse(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
