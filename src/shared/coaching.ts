/**
 * M6 shared contracts (v2.2.0): pre-send agent coaching (plan Phase 35).
 *
 * Design decisions:
 * - Coaching is OPTIONAL and ADVISORY ONLY. No code path blocks, delays or
 *   annotates the send itself; the agent asks for a review, reads it, and
 *   decides (plan: "Make the coaching evidence-based and optional").
 * - Two honestly-separated layers, mirroring post-resolution QA: a
 *   deterministic layer (always computable from the local mirror) and an
 *   optional local-LLM layer recorded via ai_runs type 'agent_coaching'.
 *   This is deliberately SEPARATE from draft verification (ai_verifications):
 *   verification guards AI-generated drafts; coaching reviews whatever the
 *   human typed.
 * - Every check reports one of pass / flagged / not_applicable so the panel
 *   shows the full checklist, not only complaints; every finding cites
 *   evidence (draft excerpt + the local facts that triggered it).
 */

// ---------------- Phase 35: agent coaching ----------------

export const COACHING_CHECK_KINDS = [
  'unanswered_customer_questions',
  'duplicated_questions',
  'unsupported_claims',
  'unsupported_timeframe',
  'missing_acknowledgment',
  'excessive_wording',
  'insufficient_detail',
  'internal_information_leakage',
  'wrong_customer_context',
  'preference_mismatch'
] as const;
export type CoachingCheckKind = (typeof COACHING_CHECK_KINDS)[number];

export const COACHING_CHECK_LABELS: Record<CoachingCheckKind, string> = {
  unanswered_customer_questions: 'Unanswered customer questions',
  duplicated_questions: 'Duplicated questions',
  unsupported_claims: 'Unsupported claims',
  unsupported_timeframe: 'Unsupported timeframe',
  missing_acknowledgment: 'Missing acknowledgment',
  excessive_wording: 'Excessive wording',
  insufficient_detail: 'Insufficient detail',
  internal_information_leakage: 'Internal information leakage',
  wrong_customer_context: 'Wrong customer context',
  preference_mismatch: 'Communication preference mismatch'
};

/** Which layer computed the check (plan Phase 35 evidence-based checks). */
export type CoachingLayer = 'deterministic' | 'ai';

export const COACHING_CHECK_LAYER: Record<CoachingCheckKind, CoachingLayer> = {
  unanswered_customer_questions: 'deterministic',
  duplicated_questions: 'deterministic',
  unsupported_claims: 'ai',
  unsupported_timeframe: 'deterministic',
  missing_acknowledgment: 'deterministic',
  excessive_wording: 'deterministic',
  insufficient_detail: 'deterministic',
  internal_information_leakage: 'deterministic',
  wrong_customer_context: 'deterministic',
  preference_mismatch: 'deterministic'
};

export type CoachingCheckStatus = 'pass' | 'flagged' | 'not_applicable' | 'unavailable';

export interface CoachingEvidence {
  /** What this evidence is (e.g. "customer question", "linked incident"). */
  description: string;
  excerpt: string;
  conversation_id?: number;
  thread_id?: number;
  incident_code?: string;
}

export interface CoachingFinding {
  /** The draft excerpt the finding is about. */
  draft_excerpt: string;
  evidence: CoachingEvidence[];
  advice: string;
}

export interface CoachingCheckResult {
  kind: CoachingCheckKind;
  label: string;
  layer: CoachingLayer;
  status: CoachingCheckStatus;
  /** What was checked and why it passed/flagged - the check explains itself. */
  detail: string;
  findings: CoachingFinding[];
}

export interface CoachingReview {
  conversation_id: number;
  draft_sha256: string;
  draft_chars: number;
  draft_words: number;
  checks: CoachingCheckResult[];
  ai: { available: boolean; model: string | null; error: string | null };
  summary: { flagged: number; checks_run: number; checks_unavailable: number };
  note: string;
  reviewed_at: string;
}

/** AI-layer output contract (closed values coerced; unparseable = honest failure). */
export interface CoachingAiLayer {
  unsupported_claims: { verdict: 'none' | 'possible' | 'likely'; reasoning: string; excerpt: string } | null;
  wrong_context: { verdict: 'no' | 'possible' | 'yes'; reasoning: string; excerpt: string } | null;
  model: string | null;
}

export const COACHING_MAX_DRAFT_CHARS = 20000;
export const COACHING_MAX_DRAFT_BYTES = 60000;
