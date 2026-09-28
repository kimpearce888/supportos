import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { seedDemoData } from '../../src/server/services/demoSeed.js';
import { SegmentSuggestService } from '../../src/server/ai/segmentSuggest.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3125';
});

/**
 * E2E (v2.1.0 / M5): the quality layer over real HTTP against the real
 * Fastify app in demo mode - knowledge gap candidates with human decisions
 * (plan Phase 26), post-resolution QA over the wire incl. the honest
 * AI-unavailable state (Phase 27), response effectiveness (Phase 28),
 * friction overview + rebuild (Phase 29), translation detect/meta + honest
 * no-model refusal (Phase 30), advanced segmentation conditions + the
 * NL->segment suggestion with a fake model through the production
 * constructor (Phase 31), the custom report builder (Phase 33) and 4xx
 * hardening for every new route.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v21-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3125, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3125';
  await ctx.coordinator.initialSync();
  // The demo seed now also derives friction findings, deterministic QA rows
  // and knowledge-gap candidates over the demo world (same code paths a
  // real instance runs on demand).
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

async function firstClosedConversation(): Promise<number> {
  const r = await get('/api/conversations?status=closed&limit=5');
  const rows = (r.json.conversations ?? r.json.rows ?? []) as { id: number }[];
  return rows[0]?.id ?? 0;
}

describe('knowledge gap engine over HTTP (Phase 26)', () => {
  it('exposes the gap report grouped by kind after a rebuild', async () => {
    const rebuild = await post('/api/knowledge/gaps/rebuild', { days: 90 });
    expect(rebuild.status).toBe(200);
    expect(Number(rebuild.json.candidates)).toBeGreaterThan(0);
    const report = await get('/api/knowledge/gaps');
    expect(report.status).toBe(200);
    const kinds = report.json.kinds as Json[];
    expect(kinds).toHaveLength(5);
    expect((report.json.notes as string[]).join(' ')).toContain('nothing is published automatically');
  });

  it('decides a candidate over HTTP and preserves the decision across rebuilds', async () => {
    const report = await get('/api/knowledge/gaps');
    const kinds = report.json.kinds as { candidates: { id: number; status: string }[] }[];
    const candidate = kinds.flatMap((k) => k.candidates).find((c) => c.status === 'candidate');
    expect(candidate).toBeDefined();
    const decide = await post(`/api/knowledge/gaps/candidates/${candidate!.id}/decide`, { decision: 'rejected', note: 'covered already' });
    expect(decide.status).toBe(200);
    expect((decide.json.candidate as Json).status).toBe('rejected');
    // second decision on the same candidate: 409, not a silent overwrite
    const again = await post(`/api/knowledge/gaps/candidates/${candidate!.id}/decide`, { decision: 'approved' });
    expect(again.status).toBe(409);
    // rebuild preserves the decision
    await post('/api/knowledge/gaps/rebuild', { days: 90 });
    const after = await get('/api/knowledge/gaps');
    const still = (after.json.kinds as { candidates: { id: number; status: string }[] }[]).flatMap((k) => k.candidates).find((c) => c.id === candidate!.id);
    expect(still?.status).toBe('rejected');
    // the draft outline never publishes anything
    const draft = await get(`/api/knowledge/gaps/candidates/${candidate!.id}/draft`);
    expect(draft.status).toBe(200);
    expect((draft.json.suggested_outline as string[]).length).toBeGreaterThanOrEqual(3);
    expect(String(draft.json.note)).toContain('never');
  });

  it('4xx hardening: hostile decide payloads and unknown ids', async () => {
    const badDecision = await post('/api/knowledge/gaps/candidates/1/decide', { decision: 'maybe' });
    expect(badDecision.status).toBe(422);
    const unknown = await post('/api/knowledge/gaps/candidates/999999/decide', { decision: 'approved' });
    expect(unknown.status).toBe(409);
    const badId = await post('/api/knowledge/gaps/candidates/not-a-number/decide', { decision: 'approved' });
    expect(badId.status).toBe(422);
    const badDraft = await get('/api/knowledge/gaps/candidates/999999/draft');
    expect(badDraft.status).toBe(404);
  });
});

describe('post-resolution QA over HTTP (Phase 27)', () => {
  it('serves the deterministic layer + friction findings for a closed conversation', async () => {
    const convId = await firstClosedConversation();
    expect(convId).toBeGreaterThan(0);
    const r = await get(`/api/qa/${convId}`);
    expect(r.status).toBe(200);
    const qa = r.json.qa as Json;
    expect(qa.deterministic).toBeDefined();
    expect((qa.deterministic as Json).computed_honestly).toBeDefined();
    expect(Array.isArray(r.json.friction)).toBe(true);
    const analyze = await post(`/api/qa/${convId}/analyze`, {});
    expect(analyze.status).toBe(200);
    expect(analyze.json.ok).toBe(true);
    expect(analyze.json.ai).toBeNull();
  });

  it('reports honest unavailability for the AI layer when the local model is down', async () => {
    const convId = await firstClosedConversation();
    const r = await post(`/api/qa/${convId}/analyze`, { includeAi: true });
    // LM Studio is not running in CI: honest 503, never a fake answer.
    expect([503, 502]).toContain(r.status);
    expect(String((r.json as Json).message)).toMatch(/LM Studio|model|failed/i);
  });

  it('overview reports coverage honestly', async () => {
    const r = await get('/api/qa/overview');
    expect(r.status).toBe(200);
    expect(Number(r.json.closed_conversations)).toBeGreaterThan(0);
    expect(Number(r.json.qa_rows)).toBeGreaterThan(0);
  });

  it('4xx hardening: unknown conversations', async () => {
    expect((await get('/api/qa/999999')).status).toBe(404);
    expect((await post('/api/qa/999999/analyze', {})).status).toBe(404);
    expect((await get('/api/qa/not-a-number')).status).toBe(422);
  });
});

describe('response effectiveness over HTTP (Phase 28)', () => {
  it('serves association-only buckets with notes and sample conversations', async () => {
    const r = await get('/api/reports/effectiveness?days=90');
    expect(r.status).toBe(200);
    const notes = (r.json.notes as string[]).join(' ');
    expect(notes).toContain('ASSOCIATIONS');
    expect(notes).not.toMatch(/\b(causes|because of|leads to)\b/i);
    const buckets = r.json.buckets as Json[];
    if (buckets.length > 0) {
      expect(buckets[0]!.conversations).toBeGreaterThan(0);
      expect(buckets[0]!.sample_conversations).toBeDefined();
    }
  });
});

describe('friction over HTTP (Phase 29)', () => {
  it('serves the overview and rebuilds deterministically (idempotent)', async () => {
    const before = await get('/api/friction/overview?days=90');
    expect(before.status).toBe(200);
    const rebuild = await post('/api/friction/rebuild', {});
    expect(rebuild.status).toBe(200);
    const after = await get('/api/friction/overview?days=90');
    expect(Number(after.json.generated_at)).toBeNaN(); // timestamp is a string
    expect((after.json.notes as string[]).join(' ')).toContain('not judgments');
    // the demo world carries some friction by construction
    const kinds = after.json.kinds as { conversations: number }[];
    expect(kinds.reduce((a, k) => a + k.conversations, 0)).toBeGreaterThan(0);
  });

  it('4xx hardening', async () => {
    expect((await get('/api/friction/999999')).status).toBe(404);
    expect((await get('/api/friction/not-a-number')).status).toBe(422);
  });
});

describe('translation over HTTP (Phase 30)', () => {
  it('meta lists languages and the deterministic detect endpoint classifies text', async () => {
    const meta = await get('/api/translation/meta');
    expect(meta.status).toBe(200);
    expect((meta.json.languages as Json[]).length).toBeGreaterThanOrEqual(18);
    expect(String((meta.json as Json).note)).toContain('nothing is ever sent automatically');
    const detect = await post('/api/translation/detect', { texts: ['Hola, no puedo entrar en mi cuenta', 'Hello there, my account is broken'] });
    expect(detect.status).toBe(200);
    const detections = detect.json.detections as { code: string | null; confidence: string }[];
    expect(detections[0]!.code).toBe('es');
    expect(detections[1]!.code).toBe('en');
  });

  it('conversation languages summary serves per-message detections', async () => {
    const convId = await firstClosedConversation();
    const r = await get(`/api/translation/conversation/${convId}`);
    expect(r.status).toBe(200);
    expect(r.json.primary_language).toBeDefined();
    expect(Array.isArray(r.json.per_message)).toBe(true);
  });

  it('translate reports an honest error with no local model (no cloud fallback)', async () => {
    const r = await post('/api/translation/translate', { text: 'Hello, my account has been broken since yesterday and I need help resetting the password', to: 'fr' });
    expect([503, 502]).toContain(r.status);
    expect(String((r.json as Json).message)).toMatch(/LM Studio|model|Translation/i);
  });

  it('4xx hardening: hostile payloads', async () => {
    expect((await post('/api/translation/detect', { texts: [] })).status).toBe(422);
    expect((await post('/api/translation/detect', { texts: 'not-an-array' })).status).toBe(422);
    expect((await post('/api/translation/translate', { text: 'Hello', to: 'xx' })).status).toBe(422);
    expect((await post('/api/translation/translate', { text: '', to: 'fr' })).status).toBe(422);
    expect((await post('/api/translation/translate', { text: 'a'.repeat(9000), to: 'fr' })).status).toBe(422);
    expect((await get('/api/translation/conversation/999999')).status).toBe(404);
  });
});

describe('advanced segmentation over HTTP (Phase 31 + 32)', () => {
  it('meta exposes the advanced condition catalogs', async () => {
    const meta = await get('/api/outreach/meta');
    expect(meta.status).toBe(200);
    const m = meta.json as Json;
    expect(Array.isArray(m.organization_property_definitions)).toBe(true);
    expect(Array.isArray(m.ticket_custom_fields)).toBe(true);
    expect(Array.isArray(m.issues)).toBe(true);
    expect(Array.isArray(m.incidents)).toBe(true);
    expect(Array.isArray(m.campaigns)).toBe(true);
    expect(Array.isArray(m.custom_object_types)).toBe(true);
    expect(Array.isArray(m.customer_event_kinds)).toBe(true);
    expect(Array.isArray(m.support_health_metrics)).toBe(true);
  });

  it('previews new condition kinds over HTTP (org name, incident exposure, campaign history)', async () => {
    const orgPreview = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'organization_property', field: 'name', op: 'contains', value: 'Andes' }],
      exclude: []
    });
    expect(orgPreview.status).toBe(200);
    expect(Number(orgPreview.json.matched)).toBeGreaterThan(0);

    const incidentPreview = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'incident_exposure' }],
      exclude: []
    });
    expect(incidentPreview.status).toBe(200);
    expect(Number(incidentPreview.json.matched)).toBeGreaterThan(0);

    const notReceived = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'campaign_history', relation: 'not_received' }],
      exclude: []
    });
    expect(notReceived.status).toBe(200);
    // not_received is a complement - result stays unique contacts
    expect(Number(notReceived.json.matched)).toBeGreaterThanOrEqual(0);
  });

  it('NL suggest: fake model proposes, the deterministic engine selects, nothing saves', async () => {
    const ctx = getContext({ demoMode: true });
    const fakeChat = async (): Promise<{ content: string | null; model: string; latencyMs: number }> => ({
      content: JSON.stringify({
        combinator: 'all',
        conditions: [
          { kind: 'contact', field: 'email_domain', op: 'contains', value: 'andes' }
        ],
        exclude: [{ kind: 'campaign_history', relation: 'received' }]
      }),
      model: 'e2e-fake-suggest-model',
      latencyMs: 2
    });
    ctx.segmentSuggest = new SegmentSuggestService(ctx.db, fakeChat);
    const r = await post('/api/outreach/segments/suggest', { request: 'customers of Andes Logistics who never got a campaign' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(String(r.json.model)).toBe('e2e-fake-suggest-model');
    // the deterministic engine executed the selection
    expect(r.json.preview).toBeDefined();
    expect(Number((r.json.preview as Json).matched)).toBeGreaterThan(0);
    const notes = (r.json.notes as string[]).join(' ');
    expect(notes).toContain('deterministic segment engine selected');
    // nothing was saved: the saved-segments list does not grow
    const segments = await get('/api/outreach/segments');
    const names = ((segments.json.segments as Json[]).map((s) => String(s.name)));
    expect(names.some((n) => n.includes('Andes'))).toBe(false);
  });

  it('NL suggest refuses hostile/invalid model output honestly', async () => {
    const ctx = getContext({ demoMode: true });
    const evilChat = async (): Promise<{ content: string | null; model: string; latencyMs: number }> => ({
      content: JSON.stringify({ combinator: 'all', conditions: [{ kind: 'drop_table', op: 'x' }], exclude: [] }),
      model: 'evil',
      latencyMs: 1
    });
    ctx.segmentSuggest = new SegmentSuggestService(ctx.db, evilChat);
    const r = await post('/api/outreach/segments/suggest', { request: 'everyone' });
    expect(r.status).toBe(422);
    expect(String((r.json as Json).message)).toContain('failed validation');
  });

  it('4xx hardening: hostile trees and short requests', async () => {
    expect((await post('/api/outreach/segments/suggest', { request: 'hi' })).status).toBe(422);
    const hostile = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'organization_property', field: 'name; DROP TABLE customers', op: 'contains', value: "' OR 1=1 --" }],
      exclude: []
    });
    expect(hostile.status).toBe(200);
    expect(Number(hostile.json.matched)).toBe(0); // injected values match nothing
    // regression lock (audit M find): an unknown issueKind must match NOTHING
    // (safe deny), never fall through to a default link table.
    const badIssueKind = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'history_issue', issueKind: 'explode', op: 'gte', value: 1 }],
      exclude: []
    });
    expect(badIssueKind.status).toBe(200);
    expect(Number(badIssueKind.json.matched)).toBe(0);
  });
});

describe('custom report builder over HTTP (Phase 33)', () => {
  it('catalog serves every metric with a definition', async () => {
    const r = await get('/api/reports/builder/catalog');
    expect(r.status).toBe(200);
    const metrics = r.json.metrics as { definition: string; limitations: string }[];
    expect(metrics.length).toBeGreaterThanOrEqual(19);
    for (const m of metrics) {
      expect(m.definition.length).toBeGreaterThan(20);
      expect(m.limitations.length).toBeGreaterThan(10);
    }
    expect(String(r.json.origin)).toBe('local');
  });

  it('runs a grouped report with a comparison range over HTTP', async () => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const run = await post('/api/reports/builder/run', {
      metric: 'conversations',
      dimension: 'day',
      dateFrom: from,
      dateTo: to,
      comparison: 'previous_period',
      filters: {},
      sort: 'dimension_asc',
      limit: 40
    });
    expect(run.status).toBe(200);
    const rows = run.json.rows as Json[];
    expect(rows.length).toBeGreaterThan(0);
    expect(run.json.comparison_rows).not.toBeNull();
    expect(String((run.json.notes as string[]).join(' '))).toContain('definition');
    expect(String(run.json.origin)).toBe('local');
  });

  it('saves, runs and deletes a report definition over HTTP', async () => {
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const save = await post('/api/reports/builder/saved', {
      name: 'E2E weekly volume',
      metric: 'conversations',
      dimension: 'none',
      dateFrom: from,
      dateTo: to,
      comparison: 'none',
      filters: {},
      sort: 'metric_desc',
      limit: 10
    });
    expect(save.status).toBe(200);
    const savedId = Number((save.json.saved as Json).id);
    const list = await get('/api/reports/builder/saved');
    expect(((list.json.saved as Json[]).some((s) => Number(s.id) === savedId))).toBe(true);
    expect((await del(`/api/reports/builder/saved/${savedId}`)).status).toBe(200);
    expect((await del(`/api/reports/builder/saved/${savedId}`)).status).toBe(404);
  });

  it('4xx hardening: hostile report configs', async () => {
    const injection = await post('/api/reports/builder/run', {
      metric: 'conversations; DROP TABLE conversations',
      dimension: 'none',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-02'
    });
    expect(injection.status).toBe(422);
    const badDate = await post('/api/reports/builder/run', { metric: 'conversations', dimension: 'none', dateFrom: 'not-a-date', dateTo: '2026-09-02' });
    expect(badDate.status).toBe(422);
    const missing = await post('/api/reports/builder/run', { metric: 'ai_attribute_share', dimension: 'none', dateFrom: '2026-09-01', dateTo: '2026-09-02' });
    expect(missing.status).toBe(422);
    expect((await post('/api/reports/builder/saved', { name: '' })).status).toBe(422);
    expect((await del('/api/reports/builder/saved/not-a-number')).status).toBe(422);
  });
});
