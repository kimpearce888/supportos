import type { DB } from '../connection.js';
import { nowIso, hashJson, isoOrNull } from './helpers.js';
import type { CustomerSummary, OrganizationSummary } from '../../../shared/types.js';

interface CustomerV3 {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  address?: Record<string, unknown> | null;
  emails?: { value?: string | null; type?: string | null }[] | null;
  phones?: { value?: string | null; type?: string | null }[] | null;
  websites?: { value?: string | null }[] | null;
  socialProfiles?: { value?: string | null; type?: string | null }[] | null;
  organization?: { id: number; name?: string | null } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

/** Customers + organizations repository. */
export class PeopleRepository {
  constructor(private db: DB) {}

  // ---------------- Customers ----------------
  upsertCustomer(c: CustomerV3): number {
    const orgLocal = c.organization?.id ? this.getOrganizationByRemoteId(c.organization.id) : null;
    this.db
      .prepare(
        `INSERT INTO customers (remote_id, first_name, last_name, photo_url, job_title, organization_id, raw_json, raw_json_hash, remote_created_at, remote_updated_at, last_seen_at, last_synced_at)
         VALUES (@rid, @first, @last, @photo, @job, @org, @raw, @hash, @rc, @ru, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, photo_url=excluded.photo_url,
           job_title=excluded.job_title, organization_id=excluded.organization_id, raw_json=excluded.raw_json, raw_json_hash=excluded.raw_json_hash,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at, last_seen_at=excluded.last_seen_at,
           last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: c.id,
        first: c.firstName ?? null,
        last: c.lastName ?? null,
        photo: c.photoUrl ?? null,
        job: c.jobTitle ?? null,
        org: orgLocal?.id ?? null,
        raw: JSON.stringify(c),
        hash: hashJson(c),
        rc: isoOrNull(c.createdAt),
        ru: isoOrNull(c.updatedAt),
        seen: nowIso(),
        synced: nowIso()
      });
    const localId = (this.db.prepare('SELECT id FROM customers WHERE remote_id = ?').get(c.id) as { id: number }).id;

    // Sub-records
    if (c.emails) {
      this.db.prepare('DELETE FROM customer_emails WHERE customer_id = ?').run(localId);
      const stmt = this.db.prepare('INSERT OR REPLACE INTO customer_emails (remote_id, customer_id, value, type) VALUES (?, ?, ?, ?)');
      const tx = this.db.transaction(() => {
        (c.emails ?? []).forEach((e, i) => {
          if (e.value) stmt.run(-localId * 1000 - i, localId, e.value, e.type ?? 'default');
        });
      });
      tx();
    }
    if (c.phones) {
      this.db.prepare('DELETE FROM customer_phones WHERE customer_id = ?').run(localId);
      const stmt = this.db.prepare('INSERT INTO customer_phones (remote_id, customer_id, value, type) VALUES (?, ?, ?, ?)');
      const tx = this.db.transaction(() => {
        (c.phones ?? []).forEach((p, i) => stmt.run(-localId * 1000 - i, localId, p.value ?? null, p.type ?? null));
      });
      tx();
    }
    if (c.websites) {
      this.db.prepare('DELETE FROM customer_websites WHERE customer_id = ?').run(localId);
      const stmt = this.db.prepare('INSERT INTO customer_websites (remote_id, customer_id, value) VALUES (?, ?, ?)');
      const tx = this.db.transaction(() => {
        (c.websites ?? []).forEach((w, i) => stmt.run(-localId * 1000 - i, localId, w.value ?? null));
      });
      tx();
    }
    if (c.socialProfiles) {
      this.db.prepare('DELETE FROM customer_social_profiles WHERE customer_id = ?').run(localId);
      const stmt = this.db.prepare('INSERT INTO customer_social_profiles (remote_id, customer_id, value, type) VALUES (?, ?, ?, ?)');
      const tx = this.db.transaction(() => {
        (c.socialProfiles ?? []).forEach((s, i) => stmt.run(-localId * 1000 - i, localId, s.value ?? null, s.type ?? null));
      });
      tx();
    }
    if (c.address) {
      const a = c.address as Record<string, string | null>;
      this.db
        .prepare('INSERT OR REPLACE INTO customer_addresses (remote_id, customer_id, lines, city, state, postal_code, country, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(-localId, localId, [a.line1, a.line2].filter(Boolean).join('\n') || null, a.city ?? null, a.state ?? null, a.postalCode ?? null, a.country ?? null, JSON.stringify(c.address));
    }
    return localId;
  }

  getCustomerByRemoteId(remoteId: number): CustomerSummary | undefined {
    return this.db
      .prepare(
        `SELECT c.id, c.remote_id, c.first_name, c.last_name, c.photo_url, c.job_title,
           c.remote_created_at, c.remote_updated_at,
           (SELECT GROUP_CONCAT(ce.value) FROM customer_emails ce WHERE ce.customer_id = c.id) AS emails,
           (SELECT GROUP_CONCAT(cp.value) FROM customer_phones cp WHERE cp.customer_id = c.id) AS phones,
           c.organization_id AS organization_id,
           o.name AS organization_name,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL) AS conversation_count,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.status = 'active' AND cv.deleted_at IS NULL) AS open_conversation_count,
           (SELECT MAX(cv.last_activity_at) FROM conversations cv WHERE cv.customer_local_id = c.id) AS last_activity_at,
           (SELECT AVG(CASE r.rating WHEN 'great' THEN 5 WHEN 'okay' THEN 3 WHEN 'not-good' THEN 1 END) FROM ratings r WHERE r.customer_local_id = c.id) AS average_rating
         FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id
         WHERE c.remote_id = ? AND c.deleted_at IS NULL`
      )
      .get(remoteId) as CustomerSummary | undefined;
  }

  getCustomerByLocalId(localId: number): CustomerSummary | undefined {
    const row = this.db.prepare('SELECT remote_id FROM customers WHERE id = ?').get(localId) as { remote_id: number } | undefined;
    return row ? this.getCustomerByRemoteId(row.remote_id) : undefined;
  }

  /** Resolve customer by any known email (matches Help Scout identity linking). */
  getCustomerByEmail(email: string): CustomerSummary | undefined {
    const row = this.db.prepare('SELECT customer_id FROM customer_emails WHERE value = ? COLLATE NOCASE LIMIT 1').get(email) as { customer_id: number } | undefined;
    return row ? this.getCustomerByLocalId(row.customer_id) : undefined;
  }

  listCustomers(page = 1, pageSize = 50, query = ''): { customers: CustomerSummary[]; total: number } {
    const where = query
      ? `WHERE (c.first_name LIKE @q OR c.last_name LIKE @q OR EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.id AND ce.value LIKE @q)) AND c.deleted_at IS NULL`
      : 'WHERE c.deleted_at IS NULL';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get({ q: `%${query}%` }) as { n: number }).n;
    const customers = this.db
      .prepare(
        `SELECT c.id, c.remote_id, c.first_name, c.last_name, c.photo_url, c.job_title,
           c.remote_created_at, c.remote_updated_at,
           (SELECT GROUP_CONCAT(ce.value) FROM customer_emails ce WHERE ce.customer_id = c.id) AS emails,
           (SELECT GROUP_CONCAT(cp.value) FROM customer_phones cp WHERE cp.customer_id = c.id) AS phones,
           c.organization_id AS organization_id,
           o.name AS organization_name,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL) AS conversation_count,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.status = 'active' AND cv.deleted_at IS NULL) AS open_conversation_count,
           (SELECT MAX(cv.last_activity_at) FROM conversations cv WHERE cv.customer_local_id = c.id) AS last_activity_at,
           (SELECT AVG(CASE r.rating WHEN 'great' THEN 5 WHEN 'okay' THEN 3 WHEN 'not-good' THEN 1 END) FROM ratings r WHERE r.customer_local_id = c.id) AS average_rating
         FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id
         ${where}
         ORDER BY c.last_name, c.first_name
         LIMIT @limit OFFSET @offset`
      )
      .all({ q: `%${query}%`, limit: pageSize, offset: (page - 1) * pageSize }) as CustomerSummary[];
    return { customers, total };
  }

  getCustomerProperties(localId: number): { name: string; value: string | null }[] {
    return this.db
      .prepare(
        `SELECT d.name AS name, cp.value AS value FROM customer_properties cp
         JOIN customer_property_definitions d ON d.id = cp.definition_id WHERE cp.customer_id = ?`
      )
      .all(localId) as { name: string; value: string | null }[];
  }

  getCustomerWebsites(localId: number): string[] {
    return (this.db.prepare('SELECT value FROM customer_websites WHERE customer_id = ?').all(localId) as { value: string | null }[]).map((r) => r.value ?? '').filter(Boolean);
  }

  getCustomerSocialProfiles(localId: number): { type: string | null; value: string | null }[] {
    return this.db.prepare('SELECT type, value FROM customer_social_profiles WHERE customer_id = ?').all(localId) as { type: string | null; value: string | null }[];
  }

  getAddress(localId: number): string | null {
    const r = this.db.prepare('SELECT lines, city, state, postal_code, country FROM customer_addresses WHERE customer_id = ?').get(localId) as
      | { lines: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null }
      | undefined;
    if (!r) return null;
    return [r.lines, [r.city, r.state, r.postal_code].filter(Boolean).join(' '), r.country].filter(Boolean).join(', ') || null;
  }

  // ---------------- Organizations ----------------
  upsertOrganization(o: { id: number; name: string; domains?: string[] | null; createdAt?: string | null; updatedAt?: string | null; raw?: unknown }): number {
    this.db
      .prepare(
        `INSERT INTO organizations (remote_id, name, domains, raw_json, raw_json_hash, remote_created_at, remote_updated_at, last_seen_at, last_synced_at)
         VALUES (@rid, @name, @domains, @raw, @hash, @rc, @ru, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET name=excluded.name, domains=excluded.domains, raw_json=excluded.raw_json,
           raw_json_hash=excluded.raw_json_hash, remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           last_seen_at=excluded.last_seen_at, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: o.id,
        name: o.name,
        domains: JSON.stringify(o.domains ?? []),
        raw: JSON.stringify(o.raw ?? o),
        hash: hashJson(o.raw ?? o),
        rc: isoOrNull(o.createdAt),
        ru: isoOrNull(o.updatedAt),
        seen: nowIso(),
        synced: nowIso()
      });
    return (this.db.prepare('SELECT id FROM organizations WHERE remote_id = ?').get(o.id) as { id: number }).id;
  }

  getOrganizationByRemoteId(remoteId: number): { id: number; name: string } | undefined {
    return this.db.prepare('SELECT id, name FROM organizations WHERE remote_id = ?').get(remoteId) as { id: number; name: string } | undefined;
  }

  listOrganizations(page = 1, pageSize = 50, query = ''): { organizations: OrganizationSummary[]; total: number } {
    const where = query ? 'WHERE o.name LIKE @q AND o.deleted_at IS NULL' : 'WHERE o.deleted_at IS NULL';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM organizations o ${where}`).get({ q: `%${query}%` }) as { n: number }).n;
    const organizations = this.db
      .prepare(
        `SELECT o.id, o.remote_id, o.name, o.domains,
           (SELECT COUNT(*) FROM customers c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS customer_count,
           (SELECT COUNT(DISTINCT cv.id) FROM conversations cv JOIN customers c2 ON c2.id = cv.customer_local_id WHERE c2.organization_id = o.id AND cv.deleted_at IS NULL) AS conversation_count,
           o.remote_created_at
         FROM organizations o ${where} ORDER BY o.name LIMIT @limit OFFSET @offset`
      )
      .all({ q: `%${query}%`, limit: pageSize, offset: (page - 1) * pageSize }) as (OrganizationSummary & { domains: string })[];
    return { organizations: organizations.map((o) => ({ ...o, domains: JSON.parse(o.domains || '[]') })), total };
  }

  getOrganizationDetail(localId: number): (OrganizationSummary & { domains: string[] }) | undefined {
    const row = this.db
      .prepare(
        `SELECT o.id, o.remote_id, o.name, o.domains, o.remote_created_at,
           (SELECT COUNT(*) FROM customers c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS customer_count,
           (SELECT COUNT(DISTINCT cv.id) FROM conversations cv JOIN customers c2 ON c2.id = cv.customer_local_id WHERE c2.organization_id = o.id AND cv.deleted_at IS NULL) AS conversation_count
         FROM organizations o WHERE o.id = ? AND o.deleted_at IS NULL`
      )
      .get(localId) as (OrganizationSummary & { domains: string }) | undefined;
    return row ? { ...row, domains: JSON.parse(row.domains || '[]') } : undefined;
  }

  getOrganizationProperties(localId: number): { name: string; value: string | null }[] {
    return this.db
      .prepare(
        `SELECT d.name AS name, op.value AS value FROM organization_properties op
         JOIN organization_property_definitions d ON d.id = op.definition_id WHERE op.organization_id = ?`
      )
      .all(localId) as { name: string; value: string | null }[];
  }

  getOrganizationCustomers(localId: number): CustomerSummary[] {
    return this.db
      .prepare(
        `SELECT c.id, c.remote_id, c.first_name, c.last_name, c.photo_url, c.job_title, c.remote_created_at, c.remote_updated_at,
           (SELECT GROUP_CONCAT(ce.value) FROM customer_emails ce WHERE ce.customer_id = c.id) AS emails,
           '' AS phones, c.organization_id AS organization_id, o.name AS organization_name,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL) AS conversation_count,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.status = 'active' AND cv.deleted_at IS NULL) AS open_conversation_count,
           NULL AS last_activity_at, NULL AS average_rating
         FROM customers c JOIN organizations o ON o.id = c.organization_id
         WHERE c.organization_id = ? AND c.deleted_at IS NULL ORDER BY c.last_name`
      )
      .all(localId) as CustomerSummary[];
  }

  // ---------------- Ratings ----------------
  upsertRating(r: { remote_id: number; conversation_local_id?: number | null; thread_local_id?: number | null; rating?: string | null; comments?: string | null; customer_local_id?: number | null; user_local_id?: number | null; createdAt?: string | null; raw?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO ratings (remote_id, conversation_id, thread_local_id, rating, comments, customer_local_id, user_local_id, remote_created_at, raw_json, last_synced_at)
         VALUES (@rid, @conv, @thread, @rating, @comments, @customer, @user, @rc, @raw, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET conversation_id=excluded.conversation_id, thread_local_id=excluded.thread_local_id,
           rating=excluded.rating, comments=excluded.comments, customer_local_id=excluded.customer_local_id, user_local_id=excluded.user_local_id,
           remote_created_at=excluded.remote_created_at, raw_json=excluded.raw_json, last_synced_at=excluded.last_synced_at`
      )
      .run({
        rid: r.remote_id,
        conv: r.conversation_local_id ?? null,
        thread: r.thread_local_id ?? null,
        rating: r.rating ?? null,
        comments: r.comments ?? null,
        customer: r.customer_local_id ?? null,
        user: r.user_local_id ?? null,
        rc: isoOrNull(r.createdAt),
        raw: JSON.stringify(r.raw ?? r),
        synced: nowIso()
      });
  }

  getRatingsForCustomer(customerLocalId: number): { rating: string; comments: string | null; created_at: string | null; conversation_id: number | null }[] {
    return this.db
      .prepare('SELECT rating, comments, remote_created_at AS created_at, conversation_id FROM ratings WHERE customer_local_id = ? ORDER BY remote_created_at DESC LIMIT 50')
      .all(customerLocalId) as { rating: string; comments: string | null; created_at: string | null; conversation_id: number | null }[];
  }
}
