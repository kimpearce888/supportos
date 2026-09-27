import type { DB } from '../database/connection.js';
import { businessMinutesBetween, wallMinutesBetween, slaStatus, isValidTimezone, type BusinessHoursConfig, type SlaTargets } from './businessHours.js';
import { DEFAULT_BUSINESS_HOURS } from './businessHours.js';

/**
 * SLA reporting service (v1.4.0): per-mailbox first-response and resolution
 * performance measured in BUSINESS minutes against configurable schedules
 * and targets, plus live "currently waiting" aging for breach risk.
 *
 * Design decisions:
 * - SQL selects the (created, first-reply / closed) pairs; the business-hours
 *   arithmetic happens in TypeScript because timezone/DST math belongs to the
 *   Intl tz database, not to hand-rolled SQL. The row counts are bounded by the
 *   report window, so this stays fast on a local mirror.
 * - Metric honesty: every row carries both wall and business minutes, and a
 *   `business_hours_configured` flag. Without a configured schedule the report
 *   still works - in wall minutes, labeled as such. Nothing silently pretends
 *   to be business-hours-adjusted.
 */

export interface SlaDurationStats {
  count: number;
  avg_wall_min: number | null;
  avg_business_min: number | null;
  median_business_min: number | null;
  met: number;
  missed: number;
  no_target: number;
  target_min: number | null;
}

export interface SlaWaitingStats {
  count: number;
  oldest_business_min: number | null;
  avg_business_min: number | null;
  at_risk: number;
}

export interface SlaMailboxRow {
  mailbox_id: number;
  mailbox_name: string;
  business_hours_configured: boolean;
  schedule: { timezone: string; days: number[]; startMinute: number; endMinute: number } | null;
  conversations_in_range: number;
  first_response: SlaDurationStats;
  resolution: SlaDurationStats;
  waiting: SlaWaitingStats;
}

export interface SlaReport {
  range: { from: string; to: string };
  mailboxes: SlaMailboxRow[];
  unconfigured_mailboxes: string[];
  source: ('helpscout' | 'local' | 'ai')[];
}

export class SlaService {
  constructor(private db: DB) {}

  /** Per-mailbox SLA report over the window. */
  slaReport(from: string, to: string, mailboxLocalIds?: number[] | null): SlaReport {
    const idFilter = this.sanitizeIds(mailboxLocalIds);
    const mailboxIn = idFilter.length > 0 ? idFilter.join(',') : null;
    const mailboxes = this.db
      .prepare(`SELECT id, name FROM mailboxes WHERE deleted_at IS NULL ${mailboxIn ? `AND id IN (${mailboxIn})` : ''} ORDER BY name`)
      .all() as { id: number; name: string }[];

    const rows: SlaMailboxRow[] = [];
    const unconfigured: string[] = [];
    for (const m of mailboxes) {
      const cfg = this.getEffectiveConfig(m.id);
      if (!this.db.prepare('SELECT 1 AS x FROM mailbox_business_hours WHERE mailbox_local_id = ?').get(m.id)) {
        unconfigured.push(m.name);
      }
      rows.push({
        mailbox_id: m.id,
        mailbox_name: m.name,
        business_hours_configured: this.isConfigured(m.id),
        schedule: cfg ? { timezone: cfg.timezone, days: cfg.days, startMinute: cfg.startMinute, endMinute: cfg.endMinute } : null,
        conversations_in_range: this.countConversations(m.id, from, to),
        first_response: this.durationStats(m.id, from, to, 'first_response', cfg),
        resolution: this.durationStats(m.id, from, to, 'resolution', cfg),
        waiting: this.waitingStats(m.id, cfg)
      });
    }
    return { range: { from, to }, mailboxes: rows, unconfigured_mailboxes: unconfigured, source: ['local'] };
  }

  // ---------------- internals ----------------

  private sanitizeIds(ids?: number[] | null): number[] {
    return (ids ?? []).map((id) => Math.trunc(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  }

  private isConfigured(mailboxLocalId: number): boolean {
    return this.db.prepare('SELECT 1 AS x FROM mailbox_business_hours WHERE mailbox_local_id = ?').get(mailboxLocalId) != null;
  }

  /** Config from storage; invalid timezones degrade to UTC (engine guards too). */
  private getEffectiveConfig(mailboxLocalId: number): (BusinessHoursConfig & SlaTargets) | null {
    const stored = (
      this.db
        .prepare('SELECT timezone, days, start_minute, end_minute, first_response_target_min, resolution_target_min FROM mailbox_business_hours WHERE mailbox_local_id = ?')
        .get(mailboxLocalId) as { timezone: string; days: string; start_minute: number; end_minute: number; first_response_target_min: number | null; resolution_target_min: number | null } | undefined
    );
    if (!stored) return null;
    let days = DEFAULT_BUSINESS_HOURS.days;
    try {
      const parsed = JSON.parse(stored.days) as number[];
      if (Array.isArray(parsed) && parsed.length > 0) days = parsed;
    } catch {
      /* fall back to Mon-Fri */
    }
    return {
      timezone: isValidTimezone(stored.timezone) ? stored.timezone : 'UTC',
      days,
      startMinute: stored.start_minute,
      endMinute: stored.end_minute,
      firstResponseTargetMin: stored.first_response_target_min,
      resolutionTargetMin: stored.resolution_target_min
    };
  }

  private countConversations(mailboxLocalId: number, from: string, to: string): number {
    return (this.db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE mailbox_local_id = ? AND deleted_at IS NULL AND remote_created_at >= ? AND remote_created_at <= ?')
      .get(mailboxLocalId, from, to) as { n: number }).n;
  }

  /** first_response pairs: conversation created -> first published reply. */
  private firstResponsePairs(mailboxLocalId: number, from: string, to: string): { start: string; end: string }[] {
    return this.db
      .prepare(
        `SELECT c.remote_created_at AS start, fr.first_reply AS end
         FROM conversations c
         JOIN (SELECT conversation_id, MIN(remote_created_at) AS first_reply FROM threads WHERE type='reply' AND state='published' AND deleted_at IS NULL GROUP BY conversation_id) fr
           ON fr.conversation_id = c.id
         WHERE c.mailbox_local_id = ? AND c.deleted_at IS NULL AND c.remote_created_at >= ? AND c.remote_created_at <= ?`
      )
      .all(mailboxLocalId, from, to) as { start: string; end: string }[];
  }

  /** resolution pairs: conversation created -> closed. */
  private resolutionPairs(mailboxLocalId: number, from: string, to: string): { start: string; end: string }[] {
    return this.db
      .prepare(
        `SELECT c.remote_created_at AS start, c.closed_at AS end
         FROM conversations c
         WHERE c.mailbox_local_id = ? AND c.deleted_at IS NULL AND c.closed_at IS NOT NULL
           AND c.closed_at >= ? AND c.closed_at <= ?`
      )
      .all(mailboxLocalId, from, to) as { start: string; end: string }[];
  }

  private durationStats(mailboxLocalId: number, from: string, to: string, kind: 'first_response' | 'resolution', cfg: (BusinessHoursConfig & SlaTargets) | null): SlaDurationStats {
    const pairs = kind === 'first_response' ? this.firstResponsePairs(mailboxLocalId, from, to) : this.resolutionPairs(mailboxLocalId, from, to);
    const target = kind === 'first_response' ? cfg?.firstResponseTargetMin ?? null : cfg?.resolutionTargetMin ?? null;
    const walls: number[] = [];
    const businesses: number[] = [];
    let met = 0;
    let missed = 0;
    let noTarget = 0;
    for (const p of pairs) {
      if (!p.start || !p.end) continue;
      const wall = wallMinutesBetween(p.start, p.end);
      const business = cfg ? businessMinutesBetween(p.start, p.end, cfg) : null;
      if (wall == null) continue;
      walls.push(wall);
      if (business != null) businesses.push(business);
      const verdict = slaStatus(business ?? wall, target);
      if (verdict === 'met') met++;
      else if (verdict === 'missed') missed++;
      else noTarget++;
    }
    const avg = (xs: number[]): number | null => (xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return Math.round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
    };
    return {
      count: pairs.length,
      avg_wall_min: avg(walls),
      avg_business_min: businesses.length > 0 ? avg(businesses) : null,
      median_business_min: businesses.length > 0 ? median(businesses) : null,
      met,
      missed,
      no_target: target == null ? pairs.length : noTarget,
      target_min: target
    };
  }

  /** Currently-open conversations aging since their last customer activity. */
  private waitingStats(mailboxLocalId: number, cfg: (BusinessHoursConfig & SlaTargets) | null): SlaWaitingStats {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(c.last_activity_at, c.remote_created_at) AS since
         FROM conversations c
         WHERE c.mailbox_local_id = ? AND c.status IN ('active','pending') AND c.deleted_at IS NULL`
      )
      .all(mailboxLocalId) as { since: string | null }[];
    const now = new Date().toISOString();
    const businesses: number[] = [];
    for (const r of rows) {
      if (!r.since) continue;
      const b = cfg ? businessMinutesBetween(r.since, now, cfg) : wallMinutesBetween(r.since, now);
      if (b != null) businesses.push(b);
    }
    const target = cfg?.firstResponseTargetMin ?? null;
    const atRisk = target != null ? businesses.filter((b) => b > target).length : 0;
    const avg = businesses.length > 0 ? Math.round(businesses.reduce((a, b) => a + b, 0) / businesses.length) : null;
    return {
      count: rows.length,
      oldest_business_min: businesses.length > 0 ? Math.round(Math.max(...businesses)) : null,
      avg_business_min: avg,
      at_risk: atRisk
    };
  }

  // ---------------- SLA alerts (v1.5.0, Issue Radar) ----------------

  /** A conversation enters at-risk once it has consumed >= 80% of its target. */
  private static readonly AT_RISK_RATIO = 0.8;

  /**
   * Business-hours-aware SLA alerts for the Issue Radar (v1.5.0).
   *
   * For every ACTIVE/PENDING conversation with a business-hours-configured
   * mailbox we measure how long it has been waiting (business minutes since
   * the last CUSTOMER message - a conversation that is merely awaiting the
   * customer is not breaching anything) and compare against the mailbox's
   * first-response target (no agent reply yet) or resolution target (replied
   * but unresolved). Honest states everywhere: mailboxes without business
   * hours or without targets are reported as `unconfigured`, never guessed.
   */
  slaAlerts(): SlaAlerts {
    const now = new Date().toISOString();
    const mailboxes = this.db.prepare('SELECT id, name FROM mailboxes WHERE deleted_at IS NULL ORDER BY name').all() as { id: number; name: string }[];
    const alerts: SlaAlertRow[] = [];
    const perMailbox: { mailbox_id: number; mailbox_name: string; breached: number; at_risk: number; monitored: number }[] = [];
    const unconfigured: string[] = [];

    for (const m of mailboxes) {
      const cfg = this.getEffectiveConfig(m.id);
      if (!cfg || !this.isConfigured(m.id)) {
        const open = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE mailbox_local_id = ? AND status IN ('active','pending') AND deleted_at IS NULL").get(m.id) as { n: number }).n;
        if (open > 0) unconfigured.push(m.name);
        perMailbox.push({ mailbox_id: m.id, mailbox_name: m.name, breached: 0, at_risk: 0, monitored: 0 });
        continue;
      }
      // Waiting conversations + whether an agent reply exists
      const rows = this.db
        .prepare(
          `SELECT c.id, c.number, c.subject, c.status, c.assignee_local_id,
             COALESCE(c.last_activity_at, c.remote_created_at) AS since,
             EXISTS (SELECT 1 FROM threads t WHERE t.conversation_id = c.id AND t.type = 'reply' AND t.state = 'published' AND t.deleted_at IS NULL) AS replied,
             (SELECT COUNT(*) FROM threads t WHERE t.conversation_id = c.id AND t.type = 'customer' AND t.deleted_at IS NULL) AS customer_threads
           FROM conversations c
           WHERE c.mailbox_local_id = ? AND c.status IN ('active','pending') AND c.deleted_at IS NULL
             AND NOT (c.snoozed_until IS NOT NULL AND c.snoozed_until > ?)`
        )
        .all(m.id, now) as { id: number; number: number; subject: string | null; status: string; assignee_local_id: number | null; since: string | null; replied: number; customer_threads: number }[];

      let breached = 0;
      let atRisk = 0;
      for (const r of rows) {
        if (!r.since || r.customer_threads === 0) continue; // nothing awaiting us
        // The clock starts at the last CUSTOMER message, not the last activity
        const lastCustomer = (this.db
          .prepare("SELECT remote_created_at FROM threads WHERE conversation_id = ? AND type = 'customer' AND deleted_at IS NULL ORDER BY remote_created_at DESC LIMIT 1")
          .get(r.id) as { remote_created_at: string } | undefined)?.remote_created_at ?? r.since;
        const target = r.replied ? cfg.resolutionTargetMin : cfg.firstResponseTargetMin;
        if (target == null) continue;
        const waited = businessMinutesBetween(lastCustomer, now, cfg);
        if (waited == null) continue;
        const state: 'ok' | 'breached' | 'at_risk' = waited > target ? 'breached' : waited >= target * SlaService.AT_RISK_RATIO ? 'at_risk' : 'ok';
        if (state === 'ok') continue;
        if (state === 'breached') breached++;
        else atRisk++;
        alerts.push({
          conversation_id: r.id,
          number: r.number,
          subject: r.subject,
          status: r.status,
          mailbox_id: m.id,
          mailbox_name: m.name,
          assignee_local_id: r.assignee_local_id,
          state,
          waited_business_min: Math.round(waited),
          target_min: target,
          target_kind: r.replied ? 'resolution' : 'first_response',
          overdue_business_min: Math.max(0, Math.round(waited - target)),
          since: lastCustomer
        });
      }
      perMailbox.push({ mailbox_id: m.id, mailbox_name: m.name, breached, at_risk: atRisk, monitored: rows.length });
    }

    alerts.sort((a, b) => b.overdue_business_min - a.overdue_business_min || a.number - b.number);
    return {
      generated_at: now,
      total_breached: alerts.filter((a) => a.state === 'breached').length,
      total_at_risk: alerts.filter((a) => a.state === 'at_risk').length,
      alerts: alerts.slice(0, 50),
      per_mailbox: perMailbox,
      unconfigured_mailboxes: unconfigured,
      note: 'Alerts measure BUSINESS minutes (nights/weekends excluded) since each conversation\'s last customer message, against the mailbox\'s SLA targets. Mailboxes without business hours or targets are listed as unconfigured - nothing is guessed.'
    };
  }
}

export interface SlaAlertRow {
  conversation_id: number;
  number: number;
  subject: string | null;
  status: string;
  mailbox_id: number;
  mailbox_name: string;
  assignee_local_id: number | null;
  state: 'breached' | 'at_risk';
  waited_business_min: number;
  target_min: number;
  target_kind: 'first_response' | 'resolution';
  overdue_business_min: number;
  since: string;
}

export interface SlaAlerts {
  generated_at: string;
  total_breached: number;
  total_at_risk: number;
  alerts: SlaAlertRow[];
  per_mailbox: { mailbox_id: number; mailbox_name: string; breached: number; at_risk: number; monitored: number }[];
  unconfigured_mailboxes: string[];
  note: string;
}
