import type { DB } from '../database/connection.js';
import type { IssueImpact } from '../../shared/workspace.js';

/**
 * Issue impact intelligence (plan Phase 19). One shared implementation for
 * BOTH incidents (conversation links in incident_conversations) and known
 * issues (links in known_issue_conversations) - the metric shape is
 * identical, only the link table differs, so there is no parallel
 * implementation to drift.
 *
 * Invariants:
 * - Affected customers are COUNT(DISTINCT customer) - a ticket count is
 *   NEVER silently used as a customer count (the plan's explicit rule).
 * - Products are read from the current local AI attribute layer
 *   (ai_attributes, source-labeled); when no attributes exist the list is
 *   empty and the note says why - nothing is invented.
 * - Release correlation is a TEMPORAL ASSOCIATION ONLY: conversations
 *   starting within 7 days after a release date. The note says so in plain
 *   words; the service never claims causation.
 */
interface ERow { [k: string]: unknown }

export class IssueImpactService {
  constructor(private db: DB) {}

  forIncident(incidentId: number): IssueImpact | null {
    const exists = this.db.prepare('SELECT 1 FROM incidents WHERE id = ?').get(incidentId);
    if (!exists) return null;
    return this.compute(incidentId, 'incident', 'incident_conversations', 'incident_id');
  }

  forKnownIssue(knownIssueId: number): IssueImpact | null {
    const exists = this.db.prepare('SELECT 1 FROM known_issues WHERE id = ?').get(knownIssueId);
    if (!exists) return null;
    return this.compute(knownIssueId, 'known_issue', 'known_issue_conversations', 'known_issue_id');
  }

  private compute(subjectId: number, subjectKind: 'incident' | 'known_issue', linkTable: string, linkColumn: string): IssueImpact {
    // linkTable/linkColumn are hard-coded constants from THIS file's call
    // sites - never user input. All values below are bound parameters.
    const convIdsSql = `SELECT l.conversation_id AS id FROM ${linkTable} l
      JOIN conversations c ON c.id = l.conversation_id
      WHERE l.${linkColumn} = ? AND c.deleted_at IS NULL`;
    const base = `FROM conversations c WHERE c.id IN (${convIdsSql}) AND c.deleted_at IS NULL`;

    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS conversations,
           COUNT(DISTINCT c.customer_local_id) AS customers,
           (SELECT COUNT(DISTINCT cu.organization_id) FROM conversations c2
              JOIN customers cu ON cu.id = c2.customer_local_id
              WHERE c2.id IN (${convIdsSql}) AND c2.deleted_at IS NULL AND cu.organization_id IS NOT NULL) AS organizations,
           MIN(c.remote_created_at) AS first_seen,
           MAX(c.remote_created_at) AS last_seen,
           SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN c.status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
           SUM(CASE WHEN c.customer_waiting_since IS NOT NULL AND c.status = 'active' THEN 1 ELSE 0 END) AS waiting_count
         ${base}`
      )
      // The link-table subquery appears twice (inside the organization
      // subquery's IN and in the base's IN): two bindings.
      .get(subjectId, subjectId) as ERow;

    // Growth: conversations started in the last 7 days vs the previous 7.
    const recent = (this.db
      .prepare(`SELECT COUNT(*) AS n ${base} AND julianday(c.remote_created_at) >= julianday('now', '-7 days')`)
      .get(subjectId) as ERow).n as number;
    const previous = (this.db
      .prepare(`SELECT COUNT(*) AS n ${base} AND julianday(c.remote_created_at) >= julianday('now', '-14 days') AND julianday(c.remote_created_at) < julianday('now', '-7 days')`)
      .get(subjectId) as ERow).n as number;
    const recent14 = (this.db
      .prepare(`SELECT COUNT(*) AS n ${base} AND julianday(c.remote_created_at) >= julianday('now', '-14 days')`)
      .get(subjectId) as ERow).n as number;
    const prior14 = (this.db
      .prepare(`SELECT COUNT(*) AS n ${base} AND julianday(c.remote_created_at) >= julianday('now', '-28 days') AND julianday(c.remote_created_at) < julianday('now', '-14 days')`)
      .get(subjectId) as ERow).n as number;
    const ratio = previous > 0 ? recent / previous : recent > 0 ? null : 0;
    const direction: IssueImpact['growth_rate_7d']['direction'] =
      ratio == null ? (recent > 0 ? 'rising' : 'unknown') : ratio >= 1.3 ? 'rising' : ratio <= 0.7 ? 'falling' : 'flat';

    const firstSeen = (counts.first_seen as string | null) ?? null;
    const trend: IssueImpact['trend'] =
      counts.conversations === 0 ? 'unknown'
      : firstSeen != null && (this.db.prepare("SELECT julianday(?) >= julianday('now', '-7 days') AS recent").get(firstSeen) as ERow).recent === 1 ? 'new'
      : prior14 === 0 && recent14 >= 1 ? 'rising'
      : prior14 > 0 && recent14 < prior14 * 0.7 ? 'falling'
      : 'stable';

    const inboxes = (this.db
      .prepare(
        `SELECT (SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id) AS mailbox, COUNT(*) AS conversations
         ${base} GROUP BY c.mailbox_local_id ORDER BY conversations DESC LIMIT 10`
      )
      .all(subjectId) as { mailbox: string | null; conversations: number }[]);

    const tags = (this.db
      .prepare(
        `SELECT t.name AS tag, COUNT(*) AS conversations
         FROM conversation_tags ct
         JOIN tags t ON t.id = ct.tag_local_id
         WHERE ct.conversation_id IN (${convIdsSql})
         GROUP BY t.name ORDER BY conversations DESC LIMIT 10`
      )
      .all(subjectId) as { tag: string; conversations: number }[]);

    // Products from the local AI attribute layer (labeled, evidence-backed;
    // empty when nothing has been analyzed - the honest state).
    const products = (this.db
      .prepare(
        `SELECT aa.value AS product, COUNT(DISTINCT aa.conversation_id) AS conversations
         FROM ai_attributes aa
         WHERE aa.attribute = 'product' AND aa.superseded_at IS NULL AND aa.source = 'ai'
           AND aa.conversation_id IN (${convIdsSql}) AND aa.confidence IN ('high', 'medium')
         GROUP BY aa.value ORDER BY conversations DESC LIMIT 10`
      )
      .all(subjectId) as { product: string | null; conversations: number }[]);

    // Release correlation (incidents only): conversations starting within
    // 7 days after a recorded release date. Temporal association, nothing more.
    const releaseCandidates: IssueImpact['release_correlation_candidates'] = [];
    if (subjectKind === 'incident') {
      const releases = this.db
        .prepare('SELECT id, version_label, released_at FROM incident_releases WHERE incident_id = ? AND released_at IS NOT NULL')
        .all(subjectId) as { id: number; version_label: string; released_at: string }[];
      const stmt = this.db
        .prepare(
          `SELECT COUNT(*) AS n ${base}
           AND julianday(c.remote_created_at) >= julianday(?) AND julianday(c.remote_created_at) < julianday(?, '+7 days')`
        );
      for (const rel of releases) {
        const n = (stmt.get(subjectId, rel.released_at, rel.released_at) as ERow).n as number;
        if (n > 0) {
          releaseCandidates.push({
            version_label: rel.version_label,
            released_at: rel.released_at,
            conversations_within_7d: n,
            note: `${n} linked conversations started within 7 days after this release date - a temporal association, not a causal claim.`
          });
        }
      }
    }

    return {
      subject_kind: subjectKind,
      subject_id: subjectId,
      affected_conversations: Number(counts.conversations ?? 0),
      affected_customers: Number(counts.customers ?? 0),
      affected_organizations: Number(counts.organizations ?? 0),
      first_seen_at: firstSeen,
      last_seen_at: (counts.last_seen as string | null) ?? null,
      growth_rate_7d: { recent, previous, ratio, direction },
      trend,
      affected_inboxes: inboxes,
      top_tags: tags,
      products,
      open_closed_distribution: { open: Number(counts.open_count ?? 0), closed: Number(counts.closed_count ?? 0) },
      customer_waiting_count: Number(counts.waiting_count ?? 0),
      release_correlation_candidates: releaseCandidates,
      note: 'Customer and organization counts are distinct entities, never ticket counts. Products come from the local AI attribute layer (empty until conversations are analyzed). Release entries describe temporal associations only.'
    };
  }
}
