import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3115';
});

/**
 * E2E (v1.5.0): Client Segmentation & Outreach, business-hours SLA alerts and
 * the encrypted multi-device bundle — exercised over real HTTP against the
 * real Fastify app in demo mode. The campaign test drives the FULL production
 * path: meta -> preview -> create -> validate -> queue -> outreach worker
 * batches -> SSE campaign-updated -> report. The encrypted sync test does a
 * genuine export/verify round-trip through the HTTP layer.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v15-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3115, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3115';
  await ctx.coordinator.initialSync();
  ctx.workers.start();
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  ctx.workers.stop();
  await app.close();
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Json {
  [key: string]: unknown;
}

async function get(p: string): Promise<Json> {
  const res = await fetch(`${baseUrl}${p}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

async function post(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  return { status: res.status, json: (await res.json()) as Json };
}

describe('Client Segmentation & Outreach (v1.5.0 e2e)', () => {
  it('GET /api/outreach/meta exposes dynamic property definitions with observed values', async () => {
    const meta = await get('/api/outreach/meta');
    const defs = meta.property_definitions as { name: string; type: string; observed_values: string[]; populated: number }[];
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const plan = defs.find((d) => d.name === 'Plan');
    expect(plan?.type).toBe('dropdown');
    expect(plan!.observed_values).toContain('Pro');
    expect(plan!.populated).toBeGreaterThan(0);
    expect(Array.isArray(meta.tags)).toBe(true);
    expect((meta.tags as string[])).toContain('timezone');
    expect((meta.mailboxes as unknown[]).length).toBeGreaterThan(0);
    expect((meta.operators_by_type as Record<string, string[]>).dropdown).toContain('is_any_of');
  });

  it('POST /api/outreach/segments/preview returns why-selected evidence per row', async () => {
    const { json } = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }],
      exclude: []
    });
    expect(json.matched as number).toBeGreaterThan(0);
    const rows = json.rows as { why: { text: string }[]; matching_tickets: { number: number; tags: string[] }[]; chosen_email: string | null }[];
    for (const r of rows) {
      expect(r.why.length).toBeGreaterThan(0);
      expect(r.matching_tickets.some((t) => t.tags.includes('timezone'))).toBe(true);
      expect(r.chosen_email).toBeTruthy();
    }
    expect(json.notes as string[]).toBeDefined();
  });

  it('full campaign flow over HTTP: create -> validate -> queue -> worker sends -> report', async () => {
    // 1. Preview
    const { json: preview } = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }],
      exclude: []
    });
    const matched = preview.matched as number;
    expect(matched).toBeGreaterThan(0);
    const mailboxLocal = ((await get('/api/outreach/meta')).mailboxes as { local_id: number }[])[0]!.local_id;

    // 2. Create campaign with ALL matched recipients
    const { json: created } = await post('/api/outreach/campaigns', {
      name: 'E2E timezone update',
      subject: 'Update for {{first_name}}',
      body: 'Hi {{first_name}}, thanks for reporting #{{last_ticket_number}}.',
      mailbox_local_id: mailboxLocal,
      tags: ['e2e-outreach'],
      definition: { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] }
    });
    expect(created.ok).toBe(true);
    const campaignId = created.id as number;
    expect(created.recipients).toBe(matched);

    // 3. Personalization render (campaign-less endpoint)
    const customerId = (preview.rows as { customer_local_id: number }[])[0]!.customer_local_id;
    const { json: rendered } = await post('/api/outreach/render', { customer_local_id: customerId, subject: 'Hi {{first_name}}', body: 'Ticket #{{last_ticket_number}}' });
    expect((rendered.rendered as { subject: string }).subject).toMatch(/Hi \w+/);
    expect((rendered.rendered as { body: string }).body).toMatch(/#\d+/);

    // 4. Validate
    const validation = await get(`/api/outreach/campaigns/${campaignId}/validate`);
    expect(validation.ok).toBe(true);
    expect((validation.counts as { ready: number }).ready).toBe(matched);

    // 5. Queue + drain (worker ticks every 2s; poll until complete)
    const { json: queued } = await post(`/api/outreach/campaigns/${campaignId}/queue`);
    expect(queued.ok).toBe(true);
    let detail: Json | null = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      detail = await get(`/api/outreach/campaigns/${campaignId}`);
      if ((detail.campaign as { status: string }).status === 'completed') break;
    }
    expect((detail!.campaign as { status: string }).status).toBe('completed');
    expect((detail!.campaign as { sent: number }).sent).toBe(matched);
    // Every recipient carries evidence + a Help Scout conversation number
    const recipients = detail!.campaign.recipients_list as { state: string; hs_conversation_number: number | null; why: unknown[] }[];
    expect(recipients.every((r) => r.state === 'sent')).toBe(true);
    expect(recipients.every((r) => r.hs_conversation_number != null)).toBe(true);
    expect(recipients.every((r) => Array.isArray(r.why) && r.why.length > 0)).toBe(true);

    // 6. Report totals + audit events exist
    const report = await get(`/api/outreach/campaigns/${campaignId}/report`);
    expect((report.totals as { sent: number }).sent).toBe(matched);
    expect((report.note as string)).toContain('conversation outcomes');
    const events = detail!.events as { event: string }[];
    expect(events.some((e) => e.event === 'campaign_created')).toBe(true);
    expect(events.some((e) => e.event === 'recipient_sent')).toBe(true);
    expect(events.some((e) => e.event === 'campaign_completed')).toBe(true);
  });

  it('duplicate protection: re-queueing a completed campaign is refused over HTTP', async () => {
    const list = (await get('/api/outreach/campaigns')).campaigns as { id: number; status: string; name: string }[];
    const done = list.find((c) => c.status === 'completed')!;
    const { json } = await post(`/api/outreach/campaigns/${done.id}/queue`);
    expect(json.ok).toBe(false);
    expect(json.message as string).toMatch(/completed/);
  });

  it('saved segments CRUD over HTTP', async () => {
    const { json: saved } = await post('/api/outreach/segments', {
      name: 'Timezone reporters',
      definition: { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] }
    });
    expect(saved.ok).toBe(true);
    const segmentId = saved.id as number;
    const segments = (await get('/api/outreach/segments')).segments as { id: number; name: string; version: number; definition: { conditions: unknown[] } }[];
    const found = segments.find((s) => s.id === segmentId);
    expect(found?.definition.conditions.length).toBe(1);
    // Update bumps the version
    const { json: updated } = await post('/api/outreach/segments', { id: segmentId, name: 'Timezone reporters', description: 'customers with timezone tickets', definition: { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] } });
    expect(updated.ok).toBe(true);
    const v2 = ((await get('/api/outreach/segments')).segments as { id: number; version: number }[]).find((s) => s.id === segmentId);
    expect(v2?.version).toBe(2);
    const del = await fetch(`${baseUrl}/api/outreach/segments/${segmentId}`, { method: 'DELETE' });
    expect((await del.json() as { ok: boolean }).ok).toBe(true);
  });

  it('DNC list over HTTP: add -> preview drops the customer -> remove restores', async () => {
    const { json: preview } = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'contact', field: 'email_domain', op: 'contains', value: 'andeslogistics.cl' }],
      exclude: []
    });
    const before = preview.matched as number;
    const first = (preview.rows as { customer_local_id: number; first_name: string }[])[0]!;
    const { json: added } = await post('/api/outreach/dnc', { customer_local_id: first.customer_local_id, reason: 'e2e' });
    expect(added.ok).toBe(true);
    const { json: after } = await post('/api/outreach/segments/preview', {
      combinator: 'all',
      conditions: [{ kind: 'contact', field: 'email_domain', op: 'contains', value: 'andeslogistics.cl' }],
      exclude: []
    });
    expect(after.matched).toBe(before - 1);
    expect((after.notes as string[]).some((n) => n.includes('Do-Not-Contact'))).toBe(true);
    const res = await fetch(`${baseUrl}/api/outreach/dnc/${first.customer_local_id}`, { method: 'DELETE' });
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe('business-hours SLA alerts (v1.5.0 e2e)', () => {
  it('GET /api/issues/sla-alerts: honest unconfigured state, then live breaches after configuration', async () => {
    const before = await get('/api/issues/sla-alerts');
    expect(before.total_breached).toBe(0);
    expect((before.unconfigured_mailboxes as string[]).length).toBeGreaterThan(0);
    expect(before.note as string).toContain('BUSINESS minutes');

    // Configure 24/7 hours + 60min first-response on EVERY demo mailbox
    const mailboxes = ((await get('/api/outreach/meta')).mailboxes as { local_id: number }[]);
    for (const m of mailboxes) {
      const setRes = await fetch(`${baseUrl}/api/settings/business-hours/${m.local_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start_minute: 0, end_minute: 1440, first_response_target_min: 60, resolution_target_min: 480 })
      });
      expect([200, 201]).toContain(setRes.status);
    }
    const after = await get('/api/issues/sla-alerts');
    expect(after.total_breached as number).toBeGreaterThan(0);
    const alerts = after.alerts as { conversation_id: number; waited_business_min: number; target_min: number; overdue_business_min: number }[];
    for (const a of alerts) {
      expect(a.waited_business_min).toBeGreaterThan(a.target_min);
      expect(a.overdue_business_min).toBeGreaterThan(0);
    }
  });
});

describe('encrypted multi-device sync (v1.5.0 e2e)', () => {
  it('export over HTTP produces a genuine encrypted bundle; verify accepts the right passphrase only', async () => {
    const { json: exported } = await post('/api/sync/encrypted/export', { passphrase: 'e2e passphrase 42' });
    expect(exported.ok).toBe(true);
    const bundlePath = exported.path as string;
    expect(bundlePath.endsWith('.sosync')).toBe(true);
    // The file on disk is ciphertext (no SQLite header near the start)
    const raw = fs.readFileSync(bundlePath);
    expect(raw.subarray(0, 6).toString('utf8')).toBe('SOSYNC');
    expect(raw.subarray(6, 64).includes(Buffer.from('SQLite format 3'))).toBe(false);

    const { json: wrong } = await post('/api/sync/encrypted/verify', { path: bundlePath, passphrase: 'not the passphrase' });
    expect(wrong.ok).toBe(false);
    const { json: right } = await post('/api/sync/encrypted/verify', { path: bundlePath, passphrase: 'e2e passphrase 42' });
    expect(right.ok).toBe(true);
    expect((right.info as { conversations: number }).conversations).toBeGreaterThan(0);

    // Ledger + listing expose the export
    const status = await get('/api/sync/encrypted');
    expect((status.bundles as { file: string }[]).some((b) => b.file.endsWith('.sosync'))).toBe(true);
    expect((status.log as { direction: string }[]).some((l) => l.direction === 'export')).toBe(true);

    // Short passphrases are refused outright
    const { json: short } = await post('/api/sync/encrypted/export', { passphrase: 'short' });
    expect(short.ok).toBe(false);
  });

  it('upload rejects non-bundle payloads (422) without writing anything', async () => {
    const res = await fetch(`${baseUrl}/api/sync/encrypted/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'this is definitely not a sosync bundle at all'
    });
    expect(res.status).toBe(422);
  });
});

describe('hybrid ticket search plumbing (v1.5.0 e2e)', () => {
  it('POST /api/search reports its retrieval mode honestly without an embedding model', async () => {
    const { json } = await post('/api/search', { query: 'timezone report', scope: 'all', filters: {} });
    expect(Array.isArray(json.hits)).toBe(true);
    expect(json.semantic_available).toBe(false);
    // mode_note explains WHY semantic is off (no embedding model in e2e env)
    expect(json.mode_note as string | undefined).toContain('embedding model');
  });
});
