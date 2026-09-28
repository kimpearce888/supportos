import { z } from 'zod';

/**
 * M4 workspace contract (v2.0.0): incidents / master issues (plan Phase 18),
 * issue impact (19), custom objects (21), local data connectors (22),
 * customer event timeline (23), customer support health (24) and knowledge
 * freshness (25).
 *
 * Design decisions:
 * - CLOSED unions everywhere (statuses, severities, event kinds, connector
 *   kinds, auth modes, link target kinds). Anything outside the union is a
 *   422, never a silent default.
 * - Incidents are LOCAL-ONLY workspace objects. They never write to Help
 *   Scout; affected customers/organizations are derived from linked
 *   conversations at read time, so they can never drift from the mirror.
 * - Custom object property VALUES are JSON validated by a Zod schema built
 *   from the type's own field definitions. User-defined data never becomes
 *   SQL: filtering compiles to whitelisted-operator parameterized fragments
 *   over the stored JSON (the viewEngine safety model).
 * - Connector auth material (header values / bearer tokens) is stored in the
 *   local database only and is REDACTED in every read path. The HTTP kind is
 *   refused for private/loopback/metadata targets (ssrfGuard - approved plan
 *   adjustment #4).
 * - Customer event kinds are a closed union: kinds with no observable source
 *   (subscription/account/product/integration events) stay ABSENT until a
 *   connector or custom object produces them - absence is the honest state.
 * - Support health is operational facts with evidence links only. There is
 *   deliberately NO single psychological "health score" (plan Phase 24:
 *   "Do not create psychological or personal judgments").
 */

// ---------------------------------------------------------------- Incidents

export const INCIDENT_STATUSES = ['investigating', 'identified', 'fix_in_progress', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_SOURCES = ['manual', 'cluster', 'known_issue'] as const;

export const INCIDENT_RELATED_KINDS = ['known_issue', 'knowledge_doc', 'campaign', 'custom_object'] as const;
export type IncidentRelatedKind = (typeof INCIDENT_RELATED_KINDS)[number];

const nonEmpty = (max: number): z.ZodType<string> => z.string().trim().min(1).max(max);

const isoDateish = z.string().max(32).regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Dates must be ISO (YYYY-MM-DD or with time)');

export const incidentCreateSchema = z.object({
  title: nonEmpty(200),
  status: z.enum(INCIDENT_STATUSES).default('investigating'),
  severity: z.enum(INCIDENT_SEVERITIES).default('sev3'),
  ownerUserId: z.number().int().positive().nullable().default(null),
  product: z.string().trim().max(120).nullable().default(null),
  feature: z.string().trim().max(120).nullable().default(null),
  description: z.string().max(4000).nullable().default(null),
  internalExplanation: z.string().max(8000).nullable().default(null),
  customerSafeExplanation: z.string().max(8000).nullable().default(null),
  knownCause: z.string().max(4000).nullable().default(null),
  workaround: z.string().max(4000).nullable().default(null),
  resolution: z.string().max(4000).nullable().default(null),
  startedAt: isoDateish.nullable().default(null),
  conversationIds: z.array(z.number().int().positive()).max(500).default([])
});

export const incidentPatchSchema = z.object({
  title: nonEmpty(200).optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  ownerUserId: z.number().int().positive().nullable().optional(),
  product: z.string().trim().max(120).nullable().optional(),
  feature: z.string().trim().max(120).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  internalExplanation: z.string().max(8000).nullable().optional(),
  customerSafeExplanation: z.string().max(8000).nullable().optional(),
  knownCause: z.string().max(4000).nullable().optional(),
  workaround: z.string().max(4000).nullable().optional(),
  resolution: z.string().max(4000).nullable().optional(),
  startedAt: isoDateish.nullable().optional(),
  resolvedAt: isoDateish.nullable().optional()
});

export const incidentNoteSchema = z.object({ body: nonEmpty(4000) });

export const incidentRefSchema = z.object({
  system: nonEmpty(60),
  reference: nonEmpty(200),
  url: z.string().trim().max(600).nullable().default(null),
  title: z.string().trim().max(300).nullable().default(null),
  status: z.string().trim().max(120).nullable().default(null),
  notes: z.string().max(2000).nullable().default(null)
});

export const incidentReleaseSchema = z.object({
  versionLabel: nonEmpty(120),
  notes: z.string().max(2000).nullable().default(null),
  releasedAt: isoDateish.nullable().default(null),
  correlation: z.string().max(500).nullable().default(null)
});

export const incidentRelatedSchema = z.object({
  targetKind: z.enum(INCIDENT_RELATED_KINDS),
  targetLocalId: z.number().int().positive(),
  note: z.string().max(500).nullable().default(null)
});

// ---------------------------------------------------------------- Impact (Phase 19)

export interface IssueImpact {
  subject_kind: 'incident' | 'known_issue';
  subject_id: number;
  affected_conversations: number;
  affected_customers: number;
  affected_organizations: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  growth_rate_7d: { recent: number; previous: number; ratio: number | null; direction: 'rising' | 'falling' | 'flat' | 'unknown' };
  trend: 'new' | 'rising' | 'falling' | 'stable' | 'unknown';
  affected_inboxes: { mailbox: string | null; conversations: number }[];
  top_tags: { tag: string; conversations: number }[];
  products: { product: string | null; conversations: number }[];
  open_closed_distribution: { open: number; closed: number };
  customer_waiting_count: number;
  release_correlation_candidates: { version_label: string; released_at: string | null; conversations_within_7d: number; note: string }[];
  note: string;
}

// ---------------------------------------------------------------- Custom objects (Phase 21)

export const CUSTOM_FIELD_TYPES = ['text', 'long_text', 'number', 'date', 'boolean', 'select'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_OBJECT_LINK_TARGETS = ['customer', 'organization', 'conversation', 'known_issue', 'incident', 'campaign'] as const;
export type CustomObjectLinkTarget = (typeof CUSTOM_OBJECT_LINK_TARGETS)[number];

/** Field keys are identifiers compiled into whitelisted JSON paths - strict. */
export const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,58}$/;
export const fieldKeySchema = z.string().regex(FIELD_KEY_REGEX, 'Field keys must be lowercase snake_case identifiers');

export const customFieldDefSchema = z.object({
  key: fieldKeySchema,
  label: nonEmpty(80),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(nonEmpty(80)).max(50).nullable().default(null)
}).refine((f) => (f.fieldType === 'select' ? (f.options ?? []).length >= 1 : true), {
  message: 'Select fields need at least one option'
});

export const customObjectTypeCreateSchema = z.object({
  name: nonEmpty(80),
  description: z.string().max(500).nullable().default(null),
  fields: z.array(customFieldDefSchema).min(1).max(40)
}).refine((t) => new Set(t.fields.map((f) => f.key)).size === t.fields.length, {
  message: 'Field keys must be unique within a type'
});

export const customObjectTypePatchSchema = z.object({
  name: nonEmpty(80).optional(),
  description: z.string().max(500).nullable().optional(),
  fields: z.array(customFieldDefSchema).min(1).max(40).optional()
}).refine((t) => (t.fields ? new Set(t.fields.map((f) => f.key)).size === t.fields.length : true), {
  message: 'Field keys must be unique within a type'
});

export const customObjectCreateSchema = z.object({
  typeId: z.number().int().positive(),
  title: nonEmpty(200),
  properties: z.record(z.string(), z.unknown()).default({}),
  links: z.array(z.object({
    targetKind: z.enum(CUSTOM_OBJECT_LINK_TARGETS),
    targetLocalId: z.number().int().positive(),
    note: z.string().max(500).nullable().default(null)
  })).max(100).default([])
});

export const customObjectPatchSchema = z.object({
  title: nonEmpty(200).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  links: z.array(z.object({
    targetKind: z.enum(CUSTOM_OBJECT_LINK_TARGETS),
    targetLocalId: z.number().int().positive(),
    note: z.string().max(500).nullable().default(null)
  })).max(100).optional()
});

// ---------------------------------------------------------------- Connectors (Phase 22)

export const CONNECTOR_KINDS = ['local_json', 'csv', 'sqlite', 'http'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const CONNECTOR_AUTH_MODES = ['none', 'header', 'bearer'] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

export const connectorAuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('header'),
    headerName: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9-]+$/, 'Header names are token identifiers'),
    headerValue: z.string().min(1).max(500)
  }),
  z.object({
    mode: z.literal('bearer'),
    token: z.string().min(1).max(500)
  })
]);

const localPathConfig = z.object({
  /** Resolved under the connectors/ data jail at runtime; relative name stored. */
  file: z.string().trim().min(1).max(200).regex(/^[^/\\]+[\w\-. ]*$/, 'File name inside the connectors directory (no absolute paths)'),
  keyColumn: z.string().trim().max(60).nullable().default(null)
});

export const connectorConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_json') }).merge(localPathConfig),
  z.object({ kind: z.literal('csv') }).merge(localPathConfig),
  z.object({
    kind: z.literal('sqlite'),
    file: z.string().trim().min(1).max(200).regex(/^[^/\\]+[\w\-. ]*$/, 'File name inside the connectors directory (no absolute paths)'),
    table: z.string().trim().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Table name identifier'),
    keyColumn: z.string().trim().max(60).nullable().default(null)
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().trim().min(8).max(600),
    keyColumn: z.string().trim().max(60).nullable().default(null)
  })
]);

export const connectorCreateSchema = z.object({
  name: nonEmpty(80),
  config: connectorConfigSchema,
  auth: connectorAuthSchema.default({ mode: 'none' }),
  refreshMethod: z.enum(['manual', 'interval']).default('manual'),
  refreshSeconds: z.number().int().min(60).max(86400).default(3600),
  allowedAi: z.boolean().default(false)
});

export const connectorPatchSchema = z.object({
  name: nonEmpty(80).optional(),
  config: connectorConfigSchema.optional(),
  auth: connectorAuthSchema.optional(),
  refreshMethod: z.enum(['manual', 'interval']).optional(),
  refreshSeconds: z.number().int().min(60).max(86400).optional(),
  allowedAi: z.boolean().optional(),
  enabled: z.boolean().optional()
});

// ---------------------------------------------------------------- Customer timeline (Phase 23)

export const CUSTOMER_EVENT_KINDS = [
  'signup', 'support_conversation', 'customer_message', 'campaign', 'campaign_reply',
  'rating', 'incident_exposure', 'custom_object_event',
  'subscription_event', 'account_event', 'product_event', 'integration_event'
] as const;
export type CustomerEventKind = (typeof CUSTOMER_EVENT_KINDS)[number];

/** Kinds that only exist once a connector / custom object produces them. */
export const CUSTOMER_EVENT_SOURCES = ['hs_sync', 'local_derived', 'local_outreach', 'custom_object', 'connector'] as const;

// ---------------------------------------------------------------- Support health (Phase 24)

export interface SupportHealthMetric {
  key: string;
  label: string;
  value: number;
  display: string;
  definition: string;
  evidence_conversation_ids: number[];
  completeness: 'known' | 'partial' | 'unknown';
}

export interface SupportHealthFlag {
  key: string;
  label: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  evidence_conversation_ids: number[];
}

export interface SupportHealthReport {
  subject_kind: 'customer' | 'organization';
  subject_id: number;
  subject_label: string;
  metrics: SupportHealthMetric[];
  flags: SupportHealthFlag[];
  incident_exposure: { incident_id: number; code: string; title: string; severity: IncidentSeverity; status: IncidentStatus; conversations: number }[];
  generated_at: string;
  note: string;
}

// ---------------------------------------------------------------- Knowledge freshness (Phase 25)

export interface KnowledgeFreshnessFlags {
  stale: boolean;
  unreviewed_long: boolean;
  conflict_candidate: boolean;
  low_usage: boolean;
  followed_by_tickets: boolean;
  fails_common_questions: boolean;
}

export interface KnowledgeFreshnessRow {
  document_id: number;
  title: string;
  source_name: string | null;
  visibility: 'customer_safe' | 'internal_only';
  version: number;
  created_at: string | null;
  updated_at: string | null;
  last_reviewed_at: string | null;
  last_verified_at: string | null;
  days_since_update: number | null;
  days_since_review: number | null;
  search_hits: number;
  last_hit_at: string | null;
  flags: KnowledgeFreshnessFlags;
  conflict_candidates: { document_id: number; title: string }[];
  followed_by_ticket_count: number;
  associated_questions: { question: string; conversation_count: number; coverage: string }[];
  note: string;
}
