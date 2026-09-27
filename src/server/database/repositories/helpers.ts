import crypto from 'node:crypto';
import type { DB } from '../connection.js';

export function hashJson(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Generic upsert helper: INSERT OR REPLACE-style merge on unique key. */
export function upsertByRemoteId(
  db: DB,
  table: string,
  remoteId: number,
  data: Record<string, unknown>,
  extraSets: string[] = []
): void {
  const keys = Object.keys(data);
  const cols = [...keys, 'last_synced_at', 'local_updated_at'];
  const placeholders = keys.map(() => '?').join(', ');
  const sets = [...keys.map((k) => `${k} = excluded.${k}`), 'last_synced_at = excluded.last_synced_at', 'local_updated_at = datetime(\'now\')', ...extraSets];
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}, ?, datetime('now'))
    ON CONFLICT(remote_id) DO UPDATE SET ${sets.join(', ')} WHERE 1=1`;
  db.prepare(sql).run(...(keys.map((k) => data[k]) as unknown[]), nowIso());
}

export function jsonGet<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function nullIfEmpty(s: string | null | undefined): string | null {
  return s && s.length > 0 ? s : null;
}

export function jsonArray(v: unknown): string {
  return JSON.stringify(v ?? []);
}

export function inClause(values: number[]): { sql: string; params: number[] } {
  if (values.length === 0) return { sql: 'NULL', params: [] };
  return { sql: values.map(() => '?').join(','), params: values };
}
