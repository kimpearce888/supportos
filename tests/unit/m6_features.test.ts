import { describe, it, expect } from 'vitest';
import { GRAPH_NODE_KINDS, GRAPH_HUMAN_RELATIONS, GRAPH_MAX_NEIGHBOR_EDGES, GRAPH_MAX_SUBGRAPH_DEPTH } from '../../src/shared/graph.js';
import { COACHING_CHECK_KINDS, COACHING_CHECK_LAYER, COACHING_CHECK_LABELS, COACHING_MAX_DRAFT_CHARS } from '../../src/shared/coaching.js';
import { MEMORY_ENTRY_KINDS, MEMORY_SECTIONS, MEMORY_QUARANTINE_PATTERNS } from '../../src/shared/memory.js';

/**
 * v2.2.0 (M6) unit tests: closed-vocabulary contracts (plan Phases 34-36)
 * and the memory red-line quarantine pattern matrix.
 */

describe('support graph contract (Phase 34)', () => {
  it('covers every node kind the plan requires', () => {
    // Plan Phase 34: Customer, Organization, Conversation, Issue, Incident,
    // Knowledge, Agent, Campaign, Product, Custom Object, Connector Data.
    for (const required of ['customer', 'organization', 'conversation', 'incident', 'knowledge_document', 'agent', 'campaign', 'product', 'custom_object', 'connector_data']) {
      expect(GRAPH_NODE_KINDS).toContain(required);
    }
    // "Issue" covers both issue representations.
    expect(GRAPH_NODE_KINDS).toContain('known_issue');
    expect(GRAPH_NODE_KINDS).toContain('issue_cluster');
    expect(GRAPH_NODE_KINDS).toHaveLength(12);
  });

  it('human relations form a closed union with labels', () => {
    expect(GRAPH_HUMAN_RELATIONS).toHaveLength(5);
    for (const r of GRAPH_HUMAN_RELATIONS) {
      expect(typeof r).toBe('string');
    }
  });

  it('enforces bounded exploration (plan Phase 41)', () => {
    expect(GRAPH_MAX_NEIGHBOR_EDGES).toBeLessThanOrEqual(200);
    expect(GRAPH_MAX_SUBGRAPH_DEPTH).toBeLessThanOrEqual(2);
  });
});

describe('coaching contract (Phase 35)', () => {
  it('implements exactly the ten checks the plan lists', () => {
    expect([...COACHING_CHECK_KINDS].sort()).toEqual([
      'duplicated_questions',
      'excessive_wording',
      'insufficient_detail',
      'internal_information_leakage',
      'missing_acknowledgment',
      'preference_mismatch',
      'unanswered_customer_questions',
      'unsupported_claims',
      'unsupported_timeframe',
      'wrong_customer_context'
    ].sort());
  });

  it('labels every check and marks only claims+context as AI-layer', () => {
    for (const kind of COACHING_CHECK_KINDS) {
      expect(COACHING_CHECK_LABELS[kind].length).toBeGreaterThan(0);
    }
    expect(COACHING_CHECK_LAYER.unsupported_claims).toBe('ai');
    // The deterministic layer covers the other eight (+ wrong_customer_context
    // has BOTH a deterministic part and an AI part).
    expect(COACHING_CHECK_LAYER.unanswered_customer_questions).toBe('deterministic');
    expect(COACHING_CHECK_LAYER.internal_information_leakage).toBe('deterministic');
    expect(COACHING_MAX_DRAFT_CHARS).toBeGreaterThan(0);
  });
});

describe('memory red-line quarantine (Phase 36)', () => {
  const matches = (key: string, value: string | null = null): boolean =>
    MEMORY_QUARANTINE_PATTERNS.some((re) => re.test(key) || re.test(value == null ? key : `${key} ${value}`));

  it('quarantines psychological/personality judgments', () => {
    expect(matches('personality type')).toBe(true);
    expect(matches('customer temperament')).toBe(true);
    expect(matches('mental health notes')).toBe(true);
    expect(matches('psychological profile')).toBe(true);
    expect(matches('emotional state')).toBe(true);
    expect(matches('introvert customer')).toBe(true);
    expect(matches('note', 'she seems neurotic in tickets')).toBe(true);
    expect(matches('diagnosis')).toBe(true);
    expect(matches('mood', 'signs of depression')).toBe(true);
    expect(matches('assessment', 'customer has bipolar tendencies')).toBe(true);
    expect(matches('intelligence level')).toBe(true);
  });

  it('does NOT quarantine ordinary support facts', () => {
    expect(matches('Preferred escalation path')).toBe(false);
    expect(matches('prefers concise replies')).toBe(false);
    expect(matches('account plan', 'enterprise tier')).toBe(false);
    expect(matches('known issue history', 'timezone bug on export')).toBe(false);
    expect(matches('Location', 'Berlin')).toBe(false);
    expect(matches('api token rotation schedule')).toBe(false);
    // "depressed" as an ordinary word boundary check: "price" must not match.
    expect(matches('price sensitivity')).toBe(false);
  });

  it('memory sections cover the plan bullets', () => {
    for (const required of ['issue_history', 'previous_resolutions', 'communication_preferences', 'recurring_patterns', 'support_outcomes', 'campaign_history', 'account_facts', 'human_entries']) {
      expect(MEMORY_SECTIONS).toContain(required);
    }
    expect(MEMORY_ENTRY_KINDS).toHaveLength(5);
  });
});
