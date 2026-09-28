import type { DB } from '../connection.js';
import type { CustomerEventKind } from '../../../shared/workspace.js';

export interface CustomerEventRecord {
  id: number;
  customer_local_id: number;
  event_kind: CustomerEventKind;
  occurred_at: string | null;
  title: string;
  detail: Record<string, unknown> | null;
  source: string;
  source_ref: string | null;
  created_at: string;
}

/**
 * Customer event timeline (plan Phase 23). Append-only local event log per
 * customer with stable dedup keys - every producer (backfill, sweep,
 * custom-object links, future connectors) inserts with INSERT OR IGNORE,
 * so nothing can ever double-fire. The broader timeline is INDEPENDENT of
 * ticket history: conversations contribute events, but so do campaigns,
 * ratings, incidents and custom objects. Kinds without an observable
 * source stay absent (the honest state).
 */
export class CustomerEventRepository {
  constructor(private db: DB) {}

  /** Idempotent insert. Returns true when a NEW event was created. */
  insertEvent(input: {
    customer_local_id: number;
    event_kind: CustomerEventKind;
    occurred_at?: string | null;
    title: string;
    detail?: Record<string, unknown> | null;
    source?: string;
    source_ref?: string | null;
    dedup_key: string;
  }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO customer_events
           (customer_local_id, event_kind, occurred_at, title, detail, source, source_ref, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.customer_local_id, input.event_kind, input.occurred_at ?? null, input.title,
        input.detail ? JSON.stringify(input.detail).slice(0, 4000) : null,
        input.source ?? 'local_derived', input.source_ref ?? null, input.dedup_key
      );
    return r.changes > 0;
  }

  listForCustomer(customerLocalId: number, kind: string | null, limit = 100, offset = 0): { events: CustomerEventRecord[]; total: number } {
    const where = kind ? 'WHERE ce.customer_local_id = ? AND ce.event_kind = ?' : 'WHERE ce.customer_local_id = ?';
    const params: unknown[] = kind ? [customerLocalId, kind] : [customerLocalId];
    const rows = this.db
      .prepare(`SELECT * FROM customer_events ce ${where} ORDER BY COALESCE(ce.occurred_at, ce.created_at) DESC, ce.id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, limit), Math.max(0, offset)) as (Omit<CustomerEventRecord, 'detail'> & { detail: string | null })[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM customer_events ce ${where}`).get(...params) as { n: number }).n;
    return { events: rows.map(this.hydrate), total };
  }

  /** Organization timeline = union of member customers' events (no copies). */
  listForOrganization(organizationId: number, kind: string | null, limit = 100, offset = 0): { events: (CustomerEventRecord & { customer_name: string | null })[]; total: number } {
    const where = kind
      ? 'WHERE cu.organization_id = ? AND ce.event_kind = ?'
      : 'WHERE cu.organization_id = ?';
    const params: unknown[] = kind ? [organizationId, kind] : [organizationId];
    const rows = this.db
      .prepare(
        `SELECT ce.*, (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu2 WHERE cu2.id = ce.customer_local_id) AS customer_name
         FROM customer_events ce
         JOIN customers cu ON cu.id = ce.customer_local_id
         ${where}
         ORDER BY COALESCE(ce.occurred_at, ce.created_at) DESC, ce.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, Math.min(200, limit), Math.max(0, offset)) as ((Omit<CustomerEventRecord, 'detail'> & { detail: string | null; customer_name: string | null }))[];
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM customer_events ce JOIN customers cu ON cu.id = ce.customer_local_id ${where}`)
      .get(...params) as { n: number }).n;
    return { events: rows.map((r) => this.hydrate(r) as CustomerEventRecord & { customer_name: string | null }), total };
  }

  kindCounts(customerLocalId: number): { kind: string; n: number }[] {
    return this.db
      .prepare('SELECT event_kind AS kind, COUNT(*) AS n FROM customer_events WHERE customer_local_id = ? GROUP BY event_kind ORDER BY n DESC')
      .all(customerLocalId) as { kind: string; n: number }[];
  }

  private hydrate(r: Omit<CustomerEventRecord, 'detail'> & { detail: string | null }): CustomerEventRecord {
    let detail: Record<string, unknown> | null = null;
    if (r.detail) {
      try { detail = JSON.parse(r.detail) as Record<string, unknown>; } catch { detail = null; }
    }
    return { ...r, detail };
  }
}
