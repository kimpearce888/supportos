import { z } from 'zod';

/**
 * M2 collaboration contract (v1.8.0): Notification Center, mentions, side
 * collaboration threads, Operations Center + workload/capacity.
 *
 * Design decisions:
 * - Notification types are a CLOSED union: every type maps to something the
 *   local mirror can actually observe (new conversation_events, SLA alerts,
 *   jobs, sync state, campaign recipients, known issues, ratings). There is
 *   NO free-form notification producer - the sweep is the single funnel,
 *   mirroring how ingestConversation is the single ingestion funnel for sync.
 * - Notifications are LOCAL-ONLY operational data (like jobs/audit), never
 *   synced to Help Scout, and honestly pruned by the retention window.
 * - Mentions match against the users Help Scout itself gives mention names
 *   for (users.mention) plus teams. Unknown @tokens stay plain text - we
 *   never guess an identity (plan Phase 13: "Respect Help Scout identity").
 * - Side threads are internal-only SupportOS constructs (plan Phase 14: never
 *   customer-visible, never forced into the Help Scout thread model).
 * - The capacity model is explicit configuration (default + per-user maxima +
 *   workload weights), never inferred from anything about a person (plan
 *   Phase 11: "Do not infer capacity from arbitrary personality information").
 *   The suggested assignee is a read-only recommendation; nothing reassigns
 *   unless a human clicks Assign (or an approved automation is explicitly
 *   enabled - which remains the v1.5 approval flow).
 */

// ---------------- Notification types ----------------

export const NOTIFICATION_TYPES = [
  'customer_replied',        // a customer replied on a conversation (targets the assignee)
  'ticket_assigned',         // a conversation was assigned to an agent (targets the new assignee)
  'mentioned',               // @agent mention in an internal note or side thread (targets mentioned user)
  'team_mentioned',          // @team mention (targets every member of the team)
  'sla_risk',                // a conversation crossed 80% of its SLA target
  'sla_breach',              // a conversation crossed its SLA target
  'automation_approval',     // an automation action is parked awaiting approval
  'ai_escalation',           // AI analysis flags urgency high/critical or frustrated sentiment
  'known_issue_detected',    // a new known issue was created/linked
  'issue_spike',             // an issue cluster is trending up
  'campaign_reply',          // a customer replied to an outreach campaign message
  'sync_failure',            // the sync state machine entered ERROR
  'job_failure',             // a background job exhausted its retries
  'customer_event',           // important customer event (e.g. a not-good rating)
  'incident_update'           // v2.0.0 (M4): incident created / status-severity change / new conversation linked / resolved
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Which types are enabled by default when no preference row exists. */
export const NOTIFICATION_TYPE_DEFAULT_ENABLED: Record<NotificationType, boolean> = {
  customer_replied: true,
  ticket_assigned: true,
  mentioned: true,
  team_mentioned: true,
  sla_risk: true,
  sla_breach: true,
  automation_approval: true,
  ai_escalation: true,
  known_issue_detected: true,
  issue_spike: true,
  campaign_reply: true,
  sync_failure: true,
  job_failure: true,
  customer_event: true,
  incident_update: true
};

export const NOTIFICATION_SEVERITY_BY_TYPE: Record<NotificationType, NotificationSeverity> = {
  customer_replied: 'info',
  ticket_assigned: 'info',
  mentioned: 'info',
  team_mentioned: 'info',
  sla_risk: 'warning',
  sla_breach: 'critical',
  automation_approval: 'warning',
  ai_escalation: 'warning',
  known_issue_detected: 'info',
  issue_spike: 'warning',
  campaign_reply: 'info',
  sync_failure: 'critical',
  job_failure: 'warning',
  customer_event: 'info',
  incident_update: 'warning'
};

export interface NotificationRecord {
  id: number;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  /** Who the notification is for: a specific user, or null = broadcast to everyone. */
  target_user_local_id: number | null;
  /** Who/what caused it, when known (null = system). */
  actor_user_local_id: number | null;
  conversation_id: number | null;
  conversation_number: number | null;
  customer_local_id: number | null;
  issue_id: number | null;
  campaign_id: number | null;
  job_id: number | null;
  side_thread_id: number | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationListResult {
  notifications: NotificationRecord[];
  total: number;
  unread: number;
}

// ---------------- Side collaboration threads ----------------

export const SIDE_THREAD_STATUSES = ['open', 'resolved'] as const;
export type SideThreadStatus = (typeof SIDE_THREAD_STATUSES)[number];

export interface SideThreadParticipant {
  user_local_id: number;
  first_name: string | null;
  last_name: string | null;
  mention: string | null;
  added_at: string;
  added_by_user_local_id: number | null;
}

export interface SideThreadMessage {
  id: number;
  side_thread_id: number;
  author_user_local_id: number | null;
  author_first_name: string | null;
  author_last_name: string | null;
  body: string;
  created_at: string;
  mentions: { user_local_id: number | null; team_local_id: number | null }[];
}

export interface SideThread {
  id: number;
  conversation_id: number;
  conversation_number: number | null;
  title: string;
  team_local_id: number | null;
  team_name: string | null;
  status: SideThreadStatus;
  created_by_user_local_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  message_count: number;
  last_message_at: string | null;
}

export interface SideThreadDetail extends SideThread {
  participants: SideThreadParticipant[];
  messages: SideThreadMessage[];
}

// ---------------- Mentions ----------------

/** A resolved @mention inside a text body. */
export interface ParsedMention {
  /** The @token as written (without the leading @), e.g. "alex". */
  token: string;
  /** Character offset of the '@' in the source text. */
  offset: number;
  user_local_id: number | null;
  team_local_id: number | null;
  display: string;
}

// ---------------- Capacity model ----------------

export const CAPACITY_WEIGHT_DEFAULTS = {
  /** Weight of one urgent (high/urgent priority) conversation in pressure. */
  urgent: 3,
  /** Weight of one SLA at-risk/breached conversation in pressure. */
  sla: 2,
  /** Weight of one customer-waiting conversation in pressure. */
  waiting: 1.5,
  /** Weight of every other open conversation in pressure. */
  open: 1
} as const;

export interface CapacityWeights {
  urgent: number;
  sla: number;
  waiting: number;
  open: number;
}

export interface CapacityModel {
  /** Default maximum simultaneously-open conversations per agent. */
  default_max_open: number;
  /** Per-user overrides keyed by LOCAL user id. */
  per_user_max: Record<string, number>;
  weights: CapacityWeights;
}

export const DEFAULT_CAPACITY_MODEL: CapacityModel = {
  default_max_open: 25,
  per_user_max: {},
  weights: { ...CAPACITY_WEIGHT_DEFAULTS }
};

// ---------------- Operations Center ----------------

export const OPERATIONS_TILE_KEYS = [
  'unassigned',
  'needs_first_response',
  'customer_waiting',
  'waiting_over_threshold',
  'urgent',
  'sla_at_risk',
  'sla_breached',
  'high_effort',
  'repeated_issue',
  'known_issue',
  'ai_escalation',
  'issue_spike',
  'automation_approvals',
  'failed_jobs',
  'sync_problems',
  'campaign_activity'
] as const;
export type OperationsTileKey = (typeof OPERATIONS_TILE_KEYS)[number];

export interface OperationsTile {
  key: OperationsTileKey;
  label: string;
  count: number;
  severity: 'info' | 'warning' | 'critical';
  /** Where clicking the tile drills to. */
  drill:
    | { type: 'inbox'; params: Record<string, string> }
    | { type: 'page'; page: 'issues' | 'automation' | 'sync-health' | 'outreach' | 'notifications' };
  note: string | null;
}

export interface OperationsSnapshot {
  generated_at: string;
  /** Mailbox scope: null = all inboxes, otherwise the mailbox local ids in scope. */
  mailbox_scope: number[] | null;
  tiles: OperationsTile[];
  waiting_threshold_minutes: number;
}

// ---------------- Workload & capacity (API response shapes) ----------------

export interface AgentWorkload {
  user_local_id: number;
  display_name: string;
  mention: string | null;
  role: string | null;
  availability: { email_status: string | null; chat_status: string | null; source: 'user_statuses' | 'unknown' };
  open_workload: number;
  pending_workload: number;
  customer_waiting_workload: number;
  urgent_workload: number;
  sla_risk_workload: number;
  weighted_load: number;
  capacity: number;
  pressure: number;
  avg_active_load_7d: number | null;
  recent_closed_7d: number;
}

export interface TeamWorkload {
  team_local_id: number;
  name: string;
  member_user_local_ids: number[];
  open_workload: number;
  weighted_load: number;
  capacity: number;
  pressure: number;
  recent_closed_7d: number;
  available_members: number;
  total_members: number;
}

export interface WorkloadSnapshotResponse {
  generated_at: string;
  unassigned_work: number;
  agents: AgentWorkload[];
  teams: TeamWorkload[];
  capacity_model: CapacityModel;
  method_notes: string[];
}

export interface SuggestedAssigneeResponse {
  conversation_id: number;
  conversation_number: number | null;
  subject: string | null;
  supportos_priority: string;
  waiting_minutes: number | null;
  suggested_user_local_id: number | null;
  suggested_display_name: string | null;
  suggested_pressure_after: number | null;
  suggested_availability: string | null;
  all_away: boolean;
  reason: string;
}

// ---------------- Write schemas ----------------

export const SideThreadCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  team_local_id: z.number().int().positive().nullable().optional(),
  participant_user_ids: z.array(z.number().int().positive()).max(20).default([]),
  first_message: z.string().trim().min(1).max(8000).optional()
});
export type SideThreadCreateInput = z.infer<typeof SideThreadCreateSchema>;

export const SideThreadMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000)
});
export type SideThreadMessageInput = z.infer<typeof SideThreadMessageSchema>;

export const SideThreadParticipantAddSchema = z.object({
  user_local_ids: z.array(z.number().int().positive()).min(1).max(20)
});

export const NotificationPrefsUpdateSchema = z.object({
  enabled: z.boolean()
});

export const CapacityModelUpdateSchema = z.object({
  default_max_open: z.number().int().min(1).max(500),
  /** Keys are LOCAL user ids - digits only (never free-form strings). */
  per_user_max: z.record(z.string().regex(/^\d+$/, 'per-user keys must be local user ids (digits)'), z.number().int().min(1).max(500)),
  weights: z.object({
    urgent: z.number().min(0).max(100),
    sla: z.number().min(0).max(100),
    waiting: z.number().min(0).max(100),
    open: z.number().min(0).max(100)
  })
});

export const MarkReadSchema = z.object({
  read: z.boolean().default(true)
});
