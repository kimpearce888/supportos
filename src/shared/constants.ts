/** Shared constants */

export const APP_NAME = 'SupportOS';
export const APP_VERSION = '1.0.0';

/** Help Scout API bases (documented, current) */
export const HS_API_BASE = 'https://api.helpscout.net';
export const HS_AUTHORIZE_URL = 'https://secure.helpscout.net/authentication/authorizeClientApplication';
export const HS_TOKEN_PATH = '/v2/oauth2/token';

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
  'attachments',
  'ratings',
  'user_statuses'
] as const;

/** Prompt versions (section 76) */
export const PROMPT_VERSIONS = {
  TICKET_ANALYSIS: 'ticket_analysis_v1',
  CUSTOMER_DRAFT: 'customer_draft_v1',
  DRAFT_VERIFICATION: 'draft_verification_v1',
  ISSUE_CLUSTER: 'issue_cluster_v1',
  REPORT_NARRATIVE: 'report_narrative_v1',
  MEMORY_EXTRACTION: 'memory_extraction_v1'
} as const;

/** Visibility labels (section 73) */
export type Visibility = 'customer_safe' | 'internal_only' | 'uncertain';

/** Data provenance (section 122) */
export type Provenance = 'remote_source' | 'local_derived' | 'ai_generated' | 'human_local';

/** Overlap window for incremental sync (edge-window miss prevention, section 11) */
export const SYNC_OVERLAP_MINUTES = 10;

/** Default page sizes */
export const CONVERSATIONS_PAGE_SIZE = 50;

/** Names for FTS + vector collections */
export const QDRANT_COLLECTION = 'supportos_vectors';
export const FTS_INDEX_VERSION = 3;
export const CHUNK_VERSION = 2;
export const KNOWLEDGE_PARSER_VERSION = 1;
