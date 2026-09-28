import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../database/connection.js';
import { ConnectorRepository, type ConnectorRecord } from '../database/repositories/connectorRepo.js';
import { checkUrlResolved } from '../security/ssrfGuard.js';
import { redactText } from '../security/redaction.js';
import { parseCsv } from './csv.js';
import type { ConnectorKind } from '../../shared/workspace.js';

/**
 * ConnectorService (plan Phase 22): refresh + read surface for approved
 * local data sources.
 *
 * Safety model:
 * - local_json / csv / sqlite files live under <cwd>/connectors/ (a path
 *   jail - the same containment rule as knowledge imports; absolute paths
 *   and traversal are refused by the Zod config schema AND re-checked here).
 * - http targets pass the full SSRF guard (literal + DNS-resolved address
 *   checks) before any request; requests have a 10s timeout, a 10 MB body
 *   cap and only accept JSON/CSV/text responses.
 * - Refresh is snapshot semantics: rows land in connector_rows keyed by a
 *   stable row key (configured key column, else a content hash); rows that
 *   vanished from the source are pruned; a failed refresh marks health =
 *   'error' and NEVER partially overwrites a previous good snapshot.
 * - The AI gate: searchForAi() only reads connectors with allowed_ai = 1
 *   and enabled = 1; everything else returns an explicit refusal. Results
 *   are bounded and redacted.
 */
export const MAX_ROWS_PER_CONNECTOR = 5000;
const MAX_ROW_BYTES = 32000;
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES = 10 * 1024 * 1024;

export interface RefreshResult {
  ok: boolean;
  rows: number;
  pruned: number;
  schema: { name: string; type: string }[] | null;
  error?: string;
}

interface NormalizedRow { row_key: string; data: Record<string, unknown> }

function connectorsRoot(): string {
  return path.resolve(process.cwd(), 'connectors');
}

function jailResolve(fileName: string): string {
  const root = connectorsRoot();
  const abs = path.resolve(root, fileName);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('File must live inside the connectors folder');
  }
  return abs;
}

/** Stable content hash for row keys when no key column is configured. */
function stableKey(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h1 ^= json.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `h${h1.toString(16)}-${json.length}`;
}

function guessType(values: unknown[]): string {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return 'text';
  if (nonNull.every((v) => typeof v === 'number')) return 'number';
  if (nonNull.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'text';
}

export class ConnectorService {
  private repo: ConnectorRepository;
  constructor(private db: DB) {
    this.repo = new ConnectorRepository(db);
  }

  get repository(): ConnectorRepository { return this.repo; }

  connectorsDir(): string { return connectorsRoot(); }

  /** Ensure the connectors folder exists (created on first use). */
  ensureConnectorsDir(): void {
    try { fs.mkdirSync(connectorsRoot(), { recursive: true }); } catch { /* already there */ }
  }

  /**
   * Validate a config at create/patch time. HTTP configs get the FULL SSRF
   * check eagerly (fail fast at configuration time); file configs get the
   * jail check. Returns an error string or null.
   */
  async validateConfig(config: { kind: ConnectorKind; file?: string; url?: string; table?: string }): Promise<string | null> {
    if (config.kind === 'http') {
      const url = String(config.url ?? '');
      const result = await checkUrlResolved(url);
      return result.ok ? null : `URL refused: ${result.reason}`;
    }
    const file = String(config.file ?? '');
    try {
      const abs = jailResolve(file);
      if (!fs.existsSync(abs)) {
        return `File not found: create "connectors/${file}" first (the connectors folder is ${connectorsRoot()})`;
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** One refresh pass for a connector. Never throws - failures are health. */
  async refresh(connectorId: number): Promise<RefreshResult> {
    const connector = this.repo.get(connectorId);
    if (!connector) return { ok: false, rows: 0, pruned: 0, schema: null, error: 'connector not found' };
    try {
      const rows = await this.fetchRows(connector);
      const fetchedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const schema = this.inferSchema(rows);
      const tx = this.db.transaction(() => {
        this.repo.upsertRows(connectorId, rows, fetchedAt);
        // Snapshot semantics: keys absent from the new source are pruned -
        // key-set based, so even a sub-second refresh prunes correctly.
        const pruned = this.repo.pruneRowsNotInKeys(connectorId, rows.map((r) => r.row_key));
        this.repo.recordSync(connectorId, 'ok', rows.length, null, schema);
        return pruned;
      });
      const pruned = tx() as number;
      return { ok: true, rows: rows.length, pruned, schema };
    } catch (e) {
      const message = String((e as Error).message ?? e).slice(0, 500);
      this.repo.recordSync(connectorId, 'error', null, message, null);
      return { ok: false, rows: 0, pruned: 0, schema: null, error: message };
    }
  }

  private async fetchRows(connector: ConnectorRecord): Promise<NormalizedRow[]> {
    const cfg = connector.config as { file?: string; url?: string; table?: string; keyColumn?: string | null };
    const keyColumn = typeof cfg.keyColumn === 'string' && cfg.keyColumn ? cfg.keyColumn : null;
    switch (connector.kind) {
      case 'local_json': {
        const abs = jailResolve(String(cfg.file));
        const stat = fs.statSync(abs);
        if (stat.size > HTTP_MAX_BYTES) throw new Error(`file too large (${Math.round(stat.size / 1024 / 1024)}MB > 10MB cap)`);
        const text = fs.readFileSync(abs, 'utf8');
        return this.normalizeRows(JSON.parse(text), keyColumn, 'the JSON root');
      }
      case 'csv': {
        const abs = jailResolve(String(cfg.file));
        const stat = fs.statSync(abs);
        if (stat.size > HTTP_MAX_BYTES) throw new Error(`file too large (${Math.round(stat.size / 1024 / 1024)}MB > 10MB cap)`);
        const text = fs.readFileSync(abs, 'utf8');
        const { rows } = parseCsv(text, MAX_ROWS_PER_CONNECTOR);
        return this.normalizeRows(rows, keyColumn, 'CSV rows');
      }
      case 'sqlite': {
        const abs = jailResolve(String(cfg.file));
        const table = String(cfg.table);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) throw new Error('invalid table name');
        const sqlite = new Database(abs, { readonly: true, timeout: 5000 });
        try {
          const count = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
          const limit = Math.min(count.n, MAX_ROWS_PER_CONNECTOR);
          const rawRows = sqlite.prepare(`SELECT * FROM "${table}" LIMIT ${limit}`).all() as Record<string, unknown>[];
          return this.normalizeRows(rawRows, keyColumn, `table "${table}"`);
        } finally {
          sqlite.close();
        }
      }
      case 'http': {
        const url = String(cfg.url);
        const guard = await checkUrlResolved(url);
        if (!guard.ok) throw new Error(`URL refused: ${guard.reason}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
          const headers: Record<string, string> = { Accept: 'application/json, text/csv, text/plain' };
          const auth = connector.auth as { mode?: string; headerName?: string; headerValue?: string; token?: string };
          if (auth?.mode === 'header' && auth.headerName && auth.headerValue) headers[auth.headerName] = auth.headerValue;
          if (auth?.mode === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
          const res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const declared = Number(res.headers.get('content-length') ?? 0);
          if (declared > HTTP_MAX_BYTES) throw new Error(`response too large (${Math.round(declared / 1024 / 1024)}MB > 10MB cap)`);
          const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
          const bodyText = await this.readBounded(res);
          if (/json/.test(contentType)) {
            return this.normalizeRows(JSON.parse(bodyText), keyColumn, 'the JSON response');
          }
          if (/csv|plain/.test(contentType) || bodyText.trimStart().startsWith('{') || bodyText.trimStart().startsWith('[')) {
            if (bodyText.trimStart().startsWith('[') || bodyText.trimStart().startsWith('{')) {
              return this.normalizeRows(JSON.parse(bodyText), keyColumn, 'the JSON response');
            }
            const { rows } = parseCsv(bodyText, MAX_ROWS_PER_CONNECTOR);
            return this.normalizeRows(rows, keyColumn, 'CSV rows');
          }
          throw new Error(`unsupported content type: ${contentType || '(none)'}`);
        } finally {
          clearTimeout(timer);
        }
      }
      default:
        throw new Error(`unsupported connector kind: ${(connector as { kind?: string }).kind ?? 'unknown'}`);
    }
  }

  /** Read the body with a hard byte cap even when content-length lies. */
  private async readBounded(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HTTP_MAX_BYTES) {
        await reader.cancel();
        throw new Error('response exceeded the 10MB cap mid-stream');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.byteLength; }
    return new TextDecoder('utf8', { fatal: false }).decode(merged);
  }

  /** Coerce a source payload into flat keyed rows. */
  private normalizeRows(payload: unknown, keyColumn: string | null, sourceLabel: string): NormalizedRow[] {
    let list: unknown[];
    if (Array.isArray(payload)) list = payload;
    else if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)) {
      list = (payload as Record<string, unknown>).data as unknown[];
    } else if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).rows)) {
      list = (payload as Record<string, unknown>).rows as unknown[];
    } else if (payload && typeof payload === 'object') {
      // A single object is one row (honest: some APIs return one record).
      list = [payload];
    } else {
      throw new Error(`${sourceLabel} must be an array of objects (or { data: [...] } / { rows: [...] })`);
    }
    if (list.length > MAX_ROWS_PER_CONNECTOR) {
      list = list.slice(0, MAX_ROWS_PER_CONNECTOR);
    }
    const out: NormalizedRow[] = [];
    for (const item of list) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (v === undefined || typeof v === 'function') continue;
        data[k] = v;
      }
      const json = JSON.stringify(data);
      if (json.length > MAX_ROW_BYTES) continue;
      let rowKey: string | null = null;
      if (keyColumn && data[keyColumn] !== undefined) {
        rowKey = String(data[keyColumn]);
      }
      out.push({ row_key: rowKey ?? stableKey(data), data });
    }
    return out;
  }

  private inferSchema(rows: NormalizedRow[]): { name: string; type: string }[] | null {
    if (rows.length === 0) return null;
    const columns = new Map<string, unknown[]>();
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.data)) {
        if (!columns.has(k)) columns.set(k, []);
        columns.get(k)!.push(v);
      }
    }
    return [...columns.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([name, values]) => ({ name, type: guessType(values) }));
  }

  // ---------------- AI read gate ----------------

  /**
   * Bounded, redacted search over ONE connector's rows - only when the
   * connector is explicitly AI-visible and enabled (plan Phase 22).
   */
  searchForAi(connectorNameOrId: string | number, query: string, limit: number): { connector: string; results: Record<string, unknown>[] } | { error: string } {
    const connector = typeof connectorNameOrId === 'number'
      ? this.repo.get(connectorNameOrId)
      : this.repo.getByName(connectorNameOrId);
    if (!connector) return { error: 'Connector not found' };
    if (!connector.allowed_ai) {
      return { error: `Connector "${connector.name}" is not marked as AI-visible. Data stays private to the UI.` };
    }
    if (!connector.enabled) return { error: `Connector "${connector.name}" is disabled.` };
    const q = query.toLowerCase();
    const { rows } = this.repo.listRows(connector.id, null, Math.min(10, Math.max(1, limit)), 0);
    const redactionEnabled = true;
    const results = rows
      .filter((r) => !q || JSON.stringify(r.data).toLowerCase().includes(q))
      .slice(0, Math.min(10, Math.max(1, limit)))
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.data)) {
          if (typeof v === 'string' && v.length > 300) {
            out[k] = redactText(v.slice(0, 300), redactionEnabled).text;
          } else if (typeof v === 'string') {
            out[k] = redactText(v, redactionEnabled).text;
          } else {
            out[k] = v;
          }
        }
        return out;
      });
    return { connector: connector.name, results };
  }

  /** Names of AI-visible connectors (for the honest tool description). */
  aiVisibleConnectorNames(): string[] {
    return this.repo.list().filter((c) => c.allowed_ai && c.enabled).map((c) => c.name);
  }
}
