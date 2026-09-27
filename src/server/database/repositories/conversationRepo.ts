import type { DB } from '../connection.js';
import { nowIso, hashJson, isoOrNull } from './helpers.js';
import type { ConversationSummary, ThreadSummary, AttachmentMeta, ConversationStatus } from '../../../shared/types.js';
import { htmlToText, chunkText } from '../../../shared/utils.js';
import type { ConversationRow, ThreadRow, AttachmentRow } from './types.js';
import { ActivityRepository } from './activityRepo.js';
import { RESPONSE_STATE_SQL, responseStateOf } from '../../inbox/responseState.js';
import type { TicketPriority } from '../../../shared/activity.js';

interface ConversationV3 {
  id: number;
  number?: number;
  threads?: number;
  type?: string | null;
  source?: { type?: string | null; via?: string | null } | null;
  folderId?: number | null;
  status?: string | null;
  state?: string | null;
  subject?: string | null;
  preview?: string | null;
  mailboxId?: number;
  assignee?: { id?: number; type?: string } | null;
  assignedTeam?: { id: number } | null;
  createdBy?: { id?: number; type?: string } | null;
  closedAt?: string | null;
  createdAt?: string | null;
  userUpdatedAt?: string | null;
  tags?: { id?: number; tag: string; color?: string | null }[];
  cc?: string[] | null;
  bcc?: string[] | null;
  primaryCustomer?: { id?: number | null; first?: string | null; last?: string | null; email?: string | null } | null;
  snooze?: { snoozedUntil?: string | null } | null;
  customFields?: { id: number; name?: string | null; value?: string | number | null; text?: string | null; systemType?: string | null }[] | null;
  _links?: { web?: { href: string } };
  [key: string]: unknown;
}

interface ThreadV3 {
  id: number;
  type?: string | null;
  status?: string | null;
  state?: string | null;
  action?: { type?: string | null; text?: string | null } | null;
  body?: string | null;
  source?: { type?: string | null; via?: string | null } | null;
  customer?: { id?: number | null; first?: string | null; last?: string | null; email?: string | null } | null;
  createdBy?: { id?: number | null; type?: string | null; first?: string | null; last?: string | null; email?: string | null } | null;
  assignedTo?: { id?: number | null; type?: string | null } | null;
  savedReplyId?: number | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  createdAt?: string | null;
  attachments?: { id: number; filename?: string | null; mimeType?: string | null; size?: number | null }[] | null;
  [key: string]: unknown;
}

export interface InboxViewParams {
  view: string;
  mailboxId?: number | null;
  /** Channel filter: 'email' or 'chat' (Beacon); undefined = all channels. */
  channel?: 'email' | 'chat' | null;
  page?: number;
  pageSize?: number;
  assigneeLocalId?: number | null;
  tag?: string | null;
  query?: string;
  // ---- v1.7.0 activity filters ----
  /** Activity column date window (resolved UTC [from, to)). */
  activityColumn?: string | null;
  activityFrom?: string | null;
  activityTo?: string | null;
  responseState?: string | null;
  priority?: string | null;
  ticketStateId?: number | null;
  /** Extra raw WHERE fragment from the saved-view engine (parameterized). */
  extraWhere?: string | null;
  extraParams?: unknown[];
  sort?: 'newest_activity' | 'oldest_activity' | 'newest_created' | 'oldest_created' | 'waiting_longest' | 'priority' | 'priority_then_waiting';
}

/** Conversations, threads, attachments repository. */
export class ConversationRepository {
  private activity: ActivityRepository;

  constructor(private db: DB) {
    this.activity = new ActivityRepository(db);
  }

  private localIds = {
    mailbox: (rid: number) => (this.db.prepare('SELECT id FROM mailboxes WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    folder: (rid: number) => (this.db.prepare('SELECT id FROM folders WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    customer: (rid: number) => (this.db.prepare('SELECT id FROM customers WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    user: (rid: number) => (this.db.prepare('SELECT id FROM users WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    team: (rid: number) => (this.db.prepare('SELECT id FROM teams WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    systemUser: (rid: number) => (this.db.prepare('SELECT id FROM system_users WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    field: (rid: number) => (this.db.prepare('SELECT id FROM inbox_fields WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null,
    savedReply: (rid: number) => (this.db.prepare('SELECT id FROM saved_replies WHERE remote_id = ?').get(rid) as { id: number } | undefined)?.id ?? null
  };

  // ---------------- Conversations ----------------

  /** Persist a v3 conversation payload. Returns local id. */
  upsertConversation(c: ConversationV3): number {
    // v1.7.0: pre-write snapshot for the change-event diff (source data for
    // conversation change events; re-syncs produce no duplicate events).
    const previous = this.getConversationByRemoteId(c.id);
    const mailboxLocal = c.mailboxId ? this.localIds.mailbox(c.mailboxId) : null;
    const folderLocal = c.folderId ? this.localIds.folder(c.folderId) : null;
    const customerLocal = c.primaryCustomer?.id ? this.localIds.customer(c.primaryCustomer.id) : null;
    const assigneeLocal = c.assignee?.id && c.assignee.type !== 'team' ? this.localIds.user(c.assignee.id) : null;
    const teamLocal = c.assignedTeam?.id ? this.localIds.team(c.assignedTeam.id) : (c.assignee?.type === 'team' && c.assignee?.id ? this.localIds.team(c.assignee.id) : null);
    const hsUrl = this.hsConversationUrl(c.number ?? c.id);

    this.db
      .prepare(
        `INSERT INTO conversations (remote_id, number, subject, preview, status, state, type, source_type, source_via, mailbox_local_id, folder_local_id,
           customer_local_id, assignee_local_id, assigned_team_local_id, closed_at, snoozed_until, thread_count, hs_url,
           remote_created_at, remote_updated_at, first_activity_at, last_activity_at, raw_json, raw_json_hash, last_seen_at, last_synced_at)
         VALUES (@rid, @number, @subject, @preview, @status, @state, @type, @sourceType, @sourceVia, @mailbox, @folder, @customer, @assignee, @team,
           @closedAt, @snoozedUntil, @threadCount, @hsUrl, @rc, @ru, @firstActivity, @lastActivity, @raw, @hash, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET
           number=excluded.number, subject=excluded.subject, preview=excluded.preview, status=excluded.status, state=excluded.state,
           type=excluded.type, source_type=COALESCE(excluded.source_type, conversations.source_type),
           source_via=COALESCE(excluded.source_via, conversations.source_via),
           mailbox_local_id=excluded.mailbox_local_id, folder_local_id=excluded.folder_local_id,
           customer_local_id=excluded.customer_local_id, assignee_local_id=excluded.assignee_local_id,
           assigned_team_local_id=excluded.assigned_team_local_id, closed_at=excluded.closed_at, snoozed_until=excluded.snoozed_until,
           thread_count=excluded.thread_count, hs_url=excluded.hs_url, remote_created_at=excluded.remote_created_at,
           remote_updated_at=excluded.remote_updated_at,
           first_activity_at=COALESCE(excluded.first_activity_at, conversations.first_activity_at),
           last_activity_at=COALESCE(excluded.last_activity_at, conversations.last_activity_at),
           raw_json=excluded.raw_json, raw_json_hash=excluded.raw_json_hash, last_seen_at=excluded.last_seen_at,
           last_synced_at=excluded.last_synced_at, deleted_at=NULL`
      )
      .run({
        rid: c.id,
        number: c.number ?? c.id,
        subject: c.subject ?? null,
        preview: c.preview ?? null,
        status: this.mapStatus(c.status),
        state: c.state ?? 'published',
        type: c.type ?? null,
        sourceType: c.source?.type ?? null,
        sourceVia: c.source?.via ?? null,
        mailbox: mailboxLocal,
        folder: folderLocal,
        customer: customerLocal,
        assignee: assigneeLocal,
        team: teamLocal,
        closedAt: isoOrNull(c.closedAt),
        snoozedUntil: isoOrNull(c.snooze?.snoozedUntil),
        threadCount: c.threads ?? 0,
        hsUrl,
        rc: isoOrNull(c.createdAt),
        ru: isoOrNull(c.userUpdatedAt ?? c.createdAt),
        firstActivity: isoOrNull(c.createdAt),
        lastActivity: isoOrNull(c.userUpdatedAt ?? c.createdAt),
        raw: JSON.stringify(c),
        hash: hashJson(c),
        seen: nowIso(),
        synced: nowIso()
      });
    const localId = (this.db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(c.id) as { id: number }).id;

    // v1.7.0 conversation change events (sync observation diff). Help Scout
    // exposes no change log, so these honestly record OBSERVATION time with
    // source='sync' - the change happened between the previous observation
    // and this one. Local writes (operations.ts path) record their own exact
    // events with source='local' and never land here.
    const observedAt = nowIso();
    if (!previous) {
      this.activity.recordEvent({
        conversationId: localId,
        eventType: 'conversation_created',
        actorType: 'customer',
        actorLocalId: customerLocal,
        occurredAt: isoOrNull(c.createdAt),
        source: 'sync',
        metadata: { number: c.number ?? c.id, mailbox_local_id: mailboxLocal },
        dedupKey: `conversation_created:${c.id}`
      });
    } else {
      const newStatus = this.mapStatus(c.status);
      if (previous.status !== newStatus) {
        this.activity.recordEvent({
          conversationId: localId,
          eventType: newStatus === 'closed' ? 'closed' : previous.status === 'closed' ? 'reopened' : 'status_changed',
          actorType: 'user',
          occurredAt: observedAt,
          source: 'sync',
          metadata: { previous: previous.status, next: newStatus, observed: true },
          dedupKey: `status_changed:${c.id}:${observedAt}`
        });
      }
      if ((previous.assignee_local_id ?? null) !== (assigneeLocal ?? null)) {
        this.activity.recordEvent({
          conversationId: localId,
          eventType: 'assignment_changed',
          actorType: 'user',
          occurredAt: observedAt,
          source: 'sync',
          metadata: { previous: previous.assignee_local_id ?? null, next: assigneeLocal ?? null, observed: true },
          dedupKey: `assignment_changed:${c.id}:${observedAt}`
        });
      }
      if ((previous.assigned_team_local_id ?? null) !== (teamLocal ?? null)) {
        this.activity.recordEvent({
          conversationId: localId,
          eventType: 'team_changed',
          actorType: 'user',
          occurredAt: observedAt,
          source: 'sync',
          metadata: { previous: previous.assigned_team_local_id ?? null, next: teamLocal ?? null, observed: true },
          dedupKey: `team_changed:${c.id}:${observedAt}`
        });
      }
      if ((previous.mailbox_local_id ?? null) !== (mailboxLocal ?? null)) {
        this.activity.recordEvent({
          conversationId: localId,
          eventType: 'moved',
          actorType: 'user',
          occurredAt: observedAt,
          source: 'sync',
          metadata: { previous_mailbox: previous.mailbox_local_id ?? null, next_mailbox: mailboxLocal ?? null, observed: true },
          dedupKey: `moved:${c.id}:${observedAt}`
        });
      }
      const prevSnooze = previous.snoozed_until ?? null;
      const nextSnooze = isoOrNull(c.snooze?.snoozedUntil);
      if (prevSnooze !== nextSnooze) {
        this.activity.recordEvent({
          conversationId: localId,
          eventType: nextSnooze ? 'snoozed' : 'unsnoozed',
          actorType: 'user',
          occurredAt: observedAt,
          source: 'sync',
          metadata: { previous: prevSnooze, next: nextSnooze, observed: true },
          dedupKey: `snooze:${c.id}:${observedAt}`
        });
      }
      // Tag diff (old names vs new names, case-insensitive)
      if (c.tags) {
        const oldTagNames = new Set((this.db.prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?').all(localId) as { name: string }[]).map((r) => r.name.toLowerCase()));
        for (const t of c.tags) {
          if (!oldTagNames.has(t.tag.toLowerCase())) {
            this.activity.recordEvent({
              conversationId: localId,
              eventType: 'tag_added',
              actorType: 'user',
              occurredAt: observedAt,
              source: 'sync',
              metadata: { tag: t.tag, observed: true },
              dedupKey: `tag_added:${c.id}:${t.tag.toLowerCase()}:${observedAt}`
            });
          }
        }
        const newTagNames = new Set(c.tags.map((t) => t.tag.toLowerCase()));
        for (const old of oldTagNames) {
          if (!newTagNames.has(old)) {
            this.activity.recordEvent({
              conversationId: localId,
              eventType: 'tag_removed',
              actorType: 'user',
              occurredAt: observedAt,
              source: 'sync',
              metadata: { tag: old, observed: true },
              dedupKey: `tag_removed:${c.id}:${old}:${observedAt}`
            });
          }
        }
      }
      // Custom field value diff
      if (c.customFields) {
        const oldFields = new Map((this.db.prepare('SELECT field_local_id, value FROM conversation_fields WHERE conversation_id = ?').all(localId) as { field_local_id: number; value: string | null }[]).map((r) => [r.field_local_id, r.value]));
        for (const f of c.customFields) {
          const fieldLocal = this.localIds.field(f.id);
          if (!fieldLocal) continue;
          const newVal = f.value != null ? String(f.value) : null;
          const oldVal = oldFields.get(fieldLocal) ?? null;
          if (oldVal !== newVal) {
            this.activity.recordEvent({
              conversationId: localId,
              eventType: 'custom_field_changed',
              actorType: 'user',
              occurredAt: observedAt,
              source: 'sync',
              metadata: { field_local_id: fieldLocal, previous: oldVal, next: newVal, observed: true },
              dedupKey: `custom_field_changed:${c.id}:${fieldLocal}:${observedAt}`
            });
          }
        }
      }
    }

    // tags
    this.db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(localId);
    if (c.tags) {
      const ensureTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
      const insertTag = this.db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_local_id) VALUES (?, ?)');
      const tx = this.db.transaction(() => {
        for (const t of c.tags ?? []) {
          const existing = ensureTag.get(t.tag) as { id: number } | undefined;
          let tagId: number;
          if (existing) tagId = existing.id;
          else {
            const slug = t.tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            // v1.6.0 audit fix: -Date.now() collided when two new tags were
            // created in the same millisecond (UNIQUE tags.remote_id) and rolled
            // back the whole tag write. The fallback is now a negative monotonic
            // local id (next autoincrement * -1); the remote-id sign semantics
            // are unchanged from before.
            const nextLocal = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM tags').get() as { n: number }).n);
            tagId = Number(this.db.prepare('INSERT INTO tags (remote_id, name, slug, color) VALUES (?, ?, ?, ?)').run(-(t.id ?? nextLocal), t.tag, slug, t.color ?? null).lastInsertRowid);
          }
          insertTag.run(localId, tagId);
        }
      });
      tx();
    }

    // custom fields
    if (c.customFields) {
      const upsertField = this.db.prepare(
        `INSERT INTO conversation_fields (conversation_id, field_local_id, value, text_value) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, field_local_id) DO UPDATE SET value=excluded.value, text_value=excluded.text_value`
      );
      const tx = this.db.transaction(() => {
        for (const f of c.customFields ?? []) {
          const fieldLocal = this.localIds.field(f.id);
          if (fieldLocal) upsertField.run(localId, fieldLocal, f.value != null ? String(f.value) : null, f.text ?? null);
        }
      });
      tx();
    }

    // FTS
    this.reindexConversationFts(localId);
    // v1.7.0: derived activity columns stay consistent with the mirror
    this.activity.recomputeActivity(localId);
    return localId;
  }

  private mapStatus(s?: string | null): ConversationStatus {
    if (s === 'pending' || s === 'closed' || s === 'spam') return s;
    return 'active';
  }

  hsConversationUrl(number: number): string {
    return `https://secure.helpscout.net/conversation/${number}`;
  }

  reindexConversationFts(localId: number): void {
    this.db.prepare('DELETE FROM fts_conversations WHERE conversation_id = ?').run(localId);
    const row = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.preview,
           TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) AS customer,
           (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
         FROM conversations c LEFT JOIN customers cu ON cu.id = c.customer_local_id WHERE c.id = ?`
      )
      .get(localId) as { id: number; number: number; subject: string | null; preview: string | null; customer: string | null; tags: string | null } | undefined;
    if (!row) return;
    this.db
      .prepare('INSERT INTO fts_conversations (subject, preview, customer, tags, numbers, conversation_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.subject ?? '', row.preview ?? '', row.customer ?? '', row.tags ?? '', String(row.number), localId);
  }

  getConversationByRemoteId(remoteId: number): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE remote_id = ?').get(remoteId) as ConversationRow | undefined;
  }

  getConversationByLocalId(localId: number): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(localId) as ConversationRow | undefined;
  }

  getConversationByNumber(number: number): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE number = ?').get(number) as ConversationRow | undefined;
  }

  listConversations(params: InboxViewParams): { conversations: ConversationSummary[]; total: number } {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, params.pageSize ?? 50);
    const where: string[] = ["c.deleted_at IS NULL", "c.merged_into_conversation_id IS NULL"];
    // v1.7.0: positional parameters throughout - the saved-view engine emits
    // positional fragments, and better-sqlite3 forbids mixing named and
    // positional binds in one statement.
    const args: unknown[] = [];

    switch (params.view) {
      case 'my-tickets':
        where.push("c.status IN ('active','pending')");
        if (params.assigneeLocalId) {
          where.push('c.assignee_local_id = ?');
          args.push(params.assigneeLocalId);
        } else where.push('c.assignee_local_id IS NOT NULL');
        break;
      case 'unassigned':
        where.push("c.status IN ('active','pending')", 'c.assignee_local_id IS NULL');
        break;
      case 'active':
        where.push("c.status = 'active'");
        break;
      case 'pending':
        where.push("c.status = 'pending'");
        break;
      case 'closed':
        where.push("c.status = 'closed'");
        break;
      case 'all':
      default:
        break;
    }
    if (params.mailboxId) {
      where.push('c.mailbox_local_id = ?');
      args.push(params.mailboxId);
    }
    if (params.channel) {
      where.push('c.type = ?');
      args.push(params.channel);
    }
    if (params.tag) {
      where.push('EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND t.name = ? COLLATE NOCASE)');
      args.push(params.tag);
    }
    // ---- v1.7.0 filters ----
    if (params.activityColumn && params.activityFrom && params.activityTo) {
      // activityColumn is a whitelisted expression from ACTIVITY_FIELD_COLUMN (never user input)
      where.push(`${params.activityColumn} IS NOT NULL AND ${params.activityColumn} >= ? AND ${params.activityColumn} < ?`);
      args.push(params.activityFrom, params.activityTo);
    }
    if (params.responseState) {
      where.push(`(${RESPONSE_STATE_SQL}) = ?`);
      args.push(params.responseState);
    }
    if (params.priority) {
      where.push('c.supportos_priority = ?');
      args.push(params.priority);
    }
    if (params.ticketStateId != null) {
      where.push('c.supportos_state_id = ?');
      args.push(params.ticketStateId);
    }
    if (params.extraWhere) {
      where.push(`(${params.extraWhere})`);
      args.push(...(params.extraParams ?? []));
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderBy = this.orderByFor(params.sort);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM conversations c ${whereSql}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT c.* FROM conversations c ${whereSql}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, (page - 1) * pageSize) as ConversationRow[];
    return { conversations: this.toSummaries(rows), total };
  }

  private orderByFor(sort: InboxViewParams['sort']): string {
    switch (sort) {
      case 'oldest_activity':
        return 'COALESCE(c.last_activity_at, c.remote_created_at, c.local_created_at) ASC';
      case 'newest_created':
        return 'COALESCE(c.remote_created_at, c.local_created_at) DESC';
      case 'oldest_created':
        return 'COALESCE(c.remote_created_at, c.local_created_at) ASC';
      case 'waiting_longest':
        return 'c.customer_waiting_since IS NULL, c.customer_waiting_since ASC';
      case 'priority':
        return "CASE c.supportos_priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, COALESCE(c.last_activity_at, c.remote_created_at) DESC";
      case 'priority_then_waiting':
        return "CASE c.supportos_priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, c.customer_waiting_since IS NULL, c.customer_waiting_since ASC";
      case 'newest_activity':
      default:
        return 'COALESCE(c.last_activity_at, c.remote_created_at, c.local_created_at) DESC';
    }
  }

  /**
   * v1.6.0 audit fix (Inbox N+1): toSummary() ran 7 fresh queries PER ROW
   * (~350 for a 50-row page, ~700 at the 100 cap). This batched variant runs
   * 7 queries TOTAL for the whole page via IN(...) lookups and produces the
   * exact same summary shape. toSummary() itself is kept for single-row
   * callers (conversation detail route).
   */
  toSummaries(rows: ConversationRow[]): ConversationSummary[] {
    if (rows.length === 0) return [];
    const convIds = rows.map((r) => r.id);
    const mailboxIds = [...new Set(rows.map((r) => r.mailbox_local_id).filter((v): v is number => v != null))];
    const customerIds = [...new Set(rows.map((r) => r.customer_local_id).filter((v): v is number => v != null))];
    const assigneeIds = [...new Set(rows.map((r) => r.assignee_local_id).filter((v): v is number => v != null))];
    const inList = (ids: number[]): string => ids.map(() => '?').join(',');
    const mailboxNames = new Map<number, string>();
    if (mailboxIds.length > 0) {
      for (const m of this.db.prepare(`SELECT id, name FROM mailboxes WHERE id IN (${inList(mailboxIds)})`).all(...mailboxIds) as { id: number; name: string }[]) {
        mailboxNames.set(m.id, m.name);
      }
    }
    const customerNames = new Map<number, string | null>();
    if (customerIds.length > 0) {
      for (const c of this.db.prepare(`SELECT id, first_name, last_name FROM customers WHERE id IN (${inList(customerIds)})`).all(...customerIds) as { id: number; first_name: string | null; last_name: string | null }[]) {
        customerNames.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || null);
      }
    }
    const customerEmails = new Map<number, string>();
    if (customerIds.length > 0) {
      for (const e of this.db
        .prepare(
          `SELECT e.customer_id, e.value FROM customer_emails e
           JOIN (SELECT customer_id, MIN(id) AS mid FROM customer_emails WHERE customer_id IN (${inList(customerIds)}) GROUP BY customer_id) m ON m.mid = e.id`
        )
        .all(...customerIds) as { customer_id: number; value: string }[]) {
        customerEmails.set(e.customer_id, e.value);
      }
    }
    const assigneeNames = new Map<number, string | null>();
    if (assigneeIds.length > 0) {
      for (const u of this.db.prepare(`SELECT id, first_name, last_name FROM users WHERE id IN (${inList(assigneeIds)})`).all(...assigneeIds) as { id: number; first_name: string | null; last_name: string | null }[]) {
        assigneeNames.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || null);
      }
    }
    const tagsByConv = new Map<number, string[]>();
    for (const t of this.db
      .prepare(
        `SELECT ct.conversation_id, t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id
         WHERE ct.conversation_id IN (${inList(convIds)}) ORDER BY t.name`
      )
      .all(...convIds) as { conversation_id: number; name: string }[]) {
      const list = tagsByConv.get(t.conversation_id) ?? [];
      list.push(t.name);
      tagsByConv.set(t.conversation_id, list);
    }
    const analyzedConvs = new Set<number>(
      (this.db
        .prepare(
          `SELECT DISTINCT conversation_id FROM ai_runs WHERE conversation_id IN (${inList(convIds)}) AND type = 'ticket_analysis' AND status = 'completed'`
        )
        .all(...convIds) as { conversation_id: number }[]).map((x) => x.conversation_id)
    );
    const kiByConv = new Map<number, number>();
    for (const k of this.db
      .prepare(`SELECT conversation_id, MIN(known_issue_id) AS kid FROM known_issue_conversations WHERE conversation_id IN (${inList(convIds)}) GROUP BY conversation_id`)
      .all(...convIds) as { conversation_id: number; kid: number }[]) {
      kiByConv.set(k.conversation_id, k.kid);
    }
    return rows.map((r) => {
      const mailbox = r.mailbox_local_id != null && mailboxNames.has(r.mailbox_local_id) ? { name: mailboxNames.get(r.mailbox_local_id)! } : undefined;
      const customer = r.customer_local_id != null && customerNames.has(r.customer_local_id) ? { first_name: customerNames.get(r.customer_local_id) ?? null, last_name: null } : undefined;
      const customerEmail = r.customer_local_id != null ? customerEmails.get(r.customer_local_id) ?? null : null;
      const assignee = r.assignee_local_id != null && assigneeNames.has(r.assignee_local_id) ? { first_name: assigneeNames.get(r.assignee_local_id) ?? null, last_name: null } : undefined;
      const tags = (tagsByConv.get(r.id) ?? []).map((n) => ({ name: n }));
      const ai = analyzedConvs.has(r.id) ? { status: 'completed' } : undefined;
      const kid = kiByConv.get(r.id);
      const ki = kid != null ? { known_issue_id: kid } : undefined;
      return this.toSummary(r, { mailbox, customer, customerEmail, assignee, tags, ai, ki });
    });
  }

  toSummary(r: ConversationRow, prefetch?: { mailbox?: { name: string | null }; customer?: { first_name: string | null; last_name: string | null }; customerEmail?: string | null; assignee?: { first_name: string | null; last_name: string | null }; tags?: { name: string }[]; ai?: { status: string }; ki?: { known_issue_id: number } }): ConversationSummary {
    // Single-row path queries everything on demand; the batched list path
    // (toSummaries) prefetches everything in 7 page-wide queries and passes
    // it here (v1.6.0 audit fix for the Inbox N+1).
    const mailbox = prefetch?.mailbox ?? (r.mailbox_local_id ? (this.db.prepare('SELECT name FROM mailboxes WHERE id = ?').get(r.mailbox_local_id) as { name: string } | undefined) : undefined);
    const customer = prefetch?.customer ?? (r.customer_local_id ? (this.db.prepare('SELECT first_name, last_name FROM customers WHERE id = ?').get(r.customer_local_id) as { first_name: string | null; last_name: string | null } | undefined) : undefined);
    const customerEmail = prefetch?.customerEmail !== undefined ? prefetch.customerEmail : r.customer_local_id
      ? (this.db.prepare('SELECT value FROM customer_emails WHERE customer_id = ? ORDER BY id LIMIT 1').get(r.customer_local_id) as { value: string } | undefined)?.value ?? null
      : null;
    const assignee = prefetch?.assignee ?? (r.assignee_local_id ? (this.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(r.assignee_local_id) as { first_name: string | null; last_name: string | null } | undefined) : undefined);
    const tags = prefetch?.tags ?? (this.db
      .prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ? ORDER BY t.name')
      .all(r.id) as { name: string }[]);
    const ai = prefetch?.ai ?? (this.db
      .prepare("SELECT status FROM ai_runs WHERE conversation_id = ? AND type = 'ticket_analysis' AND status = 'completed' ORDER BY id DESC LIMIT 1")
      .get(r.id) as { status: string } | undefined);
    const ki = prefetch?.ki ?? (this.db
      .prepare('SELECT known_issue_id FROM known_issue_conversations WHERE conversation_id = ? LIMIT 1')
      .get(r.id) as { known_issue_id: number } | undefined);
    return {
      id: r.id,
      remote_id: r.remote_id,
      number: r.number,
      subject: r.subject ?? '(no subject)',
      preview: r.preview ?? '',
      status: r.status as ConversationSummary['status'],
      type: r.type ?? null,
      source_via: r.source_via ?? null,
      mailbox_id: r.mailbox_local_id ?? 0,
      mailbox_name: mailbox?.name ?? null,
      customer_id: r.customer_local_id,
      customer_name: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null : null,
      customer_email: customerEmail,
      assignee_id: r.assignee_local_id,
      assignee_name: assignee ? [assignee.first_name, assignee.last_name].filter(Boolean).join(' ') || null : null,
      assigned_team_id: r.assigned_team_local_id,
      tags: tags.map((t) => t.name),
      thread_count: r.thread_count,
      remote_created_at: r.remote_created_at,
      remote_updated_at: r.remote_updated_at,
      closed_at: r.closed_at,
      snoozed_until: r.snoozed_until,
      is_unread: (r.is_unread ? 1 : 0) as 0 | 1,
      ai_analysis_status: ai ? 'analyzed' : 'none',
      known_issue_id: ki?.known_issue_id ?? null,
      hs_url: r.hs_url,
      merged_into_conversation_id: r.merged_into_conversation_id,
      first_activity_at: r.first_activity_at,
      last_activity_at: r.last_activity_at,
      // v1.7.0 activity engine
      first_customer_message_at: r.first_customer_message_at ?? null,
      first_response_at: r.first_response_at ?? null,
      last_customer_reply_at: r.last_customer_reply_at ?? null,
      last_human_agent_response_at: r.last_human_agent_response_at ?? null,
      customer_waiting_since: r.customer_waiting_since ?? null,
      last_status_change_at: r.last_status_change_at ?? null,
      last_assignment_change_at: r.last_assignment_change_at ?? null,
      last_tag_change_at: r.last_tag_change_at ?? null,
      activity_history_complete: (r.activity_history_complete ? 1 : 0) as 0 | 1,
      priority: (r.supportos_priority ?? 'none') as TicketPriority,
      ticket_state_id: r.supportos_state_id ?? null,
      response_state: responseStateOf({
        status: r.status,
        snoozed_until: r.snoozed_until ?? null,
        first_customer_message_at: r.first_customer_message_at ?? null,
        first_response_at: r.first_response_at ?? null,
        last_customer_reply_at: r.last_customer_reply_at ?? null,
        last_human_agent_response_at: r.last_human_agent_response_at ?? null,
        activity_history_complete: r.activity_history_complete ?? 0
      })
    };
  }

  // ---------------- Threads ----------------

  upsertThread(conversationLocalId: number, t: ThreadV3): number {
    const bodyText = t.body ? htmlToText(t.body).slice(0, 100000) : null;
    const fromType = t.createdBy?.type === 'customer' || (!t.createdBy?.type && t.customer && t.createdBy?.id === t.customer.id) ? 'customer' : t.createdBy?.type === 'system_user' ? 'system_user' : t.createdBy?.type === 'team' ? 'team' : t.createdBy ? 'user' : t.customer ? 'customer' : null;
    const createdByUser = fromType === 'user' && t.createdBy?.id ? this.localIds.user(t.createdBy.id) : null;
    const createdByCustomer = (fromType === 'customer' ? (t.createdBy?.id ?? t.customer?.id) : t.customer && !t.createdBy ? t.customer.id : null) ?? (fromType === 'customer' ? t.customer?.id : null);
    const createdBySystemUser = fromType === 'system_user' && t.createdBy?.id ? this.localIds.systemUser(t.createdBy.id) : null;

    this.db
      .prepare(
        `INSERT INTO threads (remote_id, conversation_id, type, state, body_text, body_html, from_name, from_email, from_type,
           created_by_user_id, created_by_customer_id, created_by_system_user_id, assigned_to_type, assigned_to_id,
           saved_reply_local_id, action_type, action_text, to_list, cc_list, bcc_list, scheduled_for,
           remote_created_at, remote_updated_at, raw_json, raw_json_hash, last_synced_at)
         VALUES (@rid, @conv, @type, @state, @bodyText, @bodyHtml, @fromName, @fromEmail, @fromType, @byUser, @byCustomer, @bySystem,
           @assignType, @assignId, @savedReply, @actionType, @actionText, @to, @cc, @bcc, @scheduledFor, @rc, @ru, @raw, @hash, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET conversation_id=excluded.conversation_id, type=excluded.type, state=excluded.state,
           body_text=excluded.body_text, body_html=excluded.body_html, from_name=excluded.from_name, from_email=excluded.from_email,
           from_type=excluded.from_type, created_by_user_id=excluded.created_by_user_id,
           created_by_customer_id=excluded.created_by_customer_id, created_by_system_user_id=excluded.created_by_system_user_id,
           assigned_to_type=excluded.assigned_to_type, assigned_to_id=excluded.assigned_to_id,
           saved_reply_local_id=excluded.saved_reply_local_id, action_type=excluded.action_type, action_text=excluded.action_text,
           to_list=excluded.to_list, cc_list=excluded.cc_list, bcc_list=excluded.bcc_list, scheduled_for=excluded.scheduled_for,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at, raw_json=excluded.raw_json,
           raw_json_hash=excluded.raw_json_hash, last_synced_at=excluded.last_synced_at, deleted_at=NULL`
      )
      .run({
        rid: t.id,
        conv: conversationLocalId,
        type: t.type ?? null,
        state: t.state === 'scheduled' ? 'scheduled' : t.state ?? 'published',
        bodyText,
        bodyHtml: t.body ?? null,
        fromName: [t.createdBy?.first ?? t.customer?.first, t.createdBy?.last ?? t.customer?.last].filter(Boolean).join(' ') || null,
        fromEmail: t.createdBy?.email ?? t.customer?.email ?? null,
        fromType,
        byUser: createdByUser,
        byCustomer: createdByCustomer ? this.localIds.customer(createdByCustomer) : null,
        bySystem: createdBySystemUser,
        assignType: t.assignedTo?.type ?? null,
        assignId: t.assignedTo?.id ?? null,
        savedReply: t.savedReplyId ? this.localIds.savedReply(t.savedReplyId) : null,
        actionType: t.action?.type ?? null,
        actionText: t.action?.text ?? null,
        to: JSON.stringify(t.to ?? []),
        cc: JSON.stringify(t.cc ?? []),
        bcc: JSON.stringify(t.bcc ?? []),
        scheduledFor: null,
        rc: isoOrNull(t.createdAt),
        ru: isoOrNull(t.createdAt),
        raw: JSON.stringify(t),
        hash: hashJson(t),
        synced: nowIso()
      });
    const localId = (this.db.prepare('SELECT id FROM threads WHERE remote_id = ?').get(t.id) as { id: number }).id;

    // attachments metadata
    if (t.attachments) {
      const stmt = this.db.prepare(
        `INSERT INTO attachments (remote_id, thread_id, conversation_id, filename, mime_type, size, state, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, 'metadata', ?)
         ON CONFLICT(remote_id) DO UPDATE SET thread_id=excluded.thread_id, conversation_id=excluded.conversation_id,
           filename=excluded.filename, mime_type=excluded.mime_type, size=excluded.size, raw_json=excluded.raw_json`
      );
      const tx = this.db.transaction(() => {
        for (const a of t.attachments ?? []) {
          stmt.run(a.id, localId, conversationLocalId, a.filename ?? null, a.mimeType ?? null, a.size ?? null, JSON.stringify(a));
        }
      });
      tx();
    }

    // thread participants
    this.db.prepare('DELETE FROM thread_participants WHERE thread_id = ?').run(localId);
    if (t.customer?.id) {
      this.db.prepare('INSERT OR IGNORE INTO thread_participants (thread_id, person_type, person_local_id, name, email, role) VALUES (?, ?, ?, ?, ?, ?)').run(localId, 'customer', this.localIds.customer(t.customer.id), [t.customer.first, t.customer.last].filter(Boolean).join(' ') || null, t.customer.email ?? null, 'customer');
    }
    if (t.createdBy?.id) {
      const ptype = t.createdBy.type ?? 'user';
      const pid = ptype === 'customer' ? this.localIds.customer(t.createdBy.id) : ptype === 'system_user' ? this.localIds.systemUser(t.createdBy.id) : this.localIds.user(t.createdBy.id);
      this.db.prepare('INSERT OR IGNORE INTO thread_participants (thread_id, person_type, person_local_id, name, email, role) VALUES (?, ?, ?, ?, ?, ?)').run(localId, ptype, pid, [t.createdBy.first, t.createdBy.last].filter(Boolean).join(' ') || null, t.createdBy.email ?? null, 'creator');
    }
    this.db.prepare('DELETE FROM thread_recipients WHERE thread_id = ?').run(localId);
    const rcpt = this.db.prepare('INSERT INTO thread_recipients (thread_id, email, type) VALUES (?, ?, ?)');
    const tx2 = this.db.transaction(() => {
      for (const e of t.to ?? []) rcpt.run(localId, e, 'to');
      for (const e of t.cc ?? []) rcpt.run(localId, e, 'cc');
      for (const e of t.bcc ?? []) rcpt.run(localId, e, 'bcc');
    });
    tx2();

    // FTS for thread body
    // v1.6.0 audit fix (FTS drift): the DELETE used to run only when the new body
    // was non-empty, so a thread whose body became empty kept its OLD indexed
    // text forever (ghost search hits). The stale row is always removed now;
    // a new one is inserted only when there is content to index.
    this.db.prepare('DELETE FROM fts_threads WHERE thread_id = ?').run(localId);
    if (bodyText && bodyText.trim().length > 0) {
      this.db.prepare('INSERT INTO fts_threads (body, thread_id, conversation_id) VALUES (?, ?, ?)').run(bodyText, localId, conversationLocalId);
      this.db.prepare('UPDATE threads SET fts_indexed = 1 WHERE id = ?').run(localId);
    } else {
      this.db.prepare('UPDATE threads SET fts_indexed = 0 WHERE id = ?').run(localId);
    }
    this.refreshConversationActivity(conversationLocalId);
    // v1.7.0: message/note/lineitem event (deduped on thread remote id) +
    // derived activity recompute (first_response_at, waiting_since, ...).
    const savedThread = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(localId) as ThreadRow;
    this.activity.recordThreadEvent(conversationLocalId, savedThread);
    this.activity.recomputeActivity(conversationLocalId);
    return localId;
  }

  refreshConversationActivity(conversationLocalId: number): void {
    this.db
      .prepare(
        `UPDATE conversations SET
           thread_count = (SELECT COUNT(*) FROM threads WHERE conversation_id = ? AND deleted_at IS NULL),
           first_activity_at = COALESCE((SELECT MIN(remote_created_at) FROM threads WHERE conversation_id = ? AND deleted_at IS NULL), first_activity_at),
           last_activity_at = COALESCE((SELECT MAX(remote_created_at) FROM threads WHERE conversation_id = ? AND deleted_at IS NULL), last_activity_at)
         WHERE id = ?`
      )
      .run(conversationLocalId, conversationLocalId, conversationLocalId, conversationLocalId);
  }

  getThreads(conversationLocalId: number): ThreadSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY remote_created_at ASC, id ASC')
      .all(conversationLocalId) as ThreadRow[];
    return rows.map((r) => this.threadToSummary(r));
  }

  threadToSummary(r: ThreadRow): ThreadSummary {
    const attachments = this.db
      .prepare('SELECT id, remote_id, filename, mime_type, size, thread_id, conversation_id, local_path, state, downloaded_at FROM attachments WHERE thread_id = ?')
      .all(r.id) as AttachmentMeta[];
    let createdBy: string | null = null;
    if (r.created_by_user_id) {
      const u = this.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(r.created_by_user_id) as { first_name: string | null; last_name: string | null } | undefined;
      createdBy = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : null;
    } else if (r.created_by_customer_id) {
      const c = this.db.prepare('SELECT first_name, last_name FROM customers WHERE id = ?').get(r.created_by_customer_id) as { first_name: string | null; last_name: string | null } | undefined;
      createdBy = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : null;
    }
    return {
      id: r.id,
      remote_id: r.remote_id ?? 0,
      conversation_id: r.conversation_id,
      type: (r.type ?? 'customer') as ThreadSummary['type'],
      state: (r.state ?? 'published') as ThreadSummary['state'],
      body_text: r.body_text ?? '',
      body_html: r.body_html,
      from_name: r.from_name,
      from_email: r.from_email,
      from_type: (r.from_type ?? null) as ThreadSummary['from_type'],
      created_by_id: r.created_by_user_id ?? r.created_by_customer_id,
      created_by_name: createdBy ?? r.from_name,
      to: JSON.parse(r.to_list || '[]'),
      cc: JSON.parse(r.cc_list || '[]'),
      bcc: JSON.parse(r.bcc_list || '[]'),
      saved_reply_id: r.saved_reply_local_id,
      attachments,
      remote_created_at: r.remote_created_at,
      scheduled_for: r.scheduled_for
    };
  }

  getThreadByRemoteId(remoteId: number): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE remote_id = ?').get(remoteId) as ThreadRow | undefined;
  }

  // ---------------- Local state mutation (after confirmed remote writes) ----------------

  markMerged(fromRemoteId: number, intoLocalId: number): void {
    this.db.prepare('UPDATE conversations SET merged_into_conversation_id = ?, deleted_at = ? WHERE remote_id = ?').run(intoLocalId, nowIso(), fromRemoteId);
  }

  softDeleteByRemoteId(remoteId: number): void {
    this.db.prepare('UPDATE conversations SET deleted_at = ? WHERE remote_id = ?').run(nowIso(), remoteId);
  }

  updateLocalStatus(localId: number, status: string): void {
    const previous = this.getConversationByLocalId(localId);
    this.db.prepare('UPDATE conversations SET status = ?, local_updated_at = datetime(\'now\') WHERE id = ?').run(status, localId);
    // v1.7.0 local change event (exact time - WE performed this write)
    if (previous && previous.status !== status) {
      const at = nowIso();
      this.activity.recordEvent({
        conversationId: localId,
        eventType: status === 'closed' ? 'closed' : previous.status === 'closed' && status !== 'closed' ? 'reopened' : 'status_changed',
        actorType: 'user',
        occurredAt: at,
        source: 'local',
        metadata: { previous: previous.status, next: status },
        dedupKey: `status_changed:${localId}:${at}`
      });
    }
    this.activity.recomputeActivity(localId);
  }

  updateLocalAssignee(localId: number, assigneeLocalId: number | null): void {
    const previous = this.getConversationByLocalId(localId);
    this.db.prepare('UPDATE conversations SET assignee_local_id = ?, local_updated_at = datetime(\'now\') WHERE id = ?').run(assigneeLocalId, localId);
    if (previous && (previous.assignee_local_id ?? null) !== (assigneeLocalId ?? null)) {
      const at = nowIso();
      this.activity.recordEvent({
        conversationId: localId,
        eventType: 'assignment_changed',
        actorType: 'user',
        occurredAt: at,
        source: 'local',
        metadata: { previous: previous.assignee_local_id ?? null, next: assigneeLocalId ?? null },
        dedupKey: `assignment_changed:${localId}:${at}`
      });
    }
    this.activity.recomputeActivity(localId);
  }

  updateLocalSubject(localId: number, subject: string): void {
    this.db.prepare('UPDATE conversations SET subject = ?, local_updated_at = datetime(\'now\') WHERE id = ?').run(subject, localId);
    this.reindexConversationFts(localId);
  }

  updateLocalMailbox(localId: number, mailboxLocalId: number): void {
    const previous = this.getConversationByLocalId(localId);
    this.db.prepare('UPDATE conversations SET mailbox_local_id = ?, local_updated_at = datetime(\'now\') WHERE id = ?').run(mailboxLocalId, localId);
    if (previous && (previous.mailbox_local_id ?? null) !== mailboxLocalId) {
      const at = nowIso();
      this.activity.recordEvent({
        conversationId: localId,
        eventType: 'moved',
        actorType: 'user',
        occurredAt: at,
        source: 'local',
        metadata: { previous_mailbox: previous.mailbox_local_id ?? null, next_mailbox: mailboxLocalId },
        dedupKey: `moved:${localId}:${at}`
      });
    }
  }

  updateLocalSnooze(localId: number, until: string | null): void {
    const previous = this.getConversationByLocalId(localId);
    this.db.prepare('UPDATE conversations SET snoozed_until = ?, local_updated_at = datetime(\'now\') WHERE id = ?').run(until, localId);
    if (previous && (previous.snoozed_until ?? null) !== (until ?? null)) {
      const at = nowIso();
      this.activity.recordEvent({
        conversationId: localId,
        eventType: until ? 'snoozed' : 'unsnoozed',
        actorType: 'user',
        occurredAt: at,
        source: 'local',
        metadata: { previous: previous.snoozed_until ?? null, next: until ?? null },
        dedupKey: `snooze:${localId}:${at}`
      });
    }
  }

  updateLocalTags(localId: number, tagNames: string[]): void {
    const previousNames = (this.db.prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?').all(localId) as { name: string }[]).map((r) => r.name.toLowerCase());
    this.db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(localId);
    const getTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
    const insTag = this.db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_local_id) VALUES (?, ?)');
    const tx = this.db.transaction(() => {
      for (const name of tagNames) {
        const ex = getTag.get(name) as { id: number } | undefined;
        // v1.6.0 audit fix: see the sync-path note above - monotonic local ids
        // instead of -Date.now() (same-millisecond UNIQUE collisions).
        const nextLocal = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM tags').get() as { n: number }).n);
        const tagId = ex ? ex.id : Number(this.db.prepare('INSERT INTO tags (remote_id, name, slug) VALUES (?, ?, ?)').run(-nextLocal, name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).lastInsertRowid);
        insTag.run(localId, tagId);
      }
    });
    tx();
    this.reindexConversationFts(localId);
    // v1.7.0 tag diff events (local write - exact time)
    const at = nowIso();
    const newNames = new Set(tagNames.map((t) => t.toLowerCase()));
    for (const prev of previousNames) {
      if (!newNames.has(prev)) {
        this.activity.recordEvent({ conversationId: localId, eventType: 'tag_removed', actorType: 'user', occurredAt: at, source: 'local', metadata: { tag: prev }, dedupKey: `tag_removed:${localId}:${prev}:${at}` });
      }
    }
    const prevSet = new Set(previousNames);
    for (const next of newNames) {
      if (!prevSet.has(next)) {
        this.activity.recordEvent({ conversationId: localId, eventType: 'tag_added', actorType: 'user', occurredAt: at, source: 'local', metadata: { tag: next }, dedupKey: `tag_added:${localId}:${next}:${at}` });
      }
    }
    this.activity.recomputeActivity(localId);
  }

  updateLocalFields(localId: number, fields: { field_local_id: number; value: string | null; text_value?: string | null }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO conversation_fields (conversation_id, field_local_id, value, text_value) VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id, field_local_id) DO UPDATE SET value=excluded.value, text_value=excluded.text_value`
    );
    const at = nowIso();
    const changed: { field_local_id: number; previous: string | null; next: string | null }[] = [];
    const tx = this.db.transaction(() => {
      for (const f of fields) {
        const old = (this.db.prepare('SELECT value FROM conversation_fields WHERE conversation_id = ? AND field_local_id = ?').get(localId, f.field_local_id) as { value: string | null } | undefined)?.value ?? null;
        if (old !== (f.value ?? null)) changed.push({ field_local_id: f.field_local_id, previous: old, next: f.value ?? null });
        stmt.run(localId, f.field_local_id, f.value, f.text_value ?? null);
      }
    });
    tx();
    for (const ch of changed) {
      this.activity.recordEvent({ conversationId: localId, eventType: 'custom_field_changed', actorType: 'user', occurredAt: at, source: 'local', metadata: ch, dedupKey: `custom_field_changed:${localId}:${ch.field_local_id}:${at}` });
    }
  }

  setUnread(localId: number, unread: boolean): void {
    this.db.prepare('UPDATE conversations SET is_unread = ? WHERE id = ?').run(unread ? 1 : 0, localId);
  }

  // ---------------- Attachments ----------------

  getAttachment(localId: number): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(localId) as AttachmentRow | undefined;
  }

  updateAttachmentState(localId: number, state: string, localPath: string | null, hash: string | null): void {
    this.db.prepare('UPDATE attachments SET state = ?, local_path = ?, hash = ?, downloaded_at = ? WHERE id = ?').run(state, localPath, hash, state === 'downloaded' ? nowIso() : null, localId);
  }

  listAttachmentsWithoutFile(limit = 20): AttachmentRow[] {
    return this.db.prepare("SELECT * FROM attachments WHERE state IN ('metadata','failed') ORDER BY id DESC LIMIT ?").all(limit) as AttachmentRow[];
  }

  attachmentStats(): { count: number; downloaded: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN state='downloaded' THEN 1 ELSE 0 END) AS d, SUM(COALESCE(size,0)) AS bytes FROM attachments").get() as { n: number; d: number; bytes: number };
    return { count: r.n ?? 0, downloaded: r.d ?? 0, bytes: r.bytes ?? 0 };
  }

  // ---------------- counts for dashboard ----------------

  countByStatus(): { active: number; pending: number; closed: number; spam: number; unassigned: number; backlog: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN status='spam' THEN 1 ELSE 0 END) AS spam,
          SUM(CASE WHEN status IN ('active','pending') AND assignee_local_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
          SUM(CASE WHEN status IN ('active','pending') AND (julianday('now') - COALESCE(julianday(last_activity_at), julianday(remote_created_at), julianday(local_created_at))) >= 7 THEN 1 ELSE 0 END) AS backlog,
          COUNT(*) AS total
         FROM conversations WHERE deleted_at IS NULL`
      )
      .get() as { active: number; pending: number; closed: number; spam: number; unassigned: number; backlog: number; total: number };
    return { active: r.active ?? 0, pending: r.pending ?? 0, closed: r.closed ?? 0, spam: r.spam ?? 0, unassigned: r.unassigned ?? 0, backlog: r.backlog ?? 0, total: r.total ?? 0 };
  }

  // ---------------- Ticket/thread vector chunks (v1.5.0) ----------------

  /**
   * (Re)chunk a conversation for semantic ticket search. Mirrors the docs_chunks
   * lifecycle (v1.4.0): delete+insert in a transaction, embedding state reset -
   * thread changes invalidate previous embeddings.
   *
   * Chunk text = self-describing context header (#number, subject, customer,
   * tags) + thread bodies in chronological order (customer messages, agent
   * replies AND notes: this is a LOCAL search surface over the operator's own
   * mirror, so internal notes are legitimately searchable - same visibility
   * model as the existing FTS search, which indexes everything locally).
   */
  rechunkConversation(localId: number): void {
    const conv = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject,
           TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) AS customer,
           (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
         FROM conversations c LEFT JOIN customers cu ON cu.id = c.customer_local_id WHERE c.id = ?`
      )
      .get(localId) as { id: number; number: number; subject: string | null; customer: string | null; tags: string | null } | undefined;
    if (!conv) return;
    const threads = this.db
      .prepare(
        `SELECT body_text, type, remote_created_at FROM threads
         WHERE conversation_id = ? AND deleted_at IS NULL AND body_text IS NOT NULL AND LENGTH(body_text) > 0
         ORDER BY remote_created_at ASC, id ASC`
      )
      .all(localId) as { body_text: string; type: string | null; remote_created_at: string | null }[];
    const header = [
      `#${conv.number} ${conv.subject ?? '(no subject)'}`,
      conv.customer ? `Customer: ${conv.customer}` : null,
      conv.tags ? `Tags: ${conv.tags}` : null
    ]
      .filter(Boolean)
      .join('\n');
    const threadText = threads.map((t) => t.body_text.slice(0, 4000)).join('\n\n---\n\n');
    const full = `${header}\n\n${threadText}`;
    const chunks = threadText ? chunkText(full, 1200, 150) : [full];
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversation_chunks WHERE conversation_id = ?').run(localId);
      const ins = this.db.prepare('INSERT INTO conversation_chunks (conversation_id, chunk_index, content, chunk_version) VALUES (?, ?, ?, 1)');
      chunks.forEach((c, i) => ins.run(localId, i, c));
    });
    tx();
  }

  conversationChunkStats(): { chunks: number; indexed: number; pending: number; failed: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS chunks,
           SUM(CASE WHEN embedding_state='indexed' THEN 1 ELSE 0 END) AS indexed,
           SUM(CASE WHEN embedding_state IN ('not_indexed','queued') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN embedding_state='failed' THEN 1 ELSE 0 END) AS failed
         FROM conversation_chunks`
      )
      .get() as { chunks: number; indexed: number | null; pending: number | null; failed: number | null };
    return { chunks: r.chunks ?? 0, indexed: r.indexed ?? 0, pending: r.pending ?? 0, failed: r.failed ?? 0 };
  }

  listConversationChunksNeedingEmbedding(limit = 60): { id: number; conversation_id: number; content: string }[] {
    return this.db
      .prepare(
        `SELECT id, conversation_id, content FROM conversation_chunks
         WHERE (embedding_state = 'not_indexed' OR embedding_state = 'failed') AND embedding_attempts < 5 LIMIT ?`
      )
      .all(limit) as { id: number; conversation_id: number; content: string }[];
  }

  setConversationChunkEmbeddingState(chunkId: number, state: string, model?: string | null): void {
    this.db.prepare('UPDATE conversation_chunks SET embedding_state = ?, embedding_model = COALESCE(?, embedding_model) WHERE id = ?').run(state, model ?? null, chunkId);
  }

  // v1.6.0 audit fix: see docsRepo.markDocChunkFailed - cap embedding retries at 5.
  markConversationChunkFailed(chunkId: number): void {
    this.db.prepare("UPDATE conversation_chunks SET embedding_state = 'failed', embedding_attempts = embedding_attempts + 1 WHERE id = ?").run(chunkId);
  }

  updateConversationChunkEmbedding(chunkId: number, model: string | null, embedding: Float32Array | null, state: string): void {
    this.db.prepare('UPDATE conversation_chunks SET embedding = ?, embedding_model = ?, embedding_state = ? WHERE id = ?').run(embedding ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null, model, state, chunkId);
  }

  /** All ticket chunks with a stored local embedding (the no-Qdrant fallback scan). */
  listConversationChunksWithEmbedding(limit = 5000): { id: number; conversation_id: number; content: string; embedding: Buffer }[] {
    return this.db
      .prepare(
        `SELECT id, conversation_id, content, embedding FROM conversation_chunks
         WHERE embedding IS NOT NULL AND embedding_state = 'indexed' LIMIT ?`
      )
      .all(limit) as { id: number; conversation_id: number; content: string; embedding: Buffer }[];
  }
}
