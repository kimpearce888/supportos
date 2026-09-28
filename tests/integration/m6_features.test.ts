import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { GraphService } from '../../src/server/graph/graphService.js';
import { CoachingService, type CoachingChatFn } from '../../src/server/coaching/coachingService.js';
import { CustomerMemoryService } from '../../src/server/memory/customerMemoryService.js';

/**
 * v2.2.0 (M6) integration tests: support graph relationship layer (Phase 34),
 * pre-send advisory coaching (Phase 35) and customer support memory with the
 * red-line quarantine (Phase 36). All worlds are crafted with raw inserts;
 * AI layers use deterministic fakes through the production constructor.
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;

function insertConversation(remote: number, number: number, customer: number | null, createdAt: string, closed = false): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, closed_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number}`, closed ? 'closed' : 'active', customer, createdAt, closed ? createdAt : null);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

function insertThread(convId: number, remote: number, type: 'customer' | 'reply' | 'note', body: string, at: string): number {
  db.prepare(
    `INSERT INTO threads (remote_id, conversation_id, type, body_text, state, remote_created_at, local_created_at)
     VALUES (?, ?, ?, ?, 'published', ?, datetime('now'))`
  ).run(remote, convId, type, body, at);
  return Number((db.prepare('SELECT id FROM threads WHERE remote_id = ?').get(remote) as Row).id);
}

let graph: GraphService;
let coaching: CoachingService;
let memory: CustomerMemoryService;
let conv1: number;
let conv2: number;
let custAda: number;
let custGrace: number;
let incidentId: number;

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO organizations (remote_id, name, domains) VALUES (701, 'Compute Inc', 'compute.example')").run();
  const ada = db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id, background, location) VALUES (901, 'Ada', 'Byron', 1, 'Runs the compute cluster', 'London')").run();
  custAda = Number(ada.lastInsertRowid);
  const grace = db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (902, 'Grace', 'Hopper', 1)").run();
  custGrace = Number(grace.lastInsertRowid);
  const agent = db.prepare("INSERT INTO users (remote_id, first_name, last_name, email, role) VALUES (601, 'Alan', 'Turing', 'alan@example.com', 'owner')").run();
  const agentId = Number(agent.lastInsertRowid);

  conv1 = insertConversation(9801, 101, custAda, '2026-09-01 10:00:00', true);
  conv2 = insertConversation(9802, 102, custGrace, '2026-09-02 10:00:00');

  // Conversation 1: customer question + agent reply + internal note.
  insertThread(conv1, 98011, 'customer', 'What is the default timeout for the compute API? Does it retry automatically?', '2026-09-01 10:00:00');
  insertThread(conv1, 98012, 'reply', 'The default timeout is 30 seconds. Could you confirm your account email?', '2026-09-01 11:00:00');
  insertThread(conv1, 98013, 'note', 'Internal: the retry ladder is 3 attempts with exponential backoff and the max ceiling is undocumented', '2026-09-01 11:30:00');
  // Conversation 2: assignee set (assigned_to edge) + frustration.
  db.prepare('UPDATE conversations SET assignee_local_id = ? WHERE id = ?').run(agentId, conv2);
  insertThread(conv2, 98021, 'customer', 'This is unacceptable - the export is still broken after the third time I reported it', '2026-09-02 10:00:00');
  insertThread(conv2, 98022, 'customer', 'What is the default timeout for the compute API?', '2026-09-02 10:05:00');

  // Known issue + link (linked_to_issue edge).
  const ki = db.prepare("INSERT INTO known_issues (title, symptoms, product, known_cause, status, first_seen_at, last_seen_at) VALUES ('Export fails on large files', 'CSV export times out', 'Compute API', 'Stream buffer overflow', 'investigating', '2026-08-01', '2026-09-01')").run();
  db.prepare("INSERT INTO known_issue_conversations (known_issue_id, conversation_id, linked_at, source) VALUES (?, ?, datetime('now'), 'human')").run(Number(ki.lastInsertRowid), conv1);

  // Incident with product + internal explanation, linked to conv1 (affected_by).
  const inc = db.prepare("INSERT INTO incidents (code, title, status, severity, product, internal_explanation, started_at) VALUES ('INC-900', 'Export incident', 'investigating', 'sev2', 'Compute API', 'The shard rebalancer leaks file handles under load', '2026-09-05 08:00:00')").run();
  incidentId = Number(inc.lastInsertRowid);
  db.prepare("INSERT INTO incident_conversations (incident_id, conversation_id, linked_by, linked_at) VALUES (?, ?, 'human', datetime('now'))").run(incidentId, conv1);

  // Communication preference for Ada: concise.
  db.prepare("INSERT INTO client_communication_preferences (customer_id, preference, evidence_count, first_observed, last_observed, confidence, origin, provenance) VALUES (?, 'concise', 4, '2026-06-01', '2026-09-01', 'high', 'ai_inferred', 'ai_generated')").run(custAda);

  // Outcome row for Ada's closed conversation (previous_resolutions).
  db.prepare("INSERT INTO client_support_outcomes (customer_id, conversation_id, resolved_after_first_response, follow_up_count, clarification_count, escalated, effort_score, friction, response_style, computed_at) VALUES (?, ?, 1, 0, 0, 0, 2, 'none', 'short_answer', datetime('now'))").run(custAda, conv1);

  // Campaign history for Ada.
  const camp = db.prepare("INSERT INTO outreach_campaigns (name, subject, body, status) VALUES ('Compute 2.0 launch', 'Compute 2.0 is here', 'Hello...', 'completed')").run();
  db.prepare("INSERT INTO outreach_recipients (campaign_id, customer_local_id, customer_remote_id, email, state, sent_at) VALUES (?, ?, 901, 'ada@example.com', 'sent', datetime('now'))").run(Number(camp.lastInsertRowid), custAda);

  // AI-extracted memory (usable) + a red-line one (must be quarantined).
  db.prepare("INSERT INTO customer_memories (customer_id, key, value, source, origin, conversation_id, first_seen_at, last_seen_at, confidence, provenance) VALUES (?, 'Uses the compute API daily', 'Verified via usage logs', 'ai', 'conversation', ?, '2026-07-01', '2026-09-01', 'medium', 'ai_generated')").run(custAda, conv1);
  db.prepare("INSERT INTO customer_memories (customer_id, key, value, source, origin, conversation_id, first_seen_at, last_seen_at, confidence, provenance) VALUES (?, 'Personality: anxious introvert', 'Avoids phone calls, prefers email', 'ai', 'conversation', ?, '2026-07-01', '2026-09-01', 'low', 'ai_generated')").run(custAda, conv1);

  graph = new GraphService(db);
  coaching = new CoachingService(db, null);
  memory = new CustomerMemoryService(db);
});

afterAll(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------- graph

describe('support graph (Phase 34)', () => {
  it('derives involves/belongs_to/assigned_to/affected_by/linked_to_issue edges with labels in-branch', () => {
    const nb = graph.neighbors('conversation', conv1)!;
    expect(nb).not.toBeNull();
    const relations = nb.edges.map((e) => e.relation);
    expect(relations).toContain('involves');
    expect(relations).toContain('affected_by');
    expect(relations).toContain('linked_to_issue');
    const involves = nb.edges.find((e) => e.relation === 'involves')!;
    expect(involves.target.kind).toBe('customer');
    expect(involves.target.label).toContain('Ada Byron');
    expect(involves.origin).toBe('helpscout_mirror');

    const nb2 = graph.neighbors('conversation', conv2)!;
    const assigned = nb2.edges.find((e) => e.relation === 'assigned_to')!;
    expect(assigned.target.kind).toBe('agent');
    expect(assigned.target.label).toContain('Alan Turing');
  });

  it('derives customer -> organization and customer -> incident (via conversations)', () => {
    const nb = graph.neighbors('customer', custAda)!;
    const rels = nb.edges.map((e) => e.relation);
    expect(rels).toContain('belongs_to');
    expect(rels).toContain('involves');
    expect(rels).toContain('affected_by');
    const belongs = nb.edges.find((e) => e.relation === 'belongs_to')!;
    expect(belongs.target.label).toBe('Compute Inc');
    const affected = nb.edges.find((e) => e.relation === 'affected_by' && e.target.kind === 'incident')!;
    expect(affected.target.label).toContain('INC-900');
    expect(affected.note).toContain('via conversation');
  });

  it('derives about_product from incidents and never invents products', () => {
    const before = graph.refreshProducts();
    expect(before.added).toBeGreaterThanOrEqual(1);
    const again = graph.refreshProducts();
    expect(again.added).toBe(0); // INSERT OR IGNORE - idempotent
    const nb = graph.neighbors('incident', incidentId)!;
    const productEdge = nb.edges.find((e) => e.relation === 'about_product');
    expect(productEdge).toBeDefined();
    expect(productEdge!.target.kind).toBe('product');
    expect(productEdge!.target.label).toBe('Compute API');
    expect(productEdge!.origin).toBe('deterministic_local');
  });

  it('manages human edges: create, duplicate refusal, self-edge refusal, both-direction neighbors, delete', () => {
    const created = graph.linkHumanEdge({
      source_kind: 'conversation', source_local_id: conv2,
      target_kind: 'incident', target_local_id: incidentId,
      relation: 'related_to', note: 'Grace reported the same outage', user_local_id: null
    });
    expect(created.ok).toBe(true);

    const dup = graph.linkHumanEdge({
      source_kind: 'conversation', source_local_id: conv2,
      target_kind: 'incident', target_local_id: incidentId,
      relation: 'related_to', note: null, user_local_id: null
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate');

    const selfEdge = graph.linkHumanEdge({
      source_kind: 'incident', source_local_id: incidentId,
      target_kind: 'incident', target_local_id: incidentId,
      relation: 'depends_on', note: null, user_local_id: null
    });
    expect(selfEdge.ok).toBe(false);

    const missing = graph.linkHumanEdge({
      source_kind: 'customer', source_local_id: 99999,
      target_kind: 'incident', target_local_id: incidentId,
      relation: 'related_to', note: null, user_local_id: null
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('source_not_found');

    // Both directions visible from each endpoint.
    const fromConv = graph.neighbors('conversation', conv2)!.edges.filter((e) => e.origin === 'human_local');
    expect(fromConv.some((e) => e.relation === 'related_to' && e.target.kind === 'incident')).toBe(true);
    const fromIncident = graph.neighbors('incident', incidentId)!.edges.filter((e) => e.origin === 'human_local');
    expect(fromIncident.some((e) => e.relation === 'related_to' && e.source.kind === 'conversation')).toBe(true);

    const listed = graph.listHumanEdges(10, 0);
    expect(listed.total).toBe(1);
    expect(graph.unlinkHumanEdge(listed.edges[0]!.id)).toBe(true);
    expect(graph.listHumanEdges(10, 0).total).toBe(0);
  });

  it('searches nodes with LIKE escaping and conversation numbers', () => {
    const hits = graph.search('Comp%'); // % must be treated literally
    expect(hits.some((h) => h.kind === 'organization' && h.label === 'Compute Inc')).toBe(false);
    const org = graph.search('Compute');
    expect(org.some((h) => h.kind === 'organization' && h.label === 'Compute Inc')).toBe(true);
    const byNumber = graph.search('101');
    expect(byNumber.some((h) => h.kind === 'conversation' && h.label.includes('#101'))).toBe(true);
    const ada = graph.search('Ada Byron');
    expect(ada.some((h) => h.kind === 'customer' && h.label === 'Ada Byron')).toBe(true);
  });

  it('reports honest stats (connector rows: zero derived edges by design)', () => {
    const stats = graph.stats();
    const productCount = stats.nodes.find((n) => n.kind === 'product')!.count;
    expect(productCount).toBeGreaterThanOrEqual(1);
    const connectorEdges = stats.edges.filter((e) => e.relation === 'linked_to');
    // No custom objects exist in this world.
    expect(connectorEdges.every((e) => e.count === 0)).toBe(true);
    expect(stats.notes.join(' ')).toContain('Connector rows carry no derived edges');
  });

  it('bounds subgraph exploration', () => {
    const sub = graph.subgraph('customer', custAda, { depth: 2 })!;
    expect(sub.nodes.length).toBeGreaterThan(1);
    expect(sub.depth_reached).toBeLessThanOrEqual(2);
    expect(sub.nodes.length).toBeLessThanOrEqual(250);
  });

  it('returns null for unknown nodes', () => {
    expect(graph.node('conversation', 999999)).toBeNull();
    // @ts-expect-error hostile kind at the service boundary
    expect(graph.node('drop_table', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------- coaching

describe('agent coaching (Phase 35)', () => {
  it('flags unanswered customer questions with thread evidence', async () => {
    const r = await coaching.reviewDraft(conv2, 'The export fix is on the way. We will get back to you soon.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'unanswered_customer_questions')!;
    expect(check.status).toBe('flagged');
    expect(check.findings.length).toBeGreaterThanOrEqual(1);
    expect(check.findings[0]!.evidence[0]!.excerpt).toContain('timeout');
  });

  it('flags duplicated questions the agent already asked', async () => {
    const r = await coaching.reviewDraft(conv1, 'Could you confirm your account email? Thanks.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'duplicated_questions')!;
    expect(check.status).toBe('flagged');
    expect(check.findings[0]!.evidence[0]!.description).toContain('earlier agent question');
  });

  it('flags timeframe promises against a linked ACTIVE incident', async () => {
    const r = await coaching.reviewDraft(conv1, 'We will fix this within 2 hours and the retry ladder will be adjusted.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'unsupported_timeframe')!;
    expect(check.status).toBe('flagged');
    expect(check.findings[0]!.evidence.some((e) => e.incident_code === 'INC-900')).toBe(true);
    expect(check.findings[0]!.evidence.some((e) => e.description.includes('ACTIVE incident'))).toBe(true);
  });

  it('flags missing acknowledgment when frustration is present', async () => {
    const r = await coaching.reviewDraft(conv2, 'The export bug is fixed in version 2.1.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'missing_acknowledgment')!;
    expect(check.status).toBe('flagged');
    expect(check.findings[0]!.evidence[0]!.description).toContain('frustration markers');
  });

  it('flags internal information leakage with verbatim span evidence', async () => {
    const r = await coaching.reviewDraft(conv1, 'The retry ladder is 3 attempts with exponential backoff and the max ceiling is undocumented, so expect retries.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'internal_information_leakage')!;
    expect(check.status).toBe('flagged');
    expect(check.findings[0]!.evidence[0]!.description).toContain('internal note');
  });

  it('flags wrong customer context (foreign conversation number + greeting)', async () => {
    const r = await coaching.reviewDraft(conv2, 'Hi Ada, about #101 - the fix is confirmed. Thanks, Grace.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'wrong_customer_context')!;
    expect(check.status).toBe('flagged');
    // #101 belongs to Ada (customer 1) but this conversation is Grace's.
    expect(check.findings.some((f) => f.draft_excerpt.includes('#101') && f.evidence.some((e) => e.excerpt.includes('different customer')))).toBe(true);
    // The greeting names Ada while the conversation belongs to Grace.
    expect(check.findings.some((f) => f.evidence.some((e) => e.description === 'customer record'))).toBe(true);
  });

  it('flags preference mismatch against the stored concise preference', async () => {
    const longDraft = 'Here is the full explanation. '.repeat(70) + 'The timeout is 30 seconds.';
    const r = await coaching.reviewDraft(conv1, longDraft);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'preference_mismatch')!;
    expect(check.status).toBe('flagged');
    expect(check.detail).toContain('concise');
    const wording = r.review.checks.find((c) => c.kind === 'excessive_wording')!;
    expect(wording.status).toBe('flagged');
  });

  it('reports not_applicable honestly (no preference stored)', async () => {
    const r = await coaching.reviewDraft(conv2, 'A clear and complete answer that addresses the export problem in full detail with steps.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = r.review.checks.find((c) => c.kind === 'preference_mismatch')!;
    expect(check.status).toBe('not_applicable');
    expect(check.detail).toContain('honest unknown');
  });

  it('persists the last review and returns it via get()', async () => {
    const r = await coaching.reviewDraft(conv1, 'The default timeout is 30 seconds and retries are automatic.');
    expect(r.ok).toBe(true);
    const stored = coaching.get(conv1);
    expect(stored).not.toBeNull();
    expect(stored!.checks.find((c) => c.kind === 'unanswered_customer_questions')!.status).toBe('pass');
    expect(stored!.note).toContain('Advisory only');
  });

  it('runs the AI layer through an injectable fake and records honest failure on garbage', async () => {
    const fakeChat: CoachingChatFn = async () => ({
      content: JSON.stringify({
        unsupported_claims: { verdict: 'likely', reasoning: 'The draft guarantees a fix date with no evidence.', excerpt: 'fixed by Friday' },
        wrong_context: { verdict: 'no', reasoning: 'The draft addresses the asked question.', excerpt: '' }
      }),
      model: 'fake-coach-model',
      latencyMs: 3
    });
    const withFake = new CoachingService(db, fakeChat);
    const r = await withFake.reviewDraft(conv2, 'The export will be fixed by Friday for sure.', { includeAi: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.ai.available).toBe(true);
    expect(r.review.ai.model).toBe('fake-coach-model');
    const claims = r.review.checks.find((c) => c.kind === 'unsupported_claims')!;
    expect(claims.status).toBe('flagged');
    expect(claims.layer).toBe('ai');
    const aiRun = db.prepare("SELECT id, type, status FROM ai_runs WHERE type = 'agent_coaching' ORDER BY id DESC LIMIT 1").get() as { id: number; type: string; status: string } | undefined;
    expect(aiRun?.status).toBe('completed');

    const garbage: CoachingChatFn = async () => ({ content: 'not json at all', model: 'garbage-model', latencyMs: 1 });
    const withGarbage = new CoachingService(db, garbage);
    const r2 = await withGarbage.reviewDraft(conv2, 'Another draft for the garbage model.', { includeAi: true });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.review.ai.available).toBe(false);
    expect(r2.review.ai.error).toContain('unparseable');
    const failedRun = db.prepare("SELECT status FROM ai_runs WHERE type = 'agent_coaching' ORDER BY id DESC LIMIT 1").get() as { status: string } | undefined;
    expect(failedRun?.status).toBe('failed');
  });

  it('reports honest unavailability when no chat fn is configured', async () => {
    const r = await coaching.reviewDraft(conv2, 'We are on it.', { includeAi: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.ai.error).toContain('unavailable');
    expect(r.review.checks.some((c) => c.kind === 'unsupported_claims')).toBe(false);
  });

  it('refuses empty drafts and unknown conversations', async () => {
    const empty = await coaching.reviewDraft(conv1, '   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_draft');
    const missing = await coaching.reviewDraft(999999, 'hello');
    expect(missing.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- memory

describe('customer support memory (Phase 36)', () => {
  it('composes all sections from the crafted world', () => {
    const profile = memory.profile(custAda)!;
    expect(profile).not.toBeNull();
    const sections = profile.sections.map((s) => s.section);
    for (const required of ['issue_history', 'previous_resolutions', 'communication_preferences', 'support_outcomes', 'campaign_history', 'account_facts', 'human_entries', 'ai_entries']) {
      expect(sections).toContain(required);
    }
    // Issue history from the known-issue link.
    expect(profile.sections.find((s) => s.section === 'issue_history')!.entries.some((e) => e.title.includes('Export fails'))).toBe(true);
    // Previous resolutions from the outcome row.
    expect(profile.sections.find((s) => s.section === 'previous_resolutions')!.entries.some((e) => e.title.includes('#101'))).toBe(true);
    // Communication preference with confidence.
    const pref = profile.sections.find((s) => s.section === 'communication_preferences')!.entries[0]!;
    expect(pref.title).toContain('concise');
    expect(pref.source).toBe('ai_derived');
    expect(pref.confidence).toBe('high');
    // Campaign history.
    expect(profile.sections.find((s) => s.section === 'campaign_history')!.entries.some((e) => e.title === 'Compute 2.0 launch')).toBe(true);
    // Account facts (org + background + location + customer-since).
    const account = profile.sections.find((s) => s.section === 'account_facts')!.entries.map((e) => e.title).join(' ');
    expect(account).toContain('Compute Inc');
    expect(account).toContain('Background');
    // AI memory (the clean one only).
    expect(profile.sections.find((s) => s.section === 'ai_entries')!.entries.some((e) => e.title === 'Uses the compute API daily')).toBe(true);
  });

  it('quarantines personality-shaped AI memories instead of using them', () => {
    const profile = memory.profile(custAda)!;
    const aiTitles = profile.sections.find((s) => s.section === 'ai_entries')!.entries.map((e) => e.title);
    expect(aiTitles).not.toContain('Personality: anxious introvert');
    expect(profile.quarantined.length).toBe(1);
    expect(profile.quarantined[0]!.key).toContain('Personality');
    expect(profile.quarantined[0]!.reason).toContain('policy');
    expect(profile.notes.join(' ')).toContain('quarantine');
  });

  it('upserts human entries, refuses red-line writes, and enforces deletion rules', () => {
    const ok = memory.upsertHumanEntry(custAda, { key: 'Escalation contact', value: 'pager duty: compute-oncall', kind: 'context', conversation_id: conv1 });
    expect(ok.ok).toBe(true);
    const listed = memory.profile(custAda)!.sections.find((s) => s.section === 'human_entries')!.entries;
    const entry = listed.find((e) => e.title === 'Escalation contact')!;
    expect(entry).toBeDefined();
    expect(entry.editable).toBe(true);
    expect(entry.source).toBe('human_local');
    expect(entry.confidence).toBe('high');
    expect(entry.evidence[0]!.conversation_number).toBe(101);

    const refused = memory.upsertHumanEntry(custAda, { key: 'Personality: difficult', value: 'pushy in tickets', kind: 'context', conversation_id: null });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('quarantine');

    const badConv = memory.upsertHumanEntry(custAda, { key: 'Note', value: 'x', kind: 'fact', conversation_id: 999999 });
    expect(badConv.ok).toBe(false);
    if (!badConv.ok) expect(badConv.code).toBe('conversation_not_found');

    // AI rows are immutable; quarantined rows are purgeable.
    const aiRow = db.prepare("SELECT id FROM customer_memories WHERE customer_id = ? AND source = 'ai' AND key = 'Uses the compute API daily'").get(custAda) as { id: number };
    const aiDelete = memory.deleteEntry(custAda, aiRow.id);
    expect(aiDelete.ok).toBe(false);
    if (!aiDelete.ok) expect(aiDelete.code).toBe('ai_immutable');

    const humanDelete = memory.deleteEntry(custAda, entry.entry_id!);
    expect(humanDelete.ok).toBe(true);
  });

  it('returns null for unknown customers', () => {
    expect(memory.profile(999999)).toBeNull();
  });
});
