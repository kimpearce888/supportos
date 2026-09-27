import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

/**
 * E2E (v1.3.0 roadmap): the four features that closed the v1.3.0 roadmap,
 * exercised over real HTTP against the real Fastify app in demo mode:
 *  1. Chat (Beacon) sessions in the unified inbox + channel filter
 *  2. Docs API mirror endpoints with offline FTS search
 *  3. Real-time ratings refresh over Server-Sent Events (/api/events)
 *  4. Multi-mailbox dashboards (mailboxIds + channel scope)
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v13-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  process.env.PORT = '3113';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3113, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3113';
  await ctx.coordinator.initialSync();
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  ctx.workers.stop();
  await app.close();
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('unified inbox channel filter (chat / Beacon)', () => {
  it('channel=chat returns only Beacon chat sessions with source attribution', async () => {
    const res = await fetch(`${baseUrl}/api/conversations?view=all&channel=chat&pageSize=100`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; conversations: { type: string | null; source_via: string | null }[] };
    expect(body.total).toBe(6);
    expect(body.conversations.every((c) => c.type === 'chat' && c.source_via === 'beacon')).toBe(true);
  });

  it('channel=email excludes chats; invalid channel is a 422', async () => {
    const email = (await (await fetch(`${baseUrl}/api/conversations?view=all&channel=email&pageSize=100`)).json()) as { total: number; conversations: { type: string | null }[] };
    expect(email.total).toBe(14);
    expect(email.conversations.every((c) => c.type !== 'chat')).toBe(true);
    const bad = await fetch(`${baseUrl}/api/conversations?view=all&channel=carrier-pigeon`);
    expect(bad.status).toBe(422);
    const err = (await bad.json()) as { message: string };
    expect(err.message).toContain('channel');
  });
});

describe('docs mirror endpoints', () => {
  it('lists collections and stats including the channel mix', async () => {
    const res = await fetch(`${baseUrl}/api/docs/collections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections: { name: string; article_count: number | null }[] };
    expect(body.collections.length).toBe(2);
    const stats = (await (await fetch(`${baseUrl}/api/docs/stats`)).json()) as { articles: number; chat_sessions: number; email_conversations: number; total_views: number };
    expect(stats.articles).toBe(9);
    expect(stats.chat_sessions).toBe(6);
    expect(stats.email_conversations).toBe(14);
    expect(stats.total_views).toBeGreaterThan(0);
  });

  it('searches articles offline via FTS (q=timezone) and filters by status', async () => {
    const res = await fetch(`${baseUrl}/api/docs/articles?q=timezone`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; articles: { name: string; text?: string }[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.articles.some((a) => a.name === 'Understanding schedule timezones')).toBe(true);

    const drafts = (await (await fetch(`${baseUrl}/api/docs/articles?status=draft`)).json()) as { total: number };
    expect(drafts.total).toBe(1);
    const internal = (await (await fetch(`${baseUrl}/api/docs/articles?status=internal`)).json()) as { total: number };
    expect(internal.total).toBe(1);
  });

  it('returns article detail with full text; unknown id is a 404', async () => {
    const list = (await (await fetch(`${baseUrl}/api/docs/articles?q=VAT`)).json()) as { articles: { id: number }[] };
    expect(list.articles.length).toBeGreaterThanOrEqual(1);
    const id = list.articles[0]!.id;
    const detail = (await (await fetch(`${baseUrl}/api/docs/articles/${id}`)).json()) as { article: { name: string; text: string | null } };
    expect(detail.article.text).toContain('VAT');
    const missing = await fetch(`${baseUrl}/api/docs/articles/999999`);
    expect(missing.status).toBe(404);
  });
});

describe('multi-mailbox dashboards', () => {
  it('mailboxIds scope narrows the dashboard and returns comparison rows', async () => {
    const mailboxes = (await (await fetch(`${baseUrl}/api/mailboxes`)).json()) as { id: number; name: string }[];
    expect(mailboxes.length).toBe(2);
    const support = mailboxes.find((m) => m.name === 'Support')!;

    const unscoped = (await (await fetch(`${baseUrl}/api/analytics/dashboard?days=90`)).json()) as { new_conversations: number; mailbox_comparison: { name: string }[] };
    const scoped = (await (await fetch(`${baseUrl}/api/analytics/dashboard?days=90&mailboxIds=${support.id}`)).json()) as { new_conversations: number; mailbox_comparison: { name: string }[] };
    expect(scoped.new_conversations).toBeLessThan(unscoped.new_conversations);
    expect(scoped.mailbox_comparison.length).toBe(1);
    expect(unscoped.mailbox_comparison.length).toBe(2);
  });

  it('channel=chat scope counts only Beacon chats and reports their speed', async () => {
    const body = (await (await fetch(`${baseUrl}/api/analytics/dashboard?days=90&channel=chat`)).json()) as { new_conversations: number; channel_metrics: { channel: string; first_response_avg_min: number | null }[] };
    expect(body.new_conversations).toBe(6);
    // channel_metrics is the comparison card: both channels present, chat row fast
    expect(body.channel_metrics.length).toBe(2);
    const chat = body.channel_metrics.find((m) => m.channel === 'chat');
    expect(chat).toBeDefined();
    expect(chat?.first_response_avg_min ?? 9999).toBeLessThan(60);
  });

  it('invalid mailboxIds / channel values are 422s with clear messages', async () => {
    const badMailboxes = await fetch(`${baseUrl}/api/analytics/dashboard?mailboxIds=abc`);
    expect(badMailboxes.status).toBe(422);
    const badChannel = await fetch(`${baseUrl}/api/analytics/dashboard?channel=fax`);
    expect(badChannel.status).toBe(422);
  });
});

describe('real-time ratings over SSE (/api/events)', () => {
  it('streams hello + rating events pushed by the demo simulation endpoint', async () => {
    // 1. Open the SSE stream and read frames incrementally.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: { event: string; data: string }[] = [];

    const readOnce = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (eventLine && dataLine) events.push({ event: eventLine.slice(7), data: dataLine.slice(6) });
      }
    };

    await readOnce(); // hello frame
    expect(events.some((e) => e.event === 'hello')).toBe(true);
    expect(JSON.parse(events.find((e) => e.event === 'hello')!.data).channels).toContain('ratings');

    // 2. Pick a conversation and simulate a rating arriving right now.
    const list = (await (await fetch(`${baseUrl}/api/conversations?view=all&channel=chat&pageSize=1`)).json()) as { conversations: { remote_id: number; number: number }[] };
    const target = list.conversations[0]!;
    const sim = await fetch(`${baseUrl}/api/demo/simulate-rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationRemoteId: target.remote_id, rating: 'great', comments: 'Instant over SSE!' })
    });
    expect(sim.status).toBe(200);

    // 3. The rating event must arrive on the SAME stream without polling.
    for (let i = 0; i < 5 && !events.some((e) => e.event === 'ratings'); i++) {
      await readOnce();
    }
    const ratingEvent = events.find((e) => e.event === 'ratings');
    expect(ratingEvent).toBeDefined();
    const payload = JSON.parse(ratingEvent!.data) as { rating: string; conversationNumber: number | null; comments: string | null };
    expect(payload.rating).toBe('great');
    expect(payload.conversationNumber).toBe(target.number);

    controller.abort();
  });

  it('the simulated rating lands in the dashboard counts immediately', async () => {
    const before = (await (await fetch(`${baseUrl}/api/analytics/dashboard?days=30`)).json()) as { ratings: { great: number } };
    const list = (await (await fetch(`${baseUrl}/api/conversations?view=all&pageSize=1`)).json()) as { conversations: { remote_id: number }[] };
    await fetch(`${baseUrl}/api/demo/simulate-rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationRemoteId: list.conversations[0]!.remote_id, rating: 'great' })
    });
    const after = (await (await fetch(`${baseUrl}/api/analytics/dashboard?days=30`)).json()) as { ratings: { great: number } };
    expect(after.ratings.great).toBe(before.ratings.great + 1);
  });

  it('simulate-rating validates input (422) and rejects unknown conversations (404)', async () => {
    const bad = await fetch(`${baseUrl}/api/demo/simulate-rating`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(bad.status).toBe(422);
    const badRating = await fetch(`${baseUrl}/api/demo/simulate-rating`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationRemoteId: 1, rating: 'amazing' }) });
    expect(badRating.status).toBe(422);
    const missing = await fetch(`${baseUrl}/api/demo/simulate-rating`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationRemoteId: 424242 }) });
    expect(missing.status).toBe(404);
  });
});
