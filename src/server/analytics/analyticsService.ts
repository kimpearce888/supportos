import type { DB } from '../database/connection.js';
import type { DashboardStats, MetricPoint, AiAnalytics, IssueRadarAlert, DocGap, AnswerReuseCandidate, ReportDefinitionInfo, MailboxComparisonRow } from '../../shared/types.js';
import { AnalyticsRepository } from '../database/repositories/analyticsRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';

export interface DashboardScope {
  /** Local mailbox ids to include; null/undefined = all mailboxes. */
  mailboxLocalIds?: number[] | null;
  /** Channel filter: 'email' or 'chat'; null/undefined = all channels. */
  channel?: 'email' | 'chat' | null;
}

/**
 * Local analytics (spec #46-#52, #153-#154): SQL computes numbers deterministically;
 * AI (when used) only explains them. Metric provenance is labeled everywhere.
 * v1.3.0: dashboard() accepts a scope - selected mailboxes and channel - so the
 * same deterministic SQL powers multi-mailbox comparison dashboards. Scope ids are
 * sanitized to integers before being interpolated into IN(...) clauses.
 */
export class AnalyticsService {
  private analytics: AnalyticsRepository;
  private issues: IssueRepository;
  private ai: AiRepository;

  constructor(private db: DB) {
    this.analytics = new AnalyticsRepository(db);
    this.issues = new IssueRepository(db);
    this.ai = new AiRepository(db);
  }

  dashboard(from: string, to: string, scope: DashboardScope = {}): DashboardStats {
    // --- scope fragments (safe: ids are sanitized integers) ---
    const mailboxIds = (scope.mailboxLocalIds ?? []).map((id) => Math.trunc(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
    const mailboxIn = mailboxIds.length > 0 ? mailboxIds.join(',') : null;
    const convMailboxSql = mailboxIn ? ` AND c.mailbox_local_id IN (${mailboxIn})` : '';
    const convChannelSql = scope.channel ? ` AND c.type = @channelType` : '';
    const convScopeArgs: Record<string, unknown> = scope.channel ? { channelType: scope.channel } : {};
    // Ratings scope: join back to conversations (ratings carry conversation_id only).
    // Ratings with no linked conversation are excluded from mailbox-scoped counts -
    // they cannot be attributed to a mailbox.
    const ratingJoinSql = `
      FROM ratings r LEFT JOIN conversations c ON c.id = r.conversation_id
      WHERE r.remote_created_at >= @from AND r.remote_created_at <= @to
        ${mailboxIn ? ` AND c.mailbox_local_id IN (${mailboxIn})` : ''}
        ${scope.channel ? ' AND c.type = @channelType' : ''}`;

    const counts = (this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN c.remote_created_at >= @from AND c.remote_created_at <= @to THEN 1 ELSE 0 END) AS new_conversations,
          SUM(CASE WHEN c.status='active' AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS active_conversations,
          SUM(CASE WHEN c.status='pending' AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS pending_conversations,
          SUM(CASE WHEN c.closed_at IS NOT NULL AND c.closed_at >= @from AND c.closed_at <= @to THEN 1 ELSE 0 END) AS closed_conversations,
          SUM(CASE WHEN c.status IN ('active','pending') AND c.assignee_local_id IS NULL AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS unassigned,
          SUM(CASE WHEN c.status IN ('active','pending') AND (julianday('now') - COALESCE(julianday(c.last_activity_at), julianday(c.remote_created_at))) >= 7 AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS backlog
         FROM conversations c WHERE c.deleted_at IS NULL${convMailboxSql}${convChannelSql}`
      )
      .get({ from, to, ...convScopeArgs }) as Record<string, number | null>) ?? {};

    const replies = (this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM threads t JOIN conversations c ON c.id = t.conversation_id
         WHERE t.type='reply' AND t.state='published' AND t.deleted_at IS NULL AND t.remote_created_at >= @from AND t.remote_created_at <= @to${convMailboxSql}${convChannelSql}`
      )
      .get({ from, to, ...convScopeArgs }) as { n: number }).n;

    const firstResponse = (this.db
      .prepare(
        `SELECT AVG((julianday(fr.first_reply) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS avg_min
         FROM conversations c
         JOIN (SELECT conversation_id, MIN(remote_created_at) AS first_reply FROM threads WHERE type='reply' AND state='published' AND deleted_at IS NULL GROUP BY conversation_id) fr
           ON fr.conversation_id = c.id
         WHERE c.remote_created_at >= @from AND c.remote_created_at <= @to AND c.deleted_at IS NULL${convMailboxSql}${convChannelSql}`
      )
      .get({ from, to, ...convScopeArgs }) as { avg_min: number | null }).avg_min;

    const resolution = (this.db
      .prepare(
        `SELECT AVG((julianday(c.closed_at) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS avg_min
         FROM conversations c WHERE c.closed_at IS NOT NULL AND c.closed_at >= @from AND c.closed_at <= @to AND c.deleted_at IS NULL${convMailboxSql}${convChannelSql}`
      )
      .get({ from, to, ...convScopeArgs }) as { avg_min: number | null }).avg_min;

    const ratings = (this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN r.rating='great' THEN 1 ELSE 0 END) AS great,
          SUM(CASE WHEN r.rating='okay' THEN 1 ELSE 0 END) AS okay,
          SUM(CASE WHEN r.rating='not-good' THEN 1 ELSE 0 END) AS notGood
         ${ratingJoinSql}`
      )
      .get({ from, to, ...convScopeArgs }) as { great: number; okay: number; notGood: number });

    const byMailbox = this.db
      .prepare(
        `SELECT m.name AS name, COUNT(*) AS count FROM conversations c JOIN mailboxes m ON m.id = c.mailbox_local_id
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convChannelSql} GROUP BY m.name ORDER BY count DESC`
      )
      .all({ from, to, ...convScopeArgs }) as { name: string; count: number }[];
    const byTag = this.db
      .prepare(
        `SELECT t.name AS name, COUNT(*) AS count FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id JOIN conversations c ON c.id = ct.conversation_id
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql}${convChannelSql} GROUP BY t.name ORDER BY count DESC LIMIT 12`
      )
      .all({ from, to, ...convScopeArgs }) as { name: string; count: number }[];
    const byAgent = this.db
      .prepare(
        `SELECT TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name, COUNT(*) AS count
         FROM conversations c JOIN users u ON u.id = c.assignee_local_id
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql}${convChannelSql} GROUP BY u.id ORDER BY count DESC`
      )
      .all({ from, to, ...convScopeArgs }) as { name: string; count: number }[];
    const byTeam = this.db
      .prepare(
        `SELECT tm.name AS name, COUNT(*) AS count FROM conversations c JOIN teams tm ON tm.id = c.assigned_team_local_id
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql}${convChannelSql} GROUP BY tm.name ORDER BY count DESC`
      )
      .all({ from, to, ...convScopeArgs }) as { name: string; count: number }[];
    const dailyNew = this.db
      .prepare(
        `SELECT date(c.remote_created_at) AS date, COUNT(*) AS value FROM conversations c
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql}${convChannelSql} GROUP BY date(c.remote_created_at) ORDER BY date`
      )
      .all({ from, to, ...convScopeArgs }) as MetricPoint[];

    // v1.3.0: channel split + per-channel speed (chat should be far faster than email)
    const byChannel = this.db
      .prepare(
        `SELECT COALESCE(c.type, 'unknown') AS channel, COUNT(*) AS count FROM conversations c
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql} GROUP BY COALESCE(c.type, 'unknown') ORDER BY count DESC`
      )
      .all({ from, to }) as { channel: string; count: number }[];
    const channelMetrics = this.db
      .prepare(
        `SELECT COALESCE(c.type, 'unknown') AS channel, COUNT(*) AS count,
           AVG((julianday(fr.first_reply) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS first_response_avg_min,
           AVG((julianday(c.closed_at) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS resolution_avg_min
         FROM conversations c
         LEFT JOIN (SELECT conversation_id, MIN(remote_created_at) AS first_reply FROM threads WHERE type='reply' AND state='published' AND deleted_at IS NULL GROUP BY conversation_id) fr
           ON fr.conversation_id = c.id
         WHERE c.deleted_at IS NULL AND c.remote_created_at >= @from AND c.remote_created_at <= @to${convMailboxSql}
         GROUP BY COALESCE(c.type, 'unknown') ORDER BY count DESC`
      )
      .all({ from, to }) as { channel: string; count: number; first_response_avg_min: number | null; resolution_avg_min: number | null }[];

    // v1.3.0: multi-mailbox comparison - one full KPI row per mailbox in scope
    const mailboxComparison = this.db
      .prepare(
        `SELECT m.id AS mailbox_id, m.name AS name,
           SUM(CASE WHEN c.remote_created_at >= @from AND c.remote_created_at <= @to THEN 1 ELSE 0 END) AS new_conversations,
           SUM(CASE WHEN c.status='active' AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS active_conversations,
           SUM(CASE WHEN c.closed_at IS NOT NULL AND c.closed_at >= @from AND c.closed_at <= @to THEN 1 ELSE 0 END) AS closed_conversations,
           SUM(CASE WHEN c.status IN ('active','pending') AND (julianday('now') - COALESCE(julianday(c.last_activity_at), julianday(c.remote_created_at))) >= 7 AND c.deleted_at IS NULL THEN 1 ELSE 0 END) AS backlog,
           AVG((julianday(fr.first_reply) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS first_response_avg_min,
           AVG((julianday(c.closed_at) - julianday(COALESCE(c.first_activity_at, c.remote_created_at))) * 1440) AS resolution_avg_min,
           (SELECT COUNT(*) FROM ratings r JOIN conversations c2 ON c2.id = r.conversation_id WHERE c2.mailbox_local_id = m.id AND r.rating='great' AND r.remote_created_at >= @from AND r.remote_created_at <= @to${scope.channel ? ' AND c2.type = @channelType' : ''}) AS great_ratings,
           (SELECT COUNT(*) FROM ratings r JOIN conversations c2 ON c2.id = r.conversation_id WHERE c2.mailbox_local_id = m.id AND r.remote_created_at >= @from AND r.remote_created_at <= @to${scope.channel ? ' AND c2.type = @channelType' : ''}) AS total_ratings
         FROM mailboxes m
         LEFT JOIN conversations c ON c.mailbox_local_id = m.id AND c.deleted_at IS NULL${scope.channel ? ' AND c.type = @channelType' : ''}
         LEFT JOIN (SELECT conversation_id, MIN(remote_created_at) AS first_reply FROM threads WHERE type='reply' AND state='published' AND deleted_at IS NULL GROUP BY conversation_id) fr ON fr.conversation_id = c.id
         WHERE m.deleted_at IS NULL${mailboxIn ? ` AND m.id IN (${mailboxIn})` : ''}
         GROUP BY m.id, m.name ORDER BY new_conversations DESC`
      )
      .all({ from, to, ...convScopeArgs }) as MailboxComparisonRow[];

    // Cache daily new metrics for report snapshots
    for (const d of dailyNew) this.analytics.upsertDailyMetric('new_conversations', d.date, d.value);

    return {
      range: { from, to },
      new_conversations: counts.new_conversations ?? 0,
      active_conversations: counts.active_conversations ?? 0,
      pending_conversations: counts.pending_conversations ?? 0,
      closed_conversations: counts.closed_conversations ?? 0,
      unassigned: counts.unassigned ?? 0,
      backlog: counts.backlog ?? 0,
      first_response_time_avg_min: firstResponse != null ? Math.round(firstResponse) : null,
      resolution_time_avg_min: resolution != null ? Math.round(resolution) : null,
      replies_sent: replies,
      ratings: { great: ratings.great ?? 0, okay: ratings.okay ?? 0, 'not-good': ratings.notGood ?? 0 },
      by_mailbox: byMailbox,
      by_tag: byTag,
      by_agent: byAgent,
      by_team: byTeam,
      daily_new: dailyNew,
      by_channel: byChannel,
      channel_metrics: channelMetrics.map((m) => ({
        channel: m.channel,
        count: m.count,
        first_response_avg_min: m.first_response_avg_min != null ? Math.round(m.first_response_avg_min) : null,
        resolution_avg_min: m.resolution_avg_min != null ? Math.round(m.resolution_avg_min) : null
      })),
      mailbox_comparison: mailboxComparison.map((m) => ({
        ...m,
        first_response_avg_min: m.first_response_avg_min != null ? Math.round(m.first_response_avg_min) : null,
        resolution_avg_min: m.resolution_avg_min != null ? Math.round(m.resolution_avg_min) : null
      })),
      source: ['local']
    };
  }

  aiAnalytics(): AiAnalytics {
    const r = this.ai.aiAnalytics();
    const analysisSuccessRate = r.analysis_completed + r.analysis_failed > 0 ? r.analysis_completed / (r.analysis_completed + r.analysis_failed) : 0;
    const feedbackTotal = r.drafts_accepted + r.drafts_rejected + r.drafts_edited;
    const patterns = this.db
      .prepare(
        `SELECT json_extract(verification, '$.warnings[0]') AS pattern, COUNT(*) AS count FROM ai_drafts
         WHERE verification IS NOT NULL AND json_extract(verification, '$.warnings[0]') IS NOT NULL
         GROUP BY pattern ORDER BY count DESC LIMIT 5`
      )
      .all() as { pattern: string; count: number }[];
    return {
      tickets_analyzed: r.tickets_analyzed,
      analysis_success_rate: Math.round(analysisSuccessRate * 1000) / 10,
      draft_count: r.draft_count,
      draft_accepted: r.drafts_accepted,
      draft_rejected: r.drafts_rejected,
      draft_edit_rate: feedbackTotal > 0 ? Math.round((r.drafts_edited / feedbackTotal) * 1000) / 10 : 0,
      verification_warnings: r.verification_warnings,
      unsupported_claim_rate: r.draft_count > 0 ? Math.round((r.unsupported_claims / r.draft_count) * 1000) / 10 : 0,
      common_failure_patterns: patterns,
      source: 'local'
    };
  }

  /** "Why are customers contacting us?" - data-driven categories from local analyses (spec #50). */
  whyCustomersContact(days = 30): { category: string; count: number; conversation_ids: number[] }[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(a.output, '$.issue_cluster_candidate') AS category, a.conversation_id
         FROM ai_runs a
         WHERE a.type='ticket_analysis' AND a.status='completed'
           AND a.conversation_id IS NOT NULL
           AND a.id IN (SELECT MAX(id) FROM ai_runs WHERE type='ticket_analysis' AND status='completed' GROUP BY conversation_id)
           AND json_extract(a.output, '$.issue_cluster_candidate') IS NOT NULL
           AND a.created_at >= datetime('now', '-' || @days || ' days')`
      )
      .all({ days }) as { category: string; conversation_id: number }[];
    const byCategory = new Map<string, number[]>();
    for (const r of rows) {
      const cat = String(r.category).toLowerCase().trim();
      const list = byCategory.get(cat) ?? [];
      list.push(r.conversation_id);
      byCategory.set(cat, list);
    }
    return [...byCategory.entries()]
      .map(([category, ids]) => ({ category, count: ids.length, conversation_ids: ids }))
      .sort((a, b) => b.count - a.count);
  }

  /** Top customer questions from AI analyses. */
  topQuestions(days = 30): { question: string; count: number; conversation_ids: number[] }[] {
    const rows = this.db
      .prepare(
        `SELECT LOWER(TRIM(json_extract(a.output, '$.primary_question'))) AS question, a.conversation_id
         FROM ai_runs a
         WHERE a.type='ticket_analysis' AND a.status='completed' AND a.conversation_id IS NOT NULL
           AND a.id IN (SELECT MAX(id) FROM ai_runs WHERE type='ticket_analysis' AND status='completed' GROUP BY conversation_id)
           AND json_extract(a.output, '$.primary_question') IS NOT NULL
           AND a.created_at >= datetime('now', '-' || @days || ' days')`
      )
      .all({ days }) as { question: string; conversation_id: number }[];
    const byQ = new Map<string, number[]>();
    for (const r of rows) {
      const list = byQ.get(r.question) ?? [];
      list.push(r.conversation_id);
      byQ.set(r.question, list);
    }
    return [...byQ.entries()].map(([question, ids]) => ({ question, count: ids.length, conversation_ids: ids })).sort((a, b) => b.count - a.count).slice(0, 20);
  }

  /** Documentation gap detection (spec #43): repeated questions with weak knowledge coverage. */
  docGaps(days = 90): DocGap[] {
    const questions = this.topQuestions(days).filter((q) => q.count >= 2);
    const gaps: DocGap[] = [];
    for (const q of questions) {
      const knowledgeHits = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM fts_knowledge WHERE fts_knowledge MATCH ?`)
        .all(this.ftsTokens(q.question)) as { n: number }[])[0]?.n ?? 0;
      const knownAnswer = (this.db
        .prepare(`SELECT body_text FROM threads WHERE conversation_id = ? AND type='reply' AND state='published' ORDER BY remote_created_at ASC LIMIT 1`)
        .get(q.conversation_ids[0] ?? 0) as { body_text: string | null } | undefined)?.body_text ?? null;
      let coverage: DocGap['coverage'];
      if (knowledgeHits === 0) coverage = 'missing';
      else if (knowledgeHits < 2) coverage = 'partial';
      else coverage = 'ambiguous';
      gaps.push({
        question: q.question,
        conversation_count: q.count,
        known_answer: knownAnswer ? knownAnswer.slice(0, 300) : null,
        coverage,
        suggested_doc_title: `Documentation: ${q.question.slice(0, 80)}`
      });
    }
    return gaps.slice(0, 15);
  }

  /** Answer reuse detection (spec #44): recommendation only, never automatic modification. */
  answerReuse(days = 90): AnswerReuseCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(a.output, '$.primary_question') AS question, a.conversation_id
         FROM ai_runs a
         WHERE a.type='ticket_analysis' AND a.status='completed' AND a.conversation_id IS NOT NULL
           AND a.id IN (SELECT MAX(id) FROM ai_runs WHERE type='ticket_analysis' AND status='completed' GROUP BY conversation_id)
           AND json_extract(a.output, '$.primary_question') IS NOT NULL
           AND a.created_at >= datetime('now', '-' || @days || ' days')`
      )
      .all({ days }) as { question: string; conversation_id: number }[];
    const byQ = new Map<string, number[]>();
    for (const r of rows) {
      const q = String(r.question).toLowerCase().trim();
      const list = byQ.get(q) ?? [];
      list.push(r.conversation_id);
      byQ.set(q, list);
    }
    const out: AnswerReuseCandidate[] = [];
    for (const [question, ids] of byQ) {
      if (ids.length < 2) continue;
      const first = ids[0]!;
      const commonResolution = (this.db
        .prepare("SELECT body_text FROM threads WHERE conversation_id = ? AND type='reply' AND state='published' ORDER BY remote_created_at ASC LIMIT 1")
        .get(first) as { body_text: string | null } | undefined)?.body_text ?? null;
      const savedReply = (this.db
        .prepare("SELECT name FROM saved_replies WHERE deleted_at IS NULL AND (name LIKE ? OR preview LIKE ?) LIMIT 1")
        .all(`%${question.slice(0, 40)}%`, `%${question.slice(0, 40)}%`) as { name: string }[])[0]?.name ?? null;
      const knowledgeDoc = (this.db
        .prepare('SELECT title FROM knowledge_documents WHERE title LIKE ? OR content LIKE ? LIMIT 1')
        .all(`%${question.slice(0, 40)}%`, `%${question.slice(0, 40)}%`) as { title: string }[])[0]?.title ?? null;
      out.push({
        question,
        conversation_count: ids.length,
        common_resolution: commonResolution ? commonResolution.slice(0, 300) : null,
        saved_reply_name: savedReply,
        knowledge_doc_title: knowledgeDoc
      });
    }
    return out.sort((a, b) => b.conversation_count - a.conversation_count).slice(0, 15);
  }

  /** Issue Radar (spec #42): every alert carries supporting ticket links, no causal claims. */
  issueRadar(): IssueRadarAlert[] {
    const alerts: IssueRadarAlert[] = [];
    const clusters = this.issues.listClusters();
    for (const c of clusters) {
      if (c.trend === 'new' && c.conversation_count >= 2) {
        alerts.push({
          kind: 'new_cluster',
          title: `New issue cluster: ${c.title}`,
          detail: `${c.conversation_count} conversations from ${c.customer_count} customers first seen recently. ${c.summary}`,
          conversation_ids: c.conversation_ids.slice(0, 10),
          cluster_id: c.id,
          severity: c.conversation_count >= 5 ? 'critical' : 'warning'
        });
      }
      if (c.trend === 'rising' && c.conversation_count >= 3) {
        alerts.push({
          kind: 'volume_spike',
          title: `Rising volume: ${c.title}`,
          detail: `Conversation volume in this cluster increased vs the previous 14 days. ${c.summary}`,
          conversation_ids: c.conversation_ids.slice(0, 10),
          cluster_id: c.id,
          severity: 'warning'
        });
      }
      if (c.trend === 'stable' && c.conversation_count >= 5) {
        alerts.push({
          kind: 'recurring_issue',
          title: `Recurring issue: ${c.title}`,
          detail: `${c.conversation_count} conversations over time. Consider a knowledge article or known issue entry. ${c.summary}`,
          conversation_ids: c.conversation_ids.slice(0, 10),
          cluster_id: c.id,
          severity: 'info'
        });
      }
    }
    // High-volume questions
    for (const q of this.topQuestions(30).slice(0, 3)) {
      if (q.count >= 3) {
        alerts.push({
          kind: 'high_volume_question',
          title: `High-volume question (${q.count} tickets)`,
          detail: q.question,
          conversation_ids: q.conversation_ids.slice(0, 10),
          cluster_id: null,
          severity: 'info'
        });
      }
    }
    // Escalation-heavy (v2.2.0 perf: bounded to 1000 rows - the alert only
    // needs a count check and a 10-id sample, plan Phase 41).
    const escalated = this.db
      .prepare("SELECT c.id FROM conversations c JOIN conversation_tags ct ON ct.conversation_id = c.id JOIN tags t ON t.id = ct.tag_local_id WHERE t.name = 'escalated' AND c.deleted_at IS NULL AND julianday(c.remote_created_at) >= julianday('now', '-30 days') LIMIT 1000")
      .all() as { id: number }[];
    if (escalated.length >= 2) {
      alerts.push({
        kind: 'escalation_heavy',
        title: `${escalated.length} escalated tickets in the last 30 days`,
        detail: 'Multiple tickets required escalation. Review the underlying causes - this is a correlation, not a causal claim.',
        conversation_ids: escalated.slice(0, 10).map((e) => e.id),
        cluster_id: null,
        severity: 'warning'
      });
    }
    // Rating-correlated clusters (correlation wording only). v2.2.0 perf:
    // bounded to the 2000 most recent not-good ratings (plan Phase 41) -
    // overlap detection only needs set membership against current clusters.
    const badRatings = this.db
      .prepare("SELECT r.conversation_id FROM ratings r WHERE r.rating = 'not-good' AND r.conversation_id IS NOT NULL ORDER BY r.id DESC LIMIT 2000")
      .all() as { conversation_id: number }[];
    if (badRatings.length > 0) {
      const badIds = new Set(badRatings.map((b) => b.conversation_id));
      for (const c of clusters) {
        const overlap = c.conversation_ids.filter((id) => badIds.has(id));
        if (overlap.length >= 2) {
          alerts.push({
            kind: 'rating_correlated',
            title: `Cluster "${c.title}" is associated with poor ratings`,
            detail: `${overlap.length} conversations in this cluster received "not-good" ratings. This is an association, not proof of causation.`,
            conversation_ids: overlap.slice(0, 10),
            cluster_id: c.id,
            severity: 'warning'
          });
        }
      }
    }
    // ---------------- v2.0.0 (M4, plan Phase 20): radar extensions ----------------
    alerts.push(...this.radarExtensions(clusters));
    return alerts;
  }

  /**
   * v2.0.0 (M4, plan Phase 20) radar extensions. Every alert is an
   * association with evidence links - the wording never claims causation
   * ("Never claim causation from correlation alone").
   */
  private radarExtensions(clusters: (import('../../shared/types.js').IssueCluster & { conversation_ids: number[] })[]): IssueRadarAlert[] {
    const alerts: IssueRadarAlert[] = [];
    if (clusters.length === 0) return alerts;
    const ids = clusters.flatMap((c) => c.conversation_ids);
    if (ids.length === 0) return alerts;

    // One pass over all cluster-member conversations (bounded, indexed),
    // with julian days computed once in SQL (no per-row prepares).
    const convStmt = this.db.prepare(
      `SELECT c.id, c.customer_local_id, c.mailbox_local_id, c.remote_created_at, julianday(c.remote_created_at) AS jd, julianday('now') AS now_jd
       FROM conversations c WHERE c.id IN (${ids.map(() => '?').join(',')}) AND c.deleted_at IS NULL`
    );
    interface ConvFacts { id: number; customer_local_id: number | null; mailbox_local_id: number | null; remote_created_at: string | null; jd: number | null; now_jd: number }
    const convById = new Map<number, ConvFacts>();
    for (const row of convStmt.all(...ids) as ConvFacts[]) {
      convById.set(row.id, row);
    }
    const nowJd = (this.db.prepare("SELECT julianday('now') AS j").get() as { j: number }).j;

    for (const c of clusters) {
      const convs = c.conversation_ids.map((id) => convById.get(id)).filter((x): x is ConvFacts => x != null);
      if (convs.length < 2) continue;
      const convIds = convs.map((v) => v.id);

      // Reappearing: activity in both the recent 30d and the 60-30d window.
      const recentCount = convs.filter((v) => v.jd != null && nowJd - v.jd <= 30).length;
      const olderCount = convs.filter((v) => v.jd != null && nowJd - v.jd > 30 && nowJd - v.jd <= 60).length;
      if (recentCount >= 2 && olderCount >= 2) {
        alerts.push({
          kind: 'reappearing_issue',
          title: `Reappearing issue: ${c.title}`,
          detail: `${olderCount} conversations 30-60 days ago and ${recentCount} in the last 30 days - the topic went quiet and came back. ${c.summary}`,
          conversation_ids: convIds.slice(0, 10),
          cluster_id: c.id,
          severity: 'warning'
        });
      }

      // Customer concentration: few customers, many tickets.
      const customers = new Set(convs.map((v) => v.customer_local_id).filter((x): x is number => x != null));
      if (convs.length >= 4 && customers.size > 0 && customers.size <= convs.length / 2) {
        alerts.push({
          kind: 'customer_concentration',
          title: `Customer concentration: ${c.title}`,
          detail: `${convs.length} conversations from only ${customers.size} distinct customers - a small group hitting the same problem repeatedly (an association, not a causal claim). ${c.summary}`,
          conversation_ids: convIds.slice(0, 10),
          cluster_id: c.id,
          severity: 'info'
        });
      }

      // Inbox concentration: one mailbox dominates the cluster.
      const mailboxCounts = new Map<number, number>();
      for (const v of convs) {
        if (v.mailbox_local_id == null) continue;
        mailboxCounts.set(v.mailbox_local_id, (mailboxCounts.get(v.mailbox_local_id) ?? 0) + 1);
      }
      const dominant = [...mailboxCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (dominant && convs.length >= 4 && dominant[1] / convs.length >= 0.7) {
        const mailboxName = (this.db.prepare('SELECT name FROM mailboxes WHERE id = ?').get(dominant[0]) as { name: string } | undefined)?.name ?? `mailbox #${dominant[0]}`;
        alerts.push({
          kind: 'inbox_concentration',
          title: `Inbox concentration: ${c.title}`,
          detail: `${dominant[1]} of ${convs.length} conversations arrived in "${mailboxName}" - the issue is concentrated in one channel. ${c.summary}`,
          conversation_ids: convIds.slice(0, 10),
          cluster_id: c.id,
          severity: 'info'
        });
      }

      // Release correlation: a 7-day burst window containing >= 60% of the
      // cluster (temporal clustering); releases recorded inside the window
      // are mentioned as associations. Pure julian-day arithmetic in JS.
      const jds = convs.map((v) => v.jd).filter((x): x is number => x != null).sort((a, b) => a - b);
      const dateByJd = new Map<number, string>();
      for (const v of convs) if (v.jd != null && v.remote_created_at != null) dateByJd.set(v.jd, v.remote_created_at);
      if (jds.length >= 4) {
        let bestStart: number | null = null;
        let bestCount = 0;
        for (const start of jds) {
          const inWindow = jds.filter((d) => d >= start && d < start + 7).length;
          if (inWindow > bestCount) { bestCount = inWindow; bestStart = start; }
        }
        if (bestStart != null && bestCount / jds.length >= 0.6) {
          const startDate = dateByJd.get(bestStart) ?? '';
          const releases = (this.db
            .prepare("SELECT version_label, released_at FROM incident_releases WHERE released_at IS NOT NULL AND julianday(released_at) >= ? AND julianday(released_at) < ? LIMIT 3")
            .all(bestStart, bestStart + 7) as { version_label: string; released_at: string }[]);
          const releaseNote = releases.length > 0
            ? ` Releases recorded in this window: ${releases.map((r) => r.version_label).join(', ')} (association only).`
            : '';
          alerts.push({
            kind: 'release_correlation',
            title: `Temporal burst: ${c.title}`,
            detail: `${bestCount} of ${jds.length} conversations started within one 7-day window starting ${startDate.slice(0, 10)}. Temporal clustering suggests something changed - possibly a release - but this is an association, not a causal claim.${releaseNote} ${c.summary}`,
            conversation_ids: convIds.slice(0, 10),
            cluster_id: c.id,
            severity: 'warning'
          });
        }
      }

      // Repeated unresolved pattern: one customer hitting the same cluster
      // repeatedly over a >= 14 day span.
      const byCustomer = new Map<number, { count: number; first: number; last: number; ids: number[] }>();
      for (const v of convs) {
        if (v.customer_local_id == null || v.jd == null) continue;
        const entry = byCustomer.get(v.customer_local_id) ?? { count: 0, first: v.jd, last: v.jd, ids: [] };
        entry.count += 1;
        entry.first = Math.min(entry.first, v.jd);
        entry.last = Math.max(entry.last, v.jd);
        entry.ids.push(v.id);
        byCustomer.set(v.customer_local_id, entry);
      }
      const repeated = [...byCustomer.entries()].filter(([, e]) => e.count >= 2 && e.last - e.first >= 14);
      if (repeated.length > 0) {
        alerts.push({
          kind: 'repeated_unresolved',
          title: `Repeated unresolved pattern: ${c.title}`,
          detail: `${repeated.length} customer(s) wrote in ${repeated.map(([, e]) => e.count).join(', ')} times about this cluster across 14+ day spans - the underlying problem may not be resolved. ${c.summary}`,
          conversation_ids: repeated.flatMap(([, e]) => e.ids).slice(0, 10),
          cluster_id: c.id,
          severity: 'warning'
        });
      }
    }

    // Unusual support volume (global): last 7d vs previous 7d.
    const recent7 = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL AND julianday(remote_created_at) >= julianday('now', '-7 days')").get() as { n: number }).n;
    const prev7 = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL AND julianday(remote_created_at) >= julianday('now', '-14 days') AND julianday(remote_created_at) < julianday('now', '-7 days')").get() as { n: number }).n;
    if (recent7 >= 10 && prev7 > 0 && recent7 / prev7 >= 1.4) {
      const sample = (this.db.prepare("SELECT id FROM conversations WHERE deleted_at IS NULL AND julianday(remote_created_at) >= julianday('now', '-7 days') ORDER BY remote_created_at DESC LIMIT 10").all() as { id: number }[]).map((r) => r.id);
      alerts.push({
        kind: 'volume_spike',
        title: `Unusual support volume: ${recent7} conversations in the last 7 days`,
        detail: `${recent7} conversations in the last 7 days vs ${prev7} in the previous 7 (a ${Math.round((recent7 / prev7 - 1) * 100)}% increase). An association with a change somewhere - not a causal claim.`,
        conversation_ids: sample,
        cluster_id: null,
        severity: recent7 / prev7 >= 2 ? 'critical' : 'warning'
      });
    }
    return alerts;
  }

  metricDefinitions(): ReportDefinitionInfo[] {
    return (this.db.prepare('SELECT key, name, description, formula, source, limitations FROM metric_definitions ORDER BY key').all() as ReportDefinitionInfo[]).map((d) => ({
      ...d,
      limitations: d.limitations ?? ''
    }));
  }

  private ftsTokens(q: string): string {
    return q
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 6)
      .map((t) => `"${t}"*`)
      .join(' ') || '""';
  }
}
