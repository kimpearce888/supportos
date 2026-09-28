import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3118';
});

/**
 * E2E (v1.8.0 / M2): the collaboration layer over real HTTP against the real
 * Fastify app in demo mode - Operations Center (+ drill parity), workload &
 * capacity, the Notification Center (webhook -> event -> sweep -> SSE ->
 * unread -> mark read), side threads with mentions, and the 4xx hardening
 * for every new route.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v18-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3118, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3118';
  await ctx.coordinator.initialSync();
  ctx.workers.start();
  // Initialize the notification cursor silently (history never notifies).
  await post('/api/notifications/sweep');
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true });
  ctx.workers.stop();
  // SSE streams aborted mid-test can hold connections open - never let close() hang the suite.
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 20_000);

interface Json { [k: string]: unknown }

async function get(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

async function req(p: string, body: unknown | undefined, method: 'POST' | 'PUT'): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

async function post(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  return req(p, body, 'POST');
}

async function put(p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  return req(p, body, 'PUT');
}

/** Read SSE frames incrementally off the open stream (v1.4 pattern). */
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
      for (let attempt = 0; attempt < 20; attempt++) {
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
        if (frames.length > 0) return frames;
      }
      return frames;
    },
    close: () => controller.abort()
  };
}

/** Collect SSE frames for up to `ms`, filtered by event name. */
async function collectFrames(sse: Awaited<ReturnType<typeof openSseStream>>, want: string, ms: number): Promise<Json[]> {
  const deadline = Date.now() + ms;
  const found: Json[] = [];
  while (Date.now() < deadline) {
    const frames = await Promise.race([sse.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sse timeout')), 4000))]).catch(() => [] as { event: string; data: string }[]);
    for (const f of frames) {
      if (f.event === want) found.push(JSON.parse(f.data) as Json);
    }
    if (found.length > 0) return found;
  }
  return found;
}

describe('Operations Center (v1.8.0, HTTP)', () => {
  it('serves the 16-tile snapshot and scopes by mailbox', async () => {
    const r = await get('/api/operations/center');
    expect(r.status).toBe(200);
    const tiles = r.json.tiles as { key: string; count: number; severity: string; drill: Json }[];
    expect(tiles).toHaveLength(16);
    expect(tiles.every((t) => typeof t.count === 'number' && ['info', 'warning', 'critical'].includes(t.severity))).toBe(true);
    expect(tiles.some((t) => t.drill.type === 'inbox')).toBe(true);
    const scoped = await get('/api/operations/center?mailboxes=1');
    expect(scoped.status).toBe(200);
    expect(scoped.json.mailbox_scope).toEqual([1]);
    const all = await get('/api/operations/center?mailboxes=all');
    expect(all.status).toBe(200);
    expect(all.json.mailbox_scope).toBeNull();
  });

  it('tile counts EQUAL the ?ops= drill-down totals (one fragment, one truth)', async () => {
    const r = await get('/api/operations/center');
    const tiles = new Map((r.json.tiles as { key: string; count: number }[]).map((t) => [t.key, t.count]));
    for (const key of ['unassigned', 'needs_first_response', 'customer_waiting', 'urgent', 'high_effort', 'known_issue', 'ai_escalation']) {
      const list = await get(`/api/conversations?view=active&ops=${key}&pageSize=100`);
      expect(list.status, `ops=${key}`).toBe(200);
      expect(list.json.total, `ops=${key} parity`).toBe(tiles.get(key));
    }
    const bad = await get('/api/conversations?view=active&ops=bogus');
    expect(bad.status).toBe(422);
  });

  it('workload, capacity and threshold round-trips (plus 422s)', async () => {
    const wl = await get('/api/operations/workload');
    expect(wl.status).toBe(200);
    const agents = wl.json.agents as Json[];
    expect(agents.length).toBe(3); // demo world: Alex, Priya, Tom
    expect(wl.json.method_notes as string[]).toBeInstanceOf(Array);
    for (const a of agents) {
      expect(typeof a.open_workload).toBe('number');
      expect(typeof a.pressure).toBe('number');
    }
    expect((wl.json.teams as Json[]).length).toBe(2);

    const sug = await get('/api/operations/suggested-assignees?limit=5');
    expect(sug.status).toBe(200);
    const suggestions = sug.json.suggestions as Json[];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.reason).toBeTruthy();

    const cap = await put('/api/operations/capacity', { default_max_open: 12, per_user_max: { '1': 20 }, weights: { urgent: 4, sla: 2, waiting: 1.5, open: 1 } });
    expect(cap.status).toBe(200);
    expect(cap.json.capacity_model.default_max_open).toBe(12);
    const wlAfter = await get('/api/operations/workload');
    const alex = (wlAfter.json.agents as Json[]).find((a) => a.display_name === 'Alex Rivera')!;
    expect(alex.capacity).toBe(20);
    const badCap = await put('/api/operations/capacity', { default_max_open: -5, per_user_max: {}, weights: { urgent: 4, sla: 2, waiting: 1.5, open: 1 } });
    expect(badCap.status).toBe(422);
    // restore
    await put('/api/operations/capacity', { default_max_open: 25, per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } });

    const thr = await put('/api/operations/waiting-threshold', { minutes: 90 });
    expect(thr.status).toBe(200);
    expect(thr.json.waiting_threshold_minutes).toBe(90);
    const badThr = await put('/api/operations/waiting-threshold', { minutes: 0 });
    expect(badThr.status).toBe(422);
    const badThr2 = await put('/api/operations/waiting-threshold', { minutes: 'lots' });
    expect(badThr2.status).toBe(422);
    await put('/api/operations/waiting-threshold', { minutes: 240 });
  });
});

describe('Notification Center full loop (v1.8.0, HTTP + SSE)', () => {
  it('webhook customer reply -> sweep -> SSE notification frame -> unread -> mark read', async () => {
    const sse = await openSseStream();
    await sse.read(); // hello frame

    // Pick an UNASSIGNED conversation: its customer_replied notification is a
    // broadcast (visible to the acting user); an assigned conversation would
    // target its assignee only.
    const unassigned = await get('/api/conversations?view=unassigned&pageSize=10');
    const pool = (unassigned.json.conversations as Json[]).length > 0 ? unassigned.json.conversations : (await get('/api/conversations?view=all&pageSize=10')).json.conversations;
    const target = (pool as Json[])[0]!;

    // Push a customer reply through the REAL webhook pipeline.
    const sim = await post('/api/demo/simulate-webhook', { event: 'convo.customer.reply.created', conversationRemoteId: target.remote_id, replyText: 'Reply for the notification center e2e.' });
    expect(sim.status).toBe(200);
    expect(sim.json.ok).toBe(true);

    // The worker tick (2s) processes the webhook; wait for the conversation frame.
    const convFrames = await collectFrames(sse, 'conversation', 12_000);
    expect(convFrames.length).toBeGreaterThan(0);

    // Manual sweep (deterministic; the 15s timer would also catch it).
    const sweep = await post('/api/notifications/sweep');
    expect(sweep.status).toBe(200);
    expect(sweep.json.created as number).toBeGreaterThanOrEqual(1);

    // SSE must carry the notification frame. (unreadCount in the frame is
    // target-relative - an assignee-targeted notification is not counted for
    // other users - so only the type is asserted here.)
    const notifFrames = await collectFrames(sse, 'notification', 8000);
    expect(notifFrames.length).toBeGreaterThan(0);
    expect(notifFrames.some((n) => n.type === 'customer_replied')).toBe(true);

    // List + unread count + the conversation link.
    const after = await get('/api/notifications?limit=50');
    expect(after.status).toBe(200);
    const notifs = after.json.notifications as Json[];
    const replied = notifs.find((n) => n.type === 'customer_replied')!;
    expect(replied.title).toContain('#');
    expect(replied.conversation_id).toBe(target.id);
    expect(replied.read_at).toBeNull();
    const unread = await get('/api/notifications/unread-count');
    expect(unread.json.unread as number).toBeGreaterThan(0);

    // unreadOnly filter + type filter
    const unreadOnly = await get('/api/notifications?unreadOnly=true');
    expect((unreadOnly.json.notifications as Json[]).every((n) => n.read_at === null)).toBe(true);
    const byType = await get('/api/notifications?type=customer_replied');
    expect((byType.json.notifications as Json[]).every((n) => n.type === 'customer_replied')).toBe(true);
    const badType = await get('/api/notifications?type=not_a_type');
    expect(badType.status).toBe(200); // unknown type = no filter, never 500
    expect((badType.json.notifications as Json[]).length).toBe(notifs.length);

    // mark read -> unread drops; mark unread works; read-all zeroes.
    const id = replied.id as number;
    const marked = await post(`/api/notifications/${id}/read`, { read: true });
    expect(marked.status).toBe(200);
    expect(marked.json.unread as number).toBe((unread.json.unread as number) - 1);
    const unmark = await post(`/api/notifications/${id}/read`, { read: false });
    expect(unmark.status).toBe(200);
    const readAll = await post('/api/notifications/read-all');
    expect(readAll.status).toBe(200);
    expect(readAll.json.unread).toBe(0);
    const missing = await post('/api/notifications/999999/read', { read: true });
    expect(missing.status).toBe(404);
    const badId = await post('/api/notifications/abc/read', { read: true });
    expect(badId.status).toBe(422);

    // Re-sweep is idempotent (dedup keys).
    const again = await post('/api/notifications/sweep');
    expect(again.json.created).toBe(0);
    sse.close();
  }, 30_000);

  it('preferences: disabled types produce no rows at all', async () => {
    const off = await put('/api/notifications/prefs/customer_replied', { enabled: false });
    expect(off.status).toBe(200);
    const prefs = (off.json.prefs as { type: string; enabled: boolean }[]).find((p) => p.type === 'customer_replied')!;
    expect(prefs.enabled).toBe(false);

    const list = await get('/api/conversations?view=all&pageSize=5');
    const target = (list.json.conversations as Json[])[1] ?? (list.json.conversations as Json[])[0]!;
    await post('/api/demo/simulate-webhook', { event: 'convo.customer.reply.created', conversationRemoteId: target.remote_id, replyText: 'This one should NOT notify.' });
    await new Promise((r) => setTimeout(r, 3500)); // worker tick
    const sweep = await post('/api/notifications/sweep');
    expect(sweep.json.created).toBe(0);
    const unread = await get('/api/notifications/unread-count');
    expect(unread.json.unread).toBe(0);
    // restore
    await put('/api/notifications/prefs/customer_replied', { enabled: true });
    const badPref = await put('/api/notifications/prefs/not_a_type', { enabled: false });
    expect(badPref.status).toBe(422);
    const badBody = await put('/api/notifications/prefs/customer_replied', { enabled: 'yes' });
    expect(badBody.status).toBe(422);
  }, 30_000);
});

describe('Side threads + mentions (v1.8.0, HTTP)', () => {
  let conversationId: number;

  it('serves the mention directory from the synced identity mirror', async () => {
    const r = await get('/api/mention-directory');
    expect(r.status).toBe(200);
    const users = r.json.users as { display_name: string; mention: string | null }[];
    expect(users.map((u) => u.mention).sort()).toEqual(['alex', 'priya', 'tom']);
    expect((r.json.teams as { name: string }[]).map((t) => t.name).sort()).toEqual(['Escalations', 'Tier 1']);
  });

  it('creates a side thread, resolves mentions, notifies over SSE, blocks resolved threads', async () => {
    const list = await get('/api/conversations?view=all&pageSize=5');
    conversationId = (list.json.conversations as Json[])[0]!.id as number;

    const sse = await openSseStream();
    await sse.read(); // hello

    const created = await post(`/api/conversations/${conversationId}/side-threads`, {
      title: 'Engineering huddle',
      participant_user_ids: [],
      first_message: 'Investigating the export 429s @priya, thoughts?'
    });
    expect(created.status).toBe(200);
    const thread = created.json.side_thread as Json;
    expect(thread.title).toBe('Engineering huddle');
    expect(thread.status).toBe('open');
    expect(thread.message_count).toBe(1);
    // @priya auto-joined as participant (mention -> auto-join)
    const participants = (thread.participants as { user_local_id: number }[]).map((p) => p.user_local_id);
    expect(participants.length).toBeGreaterThanOrEqual(2);
    // the first message's mention resolved to Priya's local id
    const msg = (thread.messages as Json[])[0]!;
    expect((msg.mentions as Json[]).some((m) => m.user_local_id != null)).toBe(true);

    // A team mention fans out over SSE immediately.
    const msg2 = await post(`/api/side-threads/${thread.id}/messages`, { body: 'Looping in @Tier 1 for visibility' });
    expect(msg2.status).toBe(200);
    const frames = await collectFrames(sse, 'notification', 8000);
    expect(frames.some((n) => n.type === 'team_mentioned')).toBe(true);
    sse.close();

    // Self-mention rows power the mentions-for-me queue (author = Alex).
    await post(`/api/side-threads/${thread.id}/messages`, { body: 'Note to self @alex: attach the logs' });
    const queue = await get('/api/notifications/mentions');
    expect(queue.status).toBe(200);
    const sideMentions = queue.json.side_thread_mentions as { body: string; conversation_id: number }[];
    expect(sideMentions.some((m) => m.body.includes('@alex'))).toBe(true);
    expect(sideMentions.every((m) => m.conversation_id === conversationId)).toBe(true);

    // Participants add (resolve Tom's LOCAL id from the directory - never
    // assume insert order) + detail fetch.
    const dir = await get('/api/mention-directory');
    const tom = (dir.json.users as { display_name: string; mention: string | null; user_local_id: number }[]).find((u) => u.mention === 'tom')!;
    const current = await get(`/api/side-threads/${thread.id}`);
    const alreadyIn = ((current.json.side_thread as Json).participants as { user_local_id: number }[]).map((p) => p.user_local_id);
    if (!alreadyIn.includes(tom.user_local_id)) {
      const add = await post(`/api/side-threads/${thread.id}/participants`, { user_local_ids: [tom.user_local_id] });
      expect(add.status).toBe(200);
      expect((add.json.added as number[]).length).toBeGreaterThan(0);
    }
    const detail = await get(`/api/side-threads/${thread.id}`);
    expect(detail.status).toBe(200);
    expect((detail.json.side_thread as Json).messages as Json[]).toHaveLength(3);

    // Resolve blocks messages with 409; reopen unblocks.
    const resolved = await post(`/api/side-threads/${thread.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect((resolved.json.side_thread as Json).status).toBe('resolved');
    const blocked = await post(`/api/side-threads/${thread.id}/messages`, { body: 'too late' });
    expect(blocked.status).toBe(409);
    const reopened = await post(`/api/side-threads/${thread.id}/reopen`);
    expect(reopened.status).toBe(200);
    const ok = await post(`/api/side-threads/${thread.id}/messages`, { body: 'back open' });
    expect(ok.status).toBe(200);

    // Listing per conversation.
    const threadsList = await get(`/api/conversations/${conversationId}/side-threads`);
    expect(threadsList.status).toBe(200);
    expect((threadsList.json.side_threads as Json[]).length).toBe(1);
  });

  it('hardens every new route with 4xx, never 500', async () => {
    const list = await get('/api/conversations?view=all&pageSize=5');
    const convId = (list.json.conversations as Json[])[0]!.id as number;

    expect((await post('/api/conversations/999999/side-threads', { title: 'x' })).status).toBe(404);
    expect((await post(`/api/conversations/${convId}/side-threads`, { title: '' })).status).toBe(422);
    expect((await post(`/api/conversations/${convId}/side-threads`, { title: 'x'.repeat(200) })).status).toBe(422);
    expect((await get('/api/side-threads/999999')).status).toBe(404);
    expect((await post('/api/side-threads/999999/messages', { body: 'hi' })).status).toBe(404);
    expect((await post('/api/side-threads/abc/messages', { body: 'hi' })).status).toBe(422);
    expect((await post(`/api/side-threads/1/messages`, { body: '' })).status).toBe(422);
    expect((await post(`/api/side-threads/1/messages`, { body: 'x'.repeat(9000) })).status).toBe(422);
    expect((await post('/api/side-threads/1/participants', { user_local_ids: [] })).status).toBe(422);
    expect((await post('/api/side-threads/1/participants', {})).status).toBe(422);
    expect((await get('/api/conversations/abc/side-threads')).status).toBe(422);
    // resolving an already-resolved thread is a 409 conflict, never a 500
    const r1 = await post('/api/side-threads/1/resolve');
    const r2 = await post('/api/side-threads/1/resolve');
    expect([200, 409]).toContain(r1.status);
    expect(r2.status).toBe(409);
    expect((await post('/api/side-threads/1/reopen')).status).toBe(200);
  });
});
