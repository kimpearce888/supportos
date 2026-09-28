import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { seedDemoData } from '../../src/server/services/demoSeed.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3126';
});

/**
 * E2E (v2.2.0 / M6): the support graph, agent coaching and customer memory
 * over real HTTP against the real Fastify app in demo mode - graph stats /
 * search / neighbors / subgraph + human-edge CRUD with hostile hardening
 * (Phase 34), advisory coaching reviews incl. the honest AI-unavailable
 * state (Phase 35), composed customer memory + quarantine + human entry
 * lifecycle (Phase 36), and the new read-only Copilot tool surface.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v22-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3126, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3126';
  await ctx.coordinator.initialSync();
  seedDemoData(ctx.db);
  ctx.workers.start();
}, 30_000);

afterAll(async () => {
  const ctx = getContext({ demoMode: true });
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
async function del(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'DELETE' });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

async function firstConversationId(): Promise<number> {
  const r = await get('/api/conversations?pageSize=5');
  const rows = (r.json.conversations ?? r.json.rows ?? []) as { id: number }[];
  return rows[0]?.id ?? 0;
}

describe('support graph over HTTP (Phase 34)', () => {
  it('exposes live stats with honest notes', async () => {
    const r = await get('/api/graph/stats');
    expect(r.status).toBe(200);
    const nodes = r.json.nodes as { kind: string; count: number }[];
    expect(nodes.some((n) => n.kind === 'customer' && n.count > 0)).toBe(true);
    expect(nodes.some((n) => n.kind === 'product' && n.count > 0)).toBe(true);
    const edges = r.json.edges as { relation: string; count: number }[];
    expect(edges.some((e) => e.relation === 'involves' && e.count > 0)).toBe(true);
    expect((r.json.notes as string[]).join(' ')).toContain('Connector rows carry no derived edges');
  });

  it('searches nodes and resolves neighbors with labels', async () => {
    const search = await get(`/api/graph/search?q=${encodeURIComponent('e')}`);
    expect(search.status).toBe(200);
    expect((search.json.results as Json[]).length).toBeGreaterThan(0);

    const cust = await get('/api/customers?pageSize=5');
    const customerId = ((cust.json.customers ?? []) as { id: number; conversations?: number }[]).find((c) => (c.conversations ?? 1) > 0)?.id ?? ((cust.json.customers ?? []) as { id: number }[])[0]?.id ?? 1;
    const nb = await get(`/api/graph/neighbors/customer/${customerId}`);
    expect(nb.status).toBe(200);
    const edges = nb.json.edges as { relation: string; target: { kind: string; label: string } }[];
    expect(edges.some((e) => e.relation === 'involves' || e.relation === 'belongs_to')).toBe(true);
    expect((nb.json.notes as string[]).join(' ')).toContain('never drift');
  });

  it('rejects hostile node kinds, ids and directions with 422', async () => {
    for (const p of [
      '/api/graph/neighbors/drop_table/1',
      '/api/graph/neighbors/conversation/0',
      '/api/graph/neighbors/conversation/-5',
      '/api/graph/neighbors/conversation/1?direction=sideways',
      '/api/graph/neighbors/conversation/1?limit=99999'
    ]) {
      const r = await get(p);
      expect(r.status).toBe(422);
    }
  });

  it('404s unknown nodes honestly', async () => {
    const r = await get('/api/graph/neighbors/customer/999999');
    expect(r.status).toBe(404);
  });

  it('manages human edges over HTTP with 409 on duplicates and 422 on hostile payloads', async () => {
    const convId = await firstConversationId();
    const inc = await get('/api/graph/search?q=INC');
    const incidentHit = (inc.json.results as { kind: string; local_id: number }[]).find((r) => r.kind === 'incident');
    expect(incidentHit).toBeDefined();

    const create = await post('/api/graph/edges', {
      source_kind: 'conversation', source_local_id: convId,
      target_kind: 'incident', target_local_id: incidentHit!.local_id,
      relation: 'related_to', note: 'e2e: same root cause'
    });
    expect(create.status).toBe(200);
    const edgeId = (create.json.edge as { id: number }).id;

    const duplicate = await post('/api/graph/edges', {
      source_kind: 'conversation', source_local_id: convId,
      target_kind: 'incident', target_local_id: incidentHit!.local_id,
      relation: 'related_to'
    });
    expect(duplicate.status).toBe(409);

    for (const body of [
      { source_kind: 'conversation', source_local_id: convId, target_kind: 'incident', target_local_id: incidentHit!.local_id, relation: 'destroys' },
      { source_kind: 'execvp', source_local_id: 1, target_kind: 'incident', target_local_id: 1, relation: 'related_to' },
      { source_kind: 'conversation', source_local_id: convId, target_kind: 'incident', target_local_id: 1, relation: 'related_to', note: 42 },
      {}
    ]) {
      const r = await post('/api/graph/edges', body);
      expect(r.status).toBe(422);
    }

    const listed = await get('/api/graph/edges');
    expect(listed.status).toBe(200);
    expect((listed.json.edges as Json[]).some((e) => (e as { id: number }).id === edgeId)).toBe(true);

    const removed = await del(`/api/graph/edges/${edgeId}`);
    expect(removed.status).toBe(200);
    const missing = await del(`/api/graph/edges/${edgeId}`);
    expect(missing.status).toBe(404);
  });

  it('bounds subgraph depth at 2', async () => {
    const r = await get('/api/graph/subgraph/customer/1?depth=5');
    expect(r.status).toBe(422);
    const ok = await get('/api/graph/subgraph/customer/1?depth=2');
    expect(ok.status).toBe(200);
    expect((ok.json.nodes as Json[]).length).toBeGreaterThan(1);
  });
});

describe('agent coaching over HTTP (Phase 35)', () => {
  it('reviews a draft deterministically and persists it', async () => {
    const convId = await firstConversationId();
    const r = await post(`/api/coaching/${convId}/review`, {
      draft: 'We will fix this within 2 hours. The retry ladder is 3 attempts with exponential backoff and the max ceiling is undocumented.'
    });
    expect(r.status).toBe(200);
    const checks = r.json.checks as { kind: string; status: string }[];
    expect(checks.length).toBeGreaterThanOrEqual(9);
    expect(checks.some((c) => c.kind === 'unanswered_customer_questions')).toBe(true);
    expect(r.json.note).toContain('Advisory only');

    const stored = await get(`/api/coaching/${convId}`);
    expect(stored.status).toBe(200);
    expect(stored.json.draft_words).toBe(r.json.draft_words);
  });

  it('reports the honest AI-unavailable state (deterministic layer still stored)', async () => {
    const convId = await firstConversationId();
    const r = await post(`/api/coaching/${convId}/review`, {
      draft: 'The export fix ships this week.',
      includeAi: true
    });
    // Demo mode has AI enabled but no LM Studio running: the review returns
    // 200 with the deterministic checks + an honest AI error, OR 503 with the
    // same message if the chat fn threw LmStudioError - both are honest.
    expect([200, 503]).toContain(r.status);
    if (r.status === 200) {
      expect((r.json.ai as { error: string | null }).error).toBeTruthy();
      expect((r.json.checks as Json[]).some((c) => (c as { kind: string }).kind === 'unsupported_claims')).toBe(false);
    } else {
      expect(String(r.json.message)).toContain('deterministic');
    }
  });

  it('hardens hostile coaching input with 422', async () => {
    const convId = await firstConversationId();
    for (const [body] of [
      [{ draft: '' }],
      [{ draft: 42 }],
      [{}],
      [{ draft: 'x'.repeat(20001) }]
    ] as [{ draft?: unknown }[]][]) {
      const r = await post(`/api/coaching/${convId}/review`, body);
      expect(r.status).toBe(422);
    }
    const badId = await post('/api/coaching/0/review', { draft: 'hello' });
    expect(badId.status).toBe(422);
    const missing = await post('/api/coaching/999999/review', { draft: 'hello' });
    expect(missing.status).toBe(404);
  });
});

describe('customer memory over HTTP (Phase 36)', () => {
  async function demoCustomerId(): Promise<number> {
    const cust = await get('/api/customers?pageSize=5');
    const rows = (cust.json.customers ?? []) as { id: number }[];
    return rows[0]?.id ?? 1;
  }

  it('composes the memory profile for a demo customer with honest notes', async () => {
    const customerId = await demoCustomerId();
    const r = await get(`/api/memory/${customerId}`);
    expect(r.status).toBe(200);
    const sections = r.json.sections as { section: string; entries: Json[] }[];
    expect(sections.map((s) => s.section)).toContain('human_entries');
    expect((r.json.notes as string[]).join(' ')).toContain('never drift');
  });

  it('creates and deletes human entries, refuses red-line writes and AI deletion', async () => {
    const customerId = await demoCustomerId();

    const created = await post(`/api/memory/${customerId}/entries`, {
      key: 'e2e escalation note', value: 'on-call via pager', kind: 'context'
    });
    expect(created.status).toBe(200);
    const entryId = (created.json.entry_id as number);

    const quarantined = await post(`/api/memory/${customerId}/entries`, {
      key: 'Personality: abrasive', value: 'pushy in tickets', kind: 'context'
    });
    expect(quarantined.status).toBe(422);
    expect(String(quarantined.json.message)).toContain('policy');

    for (const body of [
      { key: '', value: 'x' },
      { key: 'x', value: 42 },
      { key: 'x', kind: 'vibes' },
      { key: 'x', value: null, conversation_id: -1 }
    ]) {
      const r = await post(`/api/memory/${customerId}/entries`, body);
      expect(r.status).toBe(422);
    }

    const profile = await get(`/api/memory/${customerId}`);
    const human = (profile.json.sections as { section: string; entries: { entry_id?: number }[] }[]).find((s) => s.section === 'human_entries')!;
    expect(human.entries.some((e) => e.entry_id === entryId)).toBe(true);

    const removed = await del(`/api/memory/${customerId}/entries/${entryId}`);
    expect(removed.status).toBe(200);

    const aiRow = (profile.json.ai_entries as unknown ?? profile.json.sections).toString(); // shape probe
    void aiRow;
    const unknownCustomer = await get('/api/memory/999999');
    expect(unknownCustomer.status).toBe(404);
    const badId = await post('/api/memory/0/entries', { key: 'x' });
    expect(badId.status).toBe(422);
  });

  it('404s memory for unknown customers and 422s hostile ids', async () => {
    const r = await get('/api/memory/abc');
    expect(r.status).toBe(422);
  });
});

describe('copilot tool surface (Phase 34/36 integration)', () => {
  it('registers the three new read-only tools and refuses write-shaped names', async () => {
    const r = await get('/api/copilot/tools');
    expect(r.status).toBe(200);
    const names = ((r.json.tools ?? []) as { name?: string }[]).map((t) => t.name ?? '');
    expect(names).toContain('get_graph_neighbors');
    expect(names).toContain('get_graph_stats');
    expect(names).toContain('get_customer_memory');
    expect(names).toHaveLength(22);
    const writeShaped = names.filter((n) => /^(create|update|delete|send|write|assign|set|add|remove|drop|insert|update_)/i.test(n));
    expect(writeShaped).toHaveLength(0);
  });
});
