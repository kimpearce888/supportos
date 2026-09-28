import type { DB } from '../database/connection.js';
import { CustomerEventRepository } from '../database/repositories/customerEventsRepo.js';

/**
 * CustomerEventSweep (plan Phase 23): derives observable customer events
 * from the settled mirror. Idempotent by construction - every statement is
 * INSERT OR IGNORE with the SAME stable dedup-key conventions as the
 * migration 014 backfill (signup:{customerId}, conv_created:{convId},
 * conv_closed:{convId}, conv_first_message:{convId},
 * campaign_sent:{campaignId}:{customerId},
 * campaign_replied:{campaignId}:{customerId}, rating:{ratingId},
 * incident_exposure:{incidentId}:{customerId},
 * cobj:{objectId}:customer:{customerId}) - so re-running the sweep,
 * re-syncing, or crashing mid-sweep can never duplicate an event.
 *
 * The incremental sweep only looks at RECENT rows (cheap); rebuild()
 * re-derives the full history exactly like the migration backfill. The
 * kinds subscription/account/product/integration events have no observable
 * source in this version: they stay absent until a connector or custom
 * object produces them (custom object links DO produce custom_object_event
 * rows), which is the honest state, and the sweep never fabricates them.
 */
export class CustomerEventSweep {
  constructor(private db: DB, private events: CustomerEventRepository) {}

  /**
   * One incremental pass over recent mirror activity. Like the
   * notification sweep, it stays silent while the first sync is still
   * populating the mirror (the backfill in migration 014 / rebuild()
   * covers that history once).
   */
  sweep(): { created: number } {
    const syncState = String(this.db.prepare("SELECT value FROM application_settings WHERE key = 'sync_state'").pluck().get() ?? '"NEW"').replace(/"/g, '');
    if (syncState === 'NEW' || syncState === 'INITIALIZING' || syncState === 'BACKFILLING') {
      return { created: 0 };
    }
    let created = 0;
    created += this.deriveRecentConversations();
    created += this.deriveRecentCampaigns();
    created += this.deriveRecentRatings();
    created += this.deriveIncidentExposure();
    created += this.deriveCustomObjectEvents();
    return { created };
  }

  private runCounted(sql: string, ...params: unknown[]): number {
    const r = this.db.prepare(sql).run(...params);
    return r.changes;
  }

  private deriveRecentConversations(): number {
    let created = 0;
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.customer_local_id, 'support_conversation', c.remote_created_at,
             'Support conversation #' || c.number || ' started',
             json_object('conversation_id', c.id, 'number', c.number, 'subject', c.subject, 'status', c.status),
             'hs_sync', 'conversations:' || c.remote_id,
             'conv_created:' || c.id
      FROM conversations c
      WHERE c.customer_local_id IS NOT NULL AND c.remote_created_at IS NOT NULL AND c.deleted_at IS NULL
        AND julianday(c.remote_updated_at) >= julianday('now', '-7 days')
    `);
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.customer_local_id, 'support_conversation', c.closed_at,
             'Support conversation #' || c.number || ' closed',
             json_object('conversation_id', c.id, 'number', c.number, 'subject', c.subject, 'status', 'closed'),
             'hs_sync', 'conversations:' || c.remote_id,
             'conv_closed:' || c.id
      FROM conversations c
      WHERE c.customer_local_id IS NOT NULL AND c.closed_at IS NOT NULL AND c.deleted_at IS NULL
        AND julianday(c.remote_updated_at) >= julianday('now', '-7 days')
    `);
    created += this.runCounted(`
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
        AND julianday(c.remote_created_at) >= julianday('now', '-7 days')
    `);
    return created;
  }

  private deriveRecentCampaigns(): number {
    let created = 0;
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign', r.sent_at,
             'Outreach campaign sent: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name, 'conversation_number', r.hs_conversation_number),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_sent:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r
      JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.sent_at IS NOT NULL AND julianday(r.sent_at) >= julianday('now', '-30 days')
    `);
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign_reply', r.replied_at,
             'Customer replied to outreach: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_replied:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r
      JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.replied_at IS NOT NULL AND julianday(r.replied_at) >= julianday('now', '-30 days')
    `);
    return created;
  }

  private deriveRecentRatings(): number {
    return this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'rating', r.remote_created_at,
             'Customer rated the support ' || r.rating,
             json_object('rating', r.rating, 'comments', r.comments, 'conversation_id', r.conversation_id),
             'hs_sync', 'ratings:' || r.remote_id,
             'rating:' || r.id
      FROM ratings r
      WHERE r.customer_local_id IS NOT NULL AND r.remote_created_at IS NOT NULL
        AND julianday(r.remote_created_at) >= julianday('now', '-30 days')
    `);
  }

  /** Customers of conversations linked to ACTIVE incidents are exposed. */
  private deriveIncidentExposure(): number {
    return this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT DISTINCT c.customer_local_id, 'incident_exposure', ic.linked_at,
             'Affected by incident ' || i.code || ': ' || substr(i.title, 1, 80),
             json_object('incident_id', i.id, 'code', i.code, 'title', i.title,
                         'severity', i.severity, 'status', i.status, 'conversation_id', c.id),
             'local_derived', 'incidents:' || i.id,
             'incident_exposure:' || i.id || ':' || c.customer_local_id
      FROM incidents i
      JOIN incident_conversations ic ON ic.incident_id = i.id
      JOIN conversations c ON c.id = ic.conversation_id
      WHERE i.status != 'resolved' AND c.customer_local_id IS NOT NULL AND c.deleted_at IS NULL
    `);
  }

  /** Custom objects linked to a customer produce timeline events. */
  private deriveCustomObjectEvents(): number {
    return this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT l.target_local_id, 'custom_object_event', l.linked_at,
             COALESCE(t.name, 'Record') || ': ' || substr(o.title, 1, 80),
             json_object('object_id', o.id, 'object_title', o.title, 'type_name', t.name),
             'custom_object', 'custom_objects:' || o.id,
             'cobj:' || o.id || ':customer:' || l.target_local_id
      FROM custom_object_links l
      JOIN custom_objects o ON o.id = l.object_id AND o.deleted_at IS NULL
      JOIN custom_object_types t ON t.id = o.type_id
      WHERE l.target_kind = 'customer'
    `);
  }

  /** Full re-derivation (the maintenance/admin path). Idempotent. */
  rebuild(): { created: number } {
    let created = 0;
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT c.id, 'signup', c.remote_created_at, 'Customer created in Help Scout',
             json_object('remote_id', c.remote_id), 'hs_sync', 'customers:' || c.remote_id,
             'signup:' || c.id
      FROM customers c WHERE c.remote_created_at IS NOT NULL AND c.deleted_at IS NULL
    `);
    // The recent-window derivations cover the remaining kinds; widen their
    // windows by running them against all rows via rebuild-specific SQL.
    created += this.runCounted(`
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
    created += this.runCounted(`
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
    created += this.runCounted(`
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
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign', r.sent_at,
             'Outreach campaign sent: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name, 'conversation_number', r.hs_conversation_number),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_sent:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.sent_at IS NOT NULL
    `);
    created += this.runCounted(`
      INSERT OR IGNORE INTO customer_events
        (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
      SELECT r.customer_local_id, 'campaign_reply', r.replied_at,
             'Customer replied to outreach: ' || COALESCE(oc.name, 'campaign'),
             json_object('campaign_id', oc.id, 'campaign_name', oc.name),
             'local_outreach', 'campaign:' || oc.id,
             'campaign_replied:' || oc.id || ':' || r.customer_local_id
      FROM outreach_recipients r JOIN outreach_campaigns oc ON oc.id = r.campaign_id
      WHERE r.replied_at IS NOT NULL
    `);
    created += this.runCounted(`
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
    created += this.deriveIncidentExposure();
    created += this.deriveCustomObjectEvents();
    return { created };
  }
}
