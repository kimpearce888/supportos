/** Shared constants */

export const APP_NAME = 'SupportOS';
export const APP_VERSION = '2.0.0';

/** Help Scout API bases (documented, current) */
export const HS_API_BASE = 'https://api.helpscout.net';
export const HS_AUTHORIZE_URL = 'https://secure.helpscout.net/authentication/authorizeClientApplication';
export const HS_TOKEN_PATH = '/v2/oauth2/token';

/** Docs API base (documented; separate Docs API key, HTTP Basic auth) */
export const HS_DOCS_API_BASE = 'https://docsapi.helpscout.net';

/** Rate limit defaults (per current docs: plan-dependent; conservative default) */
export const HS_DEFAULT_RATE_LIMIT_PER_MIN = 150;
export const HS_RATE_LIMIT_SAFETY_MARGIN = 5;

/** Job priorities: P0 user reply send ... P4 background indexing */
export const PRIORITY = {
  USER_SEND: 0,
  INTERACTIVE: 1,
  SYNC: 2,
  ANALYTICS: 3,
  INDEXING: 4
} as const;

/** Sync states (section 9 of spec) */
export const SYNC_STATES = ['NEW', 'INITIALIZING', 'BACKFILLING', 'CATCHING_UP', 'LIVE', 'RECONCILING', 'PAUSED', 'ERROR'] as const;

/** Initial sync order (dependency aware, section 10) */
export const INITIAL_SYNC_ORDER = [
  'account',
  'users',
  'system_users',
  'teams',
  'mailboxes',
  'folders',
  'tags',
  'inbox_fields',
  'customer_property_definitions',
  'organization_property_definitions',
  'organizations', // before customers: customer rows reference their organization
  'customers',
  'saved_replies',
  'workflows',
  'conversations',
  'threads',
  'chats', // Beacon chat sessions (type=chat conversations) - channel catch-up after conversation sync
  'attachments',
  'ratings',
  'docs_collections', // Docs API mirror (docsapi.helpscout.net, separate API key)
  'docs_articles',
  'user_statuses'
] as const;

/** Prompt versions (section 76) */
export const PROMPT_VERSIONS = {
  TICKET_ANALYSIS: 'ticket_analysis_v1',
  CUSTOMER_DRAFT: 'customer_draft_v1',
  DRAFT_VERIFICATION: 'draft_verification_v1',
  ISSUE_CLUSTER: 'issue_cluster_v1',
  REPORT_NARRATIVE: 'report_narrative_v1',
  MEMORY_EXTRACTION: 'memory_extraction_v1',
  INTERACTION_OBSERVATION: 'interaction_observation_v1',
  INTERACTION_RECOMMENDATION: 'interaction_recommendation_v1',
  // v1.9.0 (M3)
  ATTRIBUTE_EXTRACTION: 'attribute_extraction_v1',
  COPILOT_CHAT: 'copilot_chat_v1'
} as const;

// ---------------------------------------------------------------- General AI Attribute Layer (v1.9.0 / M3, plan Phase 16) is defined
// AFTER the interaction vocabularies below (it reuses URGENCY/FRUSTRATION/
// TECHNICAL/RESPONSE_PREFERENCE values as closed enum vocabularies).

// ---------------------------------------------------------------- Client Interaction Intelligence
// Observable communication dimensions ONLY (interaction spec #6, #7, #55).
// These enums are the complete vocabulary: the AI can never produce a value
// outside them, so personality labels / diagnoses are impossible by schema.

export const INTERACTION_DIMENSIONS = [
  'tone',
  'directness',
  'detail',
  'technical_language',
  'question_structure',
  'urgency',
  'frustration',
  'expectation',
  'response_preference'
] as const;
export type InteractionDimension = (typeof INTERACTION_DIMENSIONS)[number];

export const TONE_VALUES = ['neutral', 'friendly', 'frustrated', 'appreciative', 'disappointed', 'confrontational', 'urgent', 'uncertain'] as const;
export const DIRECTNESS_VALUES = ['indirect', 'conversational', 'direct', 'highly_direct'] as const;
export const DETAIL_VALUES = ['very_low', 'low', 'moderate', 'high', 'very_high'] as const;
export const TECHNICAL_VALUES = ['non_technical', 'mixed', 'technical', 'highly_technical'] as const;
export const QUESTION_STRUCTURE_VALUES = ['single_question', 'multiple_questions', 'troubleshooting_oriented', 'confirmation_oriented', 'explanation_oriented'] as const;
export const URGENCY_VALUES = ['none', 'low', 'moderate', 'high'] as const;
export const FRUSTRATION_VALUES = ['none', 'possible', 'moderate', 'strong'] as const;
export const EXPECTATION_VALUES = ['information', 'explanation', 'troubleshooting', 'action', 'immediate_resolution', 'escalation', 'confirmation'] as const;
export const RESPONSE_PREFERENCE_VALUES = ['concise', 'detailed', 'step_by_step', 'technical', 'conversational', 'outcome_focused'] as const;

export const OPERATIONAL_CONFIDENCE_VALUES = ['high', 'medium', 'low', 'unknown'] as const;

// ---------------------------------------------------------------- General AI Attribute Layer (v1.9.0 / M3, plan Phase 16)
//
// First-class LOCAL AI attributes. The catalog is the complete closed
// vocabulary: every stored attribute key comes from this list, and enum
// values come from the per-key vocabulary below. Attributes never overwrite
// Help Scout source data - they live in their own versioned table and are
// always labeled with source ('deterministic' or 'ai') and confidence.
// A missing attribute IS 'unknown' (honest unknown: no row = no claim).

export const AI_ATTRIBUTE_KEYS = [
  'intent', // enum: what the customer wants (question/bug/feature_request/billing/how_to/feedback/other)
  'product', // text: product mentioned (from analysis; evidence-backed)
  'feature', // text: feature area (from analysis; evidence-backed)
  'issue', // text: issue type (from analysis problem_type; evidence-backed)
  'urgency', // enum (URGENCY_VALUES): observable urgency cues
  'frustration_cues', // enum (FRUSTRATION_VALUES): observable frustration cues
  'technical_familiarity', // enum (TECHNICAL_VALUES): observable technical language
  'customer_goal', // text: one-line goal (deterministic from interaction card or AI)
  'question_count', // number: questions asked by the customer in this ticket
  'risk', // enum: composite churn/escalation risk (low/medium/high) from deterministic signals
  'known_issue', // boolean: linked to a known issue
  'issue_cluster', // text: linked issue cluster title
  'response_style', // enum (RESPONSE_PREFERENCE_VALUES): recommended response style
  'escalation_signal' // boolean: customer explicitly signals escalation intent
] as const;
export type AiAttributeKey = (typeof AI_ATTRIBUTE_KEYS)[number];

export const AI_INTENT_VALUES = ['question', 'bug_report', 'feature_request', 'billing', 'how_to', 'account_management', 'feedback', 'other'] as const;
export const AI_RISK_VALUES = ['low', 'medium', 'high'] as const;

/** Attribute value types drive operator semantics in Views / automation / segments. */
export type AiAttributeValueType = 'enum' | 'number' | 'boolean' | 'text';

export interface AiAttributeDefinition {
  key: AiAttributeKey;
  label: string;
  value_type: AiAttributeValueType;
  /** Closed vocabulary for enum attributes (undefined for text/number/boolean). */
  values?: readonly string[];
  description: string;
}

export const AI_ATTRIBUTE_CATALOG: readonly AiAttributeDefinition[] = [
  { key: 'intent', label: 'Intent', value_type: 'enum', values: AI_INTENT_VALUES, description: 'What kind of request this is (question, bug report, feature request, billing, how-to...).' },
  { key: 'product', label: 'Product', value_type: 'text', description: 'Product the ticket is about, when identifiable from evidence.' },
  { key: 'feature', label: 'Feature', value_type: 'text', description: 'Feature area the ticket touches, when identifiable from evidence.' },
  { key: 'issue', label: 'Issue type', value_type: 'text', description: 'Detected issue type (from AI ticket analysis when available).' },
  { key: 'urgency', label: 'Urgency', value_type: 'enum', values: URGENCY_VALUES, description: 'Observable urgency cues in customer messages (deterministic by default).' },
  { key: 'frustration_cues', label: 'Frustration cues', value_type: 'enum', values: FRUSTRATION_VALUES, description: 'Observable frustration cues in customer messages (deterministic by default).' },
  { key: 'technical_familiarity', label: 'Technical familiarity', value_type: 'enum', values: TECHNICAL_VALUES, description: 'Technical language level used by the customer (deterministic by default).' },
  { key: 'customer_goal', label: 'Customer goal', value_type: 'text', description: 'One-line statement of what the customer is trying to achieve.' },
  { key: 'question_count', label: 'Question count', value_type: 'number', description: 'Number of questions the customer asked in this ticket (deterministic).' },
  { key: 'risk', label: 'Risk', value_type: 'enum', values: AI_RISK_VALUES, description: 'Composite churn/escalation risk from deterministic signals (never a personality claim).' },
  { key: 'known_issue', label: 'Known issue', value_type: 'boolean', description: 'Whether the ticket is linked to a known issue.' },
  { key: 'issue_cluster', label: 'Issue cluster', value_type: 'text', description: 'Issue cluster the ticket belongs to, when clustered.' },
  { key: 'response_style', label: 'Response style', value_type: 'enum', values: RESPONSE_PREFERENCE_VALUES, description: 'Recommended response style for this interaction.' },
  { key: 'escalation_signal', label: 'Escalation signal', value_type: 'boolean', description: 'Whether the customer explicitly signals escalation intent.' }
];

/** Schema version stamped on every stored attribute row (versioning, plan Phase 16). */
export const AI_ATTRIBUTE_SCHEMA_VERSION = 'attributes_v1';

/** Copilot loop bounds (plan Phase 15: read-only tools, bounded, evidence-cited). */
export const COPILOT_MAX_TOOL_ROUNDS = 5;
export const COPILOT_MAX_TOOL_CALLS = 8;
export const COPILOT_TOOL_RESULT_MAX_CHARS = 4000;

/** Preference requires repeated evidence before it counts as a pattern (spec #39, #40). */
export const INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE = 3;
/** Recency weighting half-life in days (spec #23: recent behavior dominates). */
export const INTERACTION_RECENCY_HALF_LIFE_DAYS = 90;
/** Change magnitude above which a dimension change is "significant" (0-1 scale). */
export const INTERACTION_CHANGE_SIGNIFICANCE_THRESHOLD = 0.34;

/** Visibility labels (section 73) */
export type Visibility = 'customer_safe' | 'internal_only' | 'uncertain';

/** Data provenance (section 122) */
export type Provenance = 'remote_source' | 'local_derived' | 'ai_generated' | 'human_local';

/** Overlap window for incremental sync (edge-window miss prevention, section 11) */
export const SYNC_OVERLAP_MINUTES = 10;

/** Default page sizes */
export const CONVERSATIONS_PAGE_SIZE = 50;

/** Real-time ratings refresh: default poll interval for the lightweight ratings watcher (seconds; 0 disables). */
export const RATINGS_REFRESH_DEFAULT_SECONDS = 30;

/** Names for FTS + vector collections */
export const QDRANT_COLLECTION = 'supportos_vectors';
export const FTS_INDEX_VERSION = 3;
export const CHUNK_VERSION = 2;
export const KNOWLEDGE_PARSER_VERSION = 1;
