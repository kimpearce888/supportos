import type { DB } from '../database/connection.js';
import type { NotificationRepository } from '../database/repositories/notificationRepo.js';
import type { SettingsRepository } from '../database/repositories/settingsRepo.js';
import type { SlaService } from '../analytics/slaService.js';
import type { NotificationRecord, NotificationType, NotificationSeverity } from '../../shared/collaboration.js';
import { serverEventBus } from '../services/eventBus.js';
import { buildMentionDirectory, parseMentions } from '../collaboration/mentionParser.js';

/**
 * NotificationSweep (v1.8.0, plan Phase 12): the SINGLE producer of
 * Notification Center rows.
 *
 * Design decisions:
 * - One funnel, like the sync engine's ingestConversation: every notification
 *   type is derived from an observable local fact (conversation_events, SLA
 *   alerts, jobs, sync state, outreach recipients, known issues/clusters,
 *   ai_runs, ratings) - never from free-form producers, never from guesses.
 * - Idempotence by dedup keys: event-derived notifications reuse the event's
 *   own dedup key; state-derived ones (SLA, spikes, sync failures) include
 *   the day so at most one notification per subject per day. Re-running the
 *   sweep, re-syncing, or crashing mid-sweep can never duplicate.
 * - First run is SILENT by design: the cursor initializes to "now", because
 *   history did not notify anyone (same honesty rule as conversation_events
 *   pre-sync history).
 * - All timestamp comparisons go through julianday(), which accepts both the
 *   datetime('now') space format and ISO-Z strings - never bare string
 *   compares (the v1.6.0 audit bug class).
 * - Preferences are checked BEFORE insert: a disabled type produces no row
 *   at all (not a hidden row), so the store stays honest.
 */
interface ERow { [k: string]: unknown }

const CURSOR_KEY = 'notif_event_cursor';
const SWEEP_AT_KEY = 'notif_sweep_at';

export class NotificationSweep {
  constructor(
    private db: DB,
    private notifications: NotificationRepository,
    private sla: SlaService,
    private settings: SettingsRepository
  ) {}

  /** Space-format UTC stamp (matches datetime('now') storage). */
  private nowStamp(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  private dayStamp(): string {
    return new Date().toISOString().slice(0, 10).replaceAll('-', '');
  }

  /** Create a notification (pref-checked, deduped) and emit SSE when new. */
  notify(input: {
    type: NotificationType;
    severity?: NotificationSeverity;
    title: string;
    body?: string | null;
    target_user_local_id?: number | null;
    actor_user_local_id?: number | null;
    conversation_id?: number | null;
    conversation_number?: number | null;
    customer_local_id?: number | null;
    issue_id?: number | null;
    campaign_id?: number | null;
    job_id?: number | null;
    side_thread_id?: number | null;
    dedup_key: string;
  }): NotificationRecord | null {
    if (!this.notifications.prefFor(input.type)) return null;
    const created = this.notifications.insert(input);
    if (created) {
      const me = this.meUserLocalId();
      serverEventBus.emit('notification-received', {
        id: created.id,
        type: created.type,
        severity: created.severity,
        title: created.title,
        conversationId: created.conversation_id,
        conversationNumber: created.conversation_number,
        customerId: created.customer_local_id,
        targetUserLocalId: created.target_user_local_id,
        unreadCount: this.notifications.unreadCount(me),
        at: new Date().toISOString()
      });
    }
    return created;
  }

  /** The connected Help Scout user, falling back to the first synced user. */
  meUserLocalId(): number | null {
    const row = this.db
      .prepare(
        `SELECT u.id FROM users u WHERE u.remote_id = (SELECT CAST(json_extract(value, '$') AS INTEGER) FROM application_settings WHERE key = 'me_remote_id')`
      )
      .get() as ERow | undefined;
    if (row) return Number(row.id);
    const fallback = this.db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get() as ERow | undefined;
    return fallback ? Number(fallback.id) : null;
  }

  /**
   * One sweep pass. Returns how many notifications were created. Safe to
   * re-run at any time; safe when tables are empty.
   */
  sweep(): { created: number } {
    const now = this.nowStamp();
    const cursor = this.settings.get<number | null>(CURSOR_KEY, null);
    const sweepAt = this.settings.get<string | null>(SWEEP_AT_KEY, null);
    if (cursor == null || sweepAt == null) {
      // v1.8.0 fix: do NOT initialize the cursor while the first sync is still
      // running - the boot sweep used to initialize it BEFORE the initial
      // sync populated conversation_events, so the entire first-sync history
      // arrived "after the cursor" and notified (15+ rows of spam on a fresh
      // install). CATCHING_UP/LIVE mean the mirror settled: the cursor
      // initializes silently there.
      const syncState = String(this.db.prepare("SELECT value FROM application_settings WHERE key = 'sync_state'").pluck().get() ?? '"NEW"').replace(/"/g, '');
      if (syncState === 'NEW' || syncState === 'INITIALIZING' || syncState === 'BACKFILLING') {
        return { created: 0 };
      }
      // First run after the mirror settled: initialize silently (history did
      // not notify anyone).
      const maxEvent = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM conversation_events').get() as ERow).m as number;
      this.settings.set(CURSOR_KEY, Number(maxEvent));
      this.settings.set(SWEEP_AT_KEY, now);
      return { created: 0 };
    }

    let created = 0;

    try {
      created += this.sweepConversationEvents(Number(cursor));
      created += this.sweepSla();
      created += this.sweepAutomationApprovals();
      created += this.sweepFailedJobs(sweepAt);
      created += this.sweepSyncState();
      created += this.sweepCampaignReplies(sweepAt);
      created += this.sweepKnownIssues(sweepAt);
      created += this.sweepIssueSpikes(sweepAt);
      created += this.sweepAiEscalations(sweepAt);
      created += this.sweepRatings(sweepAt);
    } finally {
      // The event cursor advances even if a step threw: each step is
      // individually idempotent, so a partially failed sweep never re-notifies.
      const maxEvent = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM conversation_events').get() as ERow).m as number;
      this.settings.set(CURSOR_KEY, Number(maxEvent));
      this.settings.set(SWEEP_AT_KEY, now);
    }
    return { created };
  }

  // ---------------- 1. conversation events ----------------

  private sweepConversationEvents(afterEventId: number): number {
    const events = this.db
      .prepare(
        `SELECT e.id, e.conversation_id, e.thread_local_id, e.event_type, e.actor_type, e.actor_local_id, e.occurred_at, e.metadata, e.dedup_key
         FROM conversation_events e
         WHERE e.id > ? AND e.event_type IN ('customer_message', 'internal_note', 'assignment_changed')
         ORDER BY e.id LIMIT 500`
      )
      .all(afterEventId) as ERow[];
    if (events.length === 0) return 0;
    let created = 0;
    for (const e of events) {
      const conv = this.db
        .prepare('SELECT id, number, subject, assignee_local_id, customer_local_id FROM conversations WHERE id = ?')
        .get(Number(e.conversation_id)) as ERow | undefined;
      if (!conv) continue; // merged/deleted
      const convId = Number(conv.id);
      const number = conv.number == null ? null : Number(conv.number);
      const meta = this.readMeta(e);

      if (String(e.event_type) === 'customer_message') {
        const excerpt = this.threadExcerpt(e.thread_local_id == null ? null : Number(e.thread_local_id));
        const r = this.notify({
          type: 'customer_replied',
          title: `Customer replied on #${number ?? convId}${conv.subject != null ? ` — ${trim(String(conv.subject), 60)}` : ''}`,
          body: excerpt,
          target_user_local_id: conv.assignee_local_id == null ? null : Number(conv.assignee_local_id),
          conversation_id: convId,
          conversation_number: number,
          customer_local_id: conv.customer_local_id == null ? null : Number(conv.customer_local_id),
          dedup_key: `n:evt:customer_replied:${String(e.dedup_key)}`
        });
        if (r) created++;
      } else if (String(e.event_type) === 'assignment_changed') {
        const next = meta.next == null ? null : Number(meta.next);
        if (next != null && next !== (e.actor_local_id == null ? null : Number(e.actor_local_id))) {
          const name = this.userDisplay(next);
          const r = this.notify({
            type: 'ticket_assigned',
            title: `#${number ?? convId} assigned to ${name}`,
            body: conv.subject != null ? trim(String(conv.subject), 120) : null,
            target_user_local_id: next,
            actor_user_local_id: e.actor_local_id == null ? null : Number(e.actor_local_id),
            conversation_id: convId,
            conversation_number: number,
            dedup_key: `n:evt:ticket_assigned:${String(e.dedup_key)}`
          });
          if (r) created++;
        }
      } else if (String(e.event_type) === 'internal_note') {
        // Mentions inside internal notes (plan Phase 13).
        const body = this.threadBody(e.thread_local_id == null ? null : Number(e.thread_local_id));
        if (body) {
          const directory = buildMentionDirectory(this.db);
          const mentions = parseMentions(body, directory);
          const author = e.actor_local_id == null ? null : Number(e.actor_local_id);
          for (const m of mentions) {
            if (m.user_local_id == null || m.user_local_id === author) continue;
            const r = this.notify({
              type: 'mentioned',
              title: `${this.userDisplay(author)} mentioned you on #${number ?? convId}`,
              body: trim(body, 200),
              target_user_local_id: m.user_local_id,
              actor_user_local_id: author,
              conversation_id: convId,
              conversation_number: number,
              dedup_key: `n:mention:${String(e.dedup_key)}:${m.user_local_id}`
            });
            if (r) created++;
          }
        }
      }
    }
    return created;
  }

  // ---------------- 2. SLA risk / breach ----------------

  private sweepSla(): number {
    let created = 0;
    const alerts = this.sla.slaAlerts();
    const day = this.dayStamp();
    for (const a of alerts.alerts) {
      const type: NotificationType = a.state === 'breached' ? 'sla_breach' : 'sla_risk';
      const r = this.notify({
        type,
        severity: a.state === 'breached' ? 'critical' : 'warning',
        title:
          a.state === 'breached'
            ? `SLA breached on #${a.number} (${a.mailbox_name}) — ${a.overdue_business_min} min over target`
            : `SLA at risk on #${a.number} (${a.mailbox_name}) — ${a.waited_business_min}/${a.target_min} business min`,
        body: a.subject ? trim(a.subject, 120) : null,
        target_user_local_id: a.assignee_local_id,
        conversation_id: a.conversation_id,
        conversation_number: a.number,
        dedup_key: `n:sla:${a.state}:${a.conversation_id}:${day}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 3. automation approvals ----------------

  private sweepAutomationApprovals(): number {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM jobs WHERE type = 'automation_action_awaiting_approval' AND status IN ('queued', 'parked') ORDER BY id LIMIT 100`
      )
      .all() as ERow[];
    let created = 0;
    for (const j of rows) {
      const payload = safeJson(j.payload);
      const conversationId = payload.conversationId == null ? null : Number(payload.conversationId);
      const conv = conversationId ? (this.db.prepare('SELECT number, subject FROM conversations WHERE id = ?').get(conversationId) as ERow | undefined) : undefined;
      const action = payload.action && typeof payload.action === 'object' ? (payload.action as { kind?: string }).kind : 'action';
      const r = this.notify({
        type: 'automation_approval',
        severity: 'warning',
        title: `Automation approval required: ${action ?? 'action'}${conv?.number ? ` on #${conv.number}` : ''}`,
        body: conv?.subject != null ? trim(String(conv.subject), 120) : null,
        conversation_id: conversationId,
        conversation_number: conv?.number == null ? null : Number(conv.number),
        job_id: j.id == null ? null : Number(j.id),
        dedup_key: `n:approval:${Number(j.id)}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 4. failed jobs ----------------

  private sweepFailedJobs(sinceStamp: string): number {
    const rows = this.db
      .prepare(`SELECT id, queue, type, error, completed_at FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 200`)
      .all() as ERow[];
    let created = 0;
    for (const j of rows) {
      const completed = j.completed_at == null ? null : String(j.completed_at);
      if (completed == null || this.beforeOrEqual(completed, sinceStamp)) continue;
      const r = this.notify({
        type: 'job_failure',
        severity: 'warning',
        title: `Background job failed (${String(j.queue)}/${String(j.type)})`,
        body: j.error == null ? null : trim(String(j.error), 200),
        job_id: j.id == null ? null : Number(j.id),
        dedup_key: `n:jobfail:${Number(j.id)}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 5. sync state ----------------

  private sweepSyncState(): number {
    // Stored values are JSON-quoted ('"ERROR"') - strip quotes before comparing.
    const state = String(this.db.prepare("SELECT value FROM application_settings WHERE key = 'sync_state'").pluck().get() ?? '').replace(/"/g, '');
    if (state !== 'ERROR') return 0;
    const r = this.notify({
      type: 'sync_failure',
      severity: 'critical',
      title: 'Help Scout sync is in ERROR state',
      body: 'Open Sync Health to see the last errors and restart the sync.',
      dedup_key: `n:syncfail:${this.dayStamp()}`
    });
    return r ? 1 : 0;
  }

  // ---------------- 6. campaign replies ----------------

  private sweepCampaignReplies(sinceStamp: string): number {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.campaign_id, r.customer_local_id, r.replied_at, c.name AS campaign_name, c.subject AS campaign_subject
         FROM outreach_recipients r JOIN outreach_campaigns c ON c.id = r.campaign_id
         WHERE r.replied_at IS NOT NULL ORDER BY r.id DESC LIMIT 200`
      )
      .all() as ERow[];
    let created = 0;
    for (const r of rows) {
      const repliedAt = String(r.replied_at);
      if (this.beforeOrEqual(repliedAt, sinceStamp)) continue;
      const customer = this.customerDisplay(r.customer_local_id == null ? null : Number(r.customer_local_id));
      const campaignId = r.campaign_id == null ? null : Number(r.campaign_id);
      const n = this.notify({
        type: 'campaign_reply',
        title: `Campaign reply: ${customer ?? 'a customer'} answered "${trim(String(r.campaign_name ?? 'campaign'), 50)}"`,
        body: r.campaign_subject != null ? trim(String(r.campaign_subject), 120) : null,
        customer_local_id: r.customer_local_id == null ? null : Number(r.customer_local_id),
        campaign_id: campaignId,
        dedup_key: `n:campreply:${Number(r.id)}`
      });
      if (n) created++;
    }
    return created;
  }

  // ---------------- 7. known issues ----------------

  private sweepKnownIssues(sinceStamp: string): number {
    const rows = this.db.prepare('SELECT id, title, status, created_at FROM known_issues ORDER BY id DESC LIMIT 100').all() as ERow[];
    let created = 0;
    for (const k of rows) {
      const at = String(k.created_at ?? '');
      if (this.beforeOrEqual(at, sinceStamp)) continue;
      const r = this.notify({
        type: 'known_issue_detected',
        title: `Known issue tracked: ${trim(String(k.title), 80)}`,
        body: `Status: ${String(k.status ?? 'investigating')}`,
        issue_id: Number(k.id),
        dedup_key: `n:knownissue:${Number(k.id)}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 8. issue spikes ----------------

  private sweepIssueSpikes(sinceStamp: string): number {
    const rows = this.db.prepare("SELECT id, title, conversation_count, updated_at FROM issue_clusters WHERE trend = 'rising' ORDER BY id DESC LIMIT 100").all() as ERow[];
    let created = 0;
    const day = this.dayStamp();
    for (const c of rows) {
      const at = String(c.updated_at ?? '');
      if (this.beforeOrEqual(at, sinceStamp)) continue;
      const r = this.notify({
        type: 'issue_spike',
        severity: 'warning',
        title: `Issue spike: ${trim(String(c.title), 80)} (${Number(c.conversation_count ?? 0)} conversations)`,
        issue_id: Number(c.id),
        dedup_key: `n:spike:${Number(c.id)}:${day}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 9. AI escalation ----------------

  private sweepAiEscalations(sinceStamp: string): number {
    const rows = this.db
      .prepare(
        `SELECT a.id AS run_id, a.conversation_id, a.output, a.created_at, c.number, c.subject, c.status
         FROM ai_runs a JOIN conversations c ON c.id = a.conversation_id
         WHERE a.type = 'ticket_analysis' AND a.status = 'completed' AND a.conversation_id IS NOT NULL
         ORDER BY a.id DESC LIMIT 200`
      )
      .all() as ERow[];
    let created = 0;
    for (const a of rows) {
      const at = String(a.created_at ?? '');
      if (this.beforeOrEqual(at, sinceStamp)) continue;
      if (String(a.status) === 'closed') continue; // escalation on a closed ticket is noise
      const analysis = safeJson(a.output);
      const urgency = typeof analysis.urgency === 'string' ? analysis.urgency : null;
      const sentiment = typeof analysis.sentiment === 'string' ? analysis.sentiment : null;
      const confidence = typeof analysis.confidence === 'string' ? analysis.confidence : 'unknown';
      const escalate = (urgency === 'high' || urgency === 'critical' || sentiment === 'frustrated') && (confidence === 'medium' || confidence === 'high');
      if (!escalate) continue;
      const convId = Number(a.conversation_id);
      const number = a.number == null ? null : Number(a.number);
      const r = this.notify({
        type: 'ai_escalation',
        severity: 'warning',
        title: `AI escalation on #${number ?? convId}${urgency === 'critical' ? ' — urgency: critical' : urgency === 'high' ? ' — urgency: high' : ' — customer frustrated'}`,
        body: [a.subject ? trim(String(a.subject), 100) : null, `AI confidence: ${confidence}`].filter(Boolean).join(' · ') || null,
        conversation_id: convId,
        conversation_number: number,
        dedup_key: `n:aiescal:${Number(a.run_id)}`
      });
      if (r) created++;
    }
    return created;
  }

  // ---------------- 10. important customer events (ratings) ----------------

  private sweepRatings(sinceStamp: string): number {
    const rows = this.db
      .prepare("SELECT id, remote_id, rating, comments, customer_local_id, conversation_id, remote_created_at FROM ratings WHERE rating = 'not-good' ORDER BY id DESC LIMIT 100")
      .all() as ERow[];
    let created = 0;
    for (const r of rows) {
      const at = String(r.remote_created_at ?? '');
      if (this.beforeOrEqual(at, sinceStamp)) continue;
      const customer = this.customerDisplay(r.customer_local_id == null ? null : Number(r.customer_local_id));
      const conv = r.conversation_id == null ? null : Number(r.conversation_id);
      const n = this.notify({
        type: 'customer_event',
        title: `Not-good rating received${customer ? ` from ${customer}` : ''}`,
        body: r.comments == null ? null : trim(String(r.comments), 200),
        customer_local_id: r.customer_local_id == null ? null : Number(r.customer_local_id),
        conversation_id: conv,
        dedup_key: `n:rating:${r.remote_id == null ? `id${r.id}` : String(r.remote_id)}`
      });
      if (n) created++;
    }
    return created;
  }

  // ---------------- helpers ----------------

  private readMeta(e: ERow): Record<string, unknown> {
    return safeJson(e.metadata ?? null);
  }

  private threadBody(threadLocalId: number | null): string | null {
    if (threadLocalId == null) return null;
    const row = this.db.prepare('SELECT body_text FROM threads WHERE id = ?').get(threadLocalId) as ERow | undefined;
    return row?.body_text == null ? null : String(row.body_text);
  }

  private threadExcerpt(threadLocalId: number | null): string | null {
    const body = this.threadBody(threadLocalId);
    return body == null ? null : trim(body, 160);
  }

  private userDisplay(userLocalId: number | null): string {
    if (userLocalId == null) return 'Someone';
    const row = this.db.prepare('SELECT first_name, last_name, email FROM users WHERE id = ?').get(userLocalId) as ERow | undefined;
    if (!row) return `user #${userLocalId}`;
    return [row.first_name, row.last_name].filter(Boolean).join(' ') || String(row.email ?? `user #${userLocalId}`);
  }

  private customerDisplay(customerLocalId: number | null): string | null {
    if (customerLocalId == null) return null;
    const row = this.db.prepare('SELECT first_name, last_name FROM customers WHERE id = ?').get(customerLocalId) as ERow | undefined;
    if (!row) return null;
    return [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
  }

  /** True when a stamp is at or before the reference (format-agnostic). */
  private beforeOrEqual(stamp: string, reference: string): boolean {
    const a = Date.parse(stamp.includes('T') ? stamp : stamp.replace(' ', 'T') + 'Z');
    const b = Date.parse(reference.includes('T') ? reference : reference.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true; // unparseable = treat as already seen (no spam)
    return a <= b;
  }
}

function safeJson(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return typeof parsed === 'object' && parsed != null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function trim(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
