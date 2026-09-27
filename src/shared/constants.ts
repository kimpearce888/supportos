/** Shared constants */

export const APP_NAME = 'SupportOS';
export const APP_VERSION = '1.6.0';

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
  INTERACTION_RECOMMENDATION: 'interaction_recommendation_v1'
} as const;

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
