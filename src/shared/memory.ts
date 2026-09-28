/**
 * M6 shared contracts (v2.2.0): customer support memory (plan Phase 36).
 *
 * Design decisions:
 * - Memory is COMPOSED AT READ TIME from the tables that already hold each
 *   fact (interactions, outcomes, links, campaigns, events, profiles). The
 *   composition can never drift from its sources, and every entry carries the
 *   source's own timestamp/confidence/evidence instead of a stale copy.
 *   Only HUMAN-written memory entries are persisted rows (customer_memories
 *   with source='human'), because a human note is information the database
 *   does not already contain.
 * - Every entry carries source / timestamp / confidence / freshness / evidence
 *   (plan Phase 36 requirement). Freshness is derived from timestamps, never
 *   guessed: no observation, no freshness claim.
 * - RED LINE (plan Phase 36: "Do not store sensitive psychological/personality
 *   judgments"): a deterministic quarantine scanner matches legacy AI memory
 *   keys/values against a closed psychological/personality pattern list.
 *   Matching entries are quarantined OUT of the usable profile - listed with
 *   a reason and deletable, never surfaced as memory the agent should act on.
 */

// ---------------- Phase 36: customer support memory ----------------

/** Kinds a human may assign to a memory entry (closed union). */
export const MEMORY_ENTRY_KINDS = ['fact', 'account', 'preference', 'issue_history', 'context'] as const;
export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];

export const MEMORY_ENTRY_KIND_LABELS: Record<MemoryEntryKind, string> = {
  fact: 'Fact',
  account: 'Account detail',
  preference: 'Preference',
  issue_history: 'Issue history',
  context: 'Context'
};

/** Composed profile sections (closed union; one per plan Phase 36 bullet). */
export const MEMORY_SECTIONS = [
  'issue_history',
  'previous_resolutions',
  'communication_preferences',
  'recurring_patterns',
  'support_outcomes',
  'campaign_history',
  'account_facts',
  'human_entries',
  'ai_entries'
] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export const MEMORY_SECTION_LABELS: Record<MemorySection, string> = {
  issue_history: 'Known issue history',
  previous_resolutions: 'Previous resolutions',
  communication_preferences: 'Communication preferences',
  recurring_patterns: 'Recurring support patterns',
  support_outcomes: 'Support outcomes',
  campaign_history: 'Campaign history',
  account_facts: 'Product & account facts',
  human_entries: 'Human-written memory',
  ai_entries: 'AI-extracted memory'
};

export type MemorySource = 'helpscout_mirror' | 'deterministic_local' | 'ai_derived' | 'human_local';

export type MemoryFreshness = 'fresh' | 'aging' | 'stale' | 'unknown';

export interface MemoryEvidence {
  description: string;
  conversation_id?: number;
  conversation_number?: number;
  thread_id?: number;
}

export interface MemoryEntry {
  section: MemorySection;
  title: string;
  value: string | null;
  source: MemorySource;
  /** Finer provenance (e.g. 'ai_inferred', 'human_entered', link origin). */
  origin: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  freshness: MemoryFreshness;
  evidence: MemoryEvidence[];
  /** Row id for persisted human/AI entries (undefined for composed rows). */
  entry_id?: number;
  kind?: MemoryEntryKind;
  /** Only human entries are editable/deletable through the memory API. */
  editable: boolean;
}

export interface MemoryQuarantinedEntry {
  entry_id: number;
  key: string;
  reason: string;
  last_seen_at: string | null;
}

export interface CustomerMemoryProfile {
  customer_local_id: number;
  customer: { first_name: string | null; last_name: string | null; organization_name: string | null };
  generated_at: string;
  sections: { section: MemorySection; label: string; entries: MemoryEntry[] }[];
  quarantined: MemoryQuarantinedEntry[];
  notes: string[];
}

/**
 * Red-line pattern list (deterministic, closed): keys/values matching these
 * patterns are quarantined. Deliberately broad - a false quarantine is a
 * mild inconvenience; a missed psychological judgment is a policy violation.
 */
export const MEMORY_QUARANTINE_PATTERNS: RegExp[] = [
  /\bpersonality\b/i,
  /\btemperament\b/i,
  /\bmental health\b/i,
  /\bpsycholog/i,
  /\bemotional state\b/i,
  /\bemotional instability\b/i,
  /\bintrovert/i,
  /\bextrovert/i,
  /\bextravert/i,
  /\bneurotic/i,
  /\bnarcissis/i,
  /\bcognitive trait/i,
  /\bmood disorder/i,
  /\bdiagnos(?:is|ed|es)\b/i,
  /\bdepress(?:ed|ion)\b/i,
  /\banxiety disorder\b/i,
  /\bbipolar\b/i,
  /\bschizo/i,
  /\bautis/i,
  /\bintelligence (?:level|score)\b/i,
  /\bEQ\b/,
  /\bIQ\b/
];

/** Freshness thresholds (days since last_seen_at; honest unknown when null). */
export const MEMORY_FRESH_DAYS = 90;
export const MEMORY_AGING_DAYS = 270;
