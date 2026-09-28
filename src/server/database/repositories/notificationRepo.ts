import type { DB } from '../connection.js';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_DEFAULT_ENABLED,
  type NotificationRecord,
  type NotificationType,
  type NotificationSeverity
} from '../../../shared/collaboration.js';

interface Row { [k: string]: unknown }

/**
 * NotificationRepository (v1.8.0): persistent local Notification Center.
 *
 * Design decisions:
 * - INSERT ... ON CONFLICT(dedup_key) DO NOTHING + reading changes: the
 *   caller learns whether the row is NEW, so sweep re-runs and re-syncs are
 *   idempotent by construction (same pattern as conversation_events).
 * - Targeting: target_user_local_id = a specific user, NULL = broadcast to
 *   the (single local) operator. List/read queries take the acting user and
 *   match "target IS NULL OR target = me".
 * - Severity/title are produced SERVER-SIDE from closed notification types;
 *   user text (subjects, note excerpts) only ever lands in title/body as
 *   DATA rendered by React (escaped), never as markup.
 * - Time formats: created_at/read_at use datetime('now')-style space format
 *   (SQLite default). Comparisons use julianday() which accepts both that
 *   and ISO - the v1.6.0 audit bug class (bare string compares) is avoided.
 */
export class NotificationRepository {
  constructor(private db: DB) {}

  /** Insert with dedup; returns the row only when it is genuinely new. */
  insert(n: {
    type: NotificationType;
    severity?: NotificationSeverity;
    title: string;
    body?: string | null;
    target_user_local_id?: number | null;
    actor_user_local_id?: number | null;
    conversation_id?: number | null;
    conversation_number?: number | null;
    customer_local_id?: number | null;
    issue_id?: number | null;
    campaign_id?: number | null;
    job_id?: number | null;
    side_thread_id?: number | null;
    dedup_key: string;
  }): NotificationRecord | null {
    const severity: NotificationSeverity = n.severity ?? 'info';
    const result = this.db
      .prepare(
        `INSERT INTO notifications
           (type, severity, title, body, target_user_local_id, actor_user_local_id,
            conversation_id, conversation_number, customer_local_id, issue_id, campaign_id, job_id, side_thread_id, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedup_key) DO NOTHING`
      )
      .run(
        n.type,
        severity,
        n.title.slice(0, 300),
        n.body?.slice(0, 2000) ?? null,
        n.target_user_local_id ?? null,
        n.actor_user_local_id ?? null,
        n.conversation_id ?? null,
        n.conversation_number ?? null,
        n.customer_local_id ?? null,
        n.issue_id ?? null,
        n.campaign_id ?? null,
        n.job_id ?? null,
        n.side_thread_id ?? null,
        n.dedup_key
      );
    if (result.changes === 0) return null;
    return this.get(Number(result.lastInsertRowid)) ?? null;
  }

  get(id: number): NotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Row | undefined;
    return row ? mapNotification(row) : null;
  }

  list(opts: {
    /** Acting user; null rows (broadcast) always match. */
    meUserLocalId: number | null;
    unreadOnly?: boolean;
    type?: NotificationType | null;
    limit?: number;
    offset?: number;
  }): { notifications: NotificationRecord[]; total: number; unread: number } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const where: string[] = ['(n.target_user_local_id IS NULL OR n.target_user_local_id = ?)'];
    const args: unknown[] = [opts.meUserLocalId ?? -1];
    if (opts.unreadOnly) where.push('n.read_at IS NULL');
    if (opts.type) {
      where.push('n.type = ?');
      args.push(opts.type);
    }
    const whereSql = where.join(' AND ');
    const rows = this.db
      .prepare(`SELECT n.* FROM notifications n WHERE ${whereSql} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Row[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${whereSql}`).get(...args) as Row).n as number;
    const unread = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE (n.target_user_local_id IS NULL OR n.target_user_local_id = ?) AND n.read_at IS NULL`)
      .get(opts.meUserLocalId ?? -1) as Row).n as number;
    return { notifications: rows.map(mapNotification), total: Number(total), unread: Number(unread) };
  }

  /** Notifications of type 'mentioned'/'team_mentioned' targeting the user. */
  mentionsForMe(meUserLocalId: number, limit = 100): NotificationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications
         WHERE type IN ('mentioned', 'team_mentioned') AND target_user_local_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(meUserLocalId, Math.min(200, limit)) as Row[];
    return rows.map(mapNotification);
  }

  unreadCount(meUserLocalId: number | null): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE (target_user_local_id IS NULL OR target_user_local_id = ?) AND read_at IS NULL')
      .get(meUserLocalId ?? -1) as Row;
    return Number(row.n);
  }

  markRead(id: number, meUserLocalId: number | null, read = true): boolean {
    const result = this.db
      .prepare(
        `UPDATE notifications SET read_at = ${read ? "datetime('now')" : 'NULL'}
         WHERE id = ? AND (target_user_local_id IS NULL OR target_user_local_id = ?)`
      )
      .run(id, meUserLocalId ?? -1);
    return result.changes > 0;
  }

  markAllRead(meUserLocalId: number | null): number {
    const result = this.db
      .prepare(`UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL AND (target_user_local_id IS NULL OR target_user_local_id = ?)`)
      .run(meUserLocalId ?? -1);
    return result.changes;
  }

  // ---------------- preferences ----------------

  /** Effective enabled state per type (missing row = type default). */
  prefFor(type: NotificationType): boolean {
    const row = this.db.prepare('SELECT enabled FROM notification_prefs WHERE notification_type = ?').get(type) as Row | undefined;
    if (row == null) return NOTIFICATION_TYPE_DEFAULT_ENABLED[type];
    return Number(row.enabled) === 1;
  }

  listPrefs(): { type: NotificationType; enabled: boolean; default_enabled: boolean }[] {
    const rows = new Map<string, number>();
    for (const r of this.db.prepare('SELECT notification_type, enabled FROM notification_prefs').all() as Row[]) {
      rows.set(String(r.notification_type), Number(r.enabled));
    }
    return NOTIFICATION_TYPES.map((t) => ({
      type: t,
      enabled: rows.has(t) ? rows.get(t) === 1 : NOTIFICATION_TYPE_DEFAULT_ENABLED[t],
      default_enabled: NOTIFICATION_TYPE_DEFAULT_ENABLED[t]
    }));
  }

  setPref(type: NotificationType, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO notification_prefs (notification_type, enabled, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(notification_type) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(type, enabled ? 1 : 0);
  }

  // ---------------- retention ----------------

  /** Prune read+old or plain-old notifications (space-format cutoff). */
  pruneOlderThan(cutoff: string): number {
    const result = this.db
      .prepare('DELETE FROM notifications WHERE julianday(created_at) < julianday(?) OR (read_at IS NOT NULL AND julianday(read_at) < julianday(?))')
      .run(cutoff, cutoff);
    return result.changes;
  }
}

function mapNotification(r: Row): NotificationRecord {
  return {
    id: Number(r.id),
    type: String(r.type) as NotificationType,
    severity: String(r.severity) as NotificationSeverity,
    title: String(r.title ?? ''),
    body: r.body == null ? null : String(r.body),
    target_user_local_id: r.target_user_local_id == null ? null : Number(r.target_user_local_id),
    actor_user_local_id: r.actor_user_local_id == null ? null : Number(r.actor_user_local_id),
    conversation_id: r.conversation_id == null ? null : Number(r.conversation_id),
    conversation_number: r.conversation_number == null ? null : Number(r.conversation_number),
    customer_local_id: r.customer_local_id == null ? null : Number(r.customer_local_id),
    issue_id: r.issue_id == null ? null : Number(r.issue_id),
    campaign_id: r.campaign_id == null ? null : Number(r.campaign_id),
    job_id: r.job_id == null ? null : Number(r.job_id),
    side_thread_id: r.side_thread_id == null ? null : Number(r.side_thread_id),
    created_at: String(r.created_at ?? ''),
    read_at: r.read_at == null ? null : String(r.read_at)
  };
}
