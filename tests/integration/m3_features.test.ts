import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';
import { AttributeRepository } from '../../src/server/database/repositories/attributeRepo.js';
import { AiAttributeService } from '../../src/server/ai/attributes.js';
import { CopilotService, type CopilotChatFn } from '../../src/server/ai/copilot.js';
import { AiToolRegistry } from '../../src/server/ai/tools.js';
import { AutomationEngine } from '../../src/server/automation/engine.js';
import { DisabledAiProvider } from '../../src/server/ai/lmStudioProvider.js';
import { automationRuleSchema } from '../../src/shared/schemas.js';
import { COPILOT_MAX_TOOL_ROUNDS } from '../../src/shared/constants.js';

/**
 * v1.9.0 (M3) integration tests: the AI attribute layer's deterministic half
 * (AI off), the read-only Copilot tool loop (deterministic fake chat), the
 * extended tool registry surface, and AI escalation rules over the automation
 * engine (plan phases 15-17).
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let settings: SettingsRepository;
let attributes: AiAttributeService;
let attrRepo: AttributeRepository;
let tools: AiToolRegistry;

function convIdByNumber(number: number): number {
  return Number((db.prepare('SELECT id FROM conversations WHERE number = ?').get(number) as Row).id);
}

function insertConversation(remote: number, number: number, customer: number): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, 'active', 1, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number}`, customer);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

function insertThread(remote: number, convId: number, type: string, body: string, at: string, fromName = 'Ada Lovelace'): void {
  db.prepare(
    `INSERT INTO threads (remote_id, conversation_id, type, state, body_text, from_type, from_name, created_by_customer_id, remote_created_at)
     VALUES (?, ?, ?, 'published', ?, 'customer', ?, 1, ?)`
  ).run(remote, convId, type, body, fromName, at);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  settings = new SettingsRepository(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (401, 'Support', 'support')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name) VALUES (801, 'Ada')").run();

  // World: conversation 201 (urgent customer, 2 questions) and 202 (calm, prior history)
  const convA = insertConversation(9801, 201, 1);
  insertThread(11001, convA, 'customer', 'This is urgent - production is down and customers cannot pay! When will this be fixed? We need this immediately.', '2024-06-01T10:00:00.000Z');
  insertThread(11002, convA, 'customer', 'Please reply as soon as possible, this is an emergency for us. We want to escalate this to your manager right now.', '2024-06-01T10:30:00.000Z');
  const convB = insertConversation(9802, 202, 1);
  insertThread(11003, convB, 'customer', 'Hello! Quick question about the export feature - does it support CSV?', '2024-05-01T09:00:00.000Z');
  const convPrior = insertConversation(9803, 203, 1);
  insertThread(11004, convPrior, 'customer', 'The export feature stopped working yesterday.', '2024-04-01T09:00:00.000Z');
  db.prepare("UPDATE conversations SET status = 'closed', closed_at = '2024-04-05 10:00' WHERE id = ?").run(convPrior);

  attributes = new AiAttributeService(db, new DisabledAiProvider());
  attrRepo = new AttributeRepository(db);
  tools = new AiToolRegistry(db);
});

afterAll(() => {
  closeDatabase();
});

// ---------------- Phase 16: attribute layer (deterministic half) ----------------

describe('AiAttributeService deterministic layer (AI disabled)', () => {
  it('computes a snapshot with zero AI: known_issue is always a known boolean', async () => {
    const convA = convIdByNumber(201);
    const snap = await attributes.compute(convA);
    const knownIssue = snap.attributes.find((a) => a.attribute === 'known_issue');
    expect(knownIssue).toBeDefined();
    expect(knownIssue!.value).toBe('false');
    expect(knownIssue!.source).toBe('deterministic');
    expect(knownIssue!.confidence).toBe('high');
  });

  it('derives observable urgency / escalation signal from real message content', async () => {
    const convA = convIdByNumber(201);
    const snap = await attributes.compute(convA);
    const urgency = snap.attributes.find((a) => a.attribute === 'urgency');
    expect(urgency?.value).toBe('high'); // "URGENT", "as soon as possible" are observable cues
    const escalation = snap.attributes.find((a) => a.attribute === 'escalation_signal');
    expect(escalation?.value).toBe('true'); // "this is costing us money" style expectation mismatch
    const qc = snap.attributes.find((a) => a.attribute === 'question_count');
    expect(qc).toBeDefined();
    expect(Number(qc!.value)).toBeGreaterThanOrEqual(1);
  });

  it('lists every AI-only slot as honest unknown (never fabricated)', async () => {
    const convA = convIdByNumber(201);
    const snap = await attributes.compute(convA);
    // intent/product/feature/issue/response_style have NO deterministic source
    for (const key of ['intent', 'product', 'feature', 'issue', 'response_style']) {
      expect(snap.attributes.find((a) => a.attribute === key)).toBeUndefined();
      expect(snap.unknown).toContain(key);
    }
    expect(snap.unknown).not.toContain('known_issue'); // deterministic slot is known
    expect(snap.unknown).not.toContain('urgency');
  });

  it('recompute is idempotent for identical input and versions history', async () => {
    const convA = convIdByNumber(201);
    const before = attrRepo.history(convA, 'urgency').length;
    await attributes.compute(convA);
    await attributes.compute(convA);
    const current = attrRepo.currentForConversation(convA);
    expect(current.find((a) => a.attribute === 'urgency')?.value).toBe('high');
    // two recomputes -> at least two version rows for urgency
    expect(attrRepo.history(convA, 'urgency').length).toBeGreaterThanOrEqual(before + 2);
  });

  it('compute() rejects unknown conversations', async () => {
    await expect(attributes.compute(999999)).rejects.toThrow('Conversation not found');
  });
});

// ---------------- Phase 15: read-only tool registry ----------------

describe('AiToolRegistry Copilot surface (read-only, redacted, bounded)', () => {
  it('get_conversation_context returns context WITHOUT SQL and with bounded messages', async () => {
    const r = (await tools.execute('get_conversation_context', '{"number": 201}')) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.subject).toBe('Ticket 201');
    expect(Array.isArray(r.messages)).toBe(true);
    expect((r.messages as unknown[]).length).toBe(2);
    expect(String((r.messages as { text: string }[])[0]!.text)).toContain('production is down');
  });

  it('get_customer_history resolves the customer from any of their tickets', async () => {
    const r = (await tools.execute('get_customer_history', '{"number": 201}')) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(Number(r.total_previous_tickets)).toBe(2); // 202 + 203
    const numbers = (r.tickets as { number: number }[]).map((t) => t.number);
    expect(numbers).toContain(202);
    expect(numbers).toContain(203);
  });

  it('get_supportos_metadata exposes ONLY derived local fields', async () => {
    const r = (await tools.execute('get_supportos_metadata', '{"number": 201}')) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.supportos_priority).toBe('none');
    expect(r.known_issue_linked).toBe(false);
    expect(r.note).toContain('local');
  });

  it('get_ai_attributes reports the current local layer with unknown honesty', async () => {
    const convA = convIdByNumber(201);
    await attributes.compute(convA);
    const r = (await tools.execute('get_ai_attributes', '{"number": 201}')) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    const attrs = r.attributes as { attribute: string; value: string }[];
    expect(attrs.find((a) => a.attribute === 'urgency')?.value).toBe('high');
    expect(String(r.note)).toContain('unknown');
  });

  it('unknown tools and malformed arguments return errors, never throw', async () => {
    expect(((await tools.execute('drop_table', '{}')) as { error: string }).error).toContain('Unknown tool');
    expect(((await tools.execute('get_conversation_context', 'not json')) as { error: string }).error).toBeDefined();
    expect(((await tools.execute('get_conversation_context', '{"number": 999999}')) as { error: string }).error).toContain('not found');
  });

  it('tool definitions stay read-only: every definition is a function with parameters, no SQL', () => {
    const defs = tools.definitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('get_conversation_context');
    expect(names).toContain('get_ai_attributes');
    for (const d of defs) {
      expect(d.type).toBe('function');
      expect(JSON.stringify(d)).not.toMatch(/SELECT |DELETE |DROP |INSERT /i);
    }
  });
});

// ---------------- Phase 15: Copilot tool loop ----------------

describe('CopilotService (bounded loop, machine citations, persisted sessions)', () => {
  /** Fake chat that demands one tool call, then answers with an evidence marker. */
  const oneToolChat: CopilotChatFn = async (opts) => {
    const hasTools = (opts.tools ?? []).length > 0;
    const lastIsTool = opts.messages.some((m) => m.role === 'tool');
    if (hasTools && !lastIsTool) {
      return {
        content: '',
        model: 'fake-local-model',
        toolCalls: [{ id: 'call-1', name: 'get_conversation_context', arguments: '{"number": 201}' }],
        latencyMs: 5
      };
    }
    return { content: 'The customer reports the payment page is broken [1]. No other tickets mention this yet.', model: 'fake-local-model', latencyMs: 7 };
  };

  it('answers with machine-generated citations from tools the SERVER executed', async () => {
    const convA = convIdByNumber(201);
    const copilot = new CopilotService(db, tools, oneToolChat);
    const result = await copilot.chat({ question: 'What is this customer asking?', conversationId: convA });
    expect(result.citations.length).toBe(1);
    expect(result.citations[0]!.tool).toBe('get_conversation_context');
    expect(result.citations[0]!.conversation_id).toBe(convA);
    expect(result.assistant_message.content).toContain('[1]');
    expect(result.assistant_message.tool_calls).toBe(1);
    // session + messages persisted: user, tool trace, assistant
    const messages = copilot.listMessages(result.session.id);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages.find((m) => m.role === 'tool')).toBeDefined();
  });

  it('records an ai_run and an audit entry with ai_involvement', async () => {
    const convA = convIdByNumber(201);
    const copilot = new CopilotService(db, tools, oneToolChat);
    await copilot.chat({ question: 'Why is this urgent?', conversationId: convA });
    const run = db.prepare("SELECT type, status, model FROM ai_runs WHERE type = 'copilot_chat' ORDER BY id DESC LIMIT 1").get() as Row;
    expect(run.status).toBe('completed');
    expect(run.model).toBe('fake-local-model');
    const audit = db.prepare("SELECT action, ai_involvement FROM audit_log WHERE action = 'copilot_chat' ORDER BY id DESC LIMIT 1").get() as Row;
    expect(Number(audit.ai_involvement)).toBe(1);
  });

  it('continues an existing session (bounded history replay)', async () => {
    const convA = convIdByNumber(201);
    const copilot = new CopilotService(db, tools, oneToolChat);
    const first = await copilot.chat({ question: 'What is this customer asking?', conversationId: convA });
    const second = await copilot.chat({ question: 'And what solved previous cases?', sessionId: first.session.id });
    expect(second.session.id).toBe(first.session.id);
    const messages = copilot.listMessages(first.session.id);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('hard-stops a model that keeps calling tools (bounded budget, honest answer)', async () => {
    const convA = convIdByNumber(201);
    const endless: CopilotChatFn = async (_opts) => ({
      content: '',
      model: 'looping-model',
      toolCalls: [{ id: `call-${Date.now()}`, name: 'search_conversations', arguments: '{"query": "x"}' }],
      latencyMs: 1
    });
    const copilot = new CopilotService(db, tools, endless);
    const result = await copilot.chat({ question: 'loop forever please', conversationId: convA });
    expect(result.tool_rounds).toBeLessThanOrEqual(COPILOT_MAX_TOOL_ROUNDS);
    expect(result.assistant_message.content.length).toBeGreaterThan(0); // honest fallback text, never empty
  });

  it('starter questions personalize from local facts', () => {
    const convA = convIdByNumber(201);
    const copilot = new CopilotService(db, tools, oneToolChat);
    const qs = copilot.starterQuestions(convA);
    expect(qs.map((q) => q.question)).toContain('What is this customer asking?');
    expect(qs.map((q) => q.question)).toContain('What happened in their previous tickets?'); // 2 prior tickets exist
    expect(copilot.starterQuestions(999999)).toEqual([]);
  });

  it('rejects empty questions and unknown sessions without writing anything', async () => {
    const copilot = new CopilotService(db, tools, oneToolChat);
    await expect(copilot.chat({ question: '   ' })).rejects.toThrow('empty');
    await expect(copilot.chat({ question: 'hi', sessionId: 999999 })).rejects.toThrow('not found');
    await expect(copilot.chat({ question: 'hi', conversationId: 999999 })).rejects.toThrow('not found');
  });
});

// ---------------- Phase 17: AI escalation rules ----------------

describe('AutomationEngine AI conditions (ai_attribute / ai_verification)', () => {
  beforeAll(async () => {
    settings.set('automation_enabled', true);
    settings.set('automation_write_actions_enabled', false);
    await attributes.compute(convIdByNumber(201));
    await attributes.compute(convIdByNumber(202));
  });

  it('high urgency routes to the review queue and ALWAYS requires approval', async () => {
    const convA = convIdByNumber(201);
    const engine = new AutomationEngine(db);
    const ruleId = engine.createRule({
      name: 'High urgency review',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'high', attribute: 'urgency' }],
      actions: [{ kind: 'manual_review_queue', params: {} }],
      requires_approval: true
    });
    const runs = await engine.fireTrigger('new_conversation', convA);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe('awaiting_approval');
    engine.deleteRule(ruleId);
  });

  it('calm tickets do NOT match the urgency rule (recorded as skipped)', async () => {
    const convB = convIdByNumber(202);
    const engine = new AutomationEngine(db);
    engine.createRule({
      name: 'High urgency review 2',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'high', attribute: 'urgency' }],
      actions: [{ kind: 'manual_review_queue', params: {} }],
      requires_approval: true
    });
    const runs = await engine.fireTrigger('new_conversation', convB);
    expect(runs.length).toBe(0); // non-matching rules return no runs...
    const recorded = engine.listRuns(5).find((r) => r.status === 'skipped'); // ...but the skip is recorded
    expect(recorded).toBeDefined();
  });

  it("missing attribute reads as 'unknown': matches equals-unknown, never a concrete value", async () => {
    const convB = convIdByNumber(202);
    const engine = new AutomationEngine(db);
    // intent has no deterministic slot and AI is off -> unknown for convB
    engine.createRule({
      name: 'intent unknown',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'unknown', attribute: 'intent' }],
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: false
    });
    const runs = await engine.fireTrigger('new_conversation', convB);
    expect(runs[0]!.status).toBe('completed'); // read action runs: intent IS unknown
    // and the same rule must NOT match a concrete-value variant
    engine.createRule({
      name: 'intent concrete',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'question', attribute: 'intent' }],
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: false
    });
    const runs2 = await engine.fireTrigger('new_conversation', convB);
    expect(runs2.filter((r) => r.status === 'completed')).toHaveLength(1); // only the unknown rule completed
  });

  it('ai_verification conditions match the latest draft verification outcome', async () => {
    const convB = convIdByNumber(202);
    const engine = new AutomationEngine(db);
    // no drafts -> verification is 'none'
    const ruleId = engine.createRule({
      name: 'verification failed review',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_verification', operator: 'equals', value: 'none' }],
      actions: [{ kind: 'manual_review_queue', params: {} }],
      requires_approval: true
    });
    const runs = await engine.fireTrigger('new_conversation', convB);
    const mine = runs.find((r) => r.rule_id === ruleId);
    expect(mine?.status).toBe('awaiting_approval'); // matched 'none' AND required approval
  });

  it('the route schema rejects ai_attribute conditions missing the catalog key', () => {
    const bad = automationRuleSchema.safeParse({
      name: 'bad',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'high' }], // no attribute key
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: true
    });
    expect(bad.success).toBe(false);
    const badValue = automationRuleSchema.safeParse({
      name: 'bad2',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_verification', operator: 'equals', value: 'maybe' }],
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: true
    });
    expect(badValue.success).toBe(false);
    const good = automationRuleSchema.safeParse({
      name: 'good',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'gte', value: 'moderate', attribute: 'urgency' }],
      actions: [{ kind: 'manual_review_queue', params: {} }],
      requires_approval: true
    });
    expect(good.success).toBe(true);
  });
});
