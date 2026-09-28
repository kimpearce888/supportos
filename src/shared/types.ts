/**
 * Shared domain types for SupportOS.
 * These are the canonical shapes used by both server and client.
 */
import type { AiAttributeKey, AiAttributeValueType, InteractionDimension } from './constants.js';

// ---------------------------------------------------------------- Sync
export type SyncState =
  | 'NEW'
  | 'INITIALIZING'
  | 'BACKFILLING'
  | 'CATCHING_UP'
  | 'LIVE'
  | 'RECONCILING'
  | 'PAUSED'
  | 'ERROR';

export type SyncResourceStatus = 'idle' | 'running' | 'ok' | 'error' | 'skipped';

export interface SyncCheckpoint {
  resource: string;
  last_success_at: string | null;
  remote_cursor: string | null;
  records_processed: number;
  records_failed: number;
  last_error: string | null;
  retry_count: number;
  status: SyncResourceStatus;
}

export interface SyncRunSummary {
  id: number;
  kind: 'initial' | 'incremental' | 'manual' | 'reconciliation';
  state: SyncState;
  started_at: string;
  finished_at: string | null;
  resources_done: number;
  resources_total: number;
  records_processed: number;
  errors: number;
}

// ---------------------------------------------------------------- Conversations
export type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam';
export type ConversationState = 'published' | 'draft' | 'deleted';
export type ThreadType = 'customer' | 'reply' | 'note' | 'forward' | 'message' | 'lineitem' | 'chat' | 'phone' | 'statuschange' | 'system' | 'action' | 'noresponse';

export interface ConversationSummary {
  id: number;
  remote_id: number;
  number: number;
  subject: string;
  preview: string;
  status: ConversationStatus;
  /** Channel: 'email' or 'chat' (Beacon chat sessions arrive as type='chat'). */
  type: string | null;
  /** Beacon attribution when present (source.via='beacon'). */
  source_via: string | null;
  mailbox_id: number;
  mailbox_name: string | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_email: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  assigned_team_id: number | null;
  tags: string[];
  thread_count: number;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  closed_at: string | null;
  snoozed_until: string | null;
  is_unread: 0 | 1;
  ai_analysis_status: 'none' | 'pending' | 'analyzed' | 'failed';
  known_issue_id: number | null;
  hs_url: string | null;
  merged_into_conversation_id: number | null;
  first_activity_at: string | null;
  last_activity_at: string | null;
  // ---- v1.7.0 activity engine ----
  first_customer_message_at: string | null;
  first_response_at: string | null;
  last_customer_reply_at: string | null;
  last_human_agent_response_at: string | null;
  customer_waiting_since: string | null;
  last_status_change_at: string | null;
  last_assignment_change_at: string | null;
  last_tag_change_at: string | null;
  activity_history_complete: 0 | 1;
  /** Local SupportOS priority (never Help Scout data). */
  priority: import('./activity.js').TicketPriority;
  /** Local SupportOS custom ticket state (null = unset). */
  ticket_state_id: number | null;
  /** v1.7.0 deterministic response state (mirrors RESPONSE_STATE_SQL). */
  response_state: import('./activity.js').ResponseState;
}

export interface ThreadSummary {
  id: number;
  remote_id: number;
  conversation_id: number;
  type: ThreadType;
  state: 'published' | 'draft' | 'scheduled' | 'deleted';
  body_text: string;
  body_html: string | null;
  from_name: string | null;
  from_email: string | null;
  from_type: 'customer' | 'user' | 'system_user' | 'team' | null;
  created_by_id: number | null;
  created_by_name: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  saved_reply_id: number | null;
  attachments: AttachmentMeta[];
  remote_created_at: string | null;
  scheduled_for: string | null;
}

export interface AttachmentMeta {
  id: number;
  remote_id: number;
  filename: string;
  mime_type: string | null;
  size: number | null;
  thread_id: number;
  conversation_id: number;
  local_path: string | null;
  state: 'metadata' | 'downloaded' | 'failed';
  downloaded_at: string | null;
}

// ---------------------------------------------------------------- People
export interface CustomerSummary {
  id: number;
  remote_id: number;
  first_name: string | null;
  last_name: string | null;
  emails: string[];
  phones: string[];
  organization_id: number | null;
  organization_name: string | null;
  photo_url: string | null;
  job_title: string | null;
  conversation_count: number;
  open_conversation_count: number;
  last_activity_at: string | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  average_rating: number | null;
}

export interface OrganizationSummary {
  id: number;
  remote_id: number;
  name: string;
  domains: string[];
  customer_count: number;
  conversation_count: number;
  remote_created_at: string | null;
}

export interface UserSummary {
  id: number;
  remote_id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  role: string | null;
  type: 'user' | 'system_user';
  timezone: string | null;
  photo_url: string | null;
  initials: string | null;
}

export interface TeamSummary {
  id: number;
  remote_id: number;
  name: string;
  member_count: number;
}

// ---------------------------------------------------------------- Reference data
export interface MailboxSummary {
  id: number;
  remote_id: number;
  name: string;
  email: string | null;
  slug: string | null;
  folder_count: number;
  created_at: string | null;
}

export interface TagSummary {
  id: number;
  remote_id: number;
  name: string;
  slug: string | null;
  color: string | null;
  ticket_count: number;
}

export interface CustomFieldOption {
  id: number;
  remote_id: number;
  label: string;
  order: number;
}

export interface CustomFieldSummary {
  id: number;
  remote_id: number;
  mailbox_id: number;
  name: string;
  type: 'dropdown' | 'date' | 'number' | 'singleline' | 'multiline' | 'checkbox';
  system_type: string | null;
  required: boolean;
  order: number;
  options: CustomFieldOption[];
}

export interface SavedReplySummary {
  id: number;
  remote_id: number;
  mailbox_id: number | null;
  name: string;
  preview: string;
  text: string | null;
  updated_at: string | null;
}

export interface WorkflowSummary {
  id: number;
  remote_id: number;
  mailbox_id: number | null;
  name: string;
  type: 'manual' | 'automatic';
  status: string | null;
  order: number | null;
}

export interface RatingSummary {
  id: number;
  remote_id: number;
  conversation_id: number;
  rating: 'great' | 'okay' | 'not-good';
  comments: string | null;
  customer_name: string | null;
  created_at: string | null;
}

// ---------------------------------------------------------------- AI
export type OperationalConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface AiSourceRef {
  source_type:
    | 'conversation'
    | 'thread'
    | 'note'
    | 'knowledge_document'
    | 'known_issue'
    | 'saved_reply'
    | 'support_case'
    | 'customer_memory'
    | 'issue_cluster';
  source_id: number;
  title: string;
  relevance: number;
  visibility: 'customer_safe' | 'internal_only' | 'uncertain';
  timestamp: string | null;
}

export interface TicketAnalysis {
  intent: string | null;
  primary_question: string | null;
  secondary_questions: string[];
  customer_goal: string | null;
  product: string | null;
  feature: string | null;
  problem_type: string | null;
  requested_action: string | null;
  urgency: 'low' | 'normal' | 'high' | 'critical' | null;
  sentiment: 'positive' | 'neutral' | 'negative' | 'frustrated' | null;
  known_issue_candidate: string | null;
  issue_cluster_candidate: string | null;
  missing_information: string[];
  summary: string | null;
  confidence: OperationalConfidence;
}

export interface DraftVerification {
  verified: boolean;
  unsupported_claims: string[];
  missing_questions: string[];
  internal_leakage: string[];
  conflicts: string[];
  warnings: string[];
}

export interface AiDraftRecord {
  id: number;
  conversation_id: number;
  content: string;
  mode: 'verified_answer' | 'standard';
  model: string | null;
  prompt_version: string;
  created_at: string;
  verification: DraftVerification | null;
  sources: AiSourceRef[];
  state: 'generated' | 'edited' | 'accepted' | 'rejected' | 'sent';
}

export interface AiJobRecord {
  id: number;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  conversation_id: number | null;
  model: string | null;
  prompt_version: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  latency_ms: number | null;
}

export interface CustomerMemory {
  id: number;
  customer_id: number;
  key: string;
  value: string;
  source: 'ai' | 'human';
  origin: 'conversation' | 'manual';
  first_seen_at: string | null;
  last_seen_at: string | null;
  confidence: OperationalConfidence;
}

// ---------------------------------------------------------------- Issues
export interface IssueCluster {
  id: number;
  title: string;
  summary: string;
  category: string | null;
  product: string | null;
  feature: string | null;
  conversation_count: number;
  customer_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  trend: 'rising' | 'stable' | 'falling' | 'new';
  known_issue_id: number | null;
  ai_generated: 0 | 1;
}

export interface KnownIssue {
  id: number;
  title: string;
  symptoms: string;
  product: string | null;
  feature: string | null;
  known_cause: string | null;
  workaround: string | null;
  customer_safe_explanation: string | null;
  internal_explanation: string | null;
  status: 'investigating' | 'identified' | 'fix_in_progress' | 'resolved' | 'monitoring';
  first_seen_at: string | null;
  last_seen_at: string | null;
  conversation_count: number;
  engineering_refs: { system: string; reference: string; url: string | null; title: string | null; status: string | null }[];
}

export interface IssueRadarAlert {
  kind: 'new_cluster' | 'volume_spike' | 'recurring_issue' | 'reappearing_issue' | 'high_volume_question' | 'doc_gap' | 'escalation_heavy' | 'rating_correlated' | 'customer_concentration' | 'inbox_concentration' | 'release_correlation' | 'repeated_unresolved';
  title: string;
  detail: string;
  conversation_ids: number[];
  cluster_id: number | null;
  severity: 'info' | 'warning' | 'critical';
}

export interface DocGap {
  question: string;
  conversation_count: number;
  known_answer: string | null;
  coverage: 'missing' | 'partial' | 'ambiguous' | 'outdated';
  suggested_doc_title: string | null;
}

export interface AnswerReuseCandidate {
  question: string;
  conversation_count: number;
  common_resolution: string | null;
  saved_reply_name: string | null;
  knowledge_doc_title: string | null;
}

// ---------------------------------------------------------------- Knowledge
export interface KnowledgeDocument {
  id: number;
  source_id: number;
  title: string;
  visibility: 'customer_safe' | 'internal_only';
  version: number;
  checksum: string | null;
  content_preview: string;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSource {
  id: number;
  name: string;
  kind: 'local_file' | 'manual' | 'import';
  visibility: 'customer_safe' | 'internal_only';
  document_count: number;
  created_at: string;
}

// ---------------------------------------------------------------- Search
export type SearchScope = 'all' | 'tickets' | 'customers' | 'knowledge' | 'issues' | 'saved_replies' | 'ai';

export interface SearchFilters {
  status?: ConversationStatus | 'all';
  mailbox_id?: number | null;
  tag?: string;
  since_days?: number;
  assignee_id?: number | null;
}

export interface SearchHit {
  scope: SearchScope;
  id: number;
  title: string;
  subtitle: string;
  snippet: string;
  score: number;
  href: string;
  why: string[];
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  total: number;
  used_semantic: boolean;
  semantic_available: boolean;
  /** v1.5.0: human-readable explanation of the retrieval mode that actually ran. */
  mode_note?: string;
}

// ---------------------------------------------------------------- Analytics
export interface MetricPoint {
  date: string;
  value: number;
}

export interface DashboardStats {
  range: { from: string; to: string };
  new_conversations: number;
  active_conversations: number;
  pending_conversations: number;
  closed_conversations: number;
  unassigned: number;
  backlog: number;
  first_response_time_avg_min: number | null;
  resolution_time_avg_min: number | null;
  replies_sent: number;
  ratings: { great: number; okay: number; 'not-good': number };
  by_mailbox: { name: string; count: number }[];
  by_tag: { name: string; count: number }[];
  by_agent: { name: string; count: number }[];
  by_team: { name: string; count: number }[];
  daily_new: MetricPoint[];
  /** Volume split by channel (email vs chat/Beacon) for the selected mailbox scope. */
  by_channel: { channel: string; count: number }[];
  /** Per-channel first-response / resolution medians: chat is expected to be much faster than email. */
  channel_metrics: { channel: string; count: number; first_response_avg_min: number | null; resolution_avg_min: number | null }[];
  /** Multi-mailbox comparison rows (one per mailbox in scope, full KPIs each). */
  mailbox_comparison: MailboxComparisonRow[];
  source: ('helpscout' | 'local' | 'ai')[];
}

export interface MailboxComparisonRow {
  mailbox_id: number;
  name: string;
  new_conversations: number;
  active_conversations: number;
  closed_conversations: number;
  backlog: number;
  first_response_avg_min: number | null;
  resolution_avg_min: number | null;
  great_ratings: number;
  total_ratings: number;
}

// ---------------------------------------------------------------- Docs mirror (v1.3.0)

export interface DocsCollectionInfo {
  id: number;
  remote_id: number;
  name: string;
  slug: string | null;
  description: string | null;
  visibility: string | null;
  article_count: number | null;
  last_synced_at: string | null;
}

export interface DocsArticleSummary {
  id: number;
  remote_id: number;
  collection_id: number;
  collection_name: string | null;
  category_id: number | null;
  category_name: string | null;
  number: number | null;
  slug: string | null;
  name: string;
  status: string | null;
  preview: string | null;
  words: number | null;
  views: number | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
}

export interface DocsArticleDetail extends DocsArticleSummary {
  text: string | null;
}

export interface DocsStats {
  collections: number;
  articles: number;
  published: number;
  drafts: number;
  internal: number;
  total_views: number;
  chat_sessions: number;
  email_conversations: number;
  last_synced_at: string | null;
  /** v1.4.0 semantic-search readiness (may be 0 until an embedding model runs). */
  docs_chunks?: number;
  docs_chunks_indexed?: number;
  docs_chunks_pending?: number;
  docs_chunks_failed?: number;
}

// ---------------------------------------------------------------- Docs semantic search (v1.4.0)

export interface DocsSearchHit {
  article: DocsArticleSummary;
  /** RRF-fused relevance; higher is better. NOT a cosine score. */
  score: number;
  why: ('fts' | 'semantic')[];
  snippet: string | null;
  /** Best matching chunk content when semantic retrieval contributed. */
  matched_chunk?: string | null;
}

export interface DocsSearchResponse {
  query: string;
  hits: DocsSearchHit[];
  total: number;
  used_semantic: boolean;
  semantic_available: boolean;
  /** Human-readable explanation of the retrieval mode that actually ran. */
  mode_note: string;
}

// ---------------------------------------------------------------- SLA / business hours (v1.4.0)

export interface BusinessHoursPayload {
  mailbox_id: number;
  timezone: string;
  days: number[];
  start_minute: number;
  end_minute: number;
  first_response_target_min: number | null;
  resolution_target_min: number | null;
  updated_at?: string;
}

export interface SlaDurationStatsInfo {
  count: number;
  avg_wall_min: number | null;
  avg_business_min: number | null;
  median_business_min: number | null;
  met: number;
  missed: number;
  no_target: number;
  target_min: number | null;
}

export interface SlaMailboxRowInfo {
  mailbox_id: number;
  mailbox_name: string;
  business_hours_configured: boolean;
  schedule: { timezone: string; days: number[]; startMinute: number; endMinute: number } | null;
  conversations_in_range: number;
  first_response: SlaDurationStatsInfo;
  resolution: SlaDurationStatsInfo;
  waiting: { count: number; oldest_business_min: number | null; avg_business_min: number | null; at_risk: number };
}

export interface SlaReportInfo {
  range: { from: string; to: string };
  mailboxes: SlaMailboxRowInfo[];
  unconfigured_mailboxes: string[];
  source: ('helpscout' | 'local' | 'ai')[];
}

export interface AiAnalytics {
  tickets_analyzed: number;
  analysis_success_rate: number;
  draft_count: number;
  draft_accepted: number;
  draft_rejected: number;
  draft_edit_rate: number;
  verification_warnings: number;
  unsupported_claim_rate: number;
  common_failure_patterns: { pattern: string; count: number }[];
  source: 'local';
}

export interface ReportDefinitionInfo {
  key: string;
  name: string;
  description: string;
  formula: string;
  source: 'helpscout' | 'local' | 'ai';
  limitations: string;
}

// ---------------------------------------------------------------- Automation
export type AutomationActionKind =
  | 'analyze_ticket'
  | 'search_similar'
  | 'check_known_issues'
  | 'create_ai_note'
  | 'create_ai_draft'
  | 'add_tag'
  | 'set_status'
  | 'assign'
  | 'manual_review_queue';

/**
 * v1.9.0 (M3, plan Phase 17): automation conditions gain AI-derived attribute
 * fields. `ai_attribute` matches the CURRENT attribute snapshot for the
 * conversation (deterministic attributes exist immediately; AI attributes
 * after analysis; a missing attribute reads as 'unknown' and never matches a
 * concrete value). `ai_verification` matches the latest AI draft verification
 * outcome ('failed' | 'passed' | 'none'). No new action kinds: higher-risk
 * writes still always require explicit approval.
 */
export type AutomationConditionField =
  | 'subject'
  | 'body'
  | 'tag'
  | 'mailbox'
  | 'confidence'
  | 'known_issue_match'
  | 'ai_attribute'
  | 'ai_verification';

export type AutomationConditionOperator = 'contains' | 'equals' | 'not_equals' | 'gt' | 'gte' | 'lt' | 'lte';

export interface AutomationCondition {
  field: AutomationConditionField;
  operator: AutomationConditionOperator;
  value: string;
  /** Required when field='ai_attribute': which catalog attribute to test. */
  attribute?: AiAttributeKey;
}

export interface AutomationRule {
  id: number;
  name: string;
  enabled: 0 | 1;
  trigger: 'new_conversation' | 'customer_reply' | 'ai_low_confidence' | 'manual';
  conditions: AutomationCondition[];
  actions: { kind: AutomationActionKind; params: Record<string, string> }[];
  priority: number;
  requires_approval: 0 | 1;
  last_run_at: string | null;
  run_count: number;
}

export interface AutomationRunRecord {
  id: number;
  rule_id: number;
  conversation_id: number | null;
  triggered_at: string;
  status: 'completed' | 'failed' | 'awaiting_approval' | 'skipped';
  detail: string;
}

// ---------------------------------------------------------------- General AI Attribute Layer (v1.9.0 / M3, plan Phase 16)

export interface AiAttributeEvidence {
  excerpt: string;
  thread_local_id: number | null;
}

export interface AiAttributeRow {
  id: number;
  conversation_id: number;
  conversation_number: number | null;
  attribute: AiAttributeKey;
  value: string;
  value_type: AiAttributeValueType;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source: 'deterministic' | 'ai';
  evidence: AiAttributeEvidence[];
  run_id: number | null;
  schema_version: string;
  computed_at: string;
}

/** Attribute + catalog metadata + honest-unknown status for one conversation. */
export interface ConversationAttributeSnapshot {
  conversation_id: number;
  conversation_number: number | null;
  attributes: (AiAttributeRow & { status: 'known' })[];
  unknown: AiAttributeKey[];
  computed_at: string | null;
}

/** Aggregate distribution for the attribute report (coverage is honest: unknown counted separately). */
export interface AiAttributeDistribution {
  attribute: AiAttributeKey;
  label: string;
  value_type: AiAttributeValueType;
  total_conversations: number;
  known: number;
  unknown: number;
  values: { value: string; count: number }[];
}

// ---------------------------------------------------------------- Local Copilot (v1.9.0 / M3, plan Phase 15)

export interface CopilotCitation {
  index: number;
  tool: string;
  label: string;
  conversation_id: number | null;
  conversation_number: number | null;
  customer_id: number | null;
}

export interface CopilotMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  citations: CopilotCitation[];
  tool_name: string | null;
  tool_calls: number;
  latency_ms: number | null;
  created_at: string;
}

export interface CopilotSession {
  id: number;
  title: string;
  conversation_id: number | null;
  conversation_number: number | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface CopilotChatResult {
  session: CopilotSession;
  user_message: CopilotMessage;
  assistant_message: CopilotMessage;
  tool_rounds: number;
  citations: CopilotCitation[];
  model: string;
  latency_ms: number;
}

// ---------------------------------------------------------------- Health / system
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  time: string;
  database: { ok: boolean; path: string; size_bytes: number; migrations_applied: number; wal: boolean };
  helpscout: { connected: boolean; demo_mode: boolean; error: string | null; oauth: { configured: boolean; authenticated: boolean; demoMode?: boolean; expiresAt?: string | null } };
  lmstudio: { connected: boolean; base_url: string; models: string[]; embedding_model: string | null; last_inference: { at: string; latencyMs: number } | null; error: string | null };
  qdrant: { connected: boolean; url: string; collections: string[]; indexed: { conversations_indexed: number; chunks_indexed: number; chunks_pending: number; chunks_failed: number }; error: string | null };
  sync: { state: SyncState; last_success: string | null; queued_jobs: number; failed_jobs: number };
  workers: { running: boolean; queue_depth: number };
}

export interface QueueJob {
  id: number;
  queue: string;
  type: string;
  priority: number;
  // v1.6.0: 'awaiting_approval' = a parked automation write action a human
  // must approve (Retry in the Queue panel) or reject (Cancel).
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  payload: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: 'user' | 'ai' | 'automation' | 'system';
  action: string;
  conversation_id: number | null;
  before_state: string | null;
  after_state: string | null;
  remote_operation: string | null;
  remote_result: string | null;
  ai_involvement: 0 | 1;
  job_id: number | null;
}

// ---------------------------------------------------------------- Settings
export interface AppSettings {
  sync_interval_minutes: number;
  api_concurrency: number;
  ai_enabled: boolean;
  automatic_analysis_enabled: boolean;
  automatic_note_enabled: boolean;
  automatic_draft_enabled: boolean;
  automation_enabled: boolean;
  automation_write_actions_enabled: boolean;
  qdrant_enabled: boolean;
  attachment_auto_download: boolean;
  automatic_reply_sending: boolean; // always false - safety
  retention_days: number | null;
  backup_interval_hours: number | null;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  display_timezone: string;
  redaction_enabled: boolean;
  ai_evaluation_mode: boolean;
  /** v2.1.0 (M5): agent's preferred drafting language (translation feature). */
  agent_language: string;
}

// ---------------------------------------------------------------- Webhooks
export interface WebhookEventRecord {
  id: number;
  event_id: string | null;
  event_hash: string;
  event_type: string;
  received_at: string;
  processing_state: 'pending' | 'processing' | 'processed' | 'failed' | 'duplicate';
  attempts: number;
  payload: string;
  processing_error: string | null;
}

// ---------------------------------------------------------------- API envelope
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  detail?: string;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  page_size: number;
  view: string;
}

// ---------------------------------------------------------------- Client Interaction Intelligence
// Interaction spec: observable support-communication behavior, never psychology.

export type InteractionSignalValue = string; // constrained to the per-dimension enums in constants.ts

/** One observable signal with its evidence and confidence (spec #8, #9). */
export interface InteractionSignal {
  dimension: InteractionDimension;
  value: InteractionSignalValue;
  confidence: OperationalConfidence;
  evidence: { excerpt: string; thread_local_id: number | null; conversation_local_id: number | null } | null;
  source: 'heuristic' | 'ai';
}

/** Current-ticket interaction analysis (spec #3, #6). */
export interface CurrentInteraction {
  conversation_local_id: number;
  customer_local_id: number | null;
  is_returning_client: boolean;
  signals: InteractionSignal[];
  customer_goal: string | null;
  message_stats: {
    customer_messages: number;
    avg_message_length: number;
    question_count: number;
    exclamation_ratio: number;
    caps_ratio: number;
  };
  generated_at: string;
  sources: 'heuristic' | 'heuristic+ai' | 'ai';
}

/** Recency-weighted longitudinal baseline (spec #5, #10, #23). */
export interface BehaviorBaseline {
  customer_local_id: number;
  conversation_count: number;
  observation_count: number;
  dimensions: { dimension: InteractionDimension; typical_value: string; confidence: OperationalConfidence; observation_count: number; last_observed: string | null }[];
  last_updated: string | null;
  profile_version: number;
}

/** Current-vs-baseline change detection (spec #5, #19). */
export interface InteractionChange {
  dimension: InteractionDimension;
  baseline_value: string | null;
  current_value: string | null;
  /** Ordinal dimensions get increase/decrease/same; nominal dimensions (tone,
   * expectation, question structure) only get 'changed' — an "increase" of
   * tone would be a meaningless direction. */
  direction: 'increase' | 'decrease' | 'same' | 'new' | 'changed';
  magnitude: number; // 0..1 (0 for nominal 'changed')
  significant: boolean;
}

/** Recommended support approach (spec #13, #14, #15). */
export interface SupportApproach {
  tone: string | null;
  length: 'concise' | 'moderate' | 'detailed' | null;
  start_with: string | null;
  then: string | null;
  avoid: string[];
  response_strategy: string[];
  de_escalation: boolean;
  escalation_recommendation: string | null;
  why: string[];
  source: 'heuristic' | 'ai' | 'ai+human-override';
  confidence: OperationalConfidence;
}

/** Observed communication preference with human override (spec #21, #22, #45). */
export interface CommunicationPreference {
  preference: string;
  evidence_count: number;
  first_observed: string | null;
  last_observed: string | null;
  confidence: OperationalConfidence;
  origin: 'ai_inferred' | 'human_entered';
  human_override: { value: string; reason: string | null; overridden_at: string } | null;
}

/** Previous support outcomes (spec #16, #17, #18, #44). */
export interface SupportOutcomeSummary {
  customer_local_id: number;
  total_conversations: number;
  first_response_resolution_rate: number | null;
  follow_up_rate: number | null;
  clarification_rate: number | null;
  escalation_rate: number | null;
  avg_effort_score: number | null;
  effective_approaches: { approach: string; worked_count: number; example_conversation_local_id: number | null; example_number: number | null }[];
  friction_flags: { conversation_local_id: number; number: number; subject: string | null; friction: 'moderate' | 'high' }[];
}

/** Repeat-client playbook (spec #46). */
export interface ClientPlaybook {
  best_opening: string | null;
  best_explanation_style: string | null;
  best_troubleshooting_style: string | null;
  likely_follow_up: string | null;
  historically_successful: string | null;
  avoid: string[];
}

/** Full ticket-scoped interaction card (spec #26, #62). */
export interface InteractionCard {
  conversation_local_id: number;
  customer_local_id: number | null;
  client_kind: 'first_time' | 'returning' | 'unknown';
  current: CurrentInteraction;
  baseline: BehaviorBaseline | null;
  changes: InteractionChange[];
  recommendation: SupportApproach | null;
  effort_score: number | null;
  friction: 'none' | 'moderate' | 'high' | null;
  repeat_issue: { detected: boolean; related_conversations: { local_id: number; number: number; subject: string | null }[] } | null;
  provenance: { ai_generated: boolean; prompt_version: string | null; model: string | null; generated_at: string | null };
}

/** Customer-scoped interaction profile (spec #25). */
export interface ClientInteractionProfile {
  customer_local_id: number;
  client_kind: 'first_time' | 'returning';
  baseline: BehaviorBaseline | null;
  preferences: CommunicationPreference[];
  timeline: { month: string; conversation_count: number; summary: string | null; conversation_local_ids: number[] }[];
  outcomes: SupportOutcomeSummary | null;
  playbook: ClientPlaybook | null;
  overrides: { id: number; field: string; ai_value: string | null; human_value: string; reason: string | null; created_at: string; active: boolean }[];
}
