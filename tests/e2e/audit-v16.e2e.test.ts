import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3116';
});

/**
 * E2E regression tests for the SECOND neutral audit (v1.6.0). Every test names
 * the audit finding it locks down. Boots the real app in demo mode on a custom
 * PORT like the v1.2 audit suite.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;
let _convId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-audit16-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'audit.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'audit.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3116, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3116';
  ctx.workers.start(); // 2s job ticks make write-behind bulk jobs process for real
  await ctx.coordinator.initialSync();
  const list = (await (await fetch(`${baseUrl}/api/conversations`)).json()) as { conversations: { id: number }[] };
  _convId = list.conversations[0]!.id;
});

afterAll(async () => {
  getContext({ dbPath: path.join(tmpDir, 'audit.db'), demoMode: true }).workers.stop();
  await app.close();
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (p: string) => fetch(`${baseUrl}${p}`);

describe('v1.6.0 audit: NaN query params are clamped, not 500s', () => {
  it('?page=abc on customers returns 200 with the fallback page (was SqliteError 500)', async () => {
    const r = await get('/api/customers?page=abc');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { page: number; customers: unknown[] };
    expect(body.page).toBe(1);
    expect(Array.isArray(body.customers)).toBe(true);
  });

  it('?pageSize=xyz on organizations returns 200 (was datatype-mismatch 500)', async () => {
    const r = await get('/api/organizations?pageSize=xyz');
    expect(r.status).toBe(200);
  });

  it('?days=abc on the dashboard and SLA report returns 200 (was RangeError 500)', async () => {
    const dash = await get('/api/analytics/dashboard?days=abc');
    expect(dash.status).toBe(200);
    const sla = await get('/api/reports/sla?days=abc');
    expect(sla.status).toBe(200);
  });

  it('?limit=abc on AI jobs returns 200 (was datatype-mismatch 500)', async () => {
    const r = await get('/api/ai/jobs?limit=abc');
    expect(r.status).toBe(200);
  });

  it('?pageSize=200 on conversations is clamped to 100 so the echo is truthful', async () => {
    const r = await get('/api/conversations?pageSize=200');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { page_size: number };
    expect(body.page_size).toBeLessThanOrEqual(100);
  });
});

describe('v1.6.0 audit: missing/wrong-typed bodies are 422s, not 500s', () => {
  it('POST /api/ai/memory/:id with {} is 422 (was NOT NULL constraint 500)', async () => {
    const r = await post('/api/ai/memory/1', {});
    expect(r.status).toBe(422);
  });

  it('POST /api/onboarding/step with {} is 422 (was NOT NULL constraint 500)', async () => {
    const r = await post('/api/onboarding/step', {});
    expect(r.status).toBe(422);
  });

  it('POST /api/reports/narrative with {} is 422 (was provider 503 with undefined fields)', async () => {
    const r = await post('/api/reports/narrative', {});
    expect(r.status).toBe(422);
  });

  it('POST /api/outreach/campaigns with numeric name is 422 (was name.trim 500)', async () => {
    const r = await post('/api/outreach/campaigns', { name: 123, subject: 'x', body: 'y', mailbox_local_id: 1 });
    expect(r.status).toBe(422);
  });

  it('POST /api/outreach/segments with numeric name is 422 (was name.trim 500)', async () => {
    const r = await post('/api/outreach/segments', { name: 42 });
    expect(r.status).toBe(422);
  });

  it('POST /api/issues/known with numeric title is 422 (a number used to be stored verbatim)', async () => {
    const r = await post('/api/issues/known', { title: 12345 });
    expect(r.status).toBe(422);
  });

  it('POST /api/issues/known/:id/refs with {} is 422 (was silent ok:false 200 with a misleading message)', async () => {
    const r = await post('/api/issues/known/1/refs', {});
    expect(r.status).toBe(422);
  });

  it('PATCH /api/automation/rules/:id validates instead of accepting anything', async () => {
    const r = await fetch(`${baseUrl}/api/automation/rules/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) });
    expect(r.status).toBe(422);
    const r2 = await fetch(`${baseUrl}/api/automation/rules/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(r2.status).toBe(422);
  });

  it('POST /api/demo/simulate-incoming with numeric body is 422 (was text.slice 500)', async () => {
    const r = await post('/api/demo/simulate-incoming', { body: 123 });
    expect(r.status).toBe(422);
  });
});

describe('v1.6.0 audit: hostile inputs', () => {
  it('a 2MB search query is a 422 (was FTS "LIKE or GLOB pattern too complex" 500)', async () => {
    const r = await post('/api/search', { query: 'A'.repeat(2_000_000) });
    expect(r.status).toBe(422);
  });



  it('queue retry/cancel 404 for nonexistent ids (was silent ok:true)', async () => {
    const retry = await post('/api/queue/999999/retry', {});
    expect(retry.status).toBe(404);
    const cancel = await post('/api/queue/999999/cancel', {});
    expect(cancel.status).toBe(404);
    const dnc = await fetch(`${baseUrl}/api/outreach/dnc/999999`, { method: 'DELETE' });
    expect(dnc.status).toBe(404);
  });

  it('knowledge file import rejects paths under data/ (the live SQLite DB lived in the old allowlist)', async () => {
    const r = await post('/api/knowledge/import-file', { path: 'data/supportos.db' });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { message: string };
    expect(body.message).toContain('knowledge-import');
  });
});

describe('v1.6.0 audit: outreach sends land in the mirror immediately', () => {
  it('a sent campaign enqueues the single-conversation sync for the created conversation', async () => {
    // Count sync_conversation jobs before
    const ctx = getContext({ dbPath: path.join(tmpDir, 'audit.db'), demoMode: true });
    const before = (ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'sync_conversation'").get() as { n: number }).n;
    // Queue + send a tiny campaign through the API
    // /api/mailboxes returns a bare array of mailbox objects
    const mailboxes = (await (await get('/api/mailboxes')).json()) as { id: number }[];
    const created = await post('/api/outreach/campaigns', {
      name: 'mirror-sync-probe',
      subject: 'Mirror sync probe',
      body: 'Hello {{first_name}}, probe.',
      mailbox_local_id: mailboxes[0]!.id,
      customer_ids: [],
      definition: { combinator: 'all', conditions: [{ kind: 'contact', field: 'has_email', op: 'is_not_empty' }], exclude: [] }
    });
    const createdBody = (await created.json()) as { ok: boolean; id?: number; recipients?: number };
    expect(created.status).toBe(200);
    const id = createdBody.id ?? (createdBody as { campaign_id?: number }).campaign_id;
    expect(id).toBeTruthy();
    // Queue + run the send synchronously through the service the worker uses
    await post(`/api/outreach/campaigns/${id}/queue`, {});
    const sent = await ctx.campaigns.sendBatch(Number(id));
    expect(sent.sent + sent.failed + sent.unknown).toBeGreaterThan(0);
    const after = (ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'sync_conversation'").get() as { n: number }).n;
    expect(after).toBeGreaterThan(before);
  });
});

describe('v1.6.0 audit (human-like testing): write-behind bulk writes notify clients', () => {
  it('a bulk tag lands and a conversation SSE event follows so the client list can refresh', async () => {
    // Found while using the app like a human: the bulk API acks ("queued"),
    // the client invalidates immediately, races the write-behind job and reads
    // STALE state; nothing re-invalidated once the tag actually landed.
    // Fix: the worker emits conversation-updated after the write completes.
    // This test asserts the event actually reaches the SSE wire.
    const controller = new AbortController();
    const sse = await fetch(`${baseUrl}/api/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readFrames = (): { event: string; data: string }[] => {
      const frames: { event: string; data: string }[] = [];
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (eventLine && dataLine) frames.push({ event: eventLine.slice(7), data: dataLine.slice(6) });
      }
      return frames;
    };
    try {
      const res = await post('/api/conversations/bulk', {
        conversationIds: [_convId],
        action: 'tag',
        params: { tag: 'sse-notify-probe' }
      });
      expect(res.status).toBe(200);
      // worker tick is ~2s; poll the stream up to 10s for the post-write
      // notification (event name 'conversation', payload carries the local id).
      // reader.read() blocks until a frame OR heartbeat arrives; race it against
      // a timer but REUSE the pending read promise - abandoning it would drop
      // the chunk it eventually resolves with.
      let notified = false;
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !notified) {
        if (!pendingRead) pendingRead = reader.read();
        const chunk = await Promise.race([
          pendingRead,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 250))
        ]);
        if (chunk) {
          pendingRead = null;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (const f of readFrames()) {
            if (f.event === 'conversation' && f.data.includes(String(_convId))) notified = true;
          }
        }
      }
      expect(notified).toBe(true);
      // and the tag itself must be on the conversation now
      const detail = (await (await get(`/api/conversations/${_convId}`)).json()) as { conversation: { tags: string[] } };
      expect(detail.conversation.tags).toContain('sse-notify-probe');
    } finally {
      controller.abort();
    }
  }, 20_000);
});

describe('v1.6.0 audit: rate limit keying (runs last - consumes the budget)', () => {
  it('rotating X-Forwarded-For does NOT bypass the mutation rate limit (spoofable header, trustProxy off)', async () => {
    // Fire 310 mutating POSTs with a DIFFERENT spoofed XFF each time; with the
    // old header-keyed limiter all 310 reached the handler. The limiter now
    // keys on the socket address, so these share ONE budget and throttle.
    let throttled = false;
    for (let i = 0; i < 310; i++) {
      const res = await fetch(`${baseUrl}/api/demo/simulate-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.255.${Math.floor(i / 255)}.${i % 255}` },
        body: JSON.stringify({})
      });
      if (res.status === 429) {
        throttled = true;
        break;
      }
      // consume the body to free the socket
      await res.arrayBuffer();
    }
    expect(throttled).toBe(true);
  }, 120_000);
});
