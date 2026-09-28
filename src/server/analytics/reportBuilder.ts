import type { DB } from '../database/connection.js';
import { RESPONSE_STATE_SQL } from '../inbox/responseState.js';
import { AI_ATTRIBUTE_CATALOG } from '../../shared/constants.js';
import { REPORT_METRICS, REPORT_DIMENSIONS } from '../../shared/reporting.js';
import type { MetricCatalogEntry, DimensionCatalogEntry, ReportConfig, ReportRow, ReportRunResult, SavedReport } from '../../shared/reporting.js';

/**
 * Custom report builder (v2.1.0, plan Phase 33).
 *
 * Compilation policy (the same one as the view engine and tile fragments):
 * metric keys, dimension keys and every SQL identifier come from CLOSED
 * code-side catalogs; only VALUES are bound parameters. A user config
 * selects catalog entries - it can never contribute SQL text.
 *
 * Every metric ships its definition and limitations (plan: "All local
 * metrics must show definitions"); the response embeds the catalog entry so
 * the UI can render it next to the numbers. Native Help Scout reports stay
 * under the Help Scout tab and are labeled by origin there - this builder
 * computes LOCAL metrics only and says so.
 */

// ---------------- metric specs (closed catalog) ----------------

type MetricAnchor = 'conversations' | 'threads' | 'transitions' | 'outcomes' | 'recipients';

interface MetricSpec {
  anchor: MetricAnchor;
  /** FROM clause (alias `c` = conversations where applicable). */
  from: string;
  /** Anchor timestamp expression the date range applies to. */
  dateExpr: string;
  /** SELECT value expression (uses `v` alias). */
  valueExpr: string;
  /** Extra WHERE clauses. */
  extraWhere?: string[];
  /** Bound parameters for extraWhere (appended after range params). */
  params?: unknown[];
  requiresAttribute?: boolean;
  requiresState?: boolean;
  /** Metrics whose only supported dimension is 'none'. */
  totalOnly?: boolean;
}

const PRIORITY_RANK: Record<string, number> = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };

function attributeShareExpr(): string {
  // Caller binds attributeKey + attributeValue after the range params.
  return `CAST(SUM(CASE WHEN EXISTS (
      SELECT 1 FROM ai_attributes a WHERE a.conversation_id = c.id AND a.attribute = ? AND a.superseded_at IS NULL AND LOWER(a.value) = LOWER(?)
    ) THEN 1 ELSE 0 END) AS REAL) / COUNT(*)`;
}

function attributeUnknownExpr(): string {
  return `CAST(SUM(CASE WHEN NOT EXISTS (
      SELECT 1 FROM ai_attributes a WHERE a.conversation_id = c.id AND a.attribute = ? AND a.superseded_at IS NULL
    ) THEN 1 ELSE 0 END) AS REAL) / COUNT(*)`;
}

const METRIC_SPECS: Record<string, MetricSpec> = {
  conversations: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.remote_created_at', valueExpr: 'COUNT(*)' },
  unique_customers: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.remote_created_at', valueExpr: 'COUNT(DISTINCT c.customer_local_id)' },
  organizations: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.remote_created_at', valueExpr: 'COUNT(DISTINCT c.organization_id)' },
  first_responses: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.first_response_at', valueExpr: 'COUNT(*)', extraWhere: ['c.first_response_at IS NOT NULL'] },
  agent_replies: { anchor: 'threads', from: 'threads t JOIN conversations c ON c.id = t.conversation_id', dateExpr: 't.remote_created_at', valueExpr: 'COUNT(*)', extraWhere: ["t.type = 'reply'", "t.deleted_at IS NULL", "t.state = 'published'"] },
  customer_replies: { anchor: 'threads', from: 'threads t JOIN conversations c ON c.id = t.conversation_id', dateExpr: 't.remote_created_at', valueExpr: 'COUNT(*)', extraWhere: ["t.type = 'customer'", 't.deleted_at IS NULL', "t.state = 'published'"] },
  closures: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.closed_at', valueExpr: 'COUNT(*)', extraWhere: ['c.closed_at IS NOT NULL'] },
  avg_first_response_minutes: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.first_response_at',
    valueExpr: 'AVG((julianday(c.first_response_at) - julianday(c.remote_created_at)) * 1440)',
    extraWhere: ['c.first_response_at IS NOT NULL', 'c.remote_created_at IS NOT NULL']
  },
  avg_resolution_minutes: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.closed_at',
    valueExpr: 'AVG((julianday(c.closed_at) - julianday(c.remote_created_at)) * 1440)',
    extraWhere: ['c.closed_at IS NOT NULL', 'c.remote_created_at IS NOT NULL']
  },
  avg_wait_hours: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.closed_at',
    valueExpr: 'AVG((julianday(c.closed_at) - julianday(c.last_customer_reply_at)) * 24)',
    extraWhere: ['c.closed_at IS NOT NULL', 'c.last_customer_reply_at IS NOT NULL', "c.status = 'closed'"]
  },
  sla_breached: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.remote_created_at',
    valueExpr: `COUNT(*)`,
    extraWhere: [
      `c.first_response_at IS NOT NULL AND c.remote_created_at IS NOT NULL`,
      `(julianday(c.first_response_at) - julianday(c.remote_created_at)) * 1440 > (SELECT mbh.first_response_target_min FROM mailbox_business_hours mbh WHERE mbh.mailbox_local_id = c.mailbox_local_id AND mbh.first_response_target_min IS NOT NULL)`
    ]
  },
  state_changes: { anchor: 'transitions', from: 'ticket_state_transitions tr', dateExpr: 'tr.occurred_at', valueExpr: 'COUNT(*)' },
  avg_state_hours: {
    anchor: 'transitions',
    from: 'ticket_state_transitions tr JOIN ticket_states s ON s.id = tr.new_state_id JOIN conversations c ON c.id = tr.conversation_id',
    dateExpr: 'tr.occurred_at',
    valueExpr: `AVG((julianday((SELECT MIN(nx.occurred_at) FROM ticket_state_transitions nx WHERE nx.conversation_id = tr.conversation_id AND nx.occurred_at > tr.occurred_at)) - julianday(tr.occurred_at)) * 24)`,
    extraWhere: ['s.key = ?'],
    requiresState: true
  },
  high_priority_rate: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.remote_created_at',
    valueExpr: `CAST(SUM(CASE WHEN c.supportos_priority IN ('high','urgent') THEN 1 ELSE 0 END) AS REAL) / COUNT(*)`
  },
  issue_linked_share: {
    anchor: 'conversations',
    from: 'conversations c',
    dateExpr: 'c.remote_created_at',
    valueExpr: `CAST(SUM(CASE WHEN (EXISTS (SELECT 1 FROM issue_cluster_conversations icc WHERE icc.conversation_id = c.id) OR EXISTS (SELECT 1 FROM known_issue_conversations kic WHERE kic.conversation_id = c.id)) THEN 1 ELSE 0 END) AS REAL) / COUNT(*)`
  },
  ai_attribute_share: { anchor: 'conversations', from: 'conversations c', dateExpr: 'c.remote_created_at', valueExpr: '', requiresAttribute: true },
  avg_customer_effort: {
    anchor: 'outcomes',
    from: 'client_support_outcomes o JOIN conversations c ON c.id = o.conversation_id',
    dateExpr: 'c.remote_created_at',
    valueExpr: 'AVG(o.effort_score)',
    extraWhere: ['o.effort_score IS NOT NULL']
  },
  high_friction_rate: {
    anchor: 'outcomes',
    from: 'client_support_outcomes o JOIN conversations c ON c.id = o.conversation_id',
    dateExpr: 'c.remote_created_at',
    valueExpr: `CAST(SUM(CASE WHEN o.friction = 'high' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)`
  },
  campaign_sent: { anchor: 'recipients', from: 'outreach_recipients r', dateExpr: 'r.sent_at', valueExpr: 'COUNT(*)', extraWhere: ['r.sent_at IS NOT NULL'], totalOnly: true },
  campaign_replies: { anchor: 'recipients', from: 'outreach_recipients r', dateExpr: 'r.replied_at', valueExpr: 'COUNT(*)', extraWhere: ['r.replied_at IS NOT NULL'], totalOnly: true },
  campaign_reply_rate: {
    anchor: 'recipients',
    from: 'outreach_recipients r',
    dateExpr: 'r.sent_at',
    valueExpr: 'CAST(SUM(CASE WHEN r.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS REAL) / COUNT(*)',
    extraWhere: ['r.sent_at IS NOT NULL'],
    totalOnly: true
  }
};

// ---------------- dimension specs (closed catalog) ----------------

interface DimensionSpec {
  /** SELECT expression producing the dimension value (alias dv). */
  expr: string;
  /** GROUP BY expression. */
  groupBy: string;
  /** Extra joins (must reference c when conversation-anchored). */
  joins?: string[];
  /** Produces a human label from the raw value in JS. */
  label?: (v: string) => string;
  /** Requires conversation anchor. */
  needsConversation?: boolean;
}

const TIME_DIMS: Record<string, DimensionSpec> = {
  day: { expr: `strftime('%Y-%m-%d', {DATE})`, groupBy: `strftime('%Y-%m-%d', {DATE})` },
  week: { expr: `strftime('%Y-%W', {DATE})`, groupBy: `strftime('%Y-%W', {DATE})` },
  month: { expr: `strftime('%Y-%m', {DATE})`, groupBy: `strftime('%Y-%m', {DATE})` }
};

const DIMENSION_SPECS: Record<string, DimensionSpec> = {
  none: { expr: `'(total)'`, groupBy: `'(total)'` },
  ...TIME_DIMS,
  mailbox: { expr: 'COALESCE((SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id), \'(no mailbox)\')', groupBy: 'c.mailbox_local_id', needsConversation: true },
  channel: { expr: `COALESCE(NULLIF(c.source_type, ''), '(unknown channel)')`, groupBy: `COALESCE(NULLIF(c.source_type, ''), '(unknown channel)')`, needsConversation: true },
  tag: { expr: 'tg.name', groupBy: 'tg.name', joins: ['JOIN conversation_tags ct ON ct.conversation_id = c.id', 'JOIN tags tg ON tg.id = ct.tag_local_id'], needsConversation: true },
  assignee: {
    expr: `COALESCE((SELECT (u.first_name || ' ' || u.last_name) FROM users u WHERE u.id = c.assignee_local_id), '(unassigned)')`,
    groupBy: 'c.assignee_local_id',
    needsConversation: true
  },
  team: {
    expr: `COALESCE((SELECT tm2.name FROM team_members tm JOIN teams tm2 ON tm2.id = tm.team_id WHERE tm.user_id = c.assignee_local_id LIMIT 1), '(no team)')`,
    groupBy: `COALESCE((SELECT tm.team_id FROM team_members tm WHERE tm.user_id = c.assignee_local_id LIMIT 1), -1)`,
    needsConversation: true
  },
  status: { expr: 'c.status', groupBy: 'c.status', needsConversation: true },
  priority: { expr: `COALESCE(NULLIF(c.supportos_priority, ''), 'none')`, groupBy: `COALESCE(NULLIF(c.supportos_priority, ''), 'none')`, needsConversation: true },
  custom_state: {
    expr: `COALESCE((SELECT ts.name FROM ticket_states ts WHERE ts.id = c.supportos_state_id), '(no state)')`,
    groupBy: 'c.supportos_state_id',
    needsConversation: true
  },
  response_state: { expr: RESPONSE_STATE_SQL, groupBy: RESPONSE_STATE_SQL, needsConversation: true },
  issue: {
    expr: `COALESCE(
      (SELECT ('KI: ' || ki.title) FROM known_issue_conversations kic JOIN known_issues ki ON ki.id = kic.known_issue_id WHERE kic.conversation_id = c.id LIMIT 1),
      (SELECT ('Cluster: ' || ic2.title) FROM issue_cluster_conversations icc JOIN issue_clusters ic2 ON ic2.id = icc.cluster_id WHERE icc.conversation_id = c.id LIMIT 1),
      '(not linked to an issue)')`,
    groupBy: `COALESCE(
      (SELECT kic.known_issue_id FROM known_issue_conversations kic WHERE kic.conversation_id = c.id LIMIT 1),
      (SELECT icc.cluster_id FROM issue_cluster_conversations icc WHERE icc.conversation_id = c.id LIMIT 1),
      -1)`,
    needsConversation: true
  }
};

// ---------------- service ----------------

export class ReportBuilderService {
  constructor(private db: DB) {}

  catalog(): { metrics: MetricCatalogEntry[]; dimensions: DimensionCatalogEntry[]; origin: 'local'; note: string } {
    return {
      metrics: REPORT_METRICS.map((m) => ({ ...m })),
      dimensions: REPORT_DIMENSIONS.map((d) => ({ ...d })),
      origin: 'local',
      note: 'This builder computes local SupportOS metrics only. Native Help Scout reports remain available under the Help Scout tab, clearly labeled as Help Scout-originated.'
    };
  }

  run(config: ReportConfig): ReportRunResult {
    const metricEntry = REPORT_METRICS.find((m) => m.key === config.metric);
    const dimensionEntry = REPORT_DIMENSIONS.find((d) => d.key === config.dimension);
    if (!metricEntry) throw new Error(`Unknown metric '${config.metric}'.`);
    if (!dimensionEntry) throw new Error(`Unknown dimension '${config.dimension}'.`);
    const spec = METRIC_SPECS[config.metric];
    if (!spec) throw new Error(`Metric '${config.metric}' is not implemented.`);
    if ((spec.totalOnly || spec.requiresAttribute || spec.requiresState) && config.dimension !== 'none') {
      throw new Error(`Metric '${config.metric}' supports no grouping (total only).`);
    }
    if (spec.requiresAttribute && !config.filters?.attributeKey) {
      throw new Error(`Metric '${config.metric}' requires an attribute key filter.`);
    }
    if (spec.requiresState && !config.filters?.stateKey) {
      throw new Error(`Metric '${config.metric}' requires a state key filter.`);
    }
    if (spec.requiresAttribute && !AI_ATTRIBUTE_CATALOG.some((a) => a.key === config.filters?.attributeKey)) {
      throw new Error(`Attribute key '${String(config.filters?.attributeKey)}' is not in the closed catalog.`);
    }
    if (spec.requiresState) {
      const state = this.db.prepare('SELECT 1 AS x FROM ticket_states WHERE key = ?').get(config.filters?.stateKey);
      if (!state) throw new Error(`State key '${String(config.filters?.stateKey)}' does not exist.`);
    }

    const rows = this.executeQuery(config, spec);
    let comparisonRows: ReportRow[] | null = null;
    let comparisonRange: { dateFrom: string; dateTo: string } | null = null;
    if (config.comparison === 'previous_period') {
      const days = Math.max(1, Math.round((Date.parse(config.dateTo) - Date.parse(config.dateFrom)) / 86400000) + 1);
      const prevTo = new Date(Date.parse(config.dateFrom) - 86400000);
      const prevFrom = new Date(Date.parse(config.dateFrom) - days * 86400000);
      comparisonRange = { dateFrom: iso(prevFrom), dateTo: iso(prevTo) };
      comparisonRows = this.executeQuery({ ...config, dateFrom: iso(prevFrom), dateTo: iso(prevTo) }, spec);
    }

    const notes: string[] = [
      `Metric definition: ${metricEntry.definition}`,
      `Limitations: ${metricEntry.limitations}`
    ];
    if (config.comparison === 'previous_period') {
      notes.push('Comparison values are differences over an earlier window of the same length; they describe change, not cause.');
    }
    if (spec.requiresAttribute && config.filters?.attributeValue == null) {
      notes.push("A blank attribute value means 'is unknown' (no current attribute row).");
    }
    return {
      metric: { ...metricEntry },
      dimension: { ...dimensionEntry },
      rows,
      comparison_rows: comparisonRows,
      comparison_range: comparisonRange,
      date_range: { dateFrom: config.dateFrom, dateTo: config.dateTo },
      notes,
      origin: 'local'
    };
  }

  private executeQuery(config: ReportConfig, spec: MetricSpec): ReportRow[] {
    const dimSpec = DIMENSION_SPECS[config.dimension]!;
    const dateExpr = spec.dateExpr;
    const dimExpr = dimSpec.expr.replace(/\{DATE\}/g, dateExpr);
    const groupExpr = dimSpec.groupBy.replace(/\{DATE\}/g, dateExpr);
    const joins: string[] = [...(spec.from.includes('conversations c') || spec.anchor === 'conversations' || spec.anchor === 'threads' || spec.anchor === 'outcomes' ? dimSpec.joins ?? [] : [])];

    // Parameters bind by POSITION in the final SQL: the SELECT value
    // expression comes before the WHERE clause, so value-expression params
    // must precede range/filter params (SQLite binds ? in string order).
    const selectParams: unknown[] = [];
    const whereParams: unknown[] = [];
    const where: string[] = [
      `COALESCE(julianday(${dateExpr}), julianday('2000-01-01')) >= julianday(?)`,
      `COALESCE(julianday(${dateExpr}), julianday('2000-01-01')) < julianday(?, '+1 day')`
    ];
    whereParams.push(config.dateFrom, config.dateTo);

    let valueExpr = spec.valueExpr;
    if (spec.requiresAttribute) {
      const attrValue = config.filters?.attributeValue ?? null;
      if (attrValue == null || attrValue === '' || attrValue.toLowerCase() === 'unknown') {
        valueExpr = attributeUnknownExpr();
        selectParams.push(config.filters!.attributeKey);
      } else {
        valueExpr = attributeShareExpr();
        selectParams.push(config.filters!.attributeKey, attrValue);
      }
    }

    for (const w of spec.extraWhere ?? []) {
      if (w === 's.key = ?') whereParams.push(config.filters?.stateKey);
      where.push(w);
    }
    const params: unknown[] = [...selectParams, ...whereParams];

    // Common conversation-level filters (only for conversation-anchored FROMs).
    const conversationAnchored = spec.anchor === 'conversations' || spec.anchor === 'threads' || spec.anchor === 'outcomes';
    const f = config.filters ?? {};
    if (conversationAnchored && spec.anchor !== 'outcomes') {
      if (Array.isArray(f.mailboxLocalIds) && f.mailboxLocalIds.length > 0) {
        where.push(`c.mailbox_local_id IN (${f.mailboxLocalIds.map(() => '?').join(',')})`);
        params.push(...f.mailboxLocalIds.filter((n) => Number.isInteger(n) && n > 0));
      }
      if (typeof f.channel === 'string' && f.channel.trim() !== '') {
        where.push(`LOWER(COALESCE(c.source_type, '')) = LOWER(?)`);
        params.push(f.channel.trim());
      }
      if (Array.isArray(f.tagsAny) && f.tagsAny.filter(Boolean).length > 0) {
        const tags = f.tagsAny.filter(Boolean);
        where.push(`EXISTS (SELECT 1 FROM conversation_tags ct2 JOIN tags tg2 ON tg2.id = ct2.tag_local_id WHERE ct2.conversation_id = c.id AND LOWER(tg2.name) IN (${tags.map(() => '?').join(',')}))`);
        params.push(...tags.map((t) => t.toLowerCase()));
      }
      if (Array.isArray(f.tagsNone) && f.tagsNone.filter(Boolean).length > 0) {
        const tags = f.tagsNone.filter(Boolean);
        where.push(`NOT EXISTS (SELECT 1 FROM conversation_tags ct2 JOIN tags tg2 ON tg2.id = ct2.tag_local_id WHERE ct2.conversation_id = c.id AND LOWER(tg2.name) IN (${tags.map(() => '?').join(',')}))`);
        params.push(...tags.map((t) => t.toLowerCase()));
      }
      if (Array.isArray(f.statuses) && f.statuses.filter(Boolean).length > 0) {
        where.push(`c.status IN (${f.statuses.map(() => '?').join(',')})`);
        params.push(...f.statuses.filter(Boolean));
      }
      if (Array.isArray(f.assigneeLocalIds) && f.assigneeLocalIds.length > 0) {
        where.push(`c.assignee_local_id IN (${f.assigneeLocalIds.map(() => '?').join(',')})`);
        params.push(...f.assigneeLocalIds.filter((n) => Number.isInteger(n)));
      }
      if (f.minPriority && PRIORITY_RANK[f.minPriority] != null) {
        where.push(`CASE c.supportos_priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 0 END >= ?`);
        params.push(PRIORITY_RANK[f.minPriority]);
      }
    }

    // NOTE: sample conversations are fetched with a separate bounded query
    // per row (cleaner than contorting the aggregate query).
    const sql = `
      SELECT ${dimExpr} AS dv, ${valueExpr} AS v
      FROM ${spec.from}
      ${joins.join(' ')}
      WHERE ${where.join(' AND ')}
      GROUP BY ${groupExpr}
    `;
    const raw = this.db.prepare(safeSql(sql)).all(...params.filter((p) => p !== undefined)) as { dv: string; v: number | null }[];
    let rows: ReportRow[] = raw.map((r) => ({
      dimension_value: String(r.dv),
      dimension_label: dimSpec.label ? dimSpec.label(String(r.dv)) : String(r.dv),
      value: r.v == null ? 0 : Number(r.v),
      sample_conversation_ids: []
    }));

    // Sample conversations for count metrics (bounded to 3 per row).
    if (conversationAnchored && spec.valueExpr === 'COUNT(*)' && config.dimension !== 'none') {
      for (const row of rows.slice(0, 20)) {
        row.sample_conversation_ids = this.sampleConversations(config, spec, dimSpec, row.dimension_value);
      }
    } else if (conversationAnchored && spec.valueExpr === 'COUNT(*)') {
      rows = rows.map((row) => ({ ...row, sample_conversation_ids: this.sampleConversations(config, spec, dimSpec, null) }));
    }

    const limit = config.limit == null ? 50 : Math.max(1, Math.min(200, Math.trunc(config.limit)));
    switch (config.sort) {
      case 'metric_asc':
        rows.sort((a, b) => a.value - b.value || a.dimension_label.localeCompare(b.dimension_label));
        break;
      case 'dimension_asc':
        rows.sort((a, b) => a.dimension_label.localeCompare(b.dimension_label));
        break;
      default:
        rows.sort((a, b) => b.value - a.value || a.dimension_label.localeCompare(b.dimension_label));
    }
    return rows.slice(0, limit);
  }

  private sampleConversations(config: ReportConfig, spec: MetricSpec, dimSpec: DimensionSpec, dimensionValue: string | null): number[] {
    const params: unknown[] = [config.dateFrom, config.dateTo];
    const where: string[] = [
      `COALESCE(julianday(${spec.dateExpr}), julianday('2000-01-01')) >= julianday(?)`,
      `COALESCE(julianday(${spec.dateExpr}), julianday('2000-01-01')) < julianday(?, '+1 day')`
    ];
    for (const w of spec.extraWhere ?? []) {
      if (w === 's.key = ?') params.push(config.filters?.stateKey);
      where.push(w);
    }
    const f = config.filters ?? {};
    if (Array.isArray(f.mailboxLocalIds) && f.mailboxLocalIds.length > 0) {
      where.push(`c.mailbox_local_id IN (${f.mailboxLocalIds.map(() => '?').join(',')})`);
      params.push(...f.mailboxLocalIds.filter((n) => Number.isInteger(n) && n > 0));
    }
    if (dimensionValue != null) {
      where.push(`${dimSpec.groupBy.replace(/\{DATE\}/g, spec.dateExpr)} = ?`);
      params.push(dimSpec.expr.startsWith('strftime') ? dimensionValue : dimensionValue);
    }
    const joins = (dimSpec.joins ?? []).join(' ');
    try {
      const rows = this.db
        .prepare(`SELECT DISTINCT c.id FROM ${spec.from} ${joins} WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 3`)
        .all(...params.filter((p) => p !== undefined)) as { id: number }[];
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  // ---------------- saved definitions ----------------

  listSaved(): SavedReport[] {
    return (this.db.prepare('SELECT * FROM report_definitions ORDER BY updated_at DESC').all() as { id: number; name: string; config: string; created_at: string; updated_at: string }[]).map((r) => ({
      id: r.id,
      name: r.name,
      config: JSON.parse(r.config) as ReportConfig,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  }

  saveSaved(name: string, config: ReportConfig): SavedReport {
    const res = this.db
      .prepare("INSERT INTO report_definitions (name, config, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(name, JSON.stringify(config));
    const id = Number(res.lastInsertRowid);
    return { id, name, config, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  }

  deleteSaved(id: number): boolean {
    return this.db.prepare('DELETE FROM report_definitions WHERE id = ?').run(id).changes > 0;
  }
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Defense in depth: the compiled SQL is built from closed catalogs only; this guard refuses anything that still smells like an injection attempt in a VALUE-less position. */
function safeSql(sql: string): string {
  if (/;|--\/\*|\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b/i.test(sql)) {
    throw new Error('Compiled report SQL failed the safety guard.');
  }
  return sql;
}
