import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { AttributeRepository } from '../../src/server/database/repositories/attributeRepo.js';
import { ViewEngine, ViewCompileError } from '../../src/server/inbox/viewEngine.js';
import {
  AI_ATTRIBUTE_CATALOG,
  AI_ATTRIBUTE_KEYS,
  AI_ATTRIBUTE_SCHEMA_VERSION,
  URGENCY_VALUES,
  FRUSTRATION_VALUES,
  TECHNICAL_VALUES,
  RESPONSE_PREFERENCE_VALUES,
  AI_INTENT_VALUES,
  AI_RISK_VALUES
} from '../../src/shared/constants.js';
import type { ViewDefinition } from '../../src/shared/activity.js';

/**
 * v1.9.0 (M3) unit tests: the AI attribute catalog contract, the
 * AttributeRepository's closed-catalog enforcement + versioning, and the
 * viewEngine's ai_attribute condition compilation (the code path shared by
 * saved Views AND the live inbox filter).
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let repo: AttributeRepository;

function insertConversation(remote: number, number: number): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, 'active', 1, 1, datetime('now'), datetime('now'), datetime('now'))`
  ).run(remote, number, `S${number}`);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (301, 'Support', 'support')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name) VALUES (701, 'Ada')").run();
  repo = new AttributeRepository(db);
});

afterAll(() => {
  closeDatabase();
});

// ---------------- catalog (the closed vocabulary) ----------------

describe('AI attribute catalog (plan Phase 16)', () => {
  it('is the complete closed key list (14 keys, no duplicates)', () => {
    expect(AI_ATTRIBUTE_KEYS).toHaveLength(14);
    expect(new Set(AI_ATTRIBUTE_KEYS).size).toBe(14);
    expect(AI_ATTRIBUTE_CATALOG.map((d) => d.key)).toEqual(AI_ATTRIBUTE_KEYS);
  });

  it('reuses the interaction vocabularies for enum attributes (no drift)', () => {
    const byKey = new Map(AI_ATTRIBUTE_CATALOG.map((d) => [d.key, d]));
    expect(byKey.get('urgency')?.values).toEqual(URGENCY_VALUES);
    expect(byKey.get('frustration_cues')?.values).toEqual(FRUSTRATION_VALUES);
    expect(byKey.get('technical_familiarity')?.values).toEqual(TECHNICAL_VALUES);
    expect(byKey.get('response_style')?.values).toEqual(RESPONSE_PREFERENCE_VALUES);
    expect(byKey.get('intent')?.values).toEqual(AI_INTENT_VALUES);
    expect(byKey.get('risk')?.values).toEqual(AI_RISK_VALUES);
  });

  it('gives every key a label, value type and description', () => {
    for (const d of AI_ATTRIBUTE_CATALOG) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(['enum', 'number', 'boolean', 'text']).toContain(d.value_type);
      expect(d.description.length).toBeGreaterThan(0);
    }
    // enum attributes must carry a closed vocabulary; others must not
    for (const d of AI_ATTRIBUTE_CATALOG) {
      if (d.value_type === 'enum') expect(d.values?.length ?? 0).toBeGreaterThan(0);
      else expect(d.values).toBeUndefined();
    }
  });
});

// ---------------- repository enforcement + versioning ----------------

describe('AttributeRepository (closed catalog + versioning)', () => {
  it('stores valid records and stamps the schema version', () => {
    const id = insertConversation(9901, 101);
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'urgency', value: 'high', value_type: 'enum', confidence: 'high', source: 'deterministic', evidence: [] },
      { conversation_id: id, attribute: 'known_issue', value: 'true', value_type: 'boolean', confidence: 'high', source: 'deterministic', evidence: [] },
      { conversation_id: id, attribute: 'question_count', value: '3', value_type: 'number', confidence: 'high', source: 'deterministic', evidence: [] }
    ], null);
    const rows = repo.currentForConversation(id);
    expect(rows.map((r) => r.attribute).sort()).toEqual(['known_issue', 'question_count', 'urgency']);
    for (const r of rows) expect(r.schema_version).toBe(AI_ATTRIBUTE_SCHEMA_VERSION);
  });

  it('DROPS records that violate the closed catalog (unknown key / enum / boolean / number / type)', () => {
    const id = insertConversation(9902, 102);
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'urgency', value: 'extreme', value_type: 'enum', confidence: 'high', source: 'deterministic', evidence: [] }, // enum violation
      { conversation_id: id, attribute: 'not_a_real_key', value: 'x', value_type: 'text', confidence: 'high', source: 'deterministic', evidence: [] }, // unknown key
      { conversation_id: id, attribute: 'escalation_signal', value: 'maybe', value_type: 'boolean', confidence: 'high', source: 'deterministic', evidence: [] }, // boolean violation
      { conversation_id: id, attribute: 'question_count', value: 'many', value_type: 'number', confidence: 'high', source: 'deterministic', evidence: [] }, // number violation
      { conversation_id: id, attribute: 'product', value: 'Billing portal', value_type: 'enum', confidence: 'high', source: 'ai', evidence: [] } // type disagreement with catalog (product is text)
    ], null);
    expect(repo.currentForConversation(id)).toEqual([]);
  });

  it('versions snapshots: recompute supersedes prior rows, history preserves them', () => {
    const id = insertConversation(9903, 103);
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'urgency', value: 'low', value_type: 'enum', confidence: 'low', source: 'deterministic', evidence: [] }
    ], null);
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'urgency', value: 'high', value_type: 'enum', confidence: 'high', source: 'deterministic', evidence: [{ excerpt: 'this is urgent', thread_local_id: 5 }] }
    ], null);
    const current = repo.currentForConversation(id);
    expect(current).toHaveLength(1);
    expect(current[0]!.value).toBe('high');
    expect(current[0]!.evidence).toEqual([{ excerpt: 'this is urgent', thread_local_id: 5 }]);
    const history = repo.history(id, 'urgency');
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]!.value).toBe('high');
    expect(history[1]!.value).toBe('low');
    expect(history[1]!.superseded_at).not.toBeNull();
  });

  it('honest unknown: a snapshot with no record for a key retires the previous value', () => {
    const id = insertConversation(9904, 104);
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'product', value: 'Mobile app', value_type: 'text', confidence: 'medium', source: 'ai', evidence: [{ excerpt: 'the mobile app crashes', thread_local_id: 1 }] },
      { conversation_id: id, attribute: 'urgency', value: 'moderate', value_type: 'enum', confidence: 'medium', source: 'deterministic', evidence: [] }
    ], null);
    // next recompute (AI offline) yields only urgency -> product reads unknown again
    repo.saveSnapshot(id, [
      { conversation_id: id, attribute: 'urgency', value: 'moderate', value_type: 'enum', confidence: 'medium', source: 'deterministic', evidence: [] }
    ], null);
    expect(repo.currentForConversation(id).map((r) => r.attribute)).toEqual(['urgency']);
    expect(repo.distinctValues('product')).toEqual([]);
  });

  it('conversationsMatching: equals / not_equals / contains / numeric gt / unknown', () => {
    const a = insertConversation(9905, 105);
    const b = insertConversation(9906, 106);
    repo.saveSnapshot(a, [
      { conversation_id: a, attribute: 'urgency', value: 'high', value_type: 'enum', confidence: 'high', source: 'deterministic', evidence: [] },
      { conversation_id: a, attribute: 'question_count', value: '4', value_type: 'number', confidence: 'high', source: 'deterministic', evidence: [] }
    ], null);
    repo.saveSnapshot(b, [
      { conversation_id: b, attribute: 'urgency', value: 'low', value_type: 'enum', confidence: 'low', source: 'deterministic', evidence: [] },
      { conversation_id: b, attribute: 'question_count', value: '1', value_type: 'number', confidence: 'high', source: 'deterministic', evidence: [] }
    ], null);
    const convA = insertConversation(9907, 107); // no attributes at all

    const eq = repo.conversationsMatching('urgency', 'equals', 'high', 50);
    expect(eq.map((m) => m.conversation_id)).toContain(a);
    expect(eq.map((m) => m.conversation_id)).not.toContain(b);
    const ne = repo.conversationsMatching('urgency', 'not_equals', 'high', 50);
    expect(ne.map((m) => m.conversation_id)).toContain(b);
    expect(ne.map((m) => m.conversation_id)).not.toContain(a);
    expect(ne.map((m) => m.conversation_id)).not.toContain(convA); // unknown never matches not_equals
    const gt = repo.conversationsMatching('question_count', 'gt', '2', 50);
    expect(gt.map((m) => m.conversation_id)).toContain(a);
    expect(gt.map((m) => m.conversation_id)).not.toContain(b);
    expect(gt.map((m) => m.conversation_id)).not.toContain(convA);
    const unknown = repo.conversationsMatching('product', 'unknown', '', 50);
    expect(unknown.map((m) => m.conversation_id)).toContain(convA); // no rows at all = unknown
    expect(unknown.map((m) => m.conversation_id)).toContain(a); // rows for OTHER keys still read unknown for product (per-key honesty)
    // hostile / malformed
    expect(repo.conversationsMatching('not_a_key', 'equals', 'x', 50)).toEqual([]);
    expect(repo.conversationsMatching('question_count', 'gt', 'NaN-ish', 50)).toEqual([]);
  });

  it('contains escapes LIKE wildcards (no wildcard injection)', () => {
    const a = insertConversation(9908, 108);
    repo.saveSnapshot(a, [
      { conversation_id: a, attribute: 'product', value: 'a%b_c', value_type: 'text', confidence: 'low', source: 'ai', evidence: [] }
    ], null);
    // '%' as a search value must match literally, not act as a wildcard
    const hits = repo.conversationsMatching('product', 'contains', '%', 50);
    expect(hits.map((m) => m.conversation_id)).toEqual([a]); // literal % matches the literal % in the value
    const noHits = repo.conversationsMatching('product', 'contains', 'zzz', 50);
    expect(noHits).toEqual([]);
  });

  it('distributions count known vs unknown honestly per attribute', () => {
    const dists = repo.distributions();
    expect(dists.map((d) => d.attribute)).toEqual([...AI_ATTRIBUTE_KEYS]);
    const urgency = dists.find((d) => d.attribute === 'urgency')!;
    const storedKnown = db.prepare("SELECT COUNT(DISTINCT conversation_id) AS n FROM ai_attributes WHERE attribute = 'urgency' AND superseded_at IS NULL").get() as Row;
    expect(urgency.known).toBe(Number(storedKnown.n));
    expect(urgency.unknown).toBe(urgency.total_conversations - urgency.known);
  });
});

// ---------------- viewEngine ai_attribute compilation ----------------

describe('viewEngine ai_attribute conditions (Views + live filter share this path)', () => {
  const engine = new ViewEngine(db, { timezone: 'UTC' });
  const compile = (conditions: ViewDefinition['conditions']): { whereSql: string; params: unknown[] } => {
    const c = engine.compile({ combinator: 'all', conditions } as ViewDefinition);
    return { whereSql: c.whereSql, params: c.params };
  };

  it('equals compiles to a parameterized EXISTS', () => {
    const { whereSql, params } = compile([{ kind: 'ai_attribute', attribute: 'urgency', op: 'equals', value: 'high' }]);
    expect(whereSql).toContain('ai_attributes');
    expect(whereSql).not.toContain("'high'"); // value is bound, never inlined
    expect(params).toContain('urgency');
    expect(params).toContain('high');
  });

  it("equals 'unknown' compiles to NOT EXISTS (honest unknown)", () => {
    const { whereSql } = compile([{ kind: 'ai_attribute', attribute: 'product', op: 'equals', value: 'unknown' }]);
    expect(whereSql).toContain('NOT EXISTS');
    expect(whereSql).toContain('ai_attributes');
  });

  it("rejects non-equals operators against 'unknown'", () => {
    expect(() => compile([{ kind: 'ai_attribute', attribute: 'product', op: 'contains', value: 'unknown' }])).toThrow(ViewCompileError);
    expect(() => compile([{ kind: 'ai_attribute', attribute: 'product', op: 'gt', value: 'unknown' }])).toThrow(ViewCompileError);
  });

  it('numeric attributes require numeric values for ordered operators', () => {
    const { whereSql } = compile([{ kind: 'ai_attribute', attribute: 'question_count', op: 'gt', value: '2' }]);
    expect(whereSql).toContain('CAST');
    expect(() => compile([{ kind: 'ai_attribute', attribute: 'question_count', op: 'gt', value: 'many' }])).toThrow(ViewCompileError);
  });

  it('ordered enum comparisons expand by vocabulary position with bound params', () => {
    // urgency: low < moderate < high (URGENCY_VALUES order)
    const { whereSql, params } = compile([{ kind: 'ai_attribute', attribute: 'urgency', op: 'gte', value: 'moderate' }]);
    expect(whereSql).toContain('IN (');
    expect(params.filter((p) => p === 'moderate' || p === 'high')).toHaveLength(2);
    expect(() => compile([{ kind: 'ai_attribute', attribute: 'urgency', op: 'gt', value: 'supercritical' }])).toThrow(ViewCompileError);
  });

  it('rejects unknown attribute keys (closed catalog)', () => {
    expect(() => compile([{ kind: 'ai_attribute', attribute: 'nope' as never, op: 'equals', value: 'x' }])).toThrow(ViewCompileError);
  });

  it('contains escapes LIKE wildcards', () => {
    const { params } = compile([{ kind: 'ai_attribute', attribute: 'product', op: 'contains', value: "a%b'c" }]);
    const like = params.find((p) => typeof p === 'string' && p.includes('%')) as string | undefined;
    expect(like).toBeDefined();
    expect(like).toBe("%a\\%b'c%");
  });
});
