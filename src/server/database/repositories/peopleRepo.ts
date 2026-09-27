import type { DB } from '../connection.js';
import { nowIso, hashJson, isoOrNull } from './helpers.js';
import type { CustomerSummary, OrganizationSummary } from '../../../shared/types.js';

interface CustomerV3 {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  jobTitle?: string | null;
  background?: string | null;
  age?: string | number | null;
  gender?: string | null;
  location?: string | null;
  phone?: string | null;
  address?: Record<string, unknown> | null;
  emails?: { value?: string | null; type?: string | null }[] | null;
  phones?: { value?: string | null; type?: string | null }[] | null;
  websites?: { value?: string | null }[] | null;
  socialProfiles?: { value?: string | null; type?: string | null }[] | null;
  organization?: { id: number; name?: string | null } | null;
  properties?: { definitionRemoteId: number | null; key: string | null; name: string | null; value: string | null }[] | null;
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
        `INSERT INTO customers (remote_id, first_name, last_name, photo_url, job_title, background, age, gender, location, organization_id, raw_json, raw_json_hash, remote_created_at, remote_updated_at, last_seen_at, last_synced_at)
         VALUES (@rid, @first, @last, @photo, @job, @background, @age, @gender, @location, @org, @raw, @hash, @rc, @ru, @seen, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, photo_url=excluded.photo_url,
           job_title=excluded.job_title, background=excluded.background, age=excluded.age, gender=excluded.gender, location=excluded.location,
           organization_id=excluded.organization_id, raw_json=excluded.raw_json, raw_json_hash=excluded.raw_json_hash,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at, last_seen_at=excluded.last_seen_at,
           last_synced_at=excluded.last_synced_at, deleted_at=NULL`
      )
      .run({
        rid: c.id,
        first: c.firstName ?? null,
        last: c.lastName ?? null,
        photo: c.photoUrl ?? null,
        job: c.jobTitle ?? null,
        background: c.background ?? null,
        age: c.age == null ? null : String(c.age),
        gender: c.gender ?? null,
        location: c.location ?? null,
        org: orgLocal?.id ?? null,
        raw: JSON.stringify(c),
        hash: hashJson(c),
        rc: isoOrNull(c.createdAt),
        ru: isoOrNull(c.updatedAt),
        seen: nowIso(),
        synced: nowIso()
      });
    const localId = (this.db.prepare('SELECT id FROM customers WHERE remote_id = ?').get(c.id) as { id: number }).id;

    // v1.5.0: customer property VALUES (segmentation targeting data). Only
    // provided keys are touched - an endpoint that omits properties never
    // erases values learned from a fuller response.
    if (c.properties && Array.isArray(c.properties) && c.properties.length > 0) {
      this.storeCustomerProperties(localId, c.properties);
    }

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
    const row = this.db
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
      .get(remoteId) as (CustomerSummary & { emails: string | null; phones: string | null }) | undefined;
    return row ? normalizeCustomer(row) : undefined;
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
      .all({ q: `%${query}%`, limit: pageSize, offset: (page - 1) * pageSize }) as (CustomerSummary & { emails: string | null; phones: string | null })[];
    return { customers: customers.map(normalizeCustomer), total };
  }

  getCustomerProperties(localId: number): { name: string; value: string | null }[] {
    return this.db
      .prepare(
        `SELECT d.name AS name, cp.value AS value FROM customer_properties cp
         JOIN customer_property_definitions d ON d.id = cp.definition_id WHERE cp.customer_id = ?`
      )
      .all(localId) as { name: string; value: string | null }[];
  }

  /**
   * v1.5.0: store customer property values, resolving each value to a synced
   * property definition by remote id first, then by key/name (API vintages
   * differ). Unknown definitions are skipped honestly - a value without a
   * definition cannot be typed for the operator matrix and would be
   * un-filterable anyway.
   */
  private storeCustomerProperties(localId: number, props: { definitionRemoteId: number | null; key: string | null; name: string | null; value: string | null }[]): void {
    const byRemote = this.db.prepare('SELECT id, remote_id, name, slug FROM customer_property_definitions').all() as { id: number; remote_id: number; name: string; slug: string | null }[];
    const defByRemote = new Map(byRemote.map((d) => [d.remote_id, d.id]));
    const defByName = new Map(byRemote.map((d) => [d.name.toLowerCase(), d.id]));
    const defBySlug = new Map(byRemote.filter((d) => d.slug).map((d) => [(d.slug ?? '').toLowerCase(), d.id]));
    const upsert = this.db.prepare(
      `INSERT INTO customer_properties (customer_id, definition_id, value) VALUES (?, ?, ?)
       ON CONFLICT(customer_id, definition_id) DO UPDATE SET value=excluded.value`
    );
    const tx = this.db.transaction(() => {
      for (const p of props) {
        const defId =
          (p.definitionRemoteId != null && defByRemote.get(p.definitionRemoteId)) ||
          (p.key ? defBySlug.get(p.key.toLowerCase()) ?? defByName.get(p.key.toLowerCase()) : undefined) ||
          (p.name ? defByName.get(p.name.toLowerCase()) : undefined) ||
          undefined;
        if (defId == null) continue;
        upsert.run(localId, defId, p.value ?? '');
      }
    });
    tx();
  }

  /** Distinct observed values per property definition (dropdown suggestions + populated counts). */
  propertyDefinitionStats(): { definition_id: number; populated: number; observed_values: string[] }[] {
    const defs = this.db.prepare('SELECT id FROM customer_property_definitions ORDER BY sort_order, name').all() as { id: number }[];
    return defs.map((d) => {
      const rows = this.db
        .prepare("SELECT value, COUNT(*) AS n FROM customer_properties WHERE definition_id = ? AND value IS NOT NULL AND value <> '' GROUP BY value ORDER BY n DESC LIMIT 25")
        .all(d.id) as { value: string; n: number }[];
      return { definition_id: d.id, populated: rows.reduce((a, r) => a + r.n, 0), observed_values: rows.map((r) => r.value) };
    });
  }

  /**
   * v1.5.0: harvest property values from raw_json snapshots (heals databases
   * synced before property pass-through existed, without a re-sync).
   */
  backfillPropertiesFromRawJson(): number {
    let healed = 0;
    const rows = this.db.prepare("SELECT id, raw_json FROM customers WHERE raw_json IS NOT NULL").all() as { id: number; raw_json: string }[];
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.raw_json);
      } catch {
        continue;
      }
      const props = (parsed as { properties?: unknown }).properties;
      if (!Array.isArray(props) || props.length === 0) continue;
      // raw_json can carry EITHER shape: the normalized internal one
      // ({definitionRemoteId, key, name, value} - what upsertCustomer stores)
      // or the raw wire one ({id, key, value} - what the API returns). Accept
      // both: the backfill's whole job is healing data we did not control.
      const normalized = props
        .map((p): { definitionRemoteId: number | null; key: string | null; name: string | null; value: string | null } | null => {
          if (p == null || typeof p !== 'object') return null;
          const o = p as Record<string, unknown>;
          const defId = typeof o.definitionRemoteId === 'number' ? o.definitionRemoteId : typeof o.id === 'number' ? o.id : null;
          const key = typeof o.key === 'string' ? o.key : null;
          const name = typeof o.name === 'string' ? o.name : key;
          if (defId == null && !key && !name) return null;
          return { definitionRemoteId: defId, key, name, value: o.value == null ? null : String(o.value) };
        })
        .filter((p): p is { definitionRemoteId: number | null; key: string | null; name: string | null; value: string | null } => p != null);
      if (normalized.length === 0) continue;
      const before = (this.db.prepare('SELECT COUNT(*) AS n FROM customer_properties WHERE customer_id = ?').get(r.id) as { n: number }).n;
      this.storeCustomerProperties(r.id, normalized);
      const after = (this.db.prepare('SELECT COUNT(*) AS n FROM customer_properties WHERE customer_id = ?').get(r.id) as { n: number }).n;
      healed += Math.max(0, after - before);
    }
    return healed;
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
    const rows = this.db
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
      .all(localId) as (CustomerSummary & { emails: string | null; phones: string | null })[];
    return rows.map(normalizeCustomer);
  }

  // ---------------- Ratings ----------------
  /**
   * Upsert one rating. Returns true when the rating was NEWLY inserted
   * (never seen before) - the signal the real-time event layer uses to push
   * `rating-received` events without spamming on every re-sync.
   */
  upsertRating(r: { remote_id: number; conversation_local_id?: number | null; thread_local_id?: number | null; rating?: string | null; comments?: string | null; customer_local_id?: number | null; user_local_id?: number | null; createdAt?: string | null; raw?: unknown }): boolean {
    const existed = (this.db.prepare('SELECT 1 AS x FROM ratings WHERE remote_id = ?').get(r.remote_id) as { x: number } | undefined) != null;
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
    return !existed;
  }

  getRatingsForCustomer(customerLocalId: number): { rating: string; comments: string | null; created_at: string | null; conversation_id: number | null }[] {
    return this.db
      .prepare('SELECT rating, comments, remote_created_at AS created_at, conversation_id FROM ratings WHERE customer_local_id = ? ORDER BY remote_created_at DESC LIMIT 50')
      .all(customerLocalId) as { rating: string; comments: string | null; created_at: string | null; conversation_id: number | null }[];
  }
}

/**
 * GROUP_CONCAT returns a comma-joined STRING (or null); the API contract and UI
 * expect arrays. Normalize every customer row once, here, at the repository boundary.
 */
function normalizeCustomer(row: CustomerSummary & { emails: string | null; phones: string | null }): CustomerSummary {
  const split = (v: string | null): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return { ...row, emails: split(row.emails ?? (Array.isArray(row.emails) ? (row.emails as unknown as string[]).join(',') : null)), phones: split(row.phones ?? (Array.isArray(row.phones) ? (row.phones as unknown as string[]).join(',') : null)) };
}
