import type { DB } from '../connection.js';
import type { IncidentStatus, IncidentSeverity } from '../../../shared/workspace.js';

export type { IncidentStatus, IncidentSeverity };

export interface IncidentRecord {
  id: number;
  code: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  owner_user_local_id: number | null;
  product: string | null;
  feature: string | null;
  description: string | null;
  internal_explanation: string | null;
  customer_safe_explanation: string | null;
  known_cause: string | null;
  workaround: string | null;
  resolution: string | null;
  started_at: string | null;
  resolved_at: string | null;
  source: string;
  provenance: string;
  created_at: string;
  updated_at: string;
}

export interface IncidentListRow extends IncidentRecord {
  conversation_count: number;
  customer_count: number;
  organization_count: number;
  owner_name: string | null;
}

export interface IncidentConversationRow {
  conversation_id: number;
  number: number;
  subject: string | null;
  status: string;
  mailbox: string | null;
  customer_local_id: number | null;
  customer_name: string | null;
  remote_created_at: string | null;
  linked_by: string;
  linked_at: string;
}

export interface IncidentEventRecord {
  id: number;
  incident_id: number;
  event_type: string;
  actor_user_local_id: number | null;
  occurred_at: string;
  detail: string | null;
  source: string;
}

export interface IncidentRefRecord {
  id: number;
  incident_id: number;
  system: string;
  reference: string;
  url: string | null;
  title: string | null;
  status: string | null;
  notes: string | null;
  created_at: string;
}

export interface IncidentReleaseRecord {
  id: number;
  incident_id: number;
  version_label: string;
  notes: string | null;
  released_at: string | null;
  correlation: string | null;
  created_at: string;
}

export interface IncidentNoteRecord {
  id: number;
  incident_id: number;
  author_user_local_id: number | null;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface IncidentRelatedRecord {
  incident_id: number;
  target_kind: string;
  target_local_id: number;
  target_label: string;
  note: string | null;
  linked_at: string;
}

const INCIDENT_EVENT_TYPES = [
  'created', 'status_changed', 'severity_changed', 'owner_changed', 'field_updated',
  'conversation_linked', 'conversation_unlinked', 'note_added',
  'related_linked', 'related_unlinked', 'ref_added', 'release_added'
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];
export { INCIDENT_EVENT_TYPES };

/**
 * Incidents / master issues (plan Phase 18). LOCAL-ONLY workspace data: no
 * row here ever syncs to Help Scout. Affected customers and organizations
 * are always DERIVED from the linked conversations - never stored, so they
 * can never drift from the mirror. Every mutation appends an idempotent
 * timeline event (dedup_key UNIQUE).
 */
export class IncidentRepository {
  constructor(private db: DB) {}

  /** INC-### code: max numeric suffix + 1, zero-padded to 3, computed in the
   *  insert transaction so concurrent creates cannot collide. */
  private nextCode(): string {
    const row = this.db.prepare("SELECT MAX(CAST(substr(code, 5) AS INTEGER)) AS maxn FROM incidents WHERE code LIKE 'INC-%' AND length(code) >= 5 AND substr(code, 5) GLOB '[0-9]*'").get() as { maxn: number | null };
    const next = (row?.maxn ?? 0) + 1;
    return `INC-${String(next).padStart(3, '0')}`;
  }

  private recordEvent(incidentId: number, eventType: IncidentEventType, detail: Record<string, unknown>, actorUserId: number | null, dedupSuffix: string): void {
    const dedup = `incident:${incidentId}:${eventType}:${dedupSuffix}`;
    this.db
      .prepare('INSERT OR IGNORE INTO incident_events (incident_id, event_type, actor_user_local_id, detail, dedup_key) VALUES (?, ?, ?, ?, ?)')
      .run(incidentId, eventType, actorUserId, JSON.stringify(detail).slice(0, 4000), dedup);
  }

  create(input: {
    title: string;
    status?: IncidentStatus;
    severity?: IncidentSeverity;
    ownerUserId?: number | null;
    product?: string | null;
    feature?: string | null;
    description?: string | null;
    internalExplanation?: string | null;
    customerSafeExplanation?: string | null;
    knownCause?: string | null;
    workaround?: string | null;
    resolution?: string | null;
    startedAt?: string | null;
    source?: string;
    conversationIds?: number[];
    actorUserId?: number | null;
  }): IncidentRecord {
    const tx = this.db.transaction(() => {
      const code = this.nextCode();
      const status = input.status ?? 'investigating';
      const r = this.db
        .prepare(
          `INSERT INTO incidents (code, title, status, severity, owner_user_local_id, product, feature, description,
             internal_explanation, customer_safe_explanation, known_cause, workaround, resolution, started_at,
             resolved_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code, input.title, status, input.severity ?? 'sev3', input.ownerUserId ?? null,
          input.product ?? null, input.feature ?? null, input.description ?? null,
          input.internalExplanation ?? null, input.customerSafeExplanation ?? null,
          input.knownCause ?? null, input.workaround ?? null, input.resolution ?? null,
          input.startedAt ?? null, status === 'resolved' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
          input.source ?? 'manual'
        );
      const id = Number(r.lastInsertRowid);
      this.recordEvent(id, 'created', { code, title: input.title, status, severity: input.severity ?? 'sev3' }, input.actorUserId ?? null, '0');
      const link = this.db.prepare('INSERT OR IGNORE INTO incident_conversations (incident_id, conversation_id, linked_by) VALUES (?, ?, ?)');
      for (const convId of input.conversationIds ?? []) {
        link.run(id, convId, 'human');
        this.recordEvent(id, 'conversation_linked', { conversation_id: convId }, input.actorUserId ?? null, `conv:${convId}`);
      }
      return id;
    });
    const id = tx() as number;
    return this.get(id)!;
  }

  get(id: number): IncidentRecord | undefined {
    return this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRecord | undefined;
  }

  getByCode(code: string): IncidentRecord | undefined {
    return this.db.prepare('SELECT * FROM incidents WHERE code = ?').get(code) as IncidentRecord | undefined;
  }

  list(filters: { status?: string; severity?: string; open?: boolean; query?: string; limit?: number; offset?: number } = {}): { incidents: IncidentListRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.status) { where.push('i.status = ?'); params.push(filters.status); }
    if (filters.severity) { where.push('i.severity = ?'); params.push(filters.severity); }
    if (filters.open) { where.push("i.status != 'resolved'"); }
    if (filters.query) { where.push('(i.title LIKE ? OR i.code LIKE ?)'); params.push(`%${filters.query}%`, `%${filters.query}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT i.*,
           (SELECT COUNT(*) FROM incident_conversations ic WHERE ic.incident_id = i.id) AS conversation_count,
           (SELECT COUNT(DISTINCT c.customer_local_id) FROM incident_conversations ic
              JOIN conversations c ON c.id = ic.conversation_id
              WHERE ic.incident_id = i.id AND c.customer_local_id IS NOT NULL AND c.deleted_at IS NULL) AS customer_count,
           (SELECT COUNT(DISTINCT cu.organization_id) FROM incident_conversations ic
              JOIN conversations c ON c.id = ic.conversation_id
              JOIN customers cu ON cu.id = c.customer_local_id
              WHERE ic.incident_id = i.id AND c.deleted_at IS NULL AND cu.organization_id IS NOT NULL) AS organization_count,
           (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) FROM users u WHERE u.id = i.owner_user_local_id) AS owner_name
         FROM incidents i ${whereSql}
         ORDER BY CASE i.status WHEN 'resolved' THEN 1 ELSE 0 END, i.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as IncidentListRow[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM incidents i ${whereSql}`).get(...params) as { n: number }).n;
    return { incidents: rows, total };
  }

  patch(id: number, changes: Record<string, unknown>, actorUserId: number | null): IncidentRecord | undefined {
    const before = this.get(id);
    if (!before) return undefined;
    const allowed = ['title', 'status', 'severity', 'owner_user_local_id', 'product', 'feature', 'description',
      'internal_explanation', 'customer_safe_explanation', 'known_cause', 'workaround', 'resolution', 'started_at', 'resolved_at'];
    const entries = Object.entries(changes).filter(([k]) => allowed.includes(k));
    if (entries.length === 0) return before;
    const tx = this.db.transaction(() => {
      const sets = entries.map(([k]) => `${k} = ?`).join(', ');
      this.db.prepare(`UPDATE incidents SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...entries.map(([, v]) => v), id);
      // Status transition bookkeeping + timeline events for meaningful changes.
      if (changes.status != null && changes.status !== before.status) {
        if (changes.status === 'resolved') {
          this.db.prepare("UPDATE incidents SET resolved_at = COALESCE(resolved_at, datetime('now')) WHERE id = ?").run(id);
        } else {
          this.db.prepare('UPDATE incidents SET resolved_at = NULL WHERE id = ?').run(id);
        }
        this.recordEvent(id, 'status_changed', { from: before.status, to: changes.status }, actorUserId, `${before.status}->${changes.status}`);
      }
      if (changes.severity != null && changes.severity !== before.severity) {
        this.recordEvent(id, 'severity_changed', { from: before.severity, to: changes.severity }, actorUserId, `${before.severity}->${changes.severity}`);
      }
      if (changes.owner_user_local_id !== undefined && changes.owner_user_local_id !== before.owner_user_local_id) {
        this.recordEvent(id, 'owner_changed', { from: before.owner_user_local_id, to: changes.owner_user_local_id }, actorUserId, `${before.owner_user_local_id}->${changes.owner_user_local_id}`);
      }
      const labelMap: Record<string, string> = {
        title: 'Title', product: 'Product', feature: 'Feature', description: 'Description',
        internal_explanation: 'Internal explanation', customer_safe_explanation: 'Customer-safe explanation',
        known_cause: 'Known cause', workaround: 'Workaround', resolution: 'Resolution', started_at: 'Start date'
      };
      for (const [k, label] of Object.entries(labelMap)) {
        if (changes[k] !== undefined && changes[k] !== (before as unknown as Record<string, unknown>)[k]) {
          this.recordEvent(id, 'field_updated', { field: label }, actorUserId, `${k}:${new Date().toISOString()}`);
        }
      }
    });
    tx();
    return this.get(id);
  }

  // ---------------- Conversation links ----------------

  linkConversation(incidentId: number, conversationId: number, linkedBy: 'human' | 'derived', actorUserId: number | null): boolean {
    const exists = this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId);
    if (!exists) return false;
    const r = this.db.prepare('INSERT OR IGNORE INTO incident_conversations (incident_id, conversation_id, linked_by) VALUES (?, ?, ?)').run(incidentId, conversationId, linkedBy);
    if (r.changes > 0) {
      this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
      this.recordEvent(incidentId, 'conversation_linked', { conversation_id: conversationId }, actorUserId, `conv:${conversationId}`);
      return true;
    }
    return false;
  }

  unlinkConversation(incidentId: number, conversationId: number, actorUserId: number | null): boolean {
    const r = this.db.prepare('DELETE FROM incident_conversations WHERE incident_id = ? AND conversation_id = ?').run(incidentId, conversationId);
    if (r.changes > 0) {
      this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
      this.recordEvent(incidentId, 'conversation_unlinked', { conversation_id: conversationId }, actorUserId, `conv:${conversationId}`);
      return true;
    }
    return false;
  }

  listConversations(incidentId: number, limit = 200): IncidentConversationRow[] {
    return this.db
      .prepare(
        `SELECT ic.conversation_id, c.number, c.subject, c.status,
           (SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id) AS mailbox,
           c.customer_local_id,
           (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu WHERE cu.id = c.customer_local_id) AS customer_name,
           c.remote_created_at, ic.linked_by, ic.linked_at
         FROM incident_conversations ic
         JOIN conversations c ON c.id = ic.conversation_id
         WHERE ic.incident_id = ? AND c.deleted_at IS NULL
         ORDER BY c.remote_created_at DESC
         LIMIT ?`
      )
      .all(incidentId, Math.min(500, limit)) as IncidentConversationRow[];
  }

  /** The active (non-resolved) incident a conversation is linked to, if any. */
  activeIncidentForConversation(conversationId: number): { incident_id: number; code: string; title: string; severity: string; status: string } | null {
    return (this.db
      .prepare(
        `SELECT i.id AS incident_id, i.code, i.title, i.severity, i.status
         FROM incident_conversations ic JOIN incidents i ON i.id = ic.incident_id
         WHERE ic.conversation_id = ? AND i.status != 'resolved'
         ORDER BY CASE i.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END, i.updated_at DESC
         LIMIT 1`
      )
      .get(conversationId) as { incident_id: number; code: string; title: string; severity: string; status: string } | null) ?? null;
  }

  /** Customers affected by this incident (DERIVED from linked conversations - plan Phase 18/19). */
  affectedCustomers(incidentId: number, limit = 100): { customer_local_id: number; name: string | null; email: string | null; organization: string | null; conversations: number; open_conversations: number }[] {
    return this.db
      .prepare(
        `SELECT c.customer_local_id,
           (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu WHERE cu.id = c.customer_local_id) AS name,
           (SELECT ce.value FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id LIMIT 1) AS email,
           (SELECT o.name FROM customers cu LEFT JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = c.customer_local_id) AS organization,
           COUNT(*) AS conversations,
           SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS open_conversations
         FROM incident_conversations ic JOIN conversations c ON c.id = ic.conversation_id
         WHERE ic.incident_id = ? AND c.deleted_at IS NULL AND c.customer_local_id IS NOT NULL
         GROUP BY c.customer_local_id
         ORDER BY conversations DESC, c.customer_local_id
         LIMIT ?`
      )
      .all(incidentId, Math.min(500, limit)) as { customer_local_id: number; name: string | null; email: string | null; organization: string | null; conversations: number; open_conversations: number }[];
  }

  /** Organizations affected (derived via linked conversations' customers). */
  affectedOrganizations(incidentId: number, limit = 50): { organization_id: number; name: string | null; customers: number; conversations: number }[] {
    return this.db
      .prepare(
        `SELECT cu.organization_id AS organization_id,
           (SELECT o.name FROM organizations o WHERE o.id = cu.organization_id) AS name,
           COUNT(DISTINCT c.customer_local_id) AS customers,
           COUNT(*) AS conversations
         FROM incident_conversations ic
         JOIN conversations c ON c.id = ic.conversation_id
         JOIN customers cu ON cu.id = c.customer_local_id
         WHERE ic.incident_id = ? AND c.deleted_at IS NULL AND cu.organization_id IS NOT NULL
         GROUP BY cu.organization_id
         ORDER BY conversations DESC
         LIMIT ?`
      )
      .all(incidentId, Math.min(200, limit)) as { organization_id: number; name: string | null; customers: number; conversations: number }[];
  }

  // ---------------- Related entities / refs / releases / notes ----------------

  addRelated(incidentId: number, targetKind: string, targetLocalId: number, note: string | null, actorUserId: number | null): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO incident_related (incident_id, target_kind, target_local_id, note) VALUES (?, ?, ?, ?)').run(incidentId, targetKind, targetLocalId, note);
    if (r.changes > 0) {
      this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
      this.recordEvent(incidentId, 'related_linked', { target_kind: targetKind, target_local_id: targetLocalId }, actorUserId, `${targetKind}:${targetLocalId}`);
      return true;
    }
    return false;
  }

  removeRelated(incidentId: number, targetKind: string, targetLocalId: number, actorUserId: number | null): boolean {
    const r = this.db.prepare('DELETE FROM incident_related WHERE incident_id = ? AND target_kind = ? AND target_local_id = ?').run(incidentId, targetKind, targetLocalId);
    if (r.changes > 0) {
      this.recordEvent(incidentId, 'related_unlinked', { target_kind: targetKind, target_local_id: targetLocalId }, actorUserId, `${targetKind}:${targetLocalId}`);
      return true;
    }
    return false;
  }

  listRelated(incidentId: number): IncidentRelatedRecord[] {
    const rows = this.db
      .prepare('SELECT incident_id, target_kind, target_local_id, note, linked_at FROM incident_related WHERE incident_id = ? ORDER BY linked_at DESC')
      .all(incidentId) as (Omit<IncidentRelatedRecord, 'target_label'>)[];
    return rows.map((r) => ({ ...r, target_label: this.labelFor(r.target_kind, r.target_local_id) }));
  }

  private labelFor(kind: string, id: number): string {
    switch (kind) {
      case 'known_issue': return String((this.db.prepare('SELECT title FROM known_issues WHERE id = ?').get(id) as { title: string } | undefined)?.title ?? `known issue #${id}`);
      case 'knowledge_doc': return String((this.db.prepare('SELECT title FROM knowledge_documents WHERE id = ?').get(id) as { title: string } | undefined)?.title ?? `document #${id}`);
      case 'campaign': return String((this.db.prepare('SELECT name FROM outreach_campaigns WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `campaign #${id}`);
      case 'custom_object': return String((this.db.prepare('SELECT title FROM custom_objects WHERE id = ?').get(id) as { title: string } | undefined)?.title ?? `object #${id}`);
      default: return `#${id}`;
    }
  }

  addRef(incidentId: number, ref: { system: string; reference: string; url?: string | null; title?: string | null; status?: string | null; notes?: string | null }): number {
    const r = this.db
      .prepare('INSERT INTO incident_refs (incident_id, system, reference, url, title, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(incidentId, ref.system, ref.reference, ref.url ?? null, ref.title ?? null, ref.status ?? null, ref.notes ?? null);
    this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
    this.recordEvent(incidentId, 'ref_added', { system: ref.system, reference: ref.reference }, null, `ref:${ref.system}:${ref.reference}`);
    return Number(r.lastInsertRowid);
  }

  deleteRef(incidentId: number, refId: number): boolean {
    return this.db.prepare('DELETE FROM incident_refs WHERE id = ? AND incident_id = ?').run(refId, incidentId).changes > 0;
  }

  listRefs(incidentId: number): IncidentRefRecord[] {
    return this.db.prepare('SELECT * FROM incident_refs WHERE incident_id = ? ORDER BY id').all(incidentId) as IncidentRefRecord[];
  }

  addRelease(incidentId: number, rel: { versionLabel: string; notes?: string | null; releasedAt?: string | null; correlation?: string | null }): number {
    const r = this.db
      .prepare('INSERT INTO incident_releases (incident_id, version_label, notes, released_at, correlation) VALUES (?, ?, ?, ?, ?)')
      .run(incidentId, rel.versionLabel, rel.notes ?? null, rel.releasedAt ?? null, rel.correlation ?? null);
    this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
    this.recordEvent(incidentId, 'release_added', { version_label: rel.versionLabel }, null, `release:${rel.versionLabel}`);
    return Number(r.lastInsertRowid);
  }

  deleteRelease(incidentId: number, releaseId: number): boolean {
    return this.db.prepare('DELETE FROM incident_releases WHERE id = ? AND incident_id = ?').run(releaseId, incidentId).changes > 0;
  }

  listReleases(incidentId: number): IncidentReleaseRecord[] {
    return this.db.prepare('SELECT * FROM incident_releases WHERE incident_id = ? ORDER BY id DESC').all(incidentId) as IncidentReleaseRecord[];
  }

  addNote(incidentId: number, body: string, authorUserId: number | null): IncidentNoteRecord {
    const r = this.db.prepare('INSERT INTO incident_notes (incident_id, author_user_local_id, body) VALUES (?, ?, ?)').run(incidentId, authorUserId, body);
    this.db.prepare("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?").run(incidentId);
    this.recordEvent(incidentId, 'note_added', { note_id: Number(r.lastInsertRowid) }, authorUserId, `note:${r.lastInsertRowid}`);
    return this.getNote(Number(r.lastInsertRowid))!;
  }

  getNote(noteId: number): IncidentNoteRecord | undefined {
    return (this.db
      .prepare(
        `SELECT n.*, (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) FROM users u WHERE u.id = n.author_user_local_id) AS author_name
         FROM incident_notes n WHERE n.id = ?`
      )
      .get(noteId) as IncidentNoteRecord | undefined);
  }

  listNotes(incidentId: number, limit = 100): IncidentNoteRecord[] {
    return this.db
      .prepare(
        `SELECT n.*, (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) FROM users u WHERE u.id = n.author_user_local_id) AS author_name
         FROM incident_notes n WHERE n.incident_id = ? ORDER BY n.created_at DESC LIMIT ?`
      )
      .all(incidentId, Math.min(200, limit)) as IncidentNoteRecord[];
  }

  // ---------------- Timeline ----------------

  listEvents(incidentId: number, limit = 200): IncidentEventRecord[] {
    return this.db
      .prepare('SELECT id, incident_id, event_type, actor_user_local_id, occurred_at, detail, source FROM incident_events WHERE incident_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?')
      .all(incidentId, Math.min(500, limit)) as IncidentEventRecord[];
  }

  delete(id: number): boolean {
    const tx = this.db.transaction(() => {
      return this.db.prepare('DELETE FROM incidents WHERE id = ?').run(id);
    });
    return tx().changes > 0;
  }
}
