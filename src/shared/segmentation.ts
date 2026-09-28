/**
 * Client Segmentation & Outreach - shared contract (v1.5.0).
 *
 * Design decisions (from the segmentation spec):
 * - The segment definition is a CONDITION TREE (structured JSON), never raw
 *   SQL: a saved segment is a reusable, inspectable, versioned rule. The
 *   engine compiles/evaluates it deterministically - AI never decides who
 *   belongs to a campaign (spec #42/#43).
 * - Properties answer "which customers?"; tags answer "which tickets?"; the
 *   resolver answers "which customers own those tickets?" (spec #65). Contact-
 *   first: every result row is a unique customer.
 * - Tag ALL/ANY/NONE semantics are CONVERSATION-level before resolving to
 *   contacts (spec #5-#7, #60): "has ALL of timezone, bug" requires ONE
 *   conversation carrying both tags.
 * - Property operators depend on the property TYPE (text/number/date/dropdown/
 *   url) discovered from the synced Help Scout definitions (spec #4) - nothing
 *   is hard-coded per property name.
 * - Exclusions are first-class: a customer matching ANY exclusion node is
 *   removed, and the local Do-Not-Contact list always wins (spec #19).
 * - Campaign recipients are a STATIC SNAPSHOT taken at campaign creation; a
 *   saved segment stays dynamic (spec #17).
 */

// ---------------- Condition tree ----------------

export type SegmentCombinator = 'all' | 'any';

export interface SegmentGroup {
  kind: 'group';
  combinator: SegmentCombinator;
  children: SegmentNode[];
}

export type PropertyType = 'text' | 'number' | 'date' | 'dropdown' | 'url';

export type PropertyOperator =
  // text + url + dropdown-shared
  | 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'is_empty' | 'is_not_empty'
  // number
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  // date
  | 'before' | 'after'
  // dropdown multi
  | 'is_any_of' | 'is_none_of';

export const OPERATORS_BY_TYPE: Record<PropertyType, PropertyOperator[]> = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  url: ['equals', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  date: ['equals', 'before', 'after', 'between', 'is_empty', 'is_not_empty'],
  dropdown: ['equals', 'not_equals', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']
};

export interface CustomerPropertyCondition {
  kind: 'customer_property';
  definitionId: number;
  name: string;
  type: PropertyType;
  op: PropertyOperator;
  /** Primary value (string; dates as YYYY-MM-DD; numbers as string). */
  value?: string | null;
  /** Secondary value for 'between'. */
  value2?: string | null;
  /** Multi-value for is_any_of / is_none_of. */
  values?: string[];
}

export type ContactField =
  | 'name' | 'email' | 'email_domain' | 'organization' | 'job_title' | 'location' | 'background'
  | 'has_email' | 'has_phone' | 'has_multiple_emails';

export type ContactOperator = 'equals' | 'not_equals' | 'contains' | 'starts_with' | 'ends_with' | 'is_empty' | 'is_not_empty';

export interface ContactCondition {
  kind: 'contact';
  field: ContactField;
  op: ContactOperator;
  value?: string | null;
}

export type TagMode = 'any' | 'all' | 'none';

/**
 * Ticket conditions apply to the SAME conversation (the intersection happens
 * at the ticket level BEFORE resolving to customers - spec #60/#62).
 * Multiple ticket nodes in one group mean DIFFERENT conversations may satisfy
 * different nodes; group them under one node when you need one ticket to
 * satisfy everything.
 */
export interface TicketCondition {
  kind: 'ticket';
  /** Tag names; semantics per tagMode. */
  tags?: string[];
  tagMode?: TagMode;
  /** Conversation statuses to match (empty = any). */
  statuses?: string[];
  /** Local mailbox ids (empty = any). */
  mailboxLocalIds?: number[];
  /** Local user ids (empty = any; use -1 for unassigned). */
  assigneeLocalIds?: number[];
  /** Conversation created within the last N days (null = any time). */
  createdWithinDays?: number | null;
  /** Conversation modified within the last N days (null = any time). */
  modifiedWithinDays?: number | null;
  numberMin?: number | null;
  numberMax?: number | null;
  /**
   * v1.9.0 (M3, plan Phase 16 "usable by Outreach"): conversation must carry a
   * current local AI attribute matching this test. Attribute keys are the
   * closed catalog; an unknown key matches NOTHING (safe deny). A missing
   * attribute row is 'unknown' and only matches value 'unknown'.
   */
  aiAttribute?: {
    attribute: string;
    op: 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
    value: string;
  } | null;
  /**
   * v2.1.0 (M5, plan Phase 31 "TICKET: custom fields"): custom (mailbox)
   * field tests applied to the SAME conversation as the rest of this node.
   * Unknown field ids match NOTHING (safe deny).
   */
  customFields?: TicketCustomFieldTest[];
  /** v2.1.0 (M5): conversation channel (source_type, e.g. email/chat). */
  channel?: string | null;
}

export type HistoryMetric =
  | 'ticket_count' | 'open_count' | 'closed_count' | 'last_contact_within_days' | 'first_contact_before_days'
  | 'waited_over_hours_count';

export interface HistoryCondition {
  kind: 'history';
  metric: HistoryMetric;
  op: 'gte' | 'lte' | 'eq';
  value: number;
}

/** Customer has EVER had a ticket with this tag (optionally within N days). */
export interface HistoryTagCondition {
  kind: 'history_tag';
  tag: string;
  withinDays?: number | null;
}

// ---------------- v2.1.0 (M5, plan Phase 31): advanced segmentation ---------

/**
 * Organization data / properties (plan Phase 31 "ORGANIZATION"). Standard
 * fields (name, domains) plus typed org custom properties discovered from
 * the synced definitions - the same operator table as customer properties.
 */
export interface OrganizationPropertyCondition {
  kind: 'organization_property';
  /** Standard field ('name'|'domains') or null when using a custom property definition. */
  field: 'name' | 'domains' | null;
  definitionId?: number | null;
  name?: string | null;
  type?: PropertyType | null;
  op: PropertyOperator;
  value?: string | null;
  value2?: string | null;
  values?: string[];
}

/**
 * Ticket-level extension (plan Phase 31 "TICKET"): custom fields and channel
 * apply to the SAME conversation as the rest of the ticket node's filters.
 */
export interface TicketCustomFieldTest {
  fieldLocalId: number;
  op: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';
  value?: string | null;
}

/** Support history: previous issues (plan Phase 31 "SUPPORT HISTORY"). */
export interface HistoryIssueCondition {
  kind: 'history_issue';
  issueKind: 'cluster' | 'known_issue';
  /** Local issue id; null = any issue of this kind. */
  issueLocalId?: number | null;
  op: 'gte' | 'eq';
  value: number;
}

/** SUPPORTOS layer: exposure to an incident (active incidents if id omitted). */
export interface IncidentExposureCondition {
  kind: 'incident_exposure';
  incidentId?: number | null;
  withinDays?: number | null;
}

/** SUPPORTOS layer: campaign history, including exclusions (not_received). */
export interface CampaignHistoryCondition {
  kind: 'campaign_history';
  relation: 'received' | 'replied' | 'not_received';
  campaignId?: number | null;
}

/** SUPPORTOS layer: deterministic customer support-health aggregates. */
export type SupportHealthMetric = 'avg_rating' | 'avg_effort_score' | 'first_response_resolution_rate' | 'high_friction_rate';

export interface SupportHealthCondition {
  kind: 'support_health';
  metric: SupportHealthMetric;
  op: 'gte' | 'lte';
  value: number;
}

/** SUPPORTOS layer: customer is linked (custom object links) to an object of a type. */
export interface CustomObjectLinkCondition {
  kind: 'custom_object_link';
  /** Custom object type id; null = any type. */
  typeId?: number | null;
}

/** SUPPORTOS layer: customer event timeline condition (closed kind union). */
export interface CustomerEventCondition {
  kind: 'customer_event';
  eventKind: 'signup' | 'support_conversation' | 'customer_message' | 'campaign' | 'campaign_reply' | 'rating' | 'incident_exposure' | 'custom_object_event';
  withinDays?: number | null;
}

export type SegmentCondition =
  | CustomerPropertyCondition | ContactCondition | TicketCondition | HistoryCondition | HistoryTagCondition
  | OrganizationPropertyCondition | HistoryIssueCondition | IncidentExposureCondition | CampaignHistoryCondition
  | SupportHealthCondition | CustomObjectLinkCondition | CustomerEventCondition;
export type SegmentNode = SegmentGroup | SegmentCondition;

export interface SegmentDefinition {
  combinator: SegmentCombinator;
  conditions: SegmentNode[];
  /** Customers matching ANY exclusion node are removed (spec #19). */
  exclude: SegmentNode[];
}

export interface SavedSegment {
  id: number;
  name: string;
  description: string | null;
  definition: SegmentDefinition;
  version: number;
  created_at: string;
  updated_at: string;
}

// ---------------- Preview / recipient rows ----------------

export interface RecipientWhyTicket {
  conversationId: number;
  number: number;
  subject: string | null;
  status: string;
  tags: string[];
  createdAt: string | null;
}

/** Human-readable line explaining one matched condition for one customer. */
export interface WhyLine {
  text: string;
  /** Optional conversation evidence backing a ticket condition. */
  tickets?: RecipientWhyTicket[];
}

export interface SegmentMatchRow {
  customer_local_id: number;
  customer_remote_id: number;
  first_name: string | null;
  last_name: string | null;
  emails: string[];
  chosen_email: string | null;
  organization: string | null;
  job_title: string | null;
  properties: { name: string; value: string | null }[];
  open_tickets: number;
  total_tickets: number;
  last_contact: string | null;
  why: WhyLine[];
  matching_tickets: RecipientWhyTicket[];
  excluded: boolean;
  exclusion_reason: string | null;
}

export interface SegmentPreviewResult {
  matched: number;
  excluded: number;
  without_email: number;
  on_dnc: number;
  rows: SegmentMatchRow[];
  /** Honest notes about how the engine evaluated the tree. */
  notes: string[];
}

// ---------------- Campaigns ----------------

export type CampaignStatus = 'draft' | 'queued' | 'sending' | 'paused' | 'completed' | 'cancelled';
export type RecipientState = 'selected' | 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled' | 'unknown';

export interface CampaignSummary {
  id: number;
  name: string;
  subject: string;
  status: CampaignStatus;
  mailbox_local_id: number | null;
  mailbox_name: string | null;
  segment_id: number | null;
  segment_name: string | null;
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  replied: number;
  created_at: string;
  queued_at: string | null;
  completed_at: string | null;
}

export interface CampaignRecipientRow {
  id: number;
  customer_local_id: number;
  customer_remote_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  state: RecipientState;
  attempts: number;
  last_error: string | null;
  hs_conversation_remote_id: number | null;
  hs_conversation_number: number | null;
  /** Local mirror conversation id (for inbox links); null until mirrored. */
  conversation_local_id?: number | null;
  sent_at: string | null;
  replied_at: string | null;
  why: WhyLine[];
  matching_tickets: RecipientWhyTicket[];
}

export interface CampaignDetail extends CampaignSummary {
  body: string;
  tags: string[];
  segment_snapshot: SegmentDefinition | null;
  recipients_list: CampaignRecipientRow[];
}

export interface CampaignValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { recipients: number; ready: number; invalid_email: number; already_sent: number; on_dnc: number; no_email: number };
}

// ---------------- Personalization ----------------

/** Variables available in campaign bodies (spec #24). Rendered before send; previewed per recipient. */
export const PERSONALIZATION_VARIABLES = ['first_name', 'last_name', 'company', 'organization', 'last_ticket_number', 'last_ticket_subject'] as const;
export type PersonalizationVariable = (typeof PERSONALIZATION_VARIABLES)[number];

export interface RenderedMessage {
  subject: string;
  body: string;
  unresolved: string[];
}

// ---------------- Outreach meta (drives the builder UI) ----------------

export interface PropertyDefInfo {
  id: number;
  remote_id: number;
  name: string;
  slug: string | null;
  type: PropertyType;
  /** Distinct values seen locally (dropdown suggestions; honest when empty). */
  observed_values: string[];
  /** How many customers locally carry a value for this property. */
  populated: number;
}

export interface OutreachMeta {
  property_definitions: PropertyDefInfo[];
  tags: string[];
  mailboxes: { local_id: number; name: string; email: string | null }[];
  assignees: { local_id: number; name: string }[];
  contact_fields: ContactField[];
  ticket_statuses: string[];
  operators_by_type: Record<PropertyType, PropertyOperator[]>;
  personalization_variables: readonly string[];
  /** v2.1.0 (M5, plan Phase 31): advanced condition catalogs. */
  organization_fields: ('name' | 'domains')[];
  organization_property_definitions: PropertyDefInfo[];
  ticket_custom_fields: { local_id: number; name: string; type: string | null }[];
  channels: string[];
  issues: { id: number; kind: 'cluster' | 'known_issue'; label: string }[];
  incidents: { id: number; code: string; title: string; status: string }[];
  campaigns: { id: number; name: string; status: string }[];
  custom_object_types: { id: number; name: string; slug: string }[];
  customer_event_kinds: string[];
  support_health_metrics: SupportHealthMetric[];
}
