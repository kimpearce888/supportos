import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3114';
});

/**
 * E2E (v1.4.0 roadmap): webhook push for conversations, semantic docs search
 * and per-mailbox SLA reporting — exercised over real HTTP against the real
 * Fastify app in demo mode. The webhook test drives the FULL production path:
 * simulate-webhook -> HMAC self-POST -> persist -> dedup -> sync job (worker
 * tick) -> mirror update -> SSE conversation-updated on the open stream.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v14-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3114, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3114';
  await ctx.coordinator.initialSync();
  ctx.workers.start(); // 2s job ticks make the webhook->sync->SSE path live
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  ctx.workers.stop();
  await app.close();
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read SSE frames incrementally off the open stream. */
async function openSseStream(): Promise<{ read: () => Promise<{ event: string; data: string }[]>; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    read: async () => {
      const frames: { event: string; data: string }[] = [];
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
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
    },
    close: () => controller.abort()
  };
}

describe('webhook push for conversations (v1.4.0)', () => {
  it('a customer-reply webhook lands in the mirror AND on the SSE stream', async () => {
    const sse = await openSseStream();
    await sse.read(); // hello frame

    // Pick a conversation and record its thread count
    const list = (await (await fetch(`${baseUrl}/api/conversations?view=all&pageSize=10`)).json()) as { conversations: { id: number; remote_id: number; thread_count: number; number: number }[] };
    const target = list.conversations[0]!;
    const before = target.thread_count;

    // Push a customer-reply event through the REAL webhook pipeline
    const sim = await fetch(`${baseUrl}/api/demo/simulate-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'convo.customer.reply.created', conversationRemoteId: target.remote_id, replyText: 'Pushed through the webhook pipeline end to end.' })
    });
    expect(sim.status).toBe(200);
    const simBody = (await sim.json()) as { ok: boolean; remoteId?: number };
    expect(simBody.ok).toBe(true);

    // The worker tick (2s) processes the webhook-source sync job; the SSE stream
    // must deliver a conversation event with the webhook reason.
    let sawConversation = false;
    for (let i = 0; i < 8 && !sawConversation; i++) {
      const frames = await sse.read();
      for (const f of frames) {
        if (f.event === 'conversation') {
          const payload = JSON.parse(f.data) as { conversationId: number | null; reason: string };
          expect(payload.reason).toBe('webhook');
          expect(payload.conversationId).toBe(target.id);
          sawConversation = true;
        }
      }
    }
    expect(sawConversation).toBe(true);
    sse.close();

    // ...and the mirror actually gained the thread
    let after = before;
    for (let i = 0; i < 12 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const detail = (await (await fetch(`${baseUrl}/api/conversations/${target.id}`)).json()) as { conversation: { thread_count: number } };
      after = detail.conversation.thread_count;
    }
    expect(after).toBeGreaterThan(before);
  }, 30000);

  it('a created-conversation webhook appears in the list after the worker tick', async () => {
    const sim = await fetch(`${baseUrl}/api/demo/simulate-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'convo.created' })
    });
    expect(sim.status).toBe(200);
    const simBody = (await sim.json()) as { ok: boolean; remoteId: number };
    expect(simBody.ok).toBe(true);

    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const list = (await (await fetch(`${baseUrl}/api/conversations?view=all&pageSize=100`)).json()) as { conversations: { remote_id: number; subject: string }[] };
      found = list.conversations.some((c) => c.remote_id === simBody.remoteId && c.subject.includes('SSO callback rejected'));
    }
    expect(found).toBe(true);
  }, 30000);

  it('rejects invalid simulation payloads with a 422', async () => {
    const bad = await fetch(`${baseUrl}/api/demo/simulate-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'carrier.pigeon' })
    });
    expect(bad.status).toBe(422);
  });

  it('webhook registration is honestly unavailable in demo mode', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://relay.example.com/hook', events: ['convo.created'] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('demo');
  });
});

describe('semantic docs search (v1.4.0)', () => {
  it('hybrid search answers with FTS hits and honest unavailability flags (no embedding model)', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=timezone`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { article: { name: string }; why: string[]; score: number }[]; used_semantic: boolean; semantic_available: boolean; mode_note: string };
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits.some((h) => h.article.name === 'Understanding schedule timezones')).toBe(true);
    expect(body.used_semantic).toBe(false);
    expect(body.semantic_available).toBe(false);
    expect(body.mode_note).toContain('embedding model');
    expect(body.hits.every((h) => h.why.includes('fts'))).toBe(true);
  });

  it('semantic can be explicitly disabled and the note says so', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=invoice&semantic=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode_note: string; hits: unknown[] };
    expect(body.mode_note).toContain('disabled');
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
  });

  it('q is required (422) and validation is sane', async () => {
    const missing = await fetch(`${baseUrl}/api/docs/search`);
    expect(missing.status).toBe(422);
    const badLimit = await fetch(`${baseUrl}/api/docs/search?q=x&limit=999`);
    expect(badLimit.status).toBe(422);
  });

  it('stats surface embedding readiness counters', async () => {
    const stats = (await (await fetch(`${baseUrl}/api/docs/stats`)).json()) as { docs_chunks?: number; docs_chunks_indexed?: number; docs_chunks_pending?: number };
    expect(stats.docs_chunks ?? 0).toBeGreaterThan(0);
    expect(stats.docs_chunks_indexed ?? 0).toBe(0); // no embedding model in CI
    expect(stats.docs_chunks_pending).toBe(stats.docs_chunks);
  });
});

describe('SLA / business-hours reporting (v1.4.0)', () => {
  it('reports wall-clock honestly before any schedule is configured', async () => {
    const res = await fetch(`${baseUrl}/api/reports/sla?days=90`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailboxes: { mailbox_name: string; business_hours_configured: boolean; first_response: { count: number; avg_wall_min: number | null; avg_business_min: number | null } }[]; unconfigured_mailboxes: string[] };
    expect(body.mailboxes.length).toBe(2);
    expect(body.unconfigured_mailboxes.length).toBe(2);
    for (const m of body.mailboxes) {
      expect(m.business_hours_configured).toBe(false);
      expect(m.first_response.count).toBeGreaterThan(0);
      expect(m.first_response.avg_wall_min).not.toBeNull();
      expect(m.first_response.avg_business_min).toBeNull();
    }
  });

  it('business-hours CRUD validates and stores schedules', async () => {
    const mailboxes = (await (await fetch(`${baseUrl}/api/mailboxes`)).json()) as { id: number; name: string }[];
    const support = mailboxes.find((m) => m.name === 'Support')!;

    const badTz = await fetch(`${baseUrl}/api/settings/business-hours/${support.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'Mars/Olympus', days: [1, 2, 3, 4, 5], start_minute: 540, end_minute: 1020, first_response_target_min: null, resolution_target_min: null }) });
    expect(badTz.status).toBe(422);
    const badWindow = await fetch(`${baseUrl}/api/settings/business-hours/${support.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'UTC', days: [1], start_minute: 1020, end_minute: 540, first_response_target_min: null, resolution_target_min: null }) });
    expect(badWindow.status).toBe(422);
    const missing = await fetch(`${baseUrl}/api/settings/business-hours/999999`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'UTC', days: [1], start_minute: 540, end_minute: 1020, first_response_target_min: null, resolution_target_min: null }) });
    expect(missing.status).toBe(404);

    const ok = await fetch(`${baseUrl}/api/settings/business-hours/${support.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start_minute: 0, end_minute: 1440, first_response_target_min: 60, resolution_target_min: 4320 }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);

    const listing = (await (await fetch(`${baseUrl}/api/settings/business-hours`)).json()) as { mailboxes: { mailbox_id: number; configured: boolean; timezone: string | null }[] };
    expect(listing.mailboxes.find((m) => m.mailbox_id === support.id)?.configured).toBe(true);
  });

  it('after configuration the report measures business minutes and classifies SLA', async () => {
    const body = (await (await fetch(`${baseUrl}/api/reports/sla?days=90`)).json()) as { mailboxes: { mailbox_name: string; business_hours_configured: boolean; schedule: { timezone: string } | null; first_response: { avg_business_min: number | null; avg_wall_min: number | null; met: number; missed: number; target_min: number | null } }[]; unconfigured_mailboxes: string[] };
    const support = body.mailboxes.find((m) => m.mailbox_name === 'Support')!;
    expect(support.business_hours_configured).toBe(true);
    expect(support.schedule?.timezone).toBe('UTC');
    // 24/7 schedule: business == wall
    expect(support.first_response.avg_business_min).toBe(support.first_response.avg_wall_min);
    expect(support.first_response.target_min).toBe(60);
    expect(support.first_response.met + support.first_response.missed).toBeGreaterThan(0);
    expect(body.unconfigured_mailboxes).toEqual(['Billing']);
  });

  it('invalid mailboxIds in the SLA endpoint is a 422', async () => {
    const bad = await fetch(`${baseUrl}/api/reports/sla?mailboxIds=abc`);
    expect(bad.status).toBe(422);
  });
});
