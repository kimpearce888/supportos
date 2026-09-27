import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { QueueJob, AuditEntry } from '../../../shared/types.js';

/** Generic background job queue + outbound remote-write queue + audit log. */
export class JobRepository {
  constructor(private db: DB) {}

  // ---------------- Generic job queue ----------------
  enqueue(queue: string, type: string, payload: Record<string, unknown>, priority = 2, maxAttempts = 3): number {
    const r = this.db
      .prepare("INSERT INTO jobs (queue, type, priority, payload, max_attempts, status, run_at, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, datetime('now'))")
      .run(queue, type, priority, JSON.stringify(payload), maxAttempts, nowIso());
    return Number(r.lastInsertRowid);
  }

  /** Claim the next runnable job (priority asc, FIFO). Uses atomic UPDATE ... RETURNING semantics. */
  claimNext(queue?: string): QueueJob | null {
    const tx = this.db.transaction(() => {
      const filter = queue ? 'AND queue = ?' : '';
      const rows = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' AND (run_at IS NULL OR run_at <= datetime('now')) ${filter}
           ORDER BY priority ASC, id ASC LIMIT 1`
        )
        .all(...(queue ? [queue] : [])) as QueueJob[];
      const job = rows[0];
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET status='running', started_at=datetime('now'), attempt = attempt + 1 WHERE id = ?").run(job.id);
      const updated = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as QueueJob;
      return updated;
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

  cancelJob(id: number): void {
    this.db.prepare("UPDATE jobs SET status='cancelled', completed_at=datetime('now') WHERE id = ? AND status IN ('queued','running')").run(id);
  }

  retryJob(id: number): void {
    this.db.prepare("UPDATE jobs SET status='queued', attempt=0, error=NULL, run_at=datetime('now') WHERE id = ?").run(id);
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
