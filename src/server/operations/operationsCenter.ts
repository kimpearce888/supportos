import type { DB } from '../database/connection.js';
import type { SettingsRepository } from '../database/repositories/settingsRepo.js';
import type { SlaService } from '../analytics/slaService.js';
import type { OperationsSnapshot, OperationsTile } from '../../shared/collaboration.js';
import { tileFragment, type ConversationOpsTileKey as FragKey } from './tileFragments.js';

/**
 * OperationsCenter service (v1.8.0, plan Phase 10): one aggregated snapshot
 * of the live operational state.
 *
 * Design decisions:
 * - Conversation-scoped tiles are COUNT(*) over the SAME whitelisted
 *   parameterized fragment the inbox drill-down uses (tileFragments.ts) -
 *   a tile can never disagree with its drill-down list.
 * - SLA tiles reuse SlaService.slaAlerts() verbatim (business-minutes logic
 *   exists exactly once in the codebase - the v1.7.0 "no parallel SLA
 *   implementation" rule).
 * - Mailbox scope: null = all inboxes; otherwise only the selected mailbox
 *   local ids. SLA alerts are filtered by the same ids.
 * - Every tile carries an honest note when its measurement has limits
 *   (wall vs business minutes, heuristic effort, AI confidence).
 */
interface ORow { [k: string]: unknown }

export const OPS_WAITING_THRESHOLD_SETTING = 'ops_waiting_threshold_minutes';
export const OPS_WAITING_THRESHOLD_DEFAULT = 240;

export class OperationsCenterService {
  constructor(
    private db: DB,
    private sla: SlaService,
    private settings: SettingsRepository
  ) {}

  snapshot(mailboxIds: number[] | null): OperationsSnapshot {
    const scope = this.sanitizeScope(mailboxIds);
    const scopeSql = scope ? `c.mailbox_local_id IN (${scope.map(() => '?').join(',')})` : null;
    const threshold = this.waitingThresholdMinutes();
    const tiles: OperationsTile[] = [];

    const convCount = (key: FragKey): number => {
      const frag = tileFragment(key, threshold);
      const where = [frag.whereSql, scopeSql].filter(Boolean).join(' AND ');
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where}`).get(...frag.params, ...(scope ?? [])) as ORow;
      return Number(row.n);
    };

    tiles.push({
      key: 'unassigned',
      label: 'Unassigned',
      count: convCount('unassigned'),
      severity: 'info',
      drill: { type: 'inbox', params: { view: 'unassigned' } },
      note: null
    });
    tiles.push({
      key: 'needs_first_response',
      label: 'Needs first response',
      count: convCount('needs_first_response'),
      severity: 'warning',
      drill: { type: 'inbox', params: { view: 'active', ops: 'needs_first_response' } },
      note: null
    });
    tiles.push({
      key: 'customer_waiting',
      label: 'Customer waiting',
      count: convCount('customer_waiting'),
      severity: 'info',
      drill: { type: 'inbox', params: { view: 'active', ops: 'customer_waiting' } },
      note: null
    });
    tiles.push({
      key: 'waiting_over_threshold',
      label: `Waiting > ${threshold} min`,
      count: convCount('waiting_over_threshold'),
      severity: 'warning',
      drill: { type: 'inbox', params: { view: 'active', ops: 'waiting_over_threshold' } },
      note: `Wall-clock minutes since the customer's last message (business hours not applied). Threshold is configurable in Settings.`
    });
    tiles.push({
      key: 'urgent',
      label: 'Urgent / high priority',
      count: convCount('urgent'),
      severity: 'warning',
      drill: { type: 'inbox', params: { view: 'active', ops: 'urgent' } },
      note: 'SupportOS priority (local field), high + urgent.'
    });

    // SLA tiles: reuse SlaService's exact business-minutes logic.
    const alerts = this.sla.slaAlerts();
    const scopedAlerts = scope ? alerts.alerts.filter((a) => scope.includes(a.mailbox_id)) : alerts.alerts;
    tiles.push({
      key: 'sla_at_risk',
      label: 'SLA at risk',
      count: scopedAlerts.filter((a) => a.state === 'at_risk').length,
      severity: 'warning',
      drill: { type: 'page', page: 'issues' },
      note: alerts.unconfigured_mailboxes.length > 0
        ? `${alerts.unconfigured_mailboxes.length} mailbox(es) have no business hours/targets configured and are not monitored.`
        : 'Business minutes at 80%+ of the mailbox target (Issue Radar holds the detail).'
    });
    tiles.push({
      key: 'sla_breached',
      label: 'SLA breached',
      count: scopedAlerts.filter((a) => a.state === 'breached').length,
      severity: 'critical',
      drill: { type: 'page', page: 'issues' },
      note: 'Business minutes past the mailbox target (Issue Radar holds the detail).'
    });

    tiles.push({
      key: 'high_effort',
      label: 'High customer effort',
      count: convCount('high_effort'),
      severity: 'info',
      drill: { type: 'inbox', params: { view: 'active', ops: 'high_effort' } },
      note: 'Heuristic: strong frustration signal or 5+ customer messages in the conversation.'
    });
    tiles.push({
      key: 'repeated_issue',
      label: 'Repeated issue',
      count: convCount('repeated_issue'),
      severity: 'info',
      drill: { type: 'inbox', params: { view: 'active', ops: 'repeated_issue' } },
      note: 'The same customer has 2+ conversations linked to one known issue.'
    });
    tiles.push({
      key: 'known_issue',
      label: 'Known issue (open tickets)',
      count: convCount('known_issue'),
      severity: 'info',
      drill: { type: 'inbox', params: { view: 'active', ops: 'known_issue' } },
      note: 'Open conversations linked to unresolved known issues.'
    });
    tiles.push({
      key: 'ai_escalation',
      label: 'AI escalation',
      count: convCount('ai_escalation'),
      severity: 'warning',
      drill: { type: 'inbox', params: { view: 'active', ops: 'ai_escalation' } },
      note: 'Latest AI analysis: urgency high/critical or frustrated sentiment, medium/high confidence.'
    });
    tiles.push({
      key: 'issue_spike',
      label: 'Issue spike',
      count: this.countIssueSpikes(),
      severity: 'warning',
      drill: { type: 'page', page: 'issues' },
      note: 'Issue clusters trending up (Issue Radar detail).'
    });
    tiles.push({
      key: 'automation_approvals',
      label: 'Automation approvals',
      count: this.countAutomationApprovals(),
      severity: 'warning',
      drill: { type: 'page', page: 'automation' },
      note: 'Actions parked awaiting explicit human approval.'
    });
    tiles.push({
      key: 'failed_jobs',
      label: 'Failed jobs (7d)',
      count: this.countFailedJobs(),
      severity: 'warning',
      drill: { type: 'page', page: 'automation' },
      note: 'Background jobs that exhausted their retries in the last 7 days.'
    });
    const syncProblems = this.syncProblems();
    tiles.push({
      key: 'sync_problems',
      label: 'Sync problems',
      count: syncProblems.count,
      severity: syncProblems.state === 'ERROR' ? 'critical' : 'info',
      drill: { type: 'page', page: 'sync-health' },
      note: syncProblems.note
    });
    tiles.push({
      key: 'campaign_activity',
      label: 'Campaign activity',
      count: this.countCampaignActivity(),
      severity: 'info',
      drill: { type: 'page', page: 'outreach' },
      note: 'Campaigns queued/sending/paused right now.'
    });

    return {
      generated_at: new Date().toISOString(),
      mailbox_scope: scope,
      tiles,
      waiting_threshold_minutes: threshold
    };
  }

  waitingThresholdMinutes(): number {
    const raw = Number(this.settings.get(OPS_WAITING_THRESHOLD_SETTING, OPS_WAITING_THRESHOLD_DEFAULT));
    return Number.isFinite(raw) ? Math.min(20160, Math.max(1, Math.trunc(raw))) : OPS_WAITING_THRESHOLD_DEFAULT;
  }

  setWaitingThresholdMinutes(minutes: number): void {
    this.settings.set(OPS_WAITING_THRESHOLD_SETTING, Math.min(20160, Math.max(1, Math.trunc(minutes))));
  }

  private sanitizeScope(mailboxIds: number[] | null): number[] | null {
    if (mailboxIds == null) return null;
    const ids = mailboxIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
    return ids.length > 0 ? ids : null;
  }

  private countIssueSpikes(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM issue_clusters WHERE trend = 'rising'").get() as ORow;
    return Number(row.n);
  }

  private countAutomationApprovals(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'automation_action_awaiting_approval' AND status IN ('queued','parked')")
      .get() as ORow;
    return Number(row.n);
  }

  private countFailedJobs(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND julianday(COALESCE(completed_at, created_at)) >= julianday('now', '-7 days')")
      .get() as ORow;
    return Number(row.n);
  }

  private syncProblems(): { count: number; state: string; note: string } {
    const state = String(this.db.prepare("SELECT value FROM application_settings WHERE key = 'sync_state'").pluck().get() ?? 'NEW').replace(/"/g, '');
    const recentErrors = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM application_errors WHERE julianday(timestamp) >= julianday('now', '-1 day')").get() as ORow).n
    );
    const problematic = state === 'ERROR' ? 1 : 0;
    const count = problematic + recentErrors;
    const note =
      state === 'ERROR'
        ? `Sync state is ERROR${recentErrors > 0 ? ` plus ${recentErrors} application error(s) in 24h` : ''}.`
        : recentErrors > 0
          ? `${recentErrors} application error(s) logged in the last 24h (state: ${state}).`
          : `Sync state: ${state}.`;
    return { count, state, note };
  }

  private countCampaignActivity(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM outreach_campaigns WHERE status IN ('queued','sending','paused')")
      .get() as ORow;
    return Number(row.n);
  }
}
