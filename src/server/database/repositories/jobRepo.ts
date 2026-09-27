import type { DB } from '../connection.js';
import type { QueueJob, AuditEntry } from '../../../shared/types.js';

/** Generic background job queue + outbound remote-write queue + audit log. */
export class JobRepository {
  constructor(private db: DB) {}

  // ---------------- Generic job queue ----------------
  enqueue(queue: string, type: string, payload: Record<string, unknown>, priority = 2, maxAttempts = 3): number {
    // run_at MUST be in SQLite's own datetime('now') format ('YYYY-MM-DD HH:MM:SS').
    // It was previously stored as ISO-8601 with 'T'/'Z' separators, which compares
    // GREATER than every datetime('now') value forever - making every queued job
    // invisible to claimNext and silently disabling the whole job pipeline
    // (webhook-triggered syncs, attachment downloads, AI jobs, embeddings).
    const r = this.db
      .prepare("INSERT INTO jobs (queue, type, priority, payload, max_attempts, status, run_at, created_at) VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'), datetime('now'))")
      .run(queue, type, priority, JSON.stringify(payload), maxAttempts);
    return Number(r.lastInsertRowid);
  }

  /** Claim the next runnable job (priority asc, FIFO). Uses atomic UPDATE ... RETURNING semantics. */
  claimNext(queue?: string): QueueJob | null {
    // The payload column stores JSON TEXT; claimNext previously cast the raw
    // row straight to QueueJob, handing the worker a STRING where it expected
    // an object. Every payload field read as undefined (remoteId -> NaN), so
    // sync jobs "completed" without syncing anything. Parsed here like every
    // other job getter.
    const parseJob = (row: unknown): QueueJob => {
      const r = row as QueueJob & { payload: string | Record<string, unknown> | null };
      return { ...r, payload: r.payload == null ? null : typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload };
    };
    const tx = this.db.transaction(() => {
      const filter = queue ? 'AND queue = ?' : '';
      const rows = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' AND (run_at IS NULL OR run_at <= datetime('now')) ${filter}
           ORDER BY priority ASC, id ASC LIMIT 1`
        )
        .all(...(queue ? [queue] : []));
      const job = rows[0];
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET status='running', started_at=datetime('now'), attempt = attempt + 1 WHERE id = ?").run((job as QueueJob).id);
      const updated = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get((job as QueueJob).id);
      return parseJob(updated);
    });
    return tx() as QueueJob | null;
  }

  completeJob(id: number, _output?: Record<string, unknown>): void {
    this.db.prepare("UPDATE jobs SET status='completed', completed_at=datetime('now'), error=NULL WHERE id = ?").run(id);
  }

  failJob(id: number, error: string, retryable: boolean): void {
    const job = this.db.prepare('SELECT attempt, max_attempts FROM jobs WHERE id = ?').get(id) as { attempt: number; max_attempts: number } | undefined;
    if (!job) return;
    const canRetry = retryable && job.attempt < job.max_attempts;
    if (canRetry) {
      const backoffSec = Math.min(300, 2 ** job.attempt * 5);
      this.db
        .prepare("UPDATE jobs SET status='queued', error=?, run_at=datetime('now', '+' || ? || ' seconds') WHERE id = ?")
        .run(error.slice(0, 1000), backoffSec, id);
    } else {
      this.db.prepare("UPDATE jobs SET status='failed', error=?, completed_at=datetime('now') WHERE id = ?").run(error.slice(0, 1000), id);
    }
  }

  // v1.6.0 audit fix: return whether a row actually changed so routes can 404
  // instead of reporting success for nonexistent/NaN ids.
  cancelJob(id: number): boolean {
    const r = this.db.prepare("UPDATE jobs SET status='cancelled', completed_at=datetime('now') WHERE id = ? AND status IN ('queued','running','awaiting_approval')").run(id);
    return r.changes > 0;
  }

  retryJob(id: number, payloadPatch: Record<string, unknown> | null = null): boolean {
    const existing = this.db
      .prepare("SELECT payload, status FROM jobs WHERE id = ? AND status IN ('failed','cancelled','awaiting_approval')")
      .get(id) as { payload: string | null; status: string } | undefined;
    if (!existing) return false;
    if (payloadPatch && existing.payload) {
      // Approving an awaiting_approval job flags the payload so the worker
      // executes the parked action instead of parking it again.
      let merged: Record<string, unknown>;
      try {
        merged = { ...(JSON.parse(existing.payload) as Record<string, unknown>), ...payloadPatch };
      } catch {
        merged = { ...payloadPatch };
      }
      this.db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify(merged), id);
    }
    const r = this.db.prepare("UPDATE jobs SET status='queued', attempt=0, error=NULL, run_at=datetime('now') WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // v1.6.0 audit fix: awaiting-approval automation jobs used to be completed as
  // no-ops by the worker (the write action silently dropped). Parked jobs keep
  // a distinct status: visible in the Queue panel, never claimed, approve via
  // retry / reject via cancel.
  parkJob(id: number): void {
    this.db.prepare("UPDATE jobs SET status='awaiting_approval', completed_at=NULL WHERE id = ?").run(id);
  }

  getJob(id: number): QueueJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    const r = row as QueueJob & { payload: string | Record<string, unknown> | null };
    return { ...r, payload: r.payload == null ? null : typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload };
  }

  clearCompleted(): number {
    const r = this.db.prepare("DELETE FROM jobs WHERE status IN ('completed','cancelled') AND completed_at < datetime('now', '-1 day')").run();
    return r.changes;
  }

  listJobs(filter: { status?: string; queue?: string; limit?: number } = {}): QueueJob[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.queue) {
      where.push('queue = ?');
      args.push(filter.queue);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = filter.limit ?? 100;
    const argsWithLimit = [...args, limit];
    const rows = this.db.prepare(`SELECT * FROM jobs ${whereSql} ORDER BY id DESC LIMIT ?`).all(...argsWithLimit) as QueueJob[];
    return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(String(r.payload)) : null }));
  }

  queueStats(): { queued: number; running: number; failed: number; completed: number } {
    const r = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM jobs`
      )
      .get() as { queued: number; running: number; failed: number; completed: number };
    return { queued: r.queued ?? 0, running: r.running ?? 0, failed: r.failed ?? 0, completed: r.completed ?? 0 };
  }

  /** Clear running locks (after a restart, stale 'running' jobs must return to the queue). */
  recoverStaleJobs(): number {
    const r = this.db
      .prepare("UPDATE jobs SET status='queued', error='Recovered after restart' WHERE status='running' AND started_at < datetime('now', '-30 minutes')")
      .run();
    return r.changes;
  }

  // ---------------- Outbound (remote write) jobs ----------------
  createOutboundJob(kind: string, payload: Record<string, unknown>, opts: { conversationId?: number | null; threadId?: number | null; idempotencyKey?: string; requiresConfirmation?: boolean; maxAttempts?: number } = {}): number {
    const r = this.db
      .prepare(
        `INSERT INTO outbound_jobs (kind, conversation_id, thread_id, payload, status, requires_confirmation, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(kind, opts.conversationId ?? null, opts.threadId ?? null, JSON.stringify(payload), opts.requiresConfirmation ? 1 : 0, opts.idempotencyKey ?? null);
    return Number(r.lastInsertRowid);
  }

  getOutboundJob(id: number): (QueueJob & { payload: Record<string, unknown> }) | undefined {
    const row = this.db.prepare('SELECT * FROM outbound_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { ...(row as unknown as QueueJob), payload: JSON.parse(String(row.payload)) };
  }

  setOutboundStatus(id: number, status: string, error?: string | null, remoteResult?: unknown): void {
    this.db
      .prepare('UPDATE outbound_jobs SET status = ?, error = ?, remote_result = ?, attempts = attempts + 1, updated_at = datetime(\'now\') WHERE id = ?')
      .run(status, error ?? null, remoteResult !== undefined ? JSON.stringify(remoteResult) : null, id);
  }

  listOutboundJobs(status?: string, limit = 100): (QueueJob & { payload: Record<string, unknown> })[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM outbound_jobs WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM outbound_jobs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({ ...(r as unknown as QueueJob), payload: JSON.parse(String(r.payload)) }));
  }

  recordOutboundAttempt(jobId: number, attempt: number, summary: string, statusCode: number | null, responseBody: string | null, latencyMs: number | null): void {
    this.db
      .prepare('INSERT INTO outbound_attempts (outbound_job_id, attempt, request_summary, status_code, response_body, latency_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, attempt, summary.slice(0, 500), statusCode, responseBody ? responseBody.slice(0, 2000) : null, latencyMs);
  }

  // ---------------- Audit log ----------------
  audit(entry: { actor: 'user' | 'ai' | 'automation' | 'system'; action: string; conversation_id?: number | null; before_state?: unknown; after_state?: unknown; remote_operation?: string | null; remote_result?: unknown; ai_involvement?: boolean; job_id?: number | null; correlation_id?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (timestamp, actor, action, conversation_id, before_state, after_state, remote_operation, remote_result, ai_involvement, job_id, correlation_id)
         VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.actor,
        entry.action,
        entry.conversation_id ?? null,
        entry.before_state !== undefined ? JSON.stringify(entry.before_state).slice(0, 4000) : null,
        entry.after_state !== undefined ? JSON.stringify(entry.after_state).slice(0, 4000) : null,
        entry.remote_operation ?? null,
        entry.remote_result !== undefined ? JSON.stringify(entry.remote_result).slice(0, 2000) : null,
        entry.ai_involvement ? 1 : 0,
        entry.job_id ?? null,
        entry.correlation_id ?? null
      );
  }

  listAudit(conversationId?: number, limit = 200): AuditEntry[] {
    const rows = conversationId
      ? (this.db.prepare('SELECT * FROM audit_log WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit) as AuditEntry[])
      : (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditEntry[]);
    return rows;
  }

  // ---------------- Application errors ----------------
  logError(service: string, message: string, stack?: string, context?: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO application_errors (timestamp, service, message, stack, context) VALUES (datetime(\'now\'), ?, ?, ?, ?)').run(service, message.slice(0, 2000), stack?.slice(0, 8000) ?? null, context ? JSON.stringify(context) : null);
  }

  listRecentErrors(limit = 50): { id: number; timestamp: string; service: string | null; message: string | null }[] {
    return this.db.prepare('SELECT id, timestamp, service, message FROM application_errors ORDER BY id DESC LIMIT ?').all(limit) as { id: number; timestamp: string; service: string | null; message: string | null }[];
  }
}
