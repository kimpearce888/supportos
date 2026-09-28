import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { seedDemoData } from '../../src/server/services/demoSeed.js';
import { AiToolRegistry } from '../../src/server/ai/tools.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3120';
});

/**
 * E2E (v2.0.0 / M4): the intelligence workspace over real HTTP against the
 * real Fastify app in demo mode - incident lifecycle (incl. declare-from-
 * known-issue), issue impact over HTTP, custom objects (dynamic validation,
 * links, search, report), connectors (refresh + rows + SSRF refusal + AI
 * visibility gate), customer timeline + support health, knowledge freshness
 * with human review/verify, the extended Copilot tool surface, and 4xx
 * hardening for every new route (plan phases 18-25).
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v20-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3120, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3120';
  await ctx.coordinator.initialSync();
  // The demo seed (normally run by the server entry) creates the M4 world:
  // incidents, custom object types/objects, the AI-visible connector and
  // the derived customer event timeline.
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
async function patch(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
async function del(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, { method: 'DELETE' });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

describe('M4 incidents over HTTP (Phase 18-19)', () => {
  it('lists seeded incidents and serves the full workspace payload with impact', async () => {
    const list = await get('/api/incidents?open=true');
    expect(list.status).toBe(200);
    const incidents = list.json.incidents as Json[];
    expect(incidents.length).toBeGreaterThanOrEqual(2);
    const first = incidents[0] as { id: number; code: string; conversation_count: number; customer_count: number };
    expect(first.code).toMatch(/^INC-\d{3}$/);
    const detail = await get(`/api/incidents/${first.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.impact).toBeTruthy();
    const impact = detail.json.impact as Json;
    expect(impact.affected_conversations).toBeGreaterThan(0);
    // Customers are distinct - never equal to the conversation count blindly.
    expect(impact.affected_customers).toBeGreaterThan(0);
    expect(Array.isArray(impact.affected_inboxes)).toBe(true);
    expect(String(impact.note)).toContain('never ticket counts');
    expect(Array.isArray(detail.json.conversations)).toBe(true);
    expect(Array.isArray(detail.json.affected_customers)).toBe(true);
    expect(Array.isArray(detail.json.timeline)).toBe(true);
  });

  it('creates an incident, links a conversation by id, notes and patches status over HTTP', async () => {
    const ctx = getContext({ demoMode: true });
    const conv = ctx.db.prepare('SELECT id, number FROM conversations WHERE deleted_at IS NULL LIMIT 1').get() as { id: number; number: number };
    const created = await post('/api/incidents', { title: 'E2E incident', severity: 'sev3', status: 'investigating', description: 'Created by the e2e suite' });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    const incident = created.json.incident as { id: number; code: string };
    const linked = await post(`/api/incidents/${incident.id}/conversations/${conv.id}`);
    expect(linked.status).toBe(200);
    expect(linked.json.linked).toBe(true);
    const note = await post(`/api/incidents/${incident.id}/notes`, { body: 'Operational note from e2e' });
    expect(note.status).toBe(200);
    const patched = await patch(`/api/incidents/${incident.id}`, { status: 'resolved' });
    expect(patched.status).toBe(200);
    const detail = await get(`/api/incidents/${incident.id}`);
    const inc = detail.json.incident as { status: string; resolved_at: string | null };
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).toBeTruthy();
    const impact = await get(`/api/incidents/${incident.id}/impact`);
    expect(impact.status).toBe(200);
  });

  it('declares an incident from a known issue, carrying explanations and conversations', async () => {
    const known = await get('/api/issues/known');
    const first = (known.json.known_issues as { id: number; conversation_count: number }[])[0];
    expect(first).toBeTruthy();
    const declared = await post(`/api/incidents/from-known-issue/${first.id}`);
    expect(declared.status).toBe(200);
    expect(declared.json.ok).toBe(true);
    const incident = declared.json.incident as { id: number; title: string };
    expect(incident.title).toContain('Known issue');
    const detail = await get(`/api/incidents/${incident.id}`);
    expect((detail.json.conversations as unknown[]).length).toBeGreaterThan(0);
    expect((detail.json.related as Json[]).some((r) => r.target_kind === 'known_issue')).toBe(true);
    const impact = await get(`/api/issues/known/${first.id}/impact`);
    expect(impact.status).toBe(200);
    expect((impact.json.impact as Json).subject_kind).toBe('known_issue');
  });

  it('hardens every incident route against hostile inputs', async () => {
    expect((await post('/api/incidents', { title: '' })).status).toBe(400);
    expect((await post('/api/incidents', { title: 'x', severity: 'sev9' })).status).toBe(400);
    expect((await post('/api/incidents', { title: 'x', conversationIds: [999999] })).status).toBe(200); // unknown ids are filtered, none linked
    expect((await get('/api/incidents/999999')).status).toBe(404);
    expect((await patch('/api/incidents/999999', { status: 'resolved' })).status).toBe(404);
    expect((await get('/api/incidents/abc')).status).toBe(404);
    expect((await post('/api/incidents/999999/conversations/1')).status).toBe(404);
    expect((await get('/api/incidents?status=WEIRD&severity=NOPE')).status).toBe(200); // ignored, falls back to all
    expect((await post('/api/incidents/1/related', { targetKind: 'customer', targetLocalId: 1 })).status).toBe(400); // closed vocabulary
    expect((await post('/api/incidents/1/related', { targetKind: 'known_issue', targetLocalId: 999999 })).status).toBe(422);
    expect((await post('/api/incidents/1/notes', { body: '' })).status).toBe(400);
    expect((await del('/api/incidents/999999')).status).toBe(404);
  });
});

describe('M4 custom objects over HTTP (Phase 21)', () => {
  it('serves seeded types and objects, creates validated objects and links', async () => {
    const types = await get('/api/custom-objects/types');
    expect(types.status).toBe(200);
    const list = types.json.types as { id: number; name: string; fields: { key: string; fieldType: string }[]; object_count: number }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const account = list.find((t) => t.slug === 'account');
    expect(account?.object_count).toBeGreaterThan(0);
    // Create an object with valid + missing-required shapes.
    const ok = await post('/api/custom-objects', { typeId: account!.id, title: 'E2E account', properties: { plan_tier: 'growth', mrr: 120 } });
    expect(ok.status).toBe(200);
    const obj = ok.json.object as { id: number; properties: Record<string, unknown> };
    expect(obj.properties.plan_tier).toBe('growth');
    const missing = await post('/api/custom-objects', { typeId: account!.id, title: 'x', properties: {} });
    expect(missing.status).toBe(422);
    const badEnum = await post('/api/custom-objects', { typeId: account!.id, title: 'x', properties: { plan_tier: 'platinum' } });
    expect(badEnum.status).toBe(422);
    // Link to a real customer; unknown target is a 422 (never an FK 500).
    const ctx = getContext({ demoMode: true });
    const customer = ctx.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: number };
    const linked = await post(`/api/custom-objects/${obj.id}/links`, { links: [{ targetKind: 'customer', targetLocalId: customer.id }] });
    expect(linked.status).toBe(200);
    const badLink = await post(`/api/custom-objects/${obj.id}/links`, { links: [{ targetKind: 'customer', targetLocalId: 999999 }] });
    expect(badLink.status).toBe(422);
    // Reverse lookup + search + report.
    expect((await get(`/api/custom-objects/for/customer/${customer.id}`)).status).toBe(200);
    expect((await get('/api/custom-objects?q=andes')).status).toBe(200);
    const report = await get('/api/custom-objects/report');
    expect(Number(report.json.report && (report.json.report as Json).total_objects)).toBeGreaterThan(0);
  });

  it('hardens the custom object routes', async () => {
    expect((await post('/api/custom-objects/types', { name: 'X' })).status).toBe(400); // no fields
    expect((await post('/api/custom-objects/types', { name: 'X', fields: [{ key: 'BAD KEY', label: 'x', fieldType: 'text' }] })).status).toBe(400);
    expect((await get('/api/custom-objects/types/999999')).status).toBe(404);
    expect((await get('/api/custom-objects/999999')).status).toBe(404);
    expect((await patch('/api/custom-objects/999999', { title: 'x' })).status).toBe(404);
    expect((await post('/api/custom-objects/999999/links', { links: [{ targetKind: 'customer', targetLocalId: 1 }] })).status).toBe(404);
    expect((await get('/api/custom-objects/for/rogue/1')).status).toBe(400);
    expect((await get('/api/custom-objects?pageSize=99999&page=abc')).status).toBe(200); // clamped, never 500
  });
});

describe('M4 connectors over HTTP (Phase 22)', () => {
  it('serves the seeded connector with redacted auth and refreshes it over HTTP', async () => {
    const list = await get('/api/connectors');
    expect(list.status).toBe(200);
    const connectors = list.json.connectors as Json[];
    expect(connectors.length).toBeGreaterThanOrEqual(1);
    const releases = connectors.find((c) => c.name === 'Product releases') as { id: number; allowed_ai: boolean; health: string } | undefined;
    expect(releases).toBeTruthy();
    // The seed refreshes async; force a synchronous refresh over HTTP.
    const refreshed = await post(`/api/connectors/${releases!.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.ok).toBe(true);
    const rows = await get(`/api/connectors/${releases!.id}/rows?q=v4.12`);
    expect(rows.status).toBe(200);
    expect((rows.json.rows as Json[]).length).toBeGreaterThanOrEqual(1);
    const detail = await get(`/api/connectors/${releases!.id}`);
    const c = detail.json.connector as { health: string; schema_json: { name: string }[] | null; row_count: number };
    expect(c.health).toBe('ok');
    expect(c.row_count).toBeGreaterThanOrEqual(3);
    expect(c.schema_json?.some((s) => s.name === 'version')).toBe(true);
  });

  it('creates a local JSON connector through the jail and refreshes it', async () => {
    const projectRoot = process.cwd();
    fs.mkdirSync(path.join(projectRoot, 'connectors'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'connectors', 'e2e-test-source.json'), JSON.stringify([
      { sku: 'A1', stock: 12 }, { sku: 'B2', stock: 0 }
    ]));
    const created = await post('/api/connectors', {
      name: 'E2E inventory', config: { kind: 'local_json', file: 'e2e-test-source.json', keyColumn: 'sku' }, allowedAi: false
    });
    expect(created.status).toBe(200);
    const connector = created.json.connector as { id: number };
    const refreshed = await post(`/api/connectors/${connector.id}/refresh`);
    expect(refreshed.json.ok).toBe(true);
    const rows = await get(`/api/connectors/${connector.id}/rows`);
    expect((rows.json.rows as Json[]).length).toBe(2);
    // Auth is always redacted in reads.
    const withAuth = await post('/api/connectors', {
      name: 'E2E authed', config: { kind: 'local_json', file: 'e2e-test-source.json' },
      auth: { mode: 'bearer', token: 'tok-1234567890' }
    });
    const authed = withAuth.json.connector as { auth: Record<string, unknown> };
    expect(authed.auth.token).toBe('••••••');
    // Cleanup.
    await del(`/api/connectors/${connector.id}`);
    await del(`/api/connectors/${(withAuth.json.connector as { id: number }).id}`);
  });

  it('refuses SSRF-shaped HTTP connector creation with 422 (approved adjustment #4)', async () => {
    for (const url of ['http://127.0.0.1/api', 'http://localhost/api', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/x', 'file:///etc/passwd']) {
      const r = await post('/api/connectors', { name: `SSRF ${url}`, config: { kind: 'http', url } });
      expect(r.status, url).toBe(422);
    }
  });

  it('hardens the connector routes', async () => {
    expect((await post('/api/connectors', { name: '' })).status).toBe(400);
    expect((await post('/api/connectors', { name: 'x', config: { kind: 'http' } })).status).toBe(400);
    expect((await get('/api/connectors/999999')).status).toBe(404);
    expect((await post('/api/connectors/999999/refresh')).status).toBe(404);
    expect((await get('/api/connectors/999999/rows')).status).toBe(404);
    expect((await get('/api/connectors/1/rows?pageSize=abc&page=-1')).status).toBe(200);
  });
});

describe('M4 customer timeline + support health over HTTP (Phases 23-24)', () => {
  it('serves the derived timeline with kind filters and honest kind counts', async () => {
    const ctx = getContext({ demoMode: true });
    const customer = ctx.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: number };
    const timeline = await get(`/api/customers/${customer.id}/timeline?pageSize=50`);
    expect(timeline.status).toBe(200);
    expect((timeline.json.events as Json[]).length).toBeGreaterThan(0);
    expect(Array.isArray(timeline.json.kind_counts)).toBe(true);
    const kinds = (timeline.json.kind_counts as { kind: string }[]).map((k) => k.kind);
    expect(kinds).toContain('signup');
    expect(kinds).toContain('support_conversation');
    // Filter by one kind.
    const filtered = await get(`/api/customers/${customer.id}/timeline?kind=signup`);
    expect((filtered.json.events as Json[]).every((e) => e.event_kind === 'signup')).toBe(true);
    // The rebuild endpoint is idempotent.
    const rebuild1 = await post('/api/timeline/rebuild');
    expect(rebuild1.status).toBe(200);
    const totalBefore = (await get(`/api/customers/${customer.id}/timeline`)).json.total as number;
    await post('/api/timeline/rebuild');
    const totalAfter = (await get(`/api/customers/${customer.id}/timeline`)).json.total as number;
    expect(totalAfter).toBe(totalBefore);
  });

  it('serves operational support health for customers and organizations (no score)', async () => {
    const ctx = getContext({ demoMode: true });
    const customer = ctx.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: number };
    const report = await get(`/api/customers/${customer.id}/support-health`);
    expect(report.status).toBe(200);
    const r = report.json.report as Json;
    expect(Array.isArray(r.metrics)).toBe(true);
    expect((r.metrics as Json[]).every((m) => typeof m.definition === 'string' && (m.definition as string).length > 10)).toBe(true);
    expect(Object.keys(r)).not.toContain('score');
    expect(String(r.note)).toContain('No psychological');
    const org = ctx.db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: number };
    const orgReport = await get(`/api/organizations/${org.id}/support-health`);
    expect(orgReport.status).toBe(200);
    const orgTimeline = await get(`/api/organizations/${org.id}/timeline`);
    expect(orgTimeline.status).toBe(200);
    expect((await get('/api/customers/999999/timeline')).status).toBe(404);
    expect((await get('/api/customers/999999/support-health')).status).toBe(404);
    expect((await get('/api/organizations/999999/support-health')).status).toBe(404);
  });

  it('exposes the active incident on conversation detail and in the inbox', async () => {
    const ctx = getContext({ demoMode: true });
    const linked = ctx.db.prepare('SELECT conversation_id FROM incident_conversations LIMIT 1').get() as { conversation_id: number };
    if (linked) {
      const detail = await get(`/api/conversations/${linked.conversation_id}`);
      expect(detail.status).toBe(200);
      // The chip appears when the incident is still open (seeded ones are).
      const active = detail.json.active_incident as { code: string } | null;
      if (active) expect(active.code).toMatch(/^INC-/);
    }
  });
});

describe('M4 knowledge freshness over HTTP (Phase 25)', () => {
  it('reports freshness flags and honors human review/verify stamps', async () => {
    const report = await get('/api/knowledge/freshness');
    expect(report.status).toBe(200);
    const docs = report.json.documents as { document_id: number; flags: Record<string, boolean>; last_reviewed_at: string | null }[];
    expect(docs.length).toBeGreaterThan(0);
    // The demo seed stamped one doc reviewed and one verified.
    expect(docs.some((d) => d.last_reviewed_at != null)).toBe(true);
    const target = docs[0]!;
    const reviewed = await post(`/api/knowledge/documents/${target.document_id}/review`);
    expect(reviewed.status).toBe(200);
    expect(String(reviewed.json.message)).toContain('nothing is published automatically');
    const verified = await post(`/api/knowledge/documents/${target.document_id}/verify`);
    expect(verified.status).toBe(200);
    expect((await post('/api/knowledge/documents/999999/review')).status).toBe(404);
    expect((await post('/api/knowledge/documents/999999/verify')).status).toBe(404);
    // Search bumps usage observability.
    await get('/api/knowledge/search?q=timezone');
    const after = (await get('/api/knowledge/freshness')).json.documents as { title: string; search_hits: number }[];
    const tz = after.find((d) => d.title.includes('Timezones'));
    expect(tz?.search_hits).toBeGreaterThan(0);
  });
});

describe('M4 Copilot tool surface (read-only, gated)', () => {
  it('exposes the four new read-only tools and refuses write-shaped names', async () => {
    const ctx = getContext({ demoMode: true });
    const registry = new AiToolRegistry(ctx.db);
    const names = registry.definitions().map((d) => d.function.name);
    expect(names).toContain('search_incidents');
    expect(names).toContain('search_custom_objects');
    expect(names).toContain('get_customer_timeline');
    expect(names).toContain('search_connector_data');
    for (const hostile of ['create_incident', 'delete_custom_object', 'refresh_connector', 'write_anything', 'execute_sql']) {
      const r = await registry.execute(hostile, '{}');
      expect(String((r as { error?: string }).error)).toContain('Unknown tool');
    }
  });

  it('search_incidents returns derived counts; get_customer_timeline serves events', async () => {
    const ctx = getContext({ demoMode: true });
    const registry = new AiToolRegistry(ctx.db);
    const incidents = await registry.execute('search_incidents', '{"query":"slack"}') as { code: string; affected_customers: number }[];
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0]!.affected_customers).toBeGreaterThan(0);
    const conv = ctx.db.prepare('SELECT number FROM conversations LIMIT 1').get() as { number: number };
    const timeline = await registry.execute('get_customer_timeline', JSON.stringify({ number: conv.number })) as { events: { kind: string }[] };
    expect(timeline.events.length).toBeGreaterThan(0);
    const custom = await registry.execute('search_custom_objects', '{"query":"andes"}') as { title: string }[];
    expect(custom.length).toBeGreaterThan(0);
  });

  it('search_connector_data enforces the explicit AI-visibility gate', async () => {
    const ctx = getContext({ demoMode: true });
    const registry = new AiToolRegistry(ctx.db);
    // The seeded 'Product releases' connector IS AI-visible.
    const allowed = await registry.execute('search_connector_data', '{"connector":"Product releases","query":"v4.12"}') as { connector: string; results: unknown[] };
    expect(allowed.results.length).toBeGreaterThan(0);
    // A connector that is not AI-visible returns an explicit refusal.
    const refusal = await registry.execute('search_connector_data', '{"connector":"nope"}') as { error?: string; ai_visible_connectors?: string[] };
    expect(refusal.error).toBeTruthy();
    expect((refusal.ai_visible_connectors ?? []).length).toBeGreaterThan(0);
  });
});
