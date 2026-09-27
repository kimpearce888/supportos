import { z } from 'zod';

/**
 * Conversation Activity Engine - shared contract (v1.7.0).
 *
 * Design decisions:
 * - Event types are a CLOSED union: every type maps to something the local
 *   mirror can actually derive (threads, conversation snapshots, local writes).
 *   Help Scout exposes no historical change log, so pre-sync change history is
 *   honestly labeled via `source` + `activity_history_complete` instead of
 *   being fabricated (plan Phase 1: "Do not fabricate events").
 * - Derived activity fields live as real conversations columns (indexed) so
 *   date/activity filtering is a range scan, never a per-row subquery
 *   (plan Phase 41: no N+1, indexed SQL).
 * - Response states are DETERMINISTIC pure functions of the derived columns -
 *   no LLM anywhere in the classification (plan Phase 4).
 * - Saved Inbox Views are structured condition TREES (JSON), never stored SQL.
 *   The engine compiles them to parameterized SQL with whitelisted identifiers
 *   at evaluation time (plan Phase 6, same philosophy as v1.5.0 segments).
 */

// ---------------- Event types ----------------

export const CONVERSATION_EVENT_TYPES = [
  'conversation_created',
  'customer_message',
  'human_agent_message',
  'system_agent_message',
  'internal_note',
  'status_changed',
  'assignment_changed',
  'team_changed',
  'inbox_changed',
  'tag_added',
  'tag_removed',
  'custom_field_changed',
  'snoozed',
  'unsnoozed',
  'scheduled',
  'closed',
  'reopened',
  'moved',
  'merged',
  'attachment_added',
  'priority_changed',
  'ticket_state_changed',
  'lineitem_action'
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

/** Where an event record came from - lets the UI phrase history honestly. */
export const EVENT_SOURCES = ['sync', 'webhook', 'local', 'rebuild'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface ConversationEvent {
  id: number;
  conversation_id: number;
  thread_local_id: number | null;
  event_type: ConversationEventType;
  actor_type: 'customer' | 'user' | 'team' | 'system_user' | 'automation' | 'unknown' | null;
  actor_local_id: number | null;
  actor_name: string | null;
  occurred_at: string | null;
  source: EventSource;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------- Derived activity fields ----------------

/**
 * Every filterable activity timestamp on a conversation. The SQL column names
 * on `conversations` are identical to these keys (whitelist for the view
 * engine - user input NEVER becomes a SQL identifier).
 */
export const ACTIVITY_FIELDS = [
  'created_at',
  'first_customer_message_at',
  'first_response_at',
  'last_customer_reply_at',
  'last_human_agent_response_at',
  'last_system_response_at',
  'last_note_at',
  'last_activity_at',
  'closed_at',
  'customer_waiting_since',
  'last_status_change_at',
  'last_assignment_change_at',
  'last_tag_change_at',
  'last_custom_field_change_at'
] as const;
export type ActivityField = (typeof ACTIVITY_FIELDS)[number];

/** created_at is the only virtual key (maps to remote_created_at). */
export const ACTIVITY_FIELD_COLUMN: Record<ActivityField, string> = {
  created_at: 'c.remote_created_at',
  first_customer_message_at: 'c.first_customer_message_at',
  first_response_at: 'c.first_response_at',
  last_customer_reply_at: 'c.last_customer_reply_at',
  last_human_agent_response_at: 'c.last_human_agent_response_at',
  last_system_response_at: 'c.last_system_response_at',
  last_note_at: 'c.last_note_at',
  last_activity_at: 'COALESCE(c.last_activity_at, c.remote_created_at)',
  closed_at: 'c.closed_at',
  customer_waiting_since: 'c.customer_waiting_since',
  last_status_change_at: 'c.last_status_change_at',
  last_assignment_change_at: 'c.last_assignment_change_at',
  last_tag_change_at: 'c.last_tag_change_at',
  last_custom_field_change_at: 'c.last_custom_field_change_at'
};

export interface ConversationActivity {
  first_customer_message_at: string | null;
  first_response_at: string | null;
  last_customer_reply_at: string | null;
  last_human_agent_response_at: string | null;
  last_system_response_at: string | null;
  last_note_at: string | null;
  customer_waiting_since: string | null;
  last_status_change_at: string | null;
  last_assignment_change_at: string | null;
  last_tag_change_at: string | null;
  last_custom_field_change_at: string | null;
  /** 1 = full thread history known locally; 0 = pre-sync conversation with no synced threads. */
  activity_history_complete: 0 | 1;
}

// ---------------- Date filter modes ----------------

/** Calendar-day modes resolve in the user's IANA timezone; rolling modes are exact hour windows. */
export const CALENDAR_DATE_MODES = ['today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'this_month', 'last_month'] as const;
export const ROLLING_DATE_MODES = ['last_24h', 'last_48h', 'last_7d', 'last_14d', 'last_30d', 'last_90d'] as const;
export const EXACT_DATE_MODES = ['exact_date', 'custom_range'] as const;
export const DATE_MODES = [...CALENDAR_DATE_MODES, ...ROLLING_DATE_MODES, ...EXACT_DATE_MODES] as const;
export type DateMode = (typeof DATE_MODES)[number];

export interface DateRange {
  /** Inclusive lower bound (UTC ISO). */
  from: string;
  /** Exclusive upper bound (UTC ISO). */
  to: string;
  /** Human label describing the resolved window (shown in the UI). */
  label: string;
  /** How the boundaries were derived (calendar-day vs rolling-hours) - for honest display. */
  kind: 'calendar' | 'rolling' | 'exact';
}

// ---------------- Response states ----------------

export const RESPONSE_STATES = [
  'needs_first_response',
  'customer_waiting',
  'agent_waiting',
  'recently_responded',
  'never_responded',
  'closed',
  'snoozed',
  'unknown'
] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

/**
 * Deterministic classification (plan Phase 4). FIRST match wins; the order is
 * part of the contract and mirrored by RESPONSE_STATE_SQL in responseState.ts:
 *   closed        status = 'closed'
 *   snoozed       active AND snoozed_until in the future
 *   needs_first_response  active, customer wrote, no agent reply ever (first_response_at NULL)
 *   customer_waiting      active, last customer reply newer than last agent reply
 *   agent_waiting         active/pending, last agent reply newer than last customer reply
 *   recently_responded    agent replied within the last 24h (rolling), not waiting
 *   never_responded       first_response_at NULL and no customer message either (no history or internal-only)
 *   unknown               history incomplete AND the deciding timestamps are missing
 */
export const RESPONSE_STATE_LABELS: Record<ResponseState, string> = {
  needs_first_response: 'Needs First Response',
  customer_waiting: 'Customer Waiting',
  agent_waiting: 'Agent Waiting',
  recently_responded: 'Recently Responded',
  never_responded: 'Never Responded',
  closed: 'Closed',
  snoozed: 'Snoozed',
  unknown: 'Unknown'
};

// ---------------- Response age metrics ----------------

export const AGE_METRICS = [
  'time_since_customer_reply',
  'time_since_agent_response',
  'customer_waiting_duration',
  'first_response_delay',
  'resolution_duration',
  'conversation_age'
] as const;
export type AgeMetric = (typeof AGE_METRICS)[number];

// ---------------- SupportOS priority ----------------

export const TICKET_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
export const PRIORITY_LABELS: Record<TicketPriority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

// ---------------- Ticket states ----------------

export interface TicketStateDef {
  id: number;
  key: string;
  name: string;
  color: string | null;
  sort_order: number;
  is_resolved: 0 | 1;
  built_in: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface StateTransition {
  id: number;
  conversation_id: number;
  previous_state_id: number | null;
  new_state_id: number;
  previous_state_name: string | null;
  new_state_name: string;
  actor_type: string;
  actor_local_id: number | null;
  actor_name: string | null;
  reason: string | null;
  occurred_at: string;
  source: string;
}

// ---------------- Saved Inbox Views ----------------

export type ViewCombinator = 'all' | 'any';

export interface ViewGroup {
  kind: 'group';
  combinator: ViewCombinator;
  children: ViewNode[];
}

export type ViewCondition =
  | { kind: 'status'; statuses: string[] }
  | { kind: 'assignee'; assigneeLocalIds: number[]; includeUnassigned: boolean }
  | { kind: 'team'; teamLocalIds: number[] }
  | { kind: 'mailbox'; mailboxLocalIds: number[] }
  | { kind: 'channel'; channels: ('email' | 'chat')[] }
  | { kind: 'tags'; tags: string[]; mode: 'any' | 'all' | 'none' }
  | { kind: 'custom_field'; fieldLocalId: number; op: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty'; value?: string | null }
  | { kind: 'customer_property'; definitionId: number; op: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty' | 'gt' | 'gte' | 'lt' | 'lte'; value?: string | null }
  | { kind: 'customer_text'; field: 'name' | 'email' | 'organization'; op: 'contains' | 'equals' | 'not_contains' | 'is_empty' | 'is_not_empty'; value?: string | null }
  | { kind: 'date_activity'; activityField: ActivityField; mode: DateMode; from?: string | null; to?: string | null; fromTime?: string | null; toTime?: string | null }
  | { kind: 'response_state'; states: ResponseState[] }
  | { kind: 'response_age'; metric: AgeMetric; op: 'gt' | 'gte' | 'lt' | 'lte'; minutes: number }
  | { kind: 'sla'; states: ('at_risk' | 'breached')[]; negate: boolean }
  | { kind: 'priority'; priorities: TicketPriority[] }
  | { kind: 'ticket_state'; stateIds: number[]; includeNoState: boolean }
  | { kind: 'known_issue'; any: boolean; knownIssueIds?: number[] }
  | { kind: 'ai_analyzed'; analyzed: boolean }
  | { kind: 'interaction_signal'; dimension: string; value: string; negate: boolean }
  | { kind: 'unread'; unread: boolean }
  | { kind: 'snoozed'; snoozed: boolean }
  | { kind: 'customer'; customerLocalIds: number[] };

export type ViewNode = ViewGroup | ViewCondition;

export interface ViewDefinition {
  combinator: ViewCombinator;
  conditions: ViewNode[];
}

export interface SavedInboxView {
  id: number;
  name: string;
  description: string | null;
  definition: ViewDefinition;
  sort_order: number;
  folder: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

// ---------------- Zod schemas (route boundary validation) ----------------

const nonEmptyStringArray = z.array(z.string().min(1).max(200)).min(1).max(50);
const idArray = z.array(z.number().int().positive()).min(1).max(200);
/** Help Scout conversation statuses are a closed set - hostile strings are rejected, not stored. */
const statusArray = z.array(z.enum(['active', 'pending', 'closed', 'spam'])).min(1).max(4);
/** Strict HH:mm with range validation (rejects 99:99 - no silent time-bound degradation). */
const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'time must be a valid HH:mm');

export const viewConditionSchema: z.ZodType<ViewCondition> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), statuses: statusArray }),
  z.object({ kind: z.literal('assignee'), assigneeLocalIds: idArray, includeUnassigned: z.boolean() }),
  z.object({ kind: z.literal('team'), teamLocalIds: idArray }),
  z.object({ kind: z.literal('mailbox'), mailboxLocalIds: idArray }),
  z.object({ kind: z.literal('channel'), channels: z.array(z.enum(['email', 'chat'])).min(1).max(2) }),
  z.object({ kind: z.literal('tags'), tags: nonEmptyStringArray, mode: z.enum(['any', 'all', 'none']) }),
  z.object({ kind: z.literal('custom_field'), fieldLocalId: z.number().int().positive(), op: z.enum(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty']), value: z.string().max(500).nullable().optional() }),
  z.object({ kind: z.literal('customer_property'), definitionId: z.number().int().positive(), op: z.enum(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty', 'gt', 'gte', 'lt', 'lte']), value: z.string().max(500).nullable().optional() }),
  z.object({ kind: z.literal('customer_text'), field: z.enum(['name', 'email', 'organization']), op: z.enum(['contains', 'equals', 'not_contains', 'is_empty', 'is_not_empty']), value: z.string().max(300).nullable().optional() }),
  z.object({ kind: z.literal('date_activity'), activityField: z.enum(ACTIVITY_FIELDS), mode: z.enum(DATE_MODES), from: z.string().max(40).nullable().optional(), to: z.string().max(40).nullable().optional(), fromTime: timeOfDay.nullable().optional(), toTime: timeOfDay.nullable().optional() }),
  z.object({ kind: z.literal('response_state'), states: z.array(z.enum(RESPONSE_STATES)).min(1) }),
  z.object({ kind: z.literal('response_age'), metric: z.enum(AGE_METRICS), op: z.enum(['gt', 'gte', 'lt', 'lte']), minutes: z.number().finite().min(0).max(60 * 24 * 365) }),
  z.object({ kind: z.literal('sla'), states: z.array(z.enum(['at_risk', 'breached'])).min(1), negate: z.boolean() }),
  z.object({ kind: z.literal('priority'), priorities: z.array(z.enum(TICKET_PRIORITIES)).min(1) }),
  z.object({ kind: z.literal('ticket_state'), stateIds: idArray, includeNoState: z.boolean() }),
  z.object({ kind: z.literal('known_issue'), any: z.boolean(), knownIssueIds: idArray.optional() }),
  z.object({ kind: z.literal('ai_analyzed'), analyzed: z.boolean() }),
  z.object({ kind: z.literal('interaction_signal'), dimension: z.string().min(1).max(40), value: z.string().min(1).max(60), negate: z.boolean() }),
  z.object({ kind: z.literal('unread'), unread: z.boolean() }),
  z.object({ kind: z.literal('snoozed'), snoozed: z.boolean() }),
  z.object({ kind: z.literal('customer'), customerLocalIds: idArray })
]) as z.ZodType<ViewCondition>;

export const viewNodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('group'),
      combinator: z.enum(['all', 'any']),
      children: z.array(viewNodeSchema).min(1).max(25)
    }),
    viewConditionSchema
  ])
);

export const viewDefinitionSchema = z.object({
  combinator: z.enum(['all', 'any']),
  conditions: z.array(viewNodeSchema).max(50)
});

export const createViewRequestSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  definition: viewDefinitionSchema,
  sort_order: z.number().int().min(0).max(9999).optional(),
  folder: z.string().max(80).nullable().optional()
});

export const updateViewRequestSchema = createViewSchemaForUpdate();
function createViewSchemaForUpdate(): z.ZodType<{ name?: string; description?: string | null; definition?: ViewDefinition; sort_order?: number; folder?: string | null }> {
  return z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    definition: viewDefinitionSchema.optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
    folder: z.string().max(80).nullable().optional()
  });
}

// ---------------- Ticket state schemas ----------------

export const createStateRequestSchema = z.object({
  name: z.string().min(1).max(80),
  key: z.string().regex(/^[a-z0-9-]+$/, 'key must be lowercase letters, digits and dashes').max(60).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex').nullable().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  is_resolved: z.boolean().optional()
});

export const updateStateRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex').nullable().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  is_resolved: z.boolean().optional()
});

export const setStateRequestSchema = z.object({
  stateId: z.number().int().positive().nullable(),
  reason: z.string().max(500).optional()
});

export const setPriorityRequestSchema = z.object({
  priority: z.enum(TICKET_PRIORITIES)
});

// ---------------- Inbox filter query schema (GET /api/conversations) ----------------

export const inboxFilterQuerySchema = z.object({
  activityField: z.enum(ACTIVITY_FIELDS).optional(),
  dateMode: z.enum(DATE_MODES).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  fromTime: timeOfDay.optional(),
  toTime: timeOfDay.optional(),
  responseState: z.enum(RESPONSE_STATES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  ticketStateId: z.string().regex(/^\d+$/).optional(),
  sort: z.enum(['newest_activity', 'oldest_activity', 'newest_created', 'oldest_created', 'waiting_longest', 'priority', 'priority_then_waiting']).optional(),
  savedViewId: z.string().regex(/^\d+$/).optional(),
  timezone: z.string().max(60).optional()
});
