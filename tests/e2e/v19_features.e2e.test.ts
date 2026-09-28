import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { CopilotService, type CopilotChatFn } from '../../src/server/ai/copilot.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3119';
});

/**
 * E2E (v1.9.0 / M3): the Copilot + attribute layer over real HTTP against the
 * real Fastify app in demo mode - attribute compute/snapshot/search/report
 * over HTTP, the LIVE inbox ai-attribute filter (same compiled path as saved
 * views), saved views with ai_attribute conditions, the full Copilot chat loop
 * (deterministic fake chat injected through the same constructor the app uses),
 * AI escalation rules through the automation API, and 4xx hardening for every
 * new route.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v19-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3119, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3119';
  await ctx.coordinator.initialSync();
  ctx.workers.start();
  await post('/api/notifications/sweep');
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  ctx.workers.stop();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 20_000);

interface Json { [k: string]: unknown }

async function get(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
async function post(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
async function patch(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
async function del(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'DELETE' });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

function firstConversation(): { id: number; number: number } {
  const r = get('/api/conversations?pageSize=1');
  // synchronous DB access instead - the list endpoint is async, so query the ctx db directly
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  const row = ctx.db.prepare('SELECT id, number FROM conversations WHERE deleted_at IS NULL ORDER BY number LIMIT 1').get() as { id: number; number: number };
  void r;
  return row;
}

// ---------------- Phase 16: attribute layer over HTTP ----------------

describe('AI attribute layer over HTTP', () => {
  it('exposes the closed catalog with the honest-unknown note', async () => {
    const { status, json } = await get('/api/attributes/catalog');
    expect(status).toBe(200);
    const catalog = json.catalog as { key: string }[];
    expect(catalog.map((c) => c.key)).toHaveLength(14);
    expect(String(json.schema_version)).toBe('attributes_v1');
    expect(String(json.note)).toContain('unknown');
  });

  it('computes a deterministic snapshot via recompute and returns it', async () => {
    const conv = firstConversation();
    const { status, json } = await post(`/api/attributes/conversation/${conv.id}/recompute`, {});
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const snap = json.snapshot as { attributes: { attribute: string; value: string; source: string }[]; unknown: string[] };
    const knownIssue = snap.attributes.find((a) => a.attribute === 'known_issue');
    expect(knownIssue).toBeDefined();
    expect(['true', 'false']).toContain(knownIssue!.value);
    expect(knownIssue!.source).toBe('deterministic');
    expect(snap.unknown).toContain('intent'); // AI is off in e2e -> honest unknown
  });

  it('serves the snapshot, version history, values and the report', async () => {
    const conv = firstConversation();
    const snap = await get(`/api/attributes/conversation/${conv.id}`);
    expect(snap.status).toBe(200);
    expect((snap.json.attributes as unknown[]).length).toBeGreaterThan(0);

    const history = await get(`/api/attributes/conversation/${conv.id}/history/known_issue?limit=10`);
    expect(history.status).toBe(200);
    expect((history.json.history as unknown[]).length).toBeGreaterThanOrEqual(1);

    const values = await get('/api/attributes/values/known_issue');
    expect(values.status).toBe(200);
    expect(Array.isArray(values.json.values)).toBe(true);

    const report = await get('/api/attributes/report');
    expect(report.status).toBe(200);
    const dists = report.json.distributions as { attribute: string; known: number; unknown: number; total_conversations: number }[];
    expect(dists).toHaveLength(14);
    const ki = dists.find((d) => d.attribute === 'known_issue')!;
    expect(ki.known + ki.unknown).toBe(ki.total_conversations);
  });

  it('searches conversations by attribute over HTTP (drill-down parity)', async () => {
    const conv = firstConversation();
    // whatever known_issue value conv has, the drill must include conv for equals
    const snap = await get(`/api/attributes/conversation/${conv.id}`);
    const val = String((snap.json.attributes as { attribute: string; value: string }[]).find((a) => a.attribute === 'known_issue')!.value);
    const drill = await get(`/api/attributes/conversations?attribute=known_issue&op=equals&value=${val}`);
    expect(drill.status).toBe(200);
    const ids = (drill.json.conversations as { conversation_id: number }[]).map((c) => c.conversation_id);
    expect(ids).toContain(conv.id);
    // unknown drill: conversations without a product value (all, while AI is off)
    const unknown = await get('/api/attributes/conversations?attribute=product&op=unknown');
    expect(unknown.status).toBe(200);
    expect((unknown.json.conversations as unknown[]).length).toBeGreaterThan(0);
    // unknown attribute key: honest empty + note, not a 500
    const bad = await get('/api/attributes/conversations?attribute=not_a_key&op=equals&value=x');
    expect(bad.status).toBe(200);
    expect(bad.json.conversations).toEqual([]);
    expect(String(bad.json.note)).toContain('catalog');
  });

  it('hardens every attribute route against hostile input', async () => {
    expect((await get('/api/attributes/conversation/notanumber')).status).toBe(422);
    expect((await get('/api/attributes/conversation/999999')).status).toBe(404);
    expect((await get('/api/attributes/conversation/1/history/not_a_key')).status).toBe(422);
    expect((await get('/api/attributes/values/not_a_key')).status).toBe(422);
    expect((await post('/api/attributes/conversation/999999/recompute', {})).status).toBe(404);
    expect((await post('/api/attributes/conversation/1/recompute', { force: 'yes-please' })).status).toBe(422);
  });
});

// ---------------- Phase 16: live inbox filter + saved views ----------------

describe('Live inbox AI-attribute filter (same compiled path as saved views)', () => {
  it('filters the live inbox by a current attribute value with honest notes', async () => {
    const conv = firstConversation();
    const snap = await get(`/api/attributes/conversation/${conv.id}`);
    const val = String((snap.json.attributes as { attribute: string; value: string }[]).find((a) => a.attribute === 'known_issue')!.value);
    const { status, json } = await get(`/api/conversations?aiAttribute=known_issue&aiAttrValue=${val}&pageSize=100`);
    expect(status).toBe(200);
    const ids = (json.conversations as { id: number }[]).map((c) => c.id);
    expect(ids).toContain(conv.id);
    expect((json.notes as string[]).some((n) => n.includes('AI attribute filter'))).toBe(true);
  });

  it("'equals unknown' finds conversations with no stored value", async () => {
    const { status, json } = await get('/api/conversations?aiAttribute=intent&aiAttrValue=unknown&pageSize=100');
    expect(status).toBe(200);
    expect((json.conversations as unknown[]).length).toBeGreaterThan(0); // AI off: every intent is unknown
  });

  it('composes with other filters and rejects hostile parameters', async () => {
    const both = await get('/api/conversations?aiAttribute=known_issue&aiAttrValue=false&responseState=needs_first_response&pageSize=100');
    expect(both.status).toBe(200);
    expect((await get('/api/conversations?aiAttribute=not_a_key&aiAttrValue=x')).status).toBe(422);
    expect((await get('/api/conversations?aiAttribute=urgency')).status).toBe(422); // missing value
    expect((await get('/api/conversations?aiAttribute=question_count&aiAttrOp=gt&aiAttrValue=many')).status).toBe(422); // numeric op, non-numeric value
    expect((await get('/api/conversations?aiAttribute=urgency&aiAttrOp=gt&aiAttrValue=not-in-vocab')).status).toBe(422); // ordered compare outside vocabulary
  });

  it('saved views can carry ai_attribute conditions and apply them', async () => {
    const created = await post('/api/inbox-views', {
      name: 'e2e-attr-known-issue-false',
      definition: { combinator: 'all', conditions: [{ kind: 'ai_attribute', attribute: 'known_issue', op: 'equals', value: 'false' }] }
    });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    const viewId = (created.json.view as { id: number }).id;
    const applied = await get(`/api/conversations?savedViewId=${viewId}&pageSize=100`);
    expect(applied.status).toBe(200);
    expect((applied.json.conversations as unknown[]).length).toBeGreaterThan(0);
    // save-time compile checks reject hostile view definitions
    const hostile = await post('/api/inbox-views', {
      name: 'e2e-hostile',
      definition: { combinator: 'all', conditions: [{ kind: 'ai_attribute', attribute: 'DROP TABLE', op: 'equals', value: 'x' }] }
    });
    expect([400, 422]).toContain(hostile.status);
    await del(`/api/inbox-views/${viewId}`);
  });
});

// ---------------- Phase 15: Local Copilot over HTTP ----------------

describe('Local Copilot over HTTP (fake local model injected via the same constructor)', () => {
  const fakeChat: CopilotChatFn = async (opts) => {
    const lastIsTool = opts.messages.some((m) => m.role === 'tool');
    if (!lastIsTool) {
      return { content: '', model: 'e2e-fake-model', toolCalls: [{ id: 'c1', name: 'search_conversations', arguments: '{"query": "billing"}' }], latencyMs: 3 };
    }
    return { content: 'I found one similar conversation about billing [1]. This is the evidence-backed answer.', model: 'e2e-fake-model', latencyMs: 4 };
  };

  it('lists the read-only tool definitions with the no-SQL note', async () => {
    const { status, json } = await get('/api/copilot/tools');
    expect(status).toBe(200);
    const tools = json.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('get_conversation_context');
    expect(String(json.note)).toContain('read-only');
  });

  it('chats, cites real tool executions, persists the session and audits the turn', async () => {
    const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
    const conv = ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY number LIMIT 1').get() as { id: number };
    // Inject the deterministic local "model" through the same constructor the app uses.
    ctx.copilot = new CopilotService(ctx.db, ctx.toolRegistry, fakeChat);

    const chat = await post('/api/copilot/chat', { question: 'Have we seen this issue before?', conversationId: conv.id });
    expect(chat.status).toBe(200);
    expect(chat.json.ok).toBe(true);
    expect(chat.json.model).toBe('e2e-fake-model');
    const citations = chat.json.citations as { tool: string; index: number }[];
    expect(citations).toHaveLength(1);
    expect(citations[0]!.tool).toBe('search_conversations');
    const sessionId = (chat.json.session as { id: number }).id;

    const session = await get(`/api/copilot/sessions/${sessionId}`);
    expect(session.status).toBe(200);
    expect((session.json.messages as unknown[]).length).toBeGreaterThanOrEqual(2);

    const audit = ctx.db.prepare("SELECT ai_involvement FROM audit_log WHERE action = 'copilot_chat' ORDER BY id DESC LIMIT 1").get() as { ai_involvement: number };
    expect(Number(audit.ai_involvement)).toBe(1);

    expect((await del(`/api/copilot/sessions/${sessionId}`)).status).toBe(200);
    expect((await get(`/api/copilot/sessions/${sessionId}`)).status).toBe(404);
  });

  it('serves personalized starter questions', async () => {
    const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
    const conv = ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY number LIMIT 1').get() as { id: number };
    const { status, json } = await get(`/api/copilot/starter-questions/${conv.id}`);
    expect(status).toBe(200);
    expect((json.questions as { question: string }[]).map((q) => q.question)).toContain('What is this customer asking?');
  });

  it('hardens copilot routes: 422/404/503, never silent behavior', async () => {
    const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
    ctx.copilot = new CopilotService(ctx.db, ctx.toolRegistry, fakeChat);
    expect((await post('/api/copilot/chat', { question: '' })).status).toBe(422);
    expect((await post('/api/copilot/chat', { question: 'hi', conversationId: 999999 })).status).toBe(404);
    expect((await post('/api/copilot/chat', { question: 'hi', sessionId: 999999 })).status).toBe(404); // client error, not a 503
    expect((await get('/api/copilot/sessions/notanumber')).status).toBe(422);
    expect((await get('/api/copilot/sessions/999999')).status).toBe(404);
    expect((await del('/api/copilot/sessions/999999')).status).toBe(404);
    expect((await get('/api/copilot/starter-questions/999999')).status).toBe(404);
    // AI disabled: honest 503, no pretending
    ctx.setAiEnabled(false);
    const disabled = await post('/api/copilot/chat', { question: 'anything' });
    expect(disabled.status).toBe(503);
    expect(String(disabled.json.message)).toContain('disabled');
    ctx.setAiEnabled(true);
  });
});

// ---------------- Phase 17: AI escalation rules over HTTP ----------------

describe('AI escalation rules over HTTP (approval-tiered, never silent writes)', () => {
  it('creates, enables and fires an AI-attribute escalation rule', async () => {
    const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
    const conv = ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY number LIMIT 1').get() as { id: number };
    await patch('/api/settings', { automation_enabled: true, automation_write_actions_enabled: false });
    await post(`/api/attributes/conversation/${conv.id}/recompute`, {});

    const created = await post('/api/automation/rules', {
      name: 'e2e-known-issue-escalation',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'false', attribute: 'known_issue' }],
      actions: [{ kind: 'manual_review_queue', params: {} }],
      requires_approval: true
    });
    expect(created.status).toBe(200);
    const ruleId = created.json.id as number;

    const enabled = await patch(`/api/automation/rules/${ruleId}`, { enabled: true });
    expect(enabled.status).toBe(200);

    const fired = await post(`/api/automation/rules/${ruleId}/trigger/${conv.id}`);
    expect(fired.status).toBe(200);
    const runs = fired.json.runs as { rule_id: number; status: string }[];
    const mine = runs.find((r) => r.rule_id === ruleId);
    expect(mine?.status).toBe('awaiting_approval'); // review-queue action NEVER auto-executes

    // the rule list shows the ai_attribute condition with its catalog key
    const rules = await get('/api/automation/rules');
    const rule = (rules.json.rules as { id: number; conditions: { field: string; attribute?: string }[] }[]).find((r) => r.id === ruleId);
    expect(rule?.conditions[0]?.field).toBe('ai_attribute');
    expect(rule?.conditions[0]?.attribute).toBe('known_issue');

    await del(`/api/automation/rules/${ruleId}`);
  });

  it('rejects AI conditions that violate the closed vocabulary', async () => {
    const bad = await post('/api/automation/rules', {
      name: 'e2e-bad-rule',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'high' }], // missing attribute key
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: true
    });
    expect(bad.status).toBe(400);
    const badValue = await post('/api/automation/rules', {
      name: 'e2e-bad-rule-2',
      trigger: 'new_conversation',
      conditions: [{ field: 'ai_verification', operator: 'equals', value: 'maybe' }],
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: true
    });
    expect(badValue.status).toBe(400);
  });
});
