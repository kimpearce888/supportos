import type { DB } from '../connection.js';
import type { ConnectorKind, ConnectorAuthMode } from '../../../shared/workspace.js';

export interface ConnectorRecord {
  id: number;
  name: string;
  kind: ConnectorKind;
  config: Record<string, unknown>;
  auth: Record<string, unknown>;
  refresh_method: 'manual' | 'interval';
  refresh_seconds: number;
  allowed_ai: 0 | 1;
  enabled: 0 | 1;
  schema_json: { name: string; type: string }[] | null;
  last_sync_at: string | null;
  last_sync_status: 'ok' | 'error' | null;
  last_sync_error: string | null;
  last_sync_rows: number | null;
  health: 'never' | 'ok' | 'error';
  created_at: string;
  updated_at: string;
  provenance: string;
}

export interface ConnectorRowRecord {
  id: number;
  connector_id: number;
  row_key: string;
  data: Record<string, unknown>;
  fetched_at: string;
}

function parseJson(text: string | null | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!text) return fallback;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return fallback; }
}

/**
 * Local data connectors (plan Phase 22). Registered sources with typed
 * config, auth material (REDACTED on every read - the repo never returns
 * raw secrets), refresh method, health and the explicit allowed_ai flag
 * that gates every AI read of connector data.
 */
export class ConnectorRepository {
  constructor(private db: DB) {}

  private hydrate(row: Record<string, unknown>): ConnectorRecord {
    let schema: { name: string; type: string }[] | null = null;
    if (typeof row.schema_json === 'string' && row.schema_json) {
      try { schema = JSON.parse(row.schema_json) as { name: string; type: string }[]; } catch { schema = null; }
    }
    return {
      ...(row as unknown as ConnectorRecord),
      config: parseJson(row.config as string, {}),
      auth: parseJson(row.auth as string, { mode: 'none' }),
      schema_json: schema
    };
  }

  /** Auth WITHOUT secret material (header value / bearer token masked). */
  redactedAuth(record: ConnectorRecord): Record<string, unknown> {
    const auth = { ...record.auth };
    if (auth.mode === 'header') auth.headerValue = '••••••';
    if (auth.mode === 'bearer') auth.token = '••••••';
    return auth;
  }

  create(input: {
    name: string;
    kind: ConnectorKind;
    config: Record<string, unknown>;
    auth: Record<string, unknown>;
    refreshMethod: 'manual' | 'interval';
    refreshSeconds: number;
    allowedAi: boolean;
  }): ConnectorRecord {
    const exists = this.db.prepare('SELECT 1 FROM connectors WHERE name = ?').get(input.name);
    if (exists) throw new Error(`Connector "${input.name}" already exists`);
    const r = this.db
      .prepare(
        `INSERT INTO connectors (name, kind, config, auth, refresh_method, refresh_seconds, allowed_ai, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(input.name, input.kind, JSON.stringify(input.config), JSON.stringify(input.auth), input.refreshMethod, input.refreshSeconds, input.allowedAi ? 1 : 0);
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): ConnectorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  getByName(name: string): ConnectorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(): ConnectorRecord[] {
    return (this.db.prepare('SELECT * FROM connectors ORDER BY name').all() as Record<string, unknown>[]).map((r) => this.hydrate(r));
  }

  patch(id: number, changes: {
    name?: string;
    config?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    refreshMethod?: 'manual' | 'interval';
    refreshSeconds?: number;
    allowedAi?: boolean;
    enabled?: boolean;
  }): ConnectorRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (changes.name != null && changes.name !== existing.name) {
      const dupe = this.db.prepare('SELECT 1 FROM connectors WHERE name = ? AND id != ?').get(changes.name, id);
      if (dupe) throw new Error(`Connector "${changes.name}" already exists`);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name != null) { sets.push('name = ?'); params.push(changes.name); }
    if (changes.config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(changes.config)); }
    if (changes.auth !== undefined) { sets.push('auth = ?'); params.push(JSON.stringify(changes.auth)); }
    if (changes.refreshMethod !== undefined) { sets.push('refresh_method = ?'); params.push(changes.refreshMethod); }
    if (changes.refreshSeconds !== undefined) { sets.push('refresh_seconds = ?'); params.push(changes.refreshSeconds); }
    if (changes.allowedAi !== undefined) { sets.push('allowed_ai = ?'); params.push(changes.allowedAi ? 1 : 0); }
    if (changes.enabled !== undefined) { sets.push('enabled = ?'); params.push(changes.enabled ? 1 : 0); }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      this.db.prepare(`UPDATE connectors SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id).changes > 0;
  }

  /** Called by the refresh service after every attempt. */
  recordSync(id: number, status: 'ok' | 'error', rows: number | null, error: string | null, schema: { name: string; type: string }[] | null): void {
    this.db
      .prepare(
        `UPDATE connectors SET last_sync_at = datetime('now'), last_sync_status = ?, last_sync_error = ?,
           last_sync_rows = ?, health = ?, schema_json = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, error, rows, status, schema ? JSON.stringify(schema) : null, id);
  }

  // ---------------- Rows ----------------

  upsertRows(connectorId: number, rows: { row_key: string; data: Record<string, unknown> }[], fetchedAt: string): number {
    const tx = this.db.transaction(() => {
      const stmt = this.db
        .prepare(
          `INSERT INTO connector_rows (connector_id, row_key, data, fetched_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (connector_id, row_key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`
        );
      for (const r of rows) stmt.run(connectorId, r.row_key, JSON.stringify(r.data).slice(0, 32000), fetchedAt);
    });
    tx();
    return rows.length;
  }

  /** Snapshot semantics: remove rows whose keys are absent from the new source set. */
  pruneRowsNotInKeys(connectorId: number, keys: string[]): number {
    if (keys.length === 0) {
      return this.db.prepare('DELETE FROM connector_rows WHERE connector_id = ?').run(connectorId).changes;
    }
    const placeholders = keys.map(() => '?').join(', ');
    return this.db
      .prepare(`DELETE FROM connector_rows WHERE connector_id = ? AND row_key NOT IN (${placeholders})`)
      .run(connectorId, ...keys).changes;
  }

  listRows(connectorId: number, query: string | null, limit: number, offset: number): { rows: ConnectorRowRecord[]; total: number } {
    const where = query
      ? 'WHERE connector_id = ? AND data LIKE ?'
      : 'WHERE connector_id = ?';
    const params: unknown[] = query ? [connectorId, `%${query}%`] : [connectorId];
    const rows = (this.db
      .prepare(`SELECT * FROM connector_rows ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as (Omit<ConnectorRowRecord, 'data'> & { data: string })[])
      .map((r) => ({ ...r, data: parseJson(r.data, {}) }));
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM connector_rows ${where}`).get(...params) as { n: number }).n;
    return { rows, total };
  }

  countRows(connectorId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM connector_rows WHERE connector_id = ?').get(connectorId) as { n: number }).n;
  }

  /** Enabled interval connectors due for a refresh. */
  dueForRefresh(now: number): ConnectorRecord[] {
    return this.list().filter((c) => {
      if (!c.enabled || c.refresh_method !== 'interval') return false;
      if (!c.last_sync_at) return true;
      const last = Date.parse(`${c.last_sync_at.replace(' ', 'T')}Z`);
      return !Number.isFinite(last) || now - last >= c.refresh_seconds * 1000;
    });
  }

  authMode(record: ConnectorRecord): ConnectorAuthMode {
    return (record.auth?.mode as ConnectorAuthMode) ?? 'none';
  }
}
