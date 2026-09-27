import type { DB } from '../connection.js';
import { nowIso, hashJson, isoOrNull, jsonArray } from './helpers.js';
import type { MailboxSummary, UserSummary, TeamSummary, TagSummary, CustomFieldSummary, SavedReplySummary, WorkflowSummary } from '../../../shared/types.js';
import type { UserStatusInfo, WebhookConfigInfo } from './types.js';

/** Reference data repository: mailboxes, folders, users, teams, tags, fields, saved replies, workflows. */
export class ReferenceRepository {
  constructor(private db: DB) {}

  // ---------------- Mailboxes ----------------
  upsertMailbox(m: { remote_id: number; name: string; slug?: string | null; email?: string | null; createdAt?: string | null; updatedAt?: string | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO mailboxes (remote_id, name, slug, email, remote_created_at, remote_updated_at, raw_json, raw_json_hash, last_seen_at, last_synced_at)
         VALUES (@rid, @name, @slug, @email, @rc, @ru, @raw, @hash, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET name=excluded.name, slug=excluded.slug, email=excluded.email,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           raw_json=excluded.raw_json, raw_json_hash=excluded.raw_json_hash, last_seen_at=excluded.last_seen_at,
           last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: m.remote_id,
        name: m.name,
        slug: m.slug ?? null,
        email: m.email ?? null,
        rc: isoOrNull(m.createdAt),
        ru: isoOrNull(m.updatedAt),
        raw: JSON.stringify(m.raw ?? m),
        hash: hashJson(m.raw ?? m),
        seen: nowIso(),
        synced: nowIso()
      });
    return this.getLocalId('mailboxes', m.remote_id)!;
  }

  getMailboxes(): MailboxSummary[] {
    return this.db
      .prepare(
        `SELECT m.id, m.remote_id, m.name, m.email, m.slug, m.remote_created_at AS created_at,
           (SELECT COUNT(*) FROM folders f WHERE f.mailbox_id = m.id) AS folder_count
         FROM mailboxes m WHERE m.deleted_at IS NULL ORDER BY m.name`
      )
      .all() as MailboxSummary[];
  }
  getMailboxByRemoteId(remoteId: number): { id: number; name: string } | undefined {
    return this.db.prepare('SELECT id, name FROM mailboxes WHERE remote_id = ?').get(remoteId) as { id: number; name: string } | undefined;
  }

  // ---------------- Folders ----------------
  upsertFolders(mailboxLocalId: number, folders: { remote_id: number; name: string; type?: string | null; userId?: number | null; totalCount?: number | null; activeCount?: number | null; raw?: unknown }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO folders (remote_id, mailbox_id, name, type, user_id, total_count, active_count, raw_json, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(remote_id) DO UPDATE SET mailbox_id=excluded.mailbox_id, name=excluded.name, type=excluded.type,
         user_id=excluded.user_id, total_count=excluded.total_count, active_count=excluded.active_count,
         raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
    );
    const tx = this.db.transaction(() => {
      for (const f of folders) {
        stmt.run(f.remote_id, mailboxLocalId, f.name, f.type ?? null, f.userId ?? null, f.totalCount ?? 0, f.activeCount ?? 0, JSON.stringify(f.raw ?? f), nowIso());
      }
    });
    tx();
  }

  // ---------------- Users ----------------
  upsertUser(u: { remote_id: number; firstName?: string | null; lastName?: string | null; email?: string | null; role?: string | null; type?: string; timezone?: string | null; photoUrl?: string | null; initials?: string | null; mention?: string | null; jobTitle?: string | null; phone?: string | null; alternateEmails?: string[] | null; createdAt?: string | null; updatedAt?: string | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO users (remote_id, first_name, last_name, email, role, type, timezone, photo_url, initials, mention, job_title, phone, alternate_emails, remote_created_at, remote_updated_at, raw_json, raw_json_hash, last_seen_at, last_synced_at)
         VALUES (@rid, @first, @last, @email, @role, @type, @tz, @photo, @init, @mention, @job, @phone, @alt, @rc, @ru, @raw, @hash, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, email=excluded.email,
           role=excluded.role, type=excluded.type, timezone=excluded.timezone, photo_url=excluded.photo_url, initials=excluded.initials,
           mention=excluded.mention, job_title=excluded.job_title, phone=excluded.phone, alternate_emails=excluded.alternate_emails,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at, raw_json=excluded.raw_json,
           raw_json_hash=excluded.raw_json_hash, last_seen_at=excluded.last_seen_at, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: u.remote_id,
        first: u.firstName ?? null,
        last: u.lastName ?? null,
        email: u.email ?? null,
        role: u.role ?? null,
        type: u.type ?? 'user',
        tz: u.timezone ?? null,
        photo: u.photoUrl ?? null,
        init: u.initials ?? null,
        mention: u.mention ?? null,
        job: u.jobTitle ?? null,
        phone: u.phone ?? null,
        alt: jsonArray(u.alternateEmails ?? []),
        rc: isoOrNull(u.createdAt),
        ru: isoOrNull(u.updatedAt),
        raw: JSON.stringify(u.raw ?? u),
        hash: hashJson(u.raw ?? u),
        seen: nowIso(),
        synced: nowIso()
      });
    return this.getLocalId('users', u.remote_id)!;
  }

  upsertSystemUser(u: { remote_id: number; firstName?: string | null; lastName?: string | null; initials?: string | null; timezone?: string | null; role?: string | null; createdAt?: string | null; updatedAt?: string | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO system_users (remote_id, first_name, last_name, initials, timezone, role, remote_created_at, remote_updated_at, raw_json, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(remote_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, initials=excluded.initials,
           timezone=excluded.timezone, role=excluded.role, remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run(u.remote_id, u.firstName ?? null, u.lastName ?? null, u.initials ?? null, u.timezone ?? null, u.role ?? null, isoOrNull(u.createdAt), isoOrNull(u.updatedAt), JSON.stringify(u.raw ?? u), nowIso());
  }

  getUsers(): UserSummary[] {
    return (this.db.prepare('SELECT id, remote_id, first_name, last_name, email, role, type, timezone, photo_url, initials FROM users WHERE deleted_at IS NULL ORDER BY first_name').all() as UserSummary[]);
  }

  getSystemUsers(): UserSummary[] {
    return this.db
      .prepare("SELECT id, remote_id, first_name, last_name, NULL as email, role, 'system_user' as type, timezone, NULL as photo_url, initials FROM system_users WHERE deleted_at IS NULL ORDER BY first_name")
      .all() as UserSummary[];
  }

  // ---------------- Teams ----------------
  upsertTeam(t: { remote_id: number; name: string; createdAt?: string | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO teams (remote_id, name, remote_created_at, raw_json, last_synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(remote_id) DO UPDATE SET name=excluded.name, remote_created_at=excluded.remote_created_at, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run(t.remote_id, t.name, isoOrNull(t.createdAt), JSON.stringify(t.raw ?? t), nowIso());
    return this.getLocalId('teams', t.remote_id)!;
  }

  upsertTeamMembers(teamLocalId: number, userIds: number[]): void {
    this.db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamLocalId);
    const stmt = this.db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)');
    const tx = this.db.transaction(() => {
      for (const uid of userIds) stmt.run(teamLocalId, uid);
    });
    tx();
  }

  getTeams(): TeamSummary[] {
    return this.db
      .prepare(
        `SELECT t.id, t.remote_id, t.name, (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
         FROM teams t WHERE t.deleted_at IS NULL ORDER BY t.name`
      )
      .all() as TeamSummary[];
  }

  // ---------------- Tags ----------------
  upsertTag(t: { remote_id: number; name: string; slug?: string | null; color?: string | null; ticketCount?: number | null; createdAt?: string | null; updatedAt?: string | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO tags (remote_id, name, slug, color, ticket_count, remote_created_at, remote_updated_at, raw_json, last_seen_at, last_synced_at)
         VALUES (@rid, @name, @slug, @color, @count, @rc, @ru, @raw, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET name=excluded.name, slug=excluded.slug, color=excluded.color,
           ticket_count=excluded.ticket_count, remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           raw_json=excluded.raw_json, last_seen_at=excluded.last_seen_at, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: t.remote_id,
        name: t.name,
        slug: t.slug ?? null,
        color: t.color ?? null,
        count: t.ticketCount ?? 0,
        rc: isoOrNull(t.createdAt),
        ru: isoOrNull(t.updatedAt),
        raw: JSON.stringify(t.raw ?? t),
        seen: nowIso(),
        synced: nowIso()
      });
    return this.getLocalId('tags', t.remote_id)!;
  }

  /** Tags are created implicitly by name when conversations reference them (v3 payloads may carry tag names without global tag records). */
  ensureTagByName(name: string): number {
    const existing = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
    if (existing) return existing.id;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const r = this.db.prepare('INSERT INTO tags (remote_id, name, slug) VALUES (?, ?, ?)').run(-Date.now(), name, slug);
    return Number(r.lastInsertRowid);
  }

  getTags(): TagSummary[] {
    return this.db.prepare('SELECT id, remote_id, name, slug, color, ticket_count FROM tags WHERE deleted_at IS NULL ORDER BY name').all() as TagSummary[];
  }

  findTagsByName(query: string): TagSummary[] {
    return this.db.prepare("SELECT id, remote_id, name, slug, color, ticket_count FROM tags WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100").all(`%${query.replace(/[\\%_]/g, (m) => '\\' + m)}%`) as TagSummary[];
  }

  // ---------------- Inbox fields ----------------
  upsertInboxField(mailboxLocalId: number, f: { remote_id: number; name: string; type?: string | null; systemType?: string | null; required?: boolean | null; order?: number | null; options?: { id: number; order?: number | null; label?: string | null }[] | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO inbox_fields (remote_id, mailbox_id, name, type, system_type, required, sort_order, raw_json, last_synced_at)
         VALUES (@rid, @mailbox, @name, @type, @sys, @req, @ord, @raw, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET mailbox_id=excluded.mailbox_id, name=excluded.name, type=excluded.type,
           system_type=excluded.system_type, required=excluded.required, sort_order=excluded.sort_order, raw_json=excluded.raw_json,
           last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: f.remote_id,
        mailbox: mailboxLocalId,
        name: f.name,
        type: f.type ?? null,
        sys: f.systemType ?? null,
        req: f.required ? 1 : 0,
        ord: f.order ?? 0,
        raw: JSON.stringify(f.raw ?? f),
        synced: nowIso()
      });
    const fieldId = this.getLocalId('inbox_fields', f.remote_id)!;
    if (f.options) {
      this.db.prepare('DELETE FROM inbox_field_options WHERE field_id = ?').run(fieldId);
      const stmt = this.db.prepare('INSERT OR REPLACE INTO inbox_field_options (remote_id, field_id, label, sort_order) VALUES (?, ?, ?, ?)');
      const tx = this.db.transaction(() => {
        for (const o of f.options ?? []) stmt.run(o.id, fieldId, o.label ?? '', o.order ?? 0);
      });
      tx();
    }
    return fieldId;
  }

  getInboxFields(): CustomFieldSummary[] {
    const fields = this.db
      .prepare(
        `SELECT f.id, f.remote_id, f.mailbox_id, f.name, f.type, f.system_type, f.required, f.sort_order AS \`order\`
         FROM inbox_fields f WHERE f.deleted_at IS NULL ORDER BY f.mailbox_id, f.sort_order`
      )
      .all() as (CustomFieldSummary & { order: number })[];
    const optStmt = this.db.prepare('SELECT id, remote_id, label, sort_order FROM inbox_field_options WHERE field_id = ? ORDER BY sort_order');
    return fields.map((f) => ({ ...f, options: optStmt.all(f.id) as CustomFieldSummary['options'] }));
  }

  getInboxFieldsForMailbox(mailboxLocalId: number): CustomFieldSummary[] {
    return this.getInboxFields().filter((f) => f.mailbox_id === mailboxLocalId);
  }

  // ---------------- Saved replies ----------------
  upsertSavedReply(r: { remote_id: number; mailboxLocalId?: number | null; name: string; preview?: string | null; text?: string | null; chatText?: string | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO saved_replies (remote_id, mailbox_local_id, name, preview, text, chat_text, raw_json, last_synced_at)
         VALUES (@rid, @mailbox, @name, @preview, @text, @chat, @raw, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET mailbox_local_id=excluded.mailbox_local_id, name=excluded.name, preview=excluded.preview,
           text=excluded.text, chat_text=excluded.chat_text, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: r.remote_id,
        mailbox: r.mailboxLocalId ?? null,
        name: r.name,
        preview: r.preview ?? null,
        text: r.text ?? null,
        chat: r.chatText ?? null,
        raw: JSON.stringify(r.raw ?? r),
        synced: nowIso()
      });
    const id = this.getLocalId('saved_replies', r.remote_id)!;
    this.db.prepare('DELETE FROM fts_saved_replies WHERE saved_reply_id = ?').run(id);
    this.db
      .prepare('INSERT INTO fts_saved_replies (saved_reply_id, name, preview, text) VALUES (?, ?, ?, ?)')
      .run(id, r.name, r.preview ?? '', r.text ?? r.preview ?? '');
  }

  getSavedReplies(): SavedReplySummary[] {
    return this.db
      .prepare('SELECT id, remote_id, mailbox_local_id AS mailbox_id, name, preview, text, remote_updated_at AS updated_at FROM saved_replies WHERE deleted_at IS NULL ORDER BY name')
      .all() as SavedReplySummary[];
  }

  searchSavedReplies(query: string): SavedReplySummary[] {
    if (!query.trim()) return this.getSavedReplies();
    return this.db
      .prepare(
        `SELECT sr.id, sr.remote_id, sr.mailbox_local_id AS mailbox_id, sr.name, sr.preview, sr.text, sr.remote_updated_at AS updated_at
         FROM fts_saved_replies f JOIN saved_replies sr ON sr.id = f.saved_reply_id
         WHERE fts_saved_replies MATCH ? AND sr.deleted_at IS NULL ORDER BY rank LIMIT 50`
      )
      .all(this.ftsQuery(query)) as SavedReplySummary[];
  }

  // ---------------- Workflows ----------------
  upsertWorkflow(w: { remote_id: number; mailboxLocalId?: number | null; name: string; type?: string | null; status?: string | null; order?: number | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO workflows (remote_id, mailbox_local_id, name, type, status, sort_order, raw_json, last_synced_at)
         VALUES (@rid, @mailbox, @name, @type, @status, @ord, @raw, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET mailbox_local_id=excluded.mailbox_local_id, name=excluded.name, type=excluded.type,
           status=excluded.status, sort_order=excluded.sort_order, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: w.remote_id,
        mailbox: w.mailboxLocalId ?? null,
        name: w.name,
        type: w.type ?? null,
        status: w.status ?? null,
        ord: w.order ?? null,
        raw: JSON.stringify(w.raw ?? w),
        synced: nowIso()
      });
  }

  getWorkflows(): WorkflowSummary[] {
    return this.db
      .prepare('SELECT id, remote_id, mailbox_local_id AS mailbox_id, name, type, status, sort_order AS "order" FROM workflows WHERE deleted_at IS NULL ORDER BY sort_order')
      .all() as WorkflowSummary[];
  }

  // ---------------- Routing / user statuses / webhooks ----------------
  upsertRoutingConfiguration(mailboxLocalId: number, raw: unknown): void {
    this.db
      .prepare(
        `INSERT INTO routing_configurations (mailbox_local_id, raw_json, last_synced_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run(mailboxLocalId, JSON.stringify(raw), nowIso());
  }

  upsertUserStatus(userLocalId: number, s: { email?: { status?: string | null; updatedAt?: string | null } | null; chat?: { status?: string | null; mailboxStatuses?: Record<string, string> } | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO user_statuses (user_local_id, email_status, email_updated_at, chat_status, mailbox_statuses, raw_json, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_local_id) DO UPDATE SET email_status=excluded.email_status, email_updated_at=excluded.email_updated_at,
           chat_status=excluded.chat_status, mailbox_statuses=excluded.mailbox_statuses, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run(userLocalId, s.email?.status ?? null, isoOrNull(s.email?.updatedAt), s.chat?.status ?? null, jsonArray(s.chat?.mailboxStatuses ?? {}), JSON.stringify(s.raw ?? s), nowIso());
  }

  getUserStatuses(): UserStatusInfo[] {
    return (this.db
      .prepare(
        `SELECT user_local_id AS user_id, email_status, chat_status, mailbox_statuses FROM user_statuses
         JOIN users ON users.id = user_statuses.user_local_id WHERE users.deleted_at IS NULL`
      )
      .all() as (UserStatusInfo & { mailbox_statuses: string })[]).map((r) => ({
      ...r,
      mailbox_statuses: JSON.parse(r.mailbox_statuses || '{}')
    }));
  }

  upsertWebhookConfig(w: { remote_id: number; url: string; events: string[]; status?: string | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO webhook_configs (remote_id, url, events, status, raw_json, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(remote_id) DO UPDATE SET url=excluded.url, events=excluded.events, status=excluded.status, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run(w.remote_id, w.url, jsonArray(w.events), w.status ?? null, JSON.stringify(w.raw ?? w), nowIso());
  }

  getWebhookConfigs(): WebhookConfigInfo[] {
    return (this.db.prepare('SELECT id, remote_id, url, events, status FROM webhook_configs').all() as (WebhookConfigInfo & { events: string })[]).map((r) => ({
      ...r,
      events: JSON.parse(r.events || '[]')
    }));
  }

  // ---------------- Account ----------------
  upsertAccount(a: { remote_id?: number | null; plan?: string | null; companyName?: string | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO accounts (remote_id, plan, company_name, raw_json, raw_json_hash, last_seen_at)
         VALUES (@rid, @plan, @company, @raw, @hash, @seen)
         ON CONFLICT(remote_id) DO UPDATE SET plan=excluded.plan, company_name=excluded.company_name, raw_json=excluded.raw_json,
           raw_json_hash=excluded.raw_json_hash, last_seen_at=excluded.last_seen_at`
      )
      .run({ rid: a.remote_id ?? 1, plan: a.plan ?? null, company: a.companyName ?? null, raw: JSON.stringify(a.raw ?? a), hash: hashJson(a.raw ?? a), seen: nowIso() });
  }

  // ---------------- Property definitions ----------------
  upsertPropertyDefinitions(kind: 'customer' | 'organization', defs: { remote_id: number; name: string; slug?: string | null; type?: string | null; order?: number | null; raw?: unknown }[]): void {
    const table = kind === 'customer' ? 'customer_property_definitions' : 'organization_property_definitions';
    const stmt = this.db.prepare(
      `INSERT INTO ${table} (remote_id, name, slug, type, sort_order, raw_json, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(remote_id) DO UPDATE SET name=excluded.name, slug=excluded.slug, type=excluded.type, sort_order=excluded.sort_order,
         raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
    );
    const tx = this.db.transaction(() => {
      for (const d of defs) stmt.run(d.remote_id, d.name, d.slug ?? null, d.type ?? null, d.order ?? 0, JSON.stringify(d.raw ?? d), nowIso());
    });
    tx();
  }

  getPropertyDefinitions(kind: 'customer' | 'organization'): { id: number; remote_id: number; name: string; type: string | null }[] {
    const table = kind === 'customer' ? 'customer_property_definitions' : 'organization_property_definitions';
    return this.db.prepare(`SELECT id, remote_id, name, type FROM ${table} WHERE deleted_at IS NULL ORDER BY sort_order`).all() as { id: number; remote_id: number; name: string; type: string | null }[];
  }

  // ---------------- helpers ----------------
  getLocalId(table: string, remoteId: number): number | null {
    const row = this.db.prepare(`SELECT id FROM ${table} WHERE remote_id = ?`).get(remoteId) as { id: number } | undefined;
    return row ? row.id : null;
  }

  ftsQuery(q: string): string {
    // Build a safe FTS5 match query: phrase-ish with prefix matching per token
    const tokens = q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
    if (tokens.length === 0) return '""';
    return tokens.map((t) => `"${t}"*`).join(' ');
  }
}
