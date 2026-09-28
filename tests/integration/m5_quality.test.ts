import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { KnowledgeGapService } from '../../src/server/knowledge/gapEngine.js';
import { FrictionAnalyzer } from '../../src/server/ai/friction.js';
import { PostResolutionQaService, type QaChatFn } from '../../src/server/ai/postResolutionQa.js';
import { TranslationService, type TranslateChatFn } from '../../src/server/ai/translation.js';
import { ReportBuilderService } from '../../src/server/analytics/reportBuilder.js';
import { SegmentEngine } from '../../src/server/segmentation/segmentEngine.js';

/**
 * v2.1.0 (M5) integration tests: knowledge gap engine (Phase 26),
 * post-resolution QA two layers (Phase 27), conversation friction (Phase 29),
 * local translation with cache (Phase 30), advanced segmentation conditions
 * (Phase 31) and the custom report builder (Phase 33).
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

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO organizations (remote_id, name, domains) VALUES (701, 'Compute Inc', 'compute.example')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (901, 'Ada', 'Byron', 1)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (902, 'Grace', 'Hopper', 1)").run();
});

afterAll(() => {
  closeDatabase(db);
});

describe('friction analyzer (Phase 29)', () => {
  it('detects repeated customer explanations with exact thread evidence', () => {
    const conv = insertConversation(9801, 101, 1, '2026-09-01 10:00:00', true);
    insertThread(conv, 98011, 'customer', 'My account is completely broken and I cannot log in since yesterday morning at all', '2026-09-01 10:00:00');
    insertThread(conv, 98012, 'reply', 'Thanks for reaching out - could you confirm your account email?', '2026-09-01 11:00:00');
    insertThread(conv, 98013, 'customer', 'As I already mentioned my account is completely broken and I cannot log in since yesterday morning at all', '2026-09-01 12:00:00');
    const analyzer = new FrictionAnalyzer(db);
    const findings = analyzer.analyzeConversation(conv);
    const repeated = findings.find((f) => f.kind === 'repeated_customer_explanations');
    expect(repeated).toBeDefined();
    expect(repeated!.evidence.length).toBeGreaterThanOrEqual(2);
    expect(repeated!.evidence[0]!.thread_id).toBeGreaterThan(0);
    expect(repeated!.detail).toContain('heuristic');
    // idempotent: re-analysis does not duplicate rows
    analyzer.analyzeConversation(conv);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM friction_findings WHERE conversation_id = ?').get(conv) as { n: number }).n;
    expect(rows).toBe(findings.length);
  });

  it('detects repeated handoffs from the event history and nothing without events', () => {
    const conv = insertConversation(9802, 102, 1, '2026-09-02 10:00:00');
    insertThread(conv, 98021, 'customer', 'Question about the invoice', '2026-09-02 10:00:00');
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO conversation_events (conversation_id, event_type, occurred_at, source, metadata, dedup_key) VALUES (?, 'assignment_changed', ?, 'local', '{}', ?)`
      ).run(conv, `2026-09-02 1${i}:00:00`, `assign:${conv}:${i}`);
    }
    const analyzer = new FrictionAnalyzer(db);
    const findings = analyzer.analyzeConversation(conv);
    expect(findings.some((f) => f.kind === 'repeated_handoffs')).toBe(true);
    const quiet = insertConversation(9803, 103, 2, '2026-09-03 10:00:00');
    insertThread(quiet, 98031, 'customer', 'Simple one-off question, thanks', '2026-09-03 10:00:00');
    expect(new FrictionAnalyzer(db).analyzeConversation(quiet)).toHaveLength(0);
  });

  it('detects duplicated information requests (entity already supplied)', () => {
    const conv = insertConversation(9804, 104, 1, '2026-09-04 10:00:00');
    insertThread(conv, 98041, 'customer', 'My order 551234 never arrived, please check order 551234', '2026-09-04 10:00:00');
    insertThread(conv, 98042, 'reply', 'Could you please send your order number so I can check?', '2026-09-04 11:00:00');
    const findings = new FrictionAnalyzer(db).analyzeConversation(conv);
    expect(findings.some((f) => f.kind === 'duplicated_information_requests')).toBe(true);
  });
});

describe('post-resolution QA (Phase 27)', () => {
  it('deterministic layer computes honest signals for a closed conversation', () => {
    const conv = insertConversation(9810, 110, 1, '2026-09-05 09:00:00', true);
    insertThread(conv, 98101, 'customer', 'How do I invite a teammate to my workspace? I want to add them as a viewer.', '2026-09-05 09:00:00');
    insertThread(conv, 98102, 'reply', 'Go to Settings > Members and click Invite. Viewers can be chosen in the role dropdown.', '2026-09-05 09:30:00');
    insertThread(conv, 98103, 'customer', 'Thanks, that worked perfectly. Closing from my side.', '2026-09-05 10:00:00');
    const qa = new PostResolutionQaService(db, null, new FrictionAnalyzer(db));
    const det = qa.computeDeterministic(conv);
    expect(det).not.toBeNull();
    expect(det!.closed).toBe(true);
    expect(det!.back_and_forth_count).toBe(0); // closing acknowledgment excluded
    expect(det!.agent_reply_count).toBe(1);
    expect(det!.first_response_minutes).toBe(30);
    expect(det!.computed_honestly.length).toBeGreaterThan(0);
  });

  it('AI layer: null chat = honest absence; fake chat = recorded through ai_runs', async () => {
    const conv = insertConversation(9811, 111, 1, '2026-09-06 09:00:00', true);
    insertThread(conv, 98111, 'customer', 'The export button returns error 500 every time I click it.', '2026-09-06 09:00:00');
    insertThread(conv, 98112, 'reply', 'We identified a bug in release 2.4; a fix ships this week. Meanwhile use the API export.', '2026-09-06 10:00:00');
    const disabled = new PostResolutionQaService(db, null, new FrictionAnalyzer(db));
    const noAi = await disabled.computeAiLayer(conv);
    expect(noAi.ai).toBeNull();
    expect(noAi.error).toContain('honestly absent');

    const fakeChat: QaChatFn = async () => ({
      content: JSON.stringify({
        answered: { value: 'yes', reasoning: 'The reply addresses the error and gives a workaround.', evidence_thread_ids: [98112] },
        evidence_supported: { value: 'partially', reasoning: 'No internal ticket link was cited.' },
        correct_issue: { value: 'yes', reasoning: 'Error 500 on export is the identified bug.' },
        suggestions: { kb_improve: true, kb_reason: 'No doc covers export errors', saved_reply_suggested: true, saved_reply_title: 'Export error 500', issue_association: 'Known issue: export bug' }
      }),
      model: 'fake-qa-model',
      latencyMs: 2
    });
    const enabled = new PostResolutionQaService(db, fakeChat, new FrictionAnalyzer(db));
    const withAi = await enabled.computeAiLayer(conv);
    expect(withAi.error).toBeNull();
    expect(withAi.ai?.answered?.value).toBe('yes');
    expect(withAi.ai?.answered?.evidence_thread_ids).toEqual([98112]);
    expect(withAi.ai?.model).toBe('fake-qa-model');
    const run = (db.prepare("SELECT status, type FROM ai_runs WHERE type = 'post_resolution_qa' ORDER BY id DESC LIMIT 1").get() as { status: string; type: string });
    expect(run.status).toBe('completed');
    expect(run.type).toBe('post_resolution_qa'); // SEPARATE from draft verification
  });

  it('AI layer survives unparseable model output honestly', async () => {
    const conv = insertConversation(9812, 112, 1, '2026-09-07 09:00:00', true);
    insertThread(conv, 98121, 'customer', 'Billing question about the last invoice.', '2026-09-07 09:00:00');
    insertThread(conv, 98122, 'reply', 'Here is the explanation of the proration.', '2026-09-07 09:20:00');
    const badChat: QaChatFn = async () => ({ content: 'not json at all', model: 'fake', latencyMs: 1 });
    const qa = new PostResolutionQaService(db, badChat, new FrictionAnalyzer(db));
    const r = await qa.computeAiLayer(conv);
    expect(r.ai).toBeNull();
    expect(r.error).toContain('unparseable');
    expect(qa.get(conv)?.deterministic).not.toBeNull();
  });
});

describe('knowledge gap engine (Phase 26)', () => {
  it('creates candidates from repeated questions without coverage and preserves human decisions across rebuilds', () => {
    // Two conversations with the same primary question, no knowledge docs.
    const q = 'how do i reset my two factor authentication';
    for (const [i, remote] of [9821, 9822].entries()) {
      const conv = insertConversation(remote, 120 + i, 1, `2026-09-1${i + 2} 09:00:00`, true);
      insertThread(conv, remote * 10 + 1, 'customer', 'How do I reset my two factor authentication?', `2026-09-1${i + 2} 09:00:00`);
      db.prepare(
        `INSERT INTO ai_runs (type, conversation_id, status, output, created_at) VALUES ('ticket_analysis', ?, 'completed', ?, datetime('now'))`
      ).run(conv, JSON.stringify({ primary_question: q }));
    }
    const gaps = new KnowledgeGapService(db);
    const r = gaps.rebuild(90);
    expect(r.candidates).toBeGreaterThan(0);
    const uncovered = (db.prepare("SELECT * FROM knowledge_candidates WHERE kind = 'repeated_question_uncovered' AND question = ?").get(q) as Row | undefined);
    expect(uncovered).toBeDefined();
    expect(Number(uncovered!.occurrence_count)).toBe(2);

    // Human decision survives the rebuild.
    const id = Number(uncovered!.id);
    expect(gaps.decide(id, 'approved', 'document it', null)?.status).toBe('approved');
    gaps.rebuild(90);
    const after = (db.prepare('SELECT status FROM knowledge_candidates WHERE id = ?').get(id) as { status: string });
    expect(after.status).toBe('approved');
    // decide() on an already-decided candidate is a clean no-op (409 shape)
    expect(gaps.decide(id, 'rejected', null, null)).toBeNull();
  });

  it('returns a draft outline with evidence conversations and never publishes', () => {
    const gaps = new KnowledgeGapService(db);
    gaps.rebuild(90);
    const first = (db.prepare("SELECT id FROM knowledge_candidates WHERE status = 'candidate' LIMIT 1").get() as { id: number } | undefined);
    if (first) {
      const draft = gaps.draft(first.id);
      expect(draft).not.toBeNull();
      expect(draft!.suggested_outline.length).toBeGreaterThanOrEqual(3);
      expect(draft!.note).toContain('never');
    }
    // no knowledge document ever appeared
    const docs = (db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get() as { n: number }).n;
    expect(docs).toBe(0);
  });

  it('flags conflicting knowledge document pairs', () => {
    db.prepare("INSERT INTO knowledge_sources (name, kind) VALUES ('Help Center', 'local_file')").run();
    db.prepare("INSERT INTO knowledge_documents (source_id, title, content) VALUES (1, 'Resetting two factor authentication steps', 'content a')").run();
    db.prepare("INSERT INTO knowledge_documents (source_id, title, content) VALUES (1, 'Resetting two factor authentication backup', 'content b')").run();
    const gaps = new KnowledgeGapService(db);
    gaps.rebuild(90);
    const conflicting = (db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates WHERE kind = 'conflicting_knowledge'").get() as { n: number }).n;
    expect(conflicting).toBeGreaterThan(0);
  });
});

describe('translation service (Phase 30)', () => {
  it('translates through the local model, caches by content hash, and refuses unknown languages', async () => {
    let calls = 0;
    const fakeChat: TranslateChatFn = async (opts) => {
      calls++;
      const system = opts.messages[0]!.content;
      expect(system).toContain('VERBATIM');
      return { content: `Bonjour ${opts.messages[1]!.content}`, model: 'fake-translate', latencyMs: 1 };
    };
    const t = new TranslationService(db, fakeChat);
    const r1 = await t.translate({ text: 'Hello, my account is broken', from: 'en', to: 'fr', purpose: 'customer_inbound' });
    expect(r1.translated_text).toContain('Bonjour');
    expect(r1.cached).toBe(false);
    expect(r1.note).toContain('no cloud');
    const r2 = await t.translate({ text: 'Hello, my account is broken', from: 'en', to: 'fr', purpose: 'customer_inbound' });
    expect(r2.cached).toBe(true);
    expect(calls).toBe(1); // cache hit never re-runs the model
    await expect(t.translate({ text: 'x', from: 'en', to: 'xx' })).rejects.toThrow('Unsupported target language');
    await expect(t.translate({ text: 'Hello', from: 'en', to: 'en' })).rejects.toThrow('nothing to translate');
  });

  it('detects the source language when from is auto and refuses honest unknown', async () => {
    const fakeChat: TranslateChatFn = async (opts) => ({ content: `Translated: ${opts.messages[1]!.content}`, model: 'fake', latencyMs: 1 });
    const t = new TranslationService(db, fakeChat);
    const r = await t.translate({ text: 'Hola, no puedo entrar en mi cuenta de usuario desde ayer', to: 'en' });
    expect(r.source_lang).toBe('es');
    expect(r.detected?.code).toBe('es');
    await expect(t.translate({ text: 'zzz qqxxx vvv', to: 'en' })).rejects.toThrow('could not be detected');
  });

  it('reports honest unavailability when the chat fn is null (AI disabled)', async () => {
    const t = new TranslationService(db, null);
    await expect(t.translate({ text: 'Hello', to: 'fr' })).rejects.toThrow('AI is disabled');
  });
});

describe('advanced segmentation conditions (Phase 31)', () => {
  it('evaluates organization, incident, campaign, health, custom-object, customer-event and issue conditions deterministically', () => {
    const engine = new SegmentEngine(db);
    // org property: standard field
    const orgName = engine.preview({ combinator: 'all', conditions: [{ kind: 'organization_property', field: 'name', op: 'contains', value: 'Compute' }], exclude: [] });
    expect(orgName.matched).toBe(2); // both customers belong to Compute Inc
    // incident exposure
    const conv = insertConversation(9831, 130, 1, '2026-09-20 09:00:00');
    db.prepare("INSERT INTO incidents (code, title, status) VALUES ('INC-900', 'Outage', 'investigating')").run();
    db.prepare('INSERT INTO incident_conversations (incident_id, conversation_id) VALUES (1, ?)').run(conv);
    const exposed = engine.preview({ combinator: 'all', conditions: [{ kind: 'incident_exposure', incidentId: 1 }], exclude: [] });
    expect(exposed.matched).toBe(1);
    const anyActive = engine.preview({ combinator: 'all', conditions: [{ kind: 'incident_exposure' }], exclude: [] });
    expect(anyActive.matched).toBe(1);
    // campaign history: not_received complement
    db.prepare("INSERT INTO outreach_campaigns (name, subject, body, status) VALUES ('M5 campaign', 'hi', 'body', 'completed')").run();
    db.prepare("INSERT INTO outreach_recipients (campaign_id, customer_local_id, email, state, sent_at) VALUES (1, 1, 'ada@example.com', 'sent', '2026-09-18 09:00:00')").run();
    const received = engine.preview({ combinator: 'all', conditions: [{ kind: 'campaign_history', relation: 'received' }], exclude: [] });
    expect(received.matched).toBe(1);
    const notReceived = engine.preview({ combinator: 'all', conditions: [{ kind: 'campaign_history', relation: 'not_received' }], exclude: [] });
    expect(notReceived.matched).toBe(1); // Grace only
    // support health: no ratings yet -> avg_rating IS NULL -> not selected by gte
    const healthy = engine.preview({ combinator: 'all', conditions: [{ kind: 'support_health', metric: 'avg_rating', op: 'gte', value: 4 }], exclude: [] });
    expect(healthy.matched).toBe(0);
    db.prepare("INSERT INTO ratings (remote_id, customer_local_id, conversation_id, rating, remote_created_at) VALUES (601, 1, ?, 'great', '2026-09-19 09:00:00')").run(conv);
    const healthy2 = engine.preview({ combinator: 'all', conditions: [{ kind: 'support_health', metric: 'avg_rating', op: 'gte', value: 4 }], exclude: [] });
    expect(healthy2.matched).toBe(1);
    // custom object link
    db.prepare("INSERT INTO custom_object_types (name, slug) VALUES ('Account', 'account')").run();
    db.prepare("INSERT INTO custom_objects (type_id, title) VALUES (1, 'Acme account')").run();
    db.prepare("INSERT INTO custom_object_links (object_id, target_kind, target_local_id) VALUES (1, 'customer', 1)").run();
    const linked = engine.preview({ combinator: 'all', conditions: [{ kind: 'custom_object_link', typeId: 1 }], exclude: [] });
    expect(linked.matched).toBe(1);
    // customer event
    db.prepare("INSERT INTO customer_events (customer_local_id, event_kind, title, dedup_key) VALUES (1, 'rating', 'rated', 'evt-1')").run();
    const withEvent = engine.preview({ combinator: 'all', conditions: [{ kind: 'customer_event', eventKind: 'rating' }], exclude: [] });
    expect(withEvent.matched).toBe(1);
    // history_issue
    db.prepare('INSERT INTO known_issues (title) VALUES (\'Export bug\')').run();
    db.prepare('INSERT INTO known_issue_conversations (known_issue_id, conversation_id) VALUES (1, ?)').run(conv);
    const issueCustomers = engine.preview({ combinator: 'all', conditions: [{ kind: 'history_issue', issueKind: 'known_issue', op: 'gte', value: 1 }], exclude: [] });
    expect(issueCustomers.matched).toBe(1);
  });

  it('applies ticket custom-field and channel filters on the SAME conversation', () => {
    const engine = new SegmentEngine(db);
    db.prepare("INSERT INTO inbox_fields (remote_id, mailbox_id, name, type) VALUES (701, 1, 'Priority', 'dropdown')").run();
    const convA = insertConversation(9841, 140, 1, '2026-09-21 09:00:00');
    const convB = insertConversation(9842, 141, 2, '2026-09-21 09:30:00');
    db.prepare("INSERT INTO conversation_fields (conversation_id, field_local_id, value, text_value) VALUES (?, 1, 'high', 'high')").run(convA);
    db.prepare("INSERT INTO conversation_fields (conversation_id, field_local_id, value, text_value) VALUES (?, 1, 'low', 'low')").run(convB);
    db.prepare("UPDATE conversations SET source_type = 'email' WHERE id = ?").run(convA);
    const r = engine.preview({
      combinator: 'all',
      conditions: [{ kind: 'ticket', customFields: [{ fieldLocalId: 1, op: 'equals', value: 'high' }], channel: 'email' }],
      exclude: []
    });
    expect(r.matched).toBe(1); // only the customer of convA
    // unknown field id matches NOTHING (safe deny)
    const denied = engine.preview({ combinator: 'all', conditions: [{ kind: 'ticket', customFields: [{ fieldLocalId: 999, op: 'equals', value: 'x' }] }], exclude: [] });
    expect(denied.matched).toBe(0);
    expect(denied.notes.some((n) => n.includes('does not exist'))).toBe(true);
  });
});

describe('report builder (Phase 33)', () => {
  it('catalog exposes definitions for every metric and runs a grouped query with a comparison range', () => {
    const builder = new ReportBuilderService(db);
    const catalog = builder.catalog();
    expect(catalog.metrics.length).toBeGreaterThanOrEqual(19);
    expect(catalog.origin).toBe('local');
    const result = builder.run({
      metric: 'conversations',
      dimension: 'none',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      comparison: 'previous_period',
      filters: {},
      sort: 'metric_desc',
      limit: 50
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.value).toBeGreaterThanOrEqual(1);
    expect(result.comparison_rows).not.toBeNull();
    expect(result.notes.join(' ')).toContain('definition');
    expect(result.origin).toBe('local');
  });

  it('rejects unknown metrics, missing attribute keys and bad states with clean errors', () => {
    const builder = new ReportBuilderService(db);
    expect(() => builder.run({ metric: 'conversations; DROP TABLE', dimension: 'none', dateFrom: '2026-09-01', dateTo: '2026-09-02', comparison: 'none', filters: {}, sort: 'metric_desc', limit: 5 })).toThrow('Unknown metric');
    expect(() => builder.run({ metric: 'ai_attribute_share', dimension: 'none', dateFrom: '2026-09-01', dateTo: '2026-09-02', comparison: 'none', filters: {}, sort: 'metric_desc', limit: 5 })).toThrow('attribute key');
    expect(() => builder.run({ metric: 'avg_state_hours', dimension: 'none', dateFrom: '2026-09-01', dateTo: '2026-09-02', comparison: 'none', filters: { stateKey: 'no-such-state' }, sort: 'metric_desc', limit: 5 })).toThrow('does not exist');
    // campaign metrics are total-only
    expect(() => builder.run({ metric: 'campaign_sent', dimension: 'day', dateFrom: '2026-09-01', dateTo: '2026-09-02', comparison: 'none', filters: {}, sort: 'metric_desc', limit: 5 })).toThrow('no grouping');
  });

  it('runs ai_attribute_share against the closed catalog with unknown-as-blank semantics', () => {
    const builder = new ReportBuilderService(db);
    const r = builder.run({
      metric: 'ai_attribute_share',
      dimension: 'none',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      comparison: 'none',
      filters: { attributeKey: 'urgency' },
      sort: 'metric_desc',
      limit: 5
    });
    // Blank value = "is unknown": with no attribute rows at all, every
    // conversation is unknown, so the share is honestly 1.0 (100%).
    expect(r.rows[0]!.value).toBe(1);
    expect(r.notes.join(' ')).toContain('unknown');
  });

  it('saves, lists and deletes report definitions', () => {
    const builder = new ReportBuilderService(db);
    const saved = builder.saveSaved('Test report', { metric: 'conversations', dimension: 'day', dateFrom: '2026-09-01', dateTo: '2026-09-02', comparison: 'none', filters: {}, sort: 'dimension_asc', limit: 10 });
    expect(builder.listSaved().some((s) => s.id === saved.id && s.name === 'Test report')).toBe(true);
    expect(builder.deleteSaved(saved.id)).toBe(true);
    expect(builder.deleteSaved(saved.id)).toBe(false);
  });
});
