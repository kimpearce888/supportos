/**
 * M5 shared contract (v2.1.0): custom report builder (plan Phase 33).
 *
 * Design decisions:
 * - The report config is a CLOSED catalog selection: metric key, dimension
 *   key and filter values all come from whitelisted catalogs; values are
 *   bound parameters. User input never becomes SQL text - same policy as
 *   the view engine and the segment engine.
 * - Every metric ships a DEFINITION and limitations text, surfaced in the
 *   API response and the UI (plan: "All local metrics must show
 *   definitions"). Native Help Scout reports remain under the Help Scout
 *   tab, labeled by origin; this builder computes local metrics only.
 * - Comparison ranges re-run the SAME compiled query over an earlier
 *   window and report deltas as differences, never as judgments.
 * - Correlation is not causation anywhere in the output wording.
 */

// ---------------- Catalogs ----------------

export interface MetricCatalogEntry {
  key: string;
  label: string;
  definition: string;
  limitations: string;
  /** 'count' metrics are integers; 'rate' metrics are 0..1; 'avg' minutes/hours floats. */
  format: 'count' | 'rate' | 'minutes' | 'hours' | 'score';
  /** Present (true) only for metrics that require an attributeKey filter. */
  needsAttribute?: boolean;
}

export const REPORT_METRICS = [
  { key: 'conversations', label: 'Conversations', format: 'count', definition: 'Conversations created in the selected range, counting each local conversation row once.', limitations: 'Counts the local mirror; conversations deleted upstream are excluded.' },
  { key: 'unique_customers', label: 'Unique customers', format: 'count', definition: 'Distinct customers who started at least one conversation in the range.', limitations: 'Counts customers with a local mirror row.' },
  { key: 'organizations', label: 'Organizations', format: 'count', definition: 'Distinct organizations of the customers who started conversations in the range.', limitations: 'Only counts customers linked to an organization.' },
  { key: 'first_responses', label: 'First responses', format: 'count', definition: 'Conversations whose first agent response fell inside the range.', limitations: 'Requires the first-response timestamp, which exists only after sync observed it.' },
  { key: 'agent_replies', label: 'Agent replies', format: 'count', definition: 'Published reply threads by agents (or agent-triggered automation) in the range.', limitations: 'Line items and internal notes are not replies.' },
  { key: 'customer_replies', label: 'Customer replies', format: 'count', definition: 'Published customer threads in the range.', limitations: 'Line items are not messages.' },
  { key: 'closures', label: 'Closures', format: 'count', definition: 'Conversations closed inside the range.', limitations: 'Reopened conversations may close more than once; each closure event counts once per observed transition.' },
  { key: 'avg_first_response_minutes', label: 'Avg first response time (minutes)', format: 'minutes', definition: 'Mean minutes from conversation creation to the first agent response, over conversations that received one.', limitations: 'Conversations still awaiting a first response are excluded, which biases the average downward.' },
  { key: 'avg_resolution_minutes', label: 'Avg resolution time (minutes)', format: 'minutes', definition: 'Mean minutes from creation to close, over conversations closed in the range.', limitations: 'Excludes conversations still open (survivorship bias). Clock time, not working hours.' },
  { key: 'avg_wait_hours', label: 'Avg customer waiting (hours)', format: 'hours', definition: 'Mean hours a customer waited for the next agent response, estimated per conversation as close-or-now minus the last customer message, when the conversation ended in a waiting-to-close shape.', limitations: 'Approximation from observable timestamps; ignores overlapping wait spans in the middle of a thread.' },
  { key: 'sla_breached', label: 'SLA breached conversations', format: 'count', definition: 'Conversations in range whose current or final wait exceeded the configured SLA target for their mailbox.', limitations: 'Uses the same expression as the SLA report; conversations without a mailbox target are not monitored.' },
  { key: 'state_changes', label: 'Custom state changes', format: 'count', definition: 'Ticket-state transitions recorded locally in the range.', limitations: 'Pre-sync history is unknown by design (Help Scout exposes no historical state log).' },
  { key: 'avg_state_hours', label: 'Avg time in custom state (hours)', format: 'hours', definition: 'Mean hours conversations spent in the selected SupportOS state, from local transitions.', limitations: 'Censored for conversations still in the state; based on local observation only.' },
  { key: 'high_priority_rate', label: 'High-priority share', format: 'rate', definition: 'Share of conversations marked high or urgent in the local SupportOS priority field.', limitations: 'Priority is a local field; unset counts as none.' },
  { key: 'issue_linked_share', label: 'Issue-linked share', format: 'rate', definition: 'Share of conversations linked to a local issue cluster or known issue.', limitations: 'Linkage depends on clustering runs; unlinking removes the attribution.' },
  { key: 'ai_attribute_share', label: 'AI attribute share', format: 'rate', definition: 'Share of conversations whose current local AI attribute matches the configured key/value.', limitations: 'AI attributes require the deterministic or AI layer to have computed; missing rows count as unknown.', needsAttribute: true },
  { key: 'avg_customer_effort', label: 'Avg customer effort', format: 'score', definition: 'Mean effort score (0-10) from the interaction engine over analyzed conversations.', limitations: 'Heuristic composite; conversations without customer messages have no score.' },
  { key: 'high_friction_rate', label: 'High-friction share', format: 'rate', definition: 'Share of analyzed conversations with high friction.', limitations: 'Friction is a deterministic heuristic, not a judgment about people.' },
  { key: 'campaign_sent', label: 'Campaign messages sent', format: 'count', definition: 'Outreach recipients actually sent in the range.', limitations: 'Counts locally observed sends; unknown-state sends resolve on reconciliation.' },
  { key: 'campaign_replies', label: 'Campaign replies', format: 'count', definition: 'Outreach recipients the customer replied to in the range.', limitations: 'Reply detection scans the local mirror of the created conversations.' },
  { key: 'campaign_reply_rate', label: 'Campaign reply rate', format: 'rate', definition: 'Replies divided by sent recipients for campaigns active in the range.', limitations: 'Not email-delivery analytics; only replies observable in Help Scout conversations count.' }
] as const satisfies readonly MetricCatalogEntry[];

export type ReportMetricKey = (typeof REPORT_METRICS)[number]['key'];

export interface DimensionCatalogEntry {
  key: string;
  label: string;
  definition: string;
}

export const REPORT_DIMENSIONS = [
  { key: 'none', label: 'No grouping (total)', definition: 'One row: the metric over the whole range.' },
  { key: 'day', label: 'Day', definition: 'Calendar day of the conversation timestamp the metric is anchored to.' },
  { key: 'week', label: 'Week', definition: 'ISO week starting Monday of the anchoring timestamp.' },
  { key: 'month', label: 'Month', definition: 'Calendar month of the anchoring timestamp.' },
  { key: 'mailbox', label: 'Mailbox', definition: 'The Help Scout mailbox the conversation belongs to.' },
  { key: 'channel', label: 'Channel', definition: 'Conversation source type (email, chat, beacon...).' },
  { key: 'tag', label: 'Tag', definition: 'One row per tag carried by conversations (a conversation with two tags counts in both rows).' },
  { key: 'assignee', label: 'Assignee', definition: 'Assigned agent; unassigned conversations group separately.' },
  { key: 'team', label: 'Team', definition: 'Team of the assigned agent, where a team assignment exists.' },
  { key: 'status', label: 'Status', definition: 'Conversation status (active/closed/pending...).' },
  { key: 'priority', label: 'Priority', definition: 'Local SupportOS priority bucket.' },
  { key: 'custom_state', label: 'Custom state', definition: 'Local SupportOS ticket state at computation time.' },
  { key: 'response_state', label: 'Response state', definition: 'Derived response state (awaiting first response, waiting on customer...).' },
  { key: 'issue', label: 'Issue', definition: 'Linked local issue cluster or known issue; unlinked conversations group separately.' }
] as const satisfies readonly DimensionCatalogEntry[];

export type ReportDimensionKey = (typeof REPORT_DIMENSIONS)[number]['key'];

// ---------------- Config ----------------

export interface ReportFilters {
  mailboxLocalIds?: number[];
  channel?: string | null;
  tagsAny?: string[];
  tagsNone?: string[];
  statuses?: string[];
  assigneeLocalIds?: number[];
  minPriority?: 'low' | 'normal' | 'high' | 'urgent' | null;
  /** For ai_attribute_share: which catalog attribute the metric measures. */
  attributeKey?: string | null;
  /** For ai_attribute_share / avg_state_hours: closed value / state key selection. */
  attributeValue?: string | null;
  stateKey?: string | null;
}

export interface ReportConfig {
  metric: ReportMetricKey;
  dimension: ReportDimensionKey;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD (inclusive)
  comparison: 'none' | 'previous_period';
  filters?: ReportFilters;
  sort: 'metric_desc' | 'metric_asc' | 'dimension_asc';
  limit?: number | null;
}

export interface SavedReport {
  id: number;
  name: string;
  config: ReportConfig;
  created_at: string;
  updated_at: string;
}

export interface ReportRow {
  dimension_value: string;
  dimension_label: string;
  value: number;
  sample_conversation_ids: number[];
}

export interface ReportRunResult {
  metric: MetricCatalogEntry;
  dimension: DimensionCatalogEntry;
  rows: ReportRow[];
  comparison_rows: ReportRow[] | null;
  comparison_range: { dateFrom: string; dateTo: string } | null;
  date_range: { dateFrom: string; dateTo: string };
  notes: string[];
  origin: 'local';
}
