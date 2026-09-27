import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { SyncState, SyncRunSummary, SyncCheckpoint, WebhookEventRecord } from '../../../shared/types.js';
import crypto from 'node:crypto';

/** Sync state, checkpoints, cursors, webhook events. */
export class SyncRepository {
  constructor(private db: DB) {}

  // ---------------- Global sync state ----------------
  getState(): SyncState {
    const row = this.db.prepare("SELECT value FROM application_settings WHERE key = 'sync_state'").get() as { value: string } | undefined;
    return (row ? JSON.parse(row.value) : 'NEW') as SyncState;
  }

  setState(state: SyncState): void {
    this.db
      .prepare("INSERT INTO application_settings (key, value, updated_at) VALUES ('sync_state', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(JSON.stringify(state));
  }

  // ---------------- Runs ----------------
  startRun(kind: 'initial' | 'incremental' | 'manual' | 'reconciliation'): number {
    const r = this.db.prepare("INSERT INTO sync_runs (kind, state, started_at) VALUES (?, ?, ?)").run(kind, 'INITIALIZING', nowIso());
    return Number(r.lastInsertRowid);
  }

  updateRun(id: number, fields: { state?: SyncState; resources_done?: number; resources_total?: number; records_processed?: number; errors?: number; detail?: unknown; finished?: boolean }): void {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    if (fields.state !== undefined) {
      sets.push('state = @state');
      args.state = fields.state;
    }
    if (fields.resources_done !== undefined) {
      sets.push('resources_done = @rd');
      args.rd = fields.resources_done;
    }
    if (fields.resources_total !== undefined) {
      sets.push('resources_total = @rt');
      args.rt = fields.resources_total;
    }
    if (fields.records_processed !== undefined) {
      sets.push('records_processed = @rp');
      args.rp = fields.records_processed;
    }
    if (fields.errors !== undefined) {
      sets.push('errors = @errors');
      args.errors = fields.errors;
    }
    if (fields.detail !== undefined) {
      sets.push('detail = @detail');
      args.detail = JSON.stringify(fields.detail);
    }
    if (fields.finished) sets.push("finished_at = datetime('now')");
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE sync_runs SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  getLatestRuns(limit = 20): SyncRunSummary[] {
    return this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit) as SyncRunSummary[];
  }

  getCurrentRun(): SyncRunSummary | undefined {
    return this.db.prepare("SELECT * FROM sync_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1").get() as SyncRunSummary | undefined;
  }

  // ---------------- Checkpoints (per resource) ----------------
  getCheckpoint(resource: string): SyncCheckpoint | undefined {
    return this.db.prepare('SELECT * FROM sync_checkpoints WHERE resource = ?').get(resource) as SyncCheckpoint | undefined;
  }

  recordSuccess(resource: string, recordsProcessed: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_checkpoints (resource, last_success_at, records_processed, records_failed, last_error, retry_count, status)
         VALUES (?, ?, ?, 0, NULL, 0, 'ok')
         ON CONFLICT(resource) DO UPDATE SET last_success_at=excluded.last_success_at,
           records_processed=records_processed + excluded.records_processed, last_error=NULL, retry_count=0, status='ok'`
      )
      .run(resource, nowIso(), recordsProcessed);
  }

  recordFailure(resource: string, error: string, recordsFailed = 0): void {
    this.db
      .prepare(
        `INSERT INTO sync_checkpoints (resource, records_processed, records_failed, last_error, retry_count, status)
         VALUES (?, 0, ?, ?, 1, 'error')
         ON CONFLICT(resource) DO UPDATE SET records_failed=records_failed + excluded.records_failed,
           last_error=excluded.last_error, retry_count=retry_count + 1, status='error'`
      )
      .run(resource, recordsFailed, error.slice(0, 500));
  }

  setCheckpointRunning(resource: string, running: boolean): void {
    this.db
      .prepare(
        `INSERT INTO sync_checkpoints (resource, status) VALUES (?, ?)
         ON CONFLICT(resource) DO UPDATE SET status=excluded.status`
      )
      .run(resource, running ? 'running' : 'idle');
  }

  getAllCheckpoints(): SyncCheckpoint[] {
    return this.db.prepare('SELECT * FROM sync_checkpoints ORDER BY resource').all() as SyncCheckpoint[];
  }

  /** The watermark: last successful conversation sync time minus overlap window. */
  getIncrementalSince(resource: string, overlapMinutes = 10): string | null {
    const cp = this.getCheckpoint(resource);
    if (!cp?.last_success_at) return null;
    const d = new Date(cp.last_success_at);
    d.setMinutes(d.getMinutes() - overlapMinutes);
    return d.toISOString();
  }

  // ---------------- Cursors ----------------
  getCursor(resource: string): string | null {
    const row = this.db.prepare('SELECT cursor FROM sync_cursors WHERE resource = ?').get(resource) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  setCursor(resource: string, cursor: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursors (resource, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`
      )
      .run(resource, cursor, nowIso());
  }

  // ---------------- Webhook events ----------------
  insertWebhookEvent(eventType: string, payload: string, eventId?: string | null): { id: number; duplicate: boolean } {
    const hash = crypto.createHash('sha256').update(`${eventType}:${payload}`).digest('hex');
    const existing = this.db.prepare('SELECT id FROM webhook_events WHERE event_hash = ?').get(hash) as { id: number } | undefined;
    if (existing) return { id: existing.id, duplicate: true };
    const r = this.db.prepare('INSERT INTO webhook_events (event_id, event_hash, event_type, received_at, payload, processing_state) VALUES (?, ?, ?, ?, ?, ?)').run(eventId ?? null, hash, eventType, nowIso(), payload, 'pending');
    return { id: Number(r.lastInsertRowid), duplicate: false };
  }

  setWebhookEventState(id: number, state: WebhookEventRecord['processing_state'], error?: string): void {
    this.db.prepare('UPDATE webhook_events SET processing_state = ?, processing_error = ?, attempts = attempts + 1 WHERE id = ?').run(state, error ?? null, id);
  }

  getPendingWebhookEvents(limit = 50): WebhookEventRecord[] {
    return this.db.prepare("SELECT * FROM webhook_events WHERE processing_state IN ('pending','failed') AND attempts < 5 ORDER BY id LIMIT ?").all(limit) as WebhookEventRecord[];
  }

  getWebhookStats(): { total: number; pending: number; processed: number; failed: number; duplicates: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN processing_state='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN processing_state='processed' THEN 1 ELSE 0 END) AS processed,
          SUM(CASE WHEN processing_state='failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN processing_state='duplicate' THEN 1 ELSE 0 END) AS duplicates
         FROM webhook_events`
      )
      .get() as { total: number; pending: number; processed: number; failed: number; duplicates: number };
    return { total: r.total ?? 0, pending: r.pending ?? 0, processed: r.processed ?? 0, failed: r.failed ?? 0, duplicates: r.duplicates ?? 0 };
  }

  listWebhookEvents(limit = 50): WebhookEventRecord[] {
    return this.db.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?').all(limit) as WebhookEventRecord[];
  }

  lastSuccessfulSync(): string | null {
    const row = this.db.prepare("SELECT MAX(last_success_at) AS t FROM sync_checkpoints WHERE status = 'ok'").get() as { t: string | null };
    return row.t;
  }
}
