/**
 * M5 shared contracts (v2.1.0): knowledge gap engine (plan Phase 26),
 * post-resolution QA (Phase 27), friction findings (Phase 29).
 *
 * Design decisions:
 * - Gap candidates are DETERMINISTIC detections persisted for human
 *   approval. Nothing ever auto-publishes into knowledge_documents; an
 *   approved candidate is a marker, drafting remains a human action.
 * - Post-resolution QA is two layers, mirroring the attribute-layer design:
 *   the deterministic layer is always computable from the local mirror
 *   (counts, repeats, handoffs); the AI layer is OPTIONAL local-LLM analysis
 *   recorded as ai_runs type 'post_resolution_qa' - kept strictly separate
 *   from pre-send draft verification.
 * - Friction findings must cite evidence: every finding carries thread ids
 *   and excerpts, so "link friction findings to exact conversation
 *   evidence" (plan) holds by construction. Findings are heuristics and say
 *   so in their detail lines - SupportOS never presents a heuristic as a
 *   judgment about a person.
 */

// ---------------- Phase 26: knowledge gap candidates ----------------

export const KNOWLEDGE_GAP_KINDS = [
  'repeated_question_uncovered',
  'repeated_question_unsolved',
  'conflicting_knowledge',
  'missing_troubleshooting_steps',
  'new_issue_undocumented'
] as const;
export type KnowledgeGapKind = (typeof KNOWLEDGE_GAP_KINDS)[number];

export const KNOWLEDGE_GAP_KIND_LABELS: Record<KnowledgeGapKind, string> = {
  repeated_question_uncovered: 'Repeated question, no covering document',
  repeated_question_unsolved: 'Repeated question, existing docs did not solve it',
  conflicting_knowledge: 'Conflicting knowledge documents',
  missing_troubleshooting_steps: 'Missing troubleshooting steps',
  new_issue_undocumented: 'New issue with no documentation'
};

export type KnowledgeCandidateStatus = 'candidate' | 'approved' | 'rejected' | 'superseded';

export interface KnowledgeCandidate {
  id: number;
  kind: KnowledgeGapKind;
  question: string;
  occurrence_count: number;
  evidence_conversation_ids: number[];
  related_document_ids: number[];
  detail: {
    explanation: string;
    /** Honest method note: how this candidate was detected. */
    method: string;
    /** For conflicting_knowledge: the document titles in conflict. */
    conflicting_titles?: string[];
    /** For new_issue_undocumented: the cluster/known-issue label. */
    issue_label?: string;
    /** For missing_troubleshooting_steps: the closest document examined. */
    closest_document_title?: string | null;
    /** First/last occurrence timestamps (ISO), when observable. */
    first_seen?: string | null;
    last_seen?: string | null;
  };
  status: KnowledgeCandidateStatus;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeGapReport {
  generated_at: string;
  kinds: {
    kind: KnowledgeGapKind;
    label: string;
    candidates: KnowledgeCandidate[];
  }[];
  totals: { candidates: number; approved: number; rejected: number };
  notes: string[];
}

export interface KnowledgeCandidateDraft {
  candidate_id: number;
  kind: KnowledgeGapKind;
  suggested_title: string;
  suggested_outline: string[];
  evidence_conversations: { conversation_local_id: number; number: number; subject: string | null }[];
  note: string;
}

// ---------------- Phase 27: post-resolution QA ----------------

export interface QaDeterministic {
  conversation_local_id: number;
  closed: boolean;
  /** Customer messages after the first agent reply that are not closing acknowledgments. */
  back_and_forth_count: number;
  /** Customer messages that repeat a >= 6-word span from an earlier customer message. */
  repeated_information_count: number;
  repeated_information_evidence: { thread_id: number; excerpt: string }[];
  /** Customer messages arriving AFTER the conversation was closed (observable avoidable follow-up signal). */
  messages_after_close: number;
  /** Assignment changes observed in the local event history (honest: pre-sync changes are unknown). */
  handoff_count: number;
  handoff_history_complete: boolean;
  /** Customer question-shaped sentences vs agent replies (coarse, labeled heuristic). */
  customer_question_count: number;
  agent_reply_count: number;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  computed_honestly: string[];
}

export interface QaAiLayer {
  answered: { value: 'yes' | 'no' | 'unclear'; reasoning: string; evidence_thread_ids: number[] } | null;
  evidence_supported: { value: 'yes' | 'partially' | 'no' | 'unclear'; reasoning: string } | null;
  correct_issue: { value: 'yes' | 'no' | 'unclear'; reasoning: string } | null;
  suggestions: {
    kb_improve: boolean;
    kb_reason: string;
    saved_reply_suggested: boolean;
    saved_reply_title: string | null;
    issue_association: string | null;
  } | null;
  model: string | null;
}

export interface PostResolutionQa {
  conversation_id: number;
  deterministic: QaDeterministic;
  ai: QaAiLayer | null;
  ai_available: boolean;
  computed_at: string;
  recomputed_at: string | null;
}

// ---------------- Phase 29: friction findings ----------------

export const FRICTION_KINDS = [
  'repeated_customer_explanations',
  'repeated_agent_questions',
  'troubleshooting_loop',
  'repeated_handoffs',
  'repeated_unresolved_interactions',
  'duplicated_information_requests'
] as const;
export type FrictionKind = (typeof FRICTION_KINDS)[number];

export const FRICTION_KIND_LABELS: Record<FrictionKind, string> = {
  repeated_customer_explanations: 'Customer explained the same thing repeatedly',
  repeated_agent_questions: 'The agent asked the same question repeatedly',
  troubleshooting_loop: 'Unnecessary troubleshooting loop',
  repeated_handoffs: 'Repeated handoffs between agents',
  repeated_unresolved_interactions: 'Repeated unresolved interactions',
  duplicated_information_requests: 'Agent re-requested information the customer already provided'
};

export interface FrictionEvidence {
  thread_id: number;
  author_type: 'customer' | 'agent';
  excerpt: string;
  at: string | null;
}

export interface FrictionFinding {
  conversation_id: number;
  conversation_number: number;
  customer_local_id: number | null;
  kind: FrictionKind;
  severity: 'low' | 'moderate' | 'high';
  evidence: FrictionEvidence[];
  detail: string;
  computed_at: string;
}

export interface FrictionOverview {
  generated_at: string;
  days: number;
  kinds: {
    kind: FrictionKind;
    label: string;
    conversations: number;
    high_severity: number;
    sample: FrictionFinding[];
  }[];
  customers_most_affected: { customer_local_id: number; first_name: string | null; last_name: string | null; findings: number; high: number }[];
  notes: string[];
}

// ---------------- Phase 28: response effectiveness ----------------

export interface EffectivenessBucket {
  style_key: string;
  style_label: string;
  kind: 'response_style' | 'characteristic';
  conversations: number;
  follow_up_rate: number | null;
  clarification_rate: number | null;
  resolved_after_first_rate: number | null;
  avg_effort_score: number | null;
  high_friction_rate: number | null;
  rating_distribution: { rating: string; count: number }[] | null;
  sample_conversations: { conversation_local_id: number; number: number; subject: string | null; outcome_summary: string }[];
}

export interface EffectivenessReport {
  generated_at: string;
  days: number;
  total_analyzed: number;
  buckets: EffectivenessBucket[];
  notes: string[];
}

