import type { DB } from '../database/connection.js';
import type { SupportHealthReport, SupportHealthMetric, SupportHealthFlag } from '../../shared/workspace.js';

/**
 * Customer/organization support health (plan Phase 24). OPERATIONAL FACTS
 * ONLY: every metric is a deterministic count/duration over observable
 * local data with a plain-language definition and bounded evidence links.
 * There is deliberately NO single "health score" - aggregating operational
 * signals into one number about a person invites psychological reading,
 * which the plan forbids ("Do not create psychological or personal
 * judgments"). Instead the report exposes labeled metrics + explicit
 * attention flags, each traceable to specific conversations.
 *
 * Every query is parameterized with exactly one subject id: the customer
 * id, or the organization id expanded through a members subselect.
 */
interface ERow { [k: string]: unknown }

const EVIDENCE_LIMIT = 10;
const ORG_MEMBERS = 'SELECT id FROM customers WHERE organization_id = ? AND deleted_at IS NULL';

export class SupportHealthService {
  constructor(private db: DB) {}

  forCustomer(customerLocalId: number): SupportHealthReport | null {
    const row = this.db
      .prepare("SELECT id, TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS label FROM customers WHERE id = ? AND deleted_at IS NULL")
      .get(customerLocalId) as { id: number; label: string } | undefined;
    if (!row) return null;
    const label = (row.label ?? '').trim() || `customer #${customerLocalId}`;
    return this.buildReport('customer', customerLocalId, label, 'c.customer_local_id = ?', 'r.customer_local_id = ?');
  }

  forOrganization(organizationId: number): SupportHealthReport | null {
    const org = this.db
      .prepare('SELECT id, name FROM organizations WHERE id = ? AND deleted_at IS NULL')
      .get(organizationId) as { id: number; name: string } | undefined;
    if (!org) return null;
    const label = (org.name ?? '').trim() || `organization #${organizationId}`;
    const convScope = `c.customer_local_id IN (${ORG_MEMBERS})`;
    const ratingScope = `r.customer_local_id IN (${ORG_MEMBERS})`;
    return this.buildReport('organization', organizationId, label, convScope, ratingScope);
  }

  private buildReport(subjectKind: 'customer' | 'organization', subjectId: number, subjectLabel: string, convScope: string, ratingScope: string): SupportHealthReport {
    const metrics: SupportHealthMetric[] = [];
    const flags: SupportHealthFlag[] = [];
    /** Evidence conversation ids for a conv-scope predicate. */
    const ev = (extraSql: string, ...extraParams: unknown[]): number[] =>
      (this.db
        .prepare(`SELECT c.id FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL ${extraSql} ORDER BY c.remote_created_at DESC LIMIT ${EVIDENCE_LIMIT}`)
        .all(subjectId, ...extraParams) as { id: number }[])
        .map((r) => r.id);

    const one = (sql: string, ...params: unknown[]): ERow => this.db.prepare(sql).get(...params) as ERow;

    const openConvs = Number(one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL AND c.status = 'active'`, subjectId).n ?? 0);
    const totalConvs = Number(one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL`, subjectId).n ?? 0);
    const volume90 = Number(one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL AND julianday(c.remote_created_at) >= julianday('now', '-90 days')`, subjectId).n ?? 0);

    metrics.push({
      key: 'open_conversations', label: 'Open conversations', value: openConvs, display: String(openConvs),
      definition: `Conversations currently in status "active" for this ${subjectKind}.`,
      evidence_conversation_ids: ev("AND c.status = 'active'"), completeness: 'known'
    });
    metrics.push({
      key: 'support_volume_total', label: 'Support volume (all time)', value: totalConvs, display: String(totalConvs),
      definition: `Total conversations ever synced for this ${subjectKind}.`,
      evidence_conversation_ids: ev(''), completeness: 'known'
    });
    metrics.push({
      key: 'support_volume_90d', label: 'Support volume (90 days)', value: volume90, display: String(volume90),
      definition: 'Conversations created in the last 90 days.',
      evidence_conversation_ids: ev("AND julianday(c.remote_created_at) >= julianday('now', '-90 days')"), completeness: 'known'
    });

    // Waiting duration (calendar days; the SLA business-hours view lives on
    // the conversation itself - this is the honest subject-side number).
    const waiting = one(
      `SELECT COUNT(*) AS n, AVG(julianday('now') - julianday(c.customer_waiting_since)) AS avg_days, MAX(julianday('now') - julianday(c.customer_waiting_since)) AS max_days
       FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL AND c.status = 'active' AND c.customer_waiting_since IS NOT NULL`, subjectId);
    const waitingCount = Number(waiting.n ?? 0);
    metrics.push({
      key: 'waiting_count', label: 'Currently waiting', value: waitingCount, display: String(waitingCount),
      definition: 'Open conversations where the customer is waiting for a reply (local waiting marker).',
      evidence_conversation_ids: ev("AND c.status = 'active' AND c.customer_waiting_since IS NOT NULL"), completeness: waitingCount > 0 ? 'known' : 'unknown'
    });
    if (waitingCount > 0) {
      metrics.push({
        key: 'waiting_avg_days', label: 'Average wait', value: Number(waiting.avg_days ?? 0),
        display: `${Number(waiting.avg_days ?? 0).toFixed(1)} days`,
        definition: 'Average calendar days waiting across currently-open conversations (not business hours).',
        evidence_conversation_ids: ev("AND c.status = 'active' AND c.customer_waiting_since IS NOT NULL"), completeness: 'known'
      });
      const maxDays = Number(waiting.max_days ?? 0);
      if (maxDays >= 5) {
        flags.push({ key: 'waiting_long', label: 'Waiting a long time', severity: 'critical', detail: `A conversation has been waiting ${maxDays.toFixed(1)} calendar days for a reply.`, evidence_conversation_ids: ev("AND c.status = 'active' AND c.customer_waiting_since IS NOT NULL") });
      } else if (maxDays >= 2) {
        flags.push({ key: 'waiting_long', label: 'Waiting', severity: 'warning', detail: `A conversation has been waiting ${maxDays.toFixed(1)} calendar days for a reply.`, evidence_conversation_ids: ev("AND c.status = 'active' AND c.customer_waiting_since IS NOT NULL") });
      }
    }

    // Response delays (first response, last 90d, calendar hours).
    const fr = one(
      `SELECT AVG(julianday(c.first_response_at) - julianday(c.first_customer_message_at)) * 24 AS avg_hours, COUNT(*) AS n
       FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL
         AND c.first_response_at IS NOT NULL AND c.first_customer_message_at IS NOT NULL
         AND julianday(c.remote_created_at) >= julianday('now', '-90 days')`, subjectId);
    metrics.push({
      key: 'first_response_avg_hours', label: 'Avg first response (90d)', value: Number(fr.avg_hours ?? 0),
      display: Number(fr.n ?? 0) > 0 ? `${Number(fr.avg_hours ?? 0).toFixed(1)} hours` : 'unknown',
      definition: 'Average calendar hours between the first customer message and the first agent reply (last 90 days). Business-hours SLA timing lives on each conversation.',
      evidence_conversation_ids: ev("AND c.first_response_at IS NOT NULL AND c.first_customer_message_at IS NOT NULL AND julianday(c.remote_created_at) >= julianday('now', '-90 days')"), completeness: Number(fr.n ?? 0) > 0 ? 'known' : 'unknown'
    });

    // Negative outcomes: not-good ratings in the last 90 days.
    const badCount = Number(one(`SELECT COUNT(*) AS n FROM ratings r WHERE r.rating = 'not-good' AND ${ratingScope} AND julianday(r.remote_created_at) >= julianday('now', '-90 days')`, subjectId).n ?? 0);
    const badEvidence = (this.db
      .prepare(`SELECT r.conversation_id FROM ratings r WHERE r.rating = 'not-good' AND ${ratingScope} AND r.conversation_id IS NOT NULL AND julianday(r.remote_created_at) >= julianday('now', '-90 days') LIMIT ${EVIDENCE_LIMIT}`)
      .all(subjectId) as { conversation_id: number }[]).map((r) => r.conversation_id);
    metrics.push({
      key: 'negative_outcomes_90d', label: 'Negative ratings (90d)', value: badCount, display: String(badCount),
      definition: 'Ratings "not-good" received in the last 90 days (Help Scout mirror).',
      evidence_conversation_ids: badEvidence, completeness: 'known'
    });
    if (badCount >= 2) {
      flags.push({ key: 'negative_outcomes', label: 'Recent negative outcomes', severity: 'warning', detail: `${badCount} "not-good" ratings in the last 90 days.`, evidence_conversation_ids: badEvidence });
    }

    // Escalation history (escalated tag, all time).
    const escalatedSql = "AND EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND t.name = 'escalated')";
    const escalations = Number(one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL ${escalatedSql}`, subjectId).n ?? 0);
    metrics.push({
      key: 'escalation_history', label: 'Escalated conversations', value: escalations, display: String(escalations),
      definition: 'Conversations carrying the "escalated" tag (all time, Help Scout mirror).',
      evidence_conversation_ids: ev(escalatedSql), completeness: 'known'
    });
    if (escalations >= 2) {
      flags.push({ key: 'escalation_history', label: 'Escalation history', severity: 'info', detail: `${escalations} conversations were escalated historically.`, evidence_conversation_ids: ev(escalatedSql) });
    }

    // Customer effort proxy: customer replies per conversation (90d).
    const effort = one(
      `SELECT AVG(x.msgs) AS avg_msgs FROM (
         SELECT c.id, (SELECT COUNT(*) FROM threads t WHERE t.conversation_id = c.id AND t.type = 'customer' AND t.deleted_at IS NULL AND t.state = 'published') AS msgs
         FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL AND julianday(c.remote_created_at) >= julianday('now', '-90 days')) x`, subjectId);
    const avgMsgs = Number(effort.avg_msgs ?? 0);
    metrics.push({
      key: 'customer_effort_msgs', label: 'Customer effort proxy (90d)', value: avgMsgs,
      display: avgMsgs > 0 ? `${avgMsgs.toFixed(1)} messages / conversation` : 'unknown',
      definition: 'Average number of customer messages per conversation in the last 90 days. A high value often means more back-and-forth to get resolved - an operational proxy, not a judgment about anyone.',
      evidence_conversation_ids: ev("AND julianday(c.remote_created_at) >= julianday('now', '-90 days')"), completeness: avgMsgs > 0 ? 'partial' : 'unknown'
    });
    if (avgMsgs >= 5) {
      flags.push({ key: 'high_effort', label: 'High customer effort', severity: 'info', detail: `An average of ${avgMsgs.toFixed(1)} customer messages per conversation in the last 90 days.`, evidence_conversation_ids: ev("AND julianday(c.remote_created_at) >= julianday('now', '-90 days')") });
    }

    // Repeated issues: same cluster hitting this subject repeatedly.
    const repeated = one(
      `SELECT ic.title AS title, COUNT(*) AS n FROM conversations c
       JOIN issue_cluster_conversations icc ON icc.conversation_id = c.id
       JOIN issue_clusters ic ON ic.id = icc.cluster_id
       WHERE ${convScope} AND c.deleted_at IS NULL GROUP BY ic.id HAVING n >= 2 ORDER BY n DESC LIMIT 1`, subjectId) as { title?: string; n?: number } | undefined;
    const repeatedN = Number(repeated?.n ?? 0);
    metrics.push({
      key: 'repeated_issues', label: 'Repeated issue exposure', value: repeatedN,
      display: repeatedN > 0 ? `${repeatedN} in "${String(repeated?.title ?? '')}"` : 'none',
      definition: 'Most-repeated issue cluster for this subject (conversations within one cluster). "None" is honest when no cluster repeats.',
      evidence_conversation_ids: ev('AND EXISTS (SELECT 1 FROM issue_cluster_conversations icc WHERE icc.conversation_id = c.id)'), completeness: 'known'
    });
    if (repeatedN >= 3) {
      flags.push({
        key: 'repeated_issue', label: 'Repeated issue', severity: 'warning',
        detail: `${repeatedN} conversations in the "${String(repeated?.title ?? '')}" issue cluster.`,
        evidence_conversation_ids: ev('AND EXISTS (SELECT 1 FROM issue_cluster_conversations icc JOIN issue_clusters ic ON ic.id = icc.cluster_id WHERE icc.conversation_id = c.id AND ic.title = ?)', String(repeated?.title ?? ''))
      });
    }

    // Unresolved issues: open conversations linked to non-resolved known issues.
    const unresolvedSql = "AND c.status = 'active' AND EXISTS (SELECT 1 FROM known_issue_conversations kic JOIN known_issues ki ON ki.id = kic.known_issue_id WHERE kic.conversation_id = c.id AND ki.status != 'resolved')";
    const unresolvedCount = Number(one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${convScope} AND c.deleted_at IS NULL ${unresolvedSql}`, subjectId).n ?? 0);
    metrics.push({
      key: 'unresolved_known_issues', label: 'Open conversations on unresolved issues', value: unresolvedCount, display: String(unresolvedCount),
      definition: 'Open conversations linked to known issues that are not yet resolved.',
      evidence_conversation_ids: ev(unresolvedSql), completeness: 'known'
    });
    if (unresolvedCount >= 1) {
      flags.push({ key: 'unresolved_issues', label: 'Unresolved issues', severity: 'warning', detail: `${unresolvedCount} open conversation(s) tied to known issues that are not resolved.`, evidence_conversation_ids: ev(unresolvedSql) });
    }

    // Current incident exposure (via members for organizations).
    const incidentScope = subjectKind === 'customer' ? 'c.customer_local_id = ?' : `c.customer_local_id IN (${ORG_MEMBERS})`;
    const incidents = this.db
      .prepare(
        `SELECT DISTINCT i.id AS incident_id, i.code, i.title, i.severity, i.status, COUNT(DISTINCT c.id) AS conversations
         FROM incidents i
         JOIN incident_conversations ic ON ic.incident_id = i.id
         JOIN conversations c ON c.id = ic.conversation_id
         WHERE i.status != 'resolved' AND c.deleted_at IS NULL AND ${incidentScope}
         GROUP BY i.id
         ORDER BY CASE i.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END`
      )
      .all(subjectId) as { incident_id: number; code: string; title: string; severity: 'sev1' | 'sev2' | 'sev3' | 'sev4'; status: string; conversations: number }[];
    const incidentEvidence = ev('AND EXISTS (SELECT 1 FROM incident_conversations ic JOIN incidents i ON i.id = ic.incident_id WHERE ic.conversation_id = c.id AND i.status != \'resolved\')');
    metrics.push({
      key: 'incident_exposure', label: 'Current incident exposure', value: incidents.length, display: incidents.length > 0 ? `${incidents.length} active incident(s)` : 'none',
      definition: 'Active (non-resolved) incidents this subject is exposed to via linked conversations.',
      evidence_conversation_ids: incidentEvidence, completeness: 'known'
    });
    for (const inc of incidents) {
      flags.push({
        key: `incident_${inc.incident_id}`, label: `Incident ${inc.code}`,
        severity: inc.severity === 'sev1' ? 'critical' : inc.severity === 'sev2' ? 'warning' : 'info',
        detail: `${inc.conversations} linked conversation(s) in active incident "${inc.title}" (status ${inc.status}).`,
        evidence_conversation_ids: ev('AND EXISTS (SELECT 1 FROM incident_conversations ic JOIN incidents i ON i.id = ic.incident_id WHERE ic.conversation_id = c.id AND i.status != \'resolved\' AND i.id = ?)', inc.incident_id)
      });
    }

    return {
      subject_kind: subjectKind,
      subject_id: subjectId,
      subject_label: subjectLabel,
      metrics,
      flags,
      incident_exposure: incidents.map((i) => ({ incident_id: i.incident_id, code: i.code, title: i.title, severity: i.severity, status: i.status as SupportHealthReport['incident_exposure'][number]['status'], conversations: i.conversations })),
      generated_at: new Date().toISOString(),
      note: 'Operational facts with evidence only. No psychological or personal judgments; no aggregate "score" by design (plan Phase 24).'
    };
  }
}
