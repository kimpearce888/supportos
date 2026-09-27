import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3117';
});

/**
 * E2E (v1.7.0): the conversation activity engine over real HTTP against the
 * real Fastify app in demo mode - date/activity filters (incl. adversarial
 * params), response-state filtering, priority, custom ticket states with
 * transition history, the event timeline, saved Inbox Views (dynamic dates)
 * and the rebuild endpoint.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v17-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3117, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3117';
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

interface Json { [k: string]: unknown }

async function get(p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: (await res.json()) as Json };
}

async function post(p: string, body?: unknown, method = 'POST'): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    // No Content-Type without a body: Fastify's JSON parser rejects an empty
    // body labeled as application/json (correctly) with 400.
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as Json };
}

describe('v1.7.0 inbox activity filters (HTTP)', () => {
  it('lists conversations with the new summary fields (response_state, priority, waiting)', async () => {
    const r = await get('/api/conversations?view=all&pageSize=100');
    expect(r.status).toBe(200);
    const convs = r.json.conversations as Json[];
    expect(convs.length).toBeGreaterThan(5);
    for (const c of convs) {
      expect(typeof c.response_state).toBe('string');
      expect(typeof c.priority).toBe('string');
      expect(c.activity_history_complete === 0 || c.activity_history_complete === 1).toBe(true);
    }
    // The demo corpus has active conversations with customer messages
    const states = new Set(convs.map((c) => c.response_state));
    expect(states.size).toBeGreaterThan(1);
  });

  it('filters by response state deterministically', async () => {
    const waiting = await get('/api/conversations?view=all&responseState=customer_waiting&pageSize=100');
    expect(waiting.status).toBe(200);
    for (const c of waiting.json.conversations as Json[]) {
      expect(c.response_state).toBe('customer_waiting');
      expect(c.customer_waiting_since).toBeTruthy();
    }
    const closed = await get('/api/conversations?view=all&responseState=closed&pageSize=100');
    for (const c of closed.json.conversations as Json[]) {
      expect(c.response_state).toBe('closed');
    }
  });

  it('filters by activity field + date mode (rolling and calendar, with notes)', async () => {
    const rolling = await get('/api/conversations?view=all&activityField=created_at&dateMode=last_90d&pageSize=100');
    expect(rolling.status).toBe(200);
    expect((rolling.json.conversations as Json[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(rolling.json.notes)).toContain('rolling');

    const today = await get('/api/conversations?view=all&activityField=last_activity_at&dateMode=today&timezone=UTC&pageSize=100');
    expect(today.status).toBe(200);
    expect(JSON.stringify(today.json.notes)).toContain('Today');
    // calendar vs rolling are labeled differently (honest semantics)
    const cal24 = await get('/api/conversations?view=all&activityField=created_at&dateMode=today&timezone=UTC');
    const roll24 = await get('/api/conversations?view=all&activityField=created_at&dateMode=last_24h');
    expect(JSON.stringify(cal24.json.notes)).toContain('calendar');
    expect(JSON.stringify(roll24.json.notes)).toContain('rolling');
  });

  it('rejects malformed filter params with 422 (never silently widens)', async () => {
    const cases = [
      '/api/conversations?view=all&activityField=nope&dateMode=today',
      '/api/conversations?view=all&activityField=created_at&dateMode=whenever',
      '/api/conversations?view=all&responseState=very_tired',
      '/api/conversations?view=all&priority=MEGA',
      '/api/conversations?view=all&activityField=created_at&dateMode=exact_date&from=not-a-date',
      '/api/conversations?view=all&activityField=created_at&dateMode=exact_date',
      '/api/conversations?view=all&activityField=created_at&dateMode=custom_range&from=2024-02-30&to=2024-13-01',
      '/api/conversations?view=all&sort=chaos',
      '/api/conversations?view=all&savedViewId=abc'
    ];
    for (const p of cases) {
      const r = await get(p);
      expect(r.status).toBe(422);
      expect((r.json as { error?: string }).error).toBe('ValidationError');
    }
  });

  it('sorts by waiting duration and priority', async () => {
    const waiting = await get('/api/conversations?view=all&sort=waiting_longest&pageSize=100');
    expect(waiting.status).toBe(200);
    const rows = (waiting.json.conversations as Json[]).filter((c) => c.customer_waiting_since != null);
    for (let i = 1; i < rows.length; i++) {
      expect(Date.parse(String(rows[i - 1]!.customer_waiting_since))).toBeLessThanOrEqual(Date.parse(String(rows[i]!.customer_waiting_since)));
    }
    const pri = await get('/api/conversations?view=all&sort=priority&pageSize=100');
    expect(pri.status).toBe(200);
  });
});

describe('v1.7.0 priority + custom ticket states (HTTP)', () => {
  let convId: number;

  it('sets and clears priority (local-only; audit + event recorded)', async () => {
    const list = await get('/api/conversations?view=active&pageSize=1');
    convId = (list.json.conversations as Json[])[0]!.id as number;

    const set = await post(`/api/conversations/${convId}/priority`, { priority: 'urgent' });
    expect(set.status).toBe(200);
    expect(set.json.ok).toBe(true);

    const detail = await get(`/api/conversations/${convId}`);
    expect((detail.json.conversation as Json).priority).toBe('urgent');

    // Filter finds it
    const urgent = await get('/api/conversations?view=all&priority=urgent');
    expect((urgent.json.conversations as Json[]).some((c) => c.id === convId)).toBe(true);

    // Priority event in the timeline
    const events = await get(`/api/conversations/${convId}/events`);
    const types = (events.json.events as Json[]).map((e) => e.event_type);
    expect(types).toContain('priority_changed');

    // Back to none
    const clear = await post(`/api/conversations/${convId}/priority`, { priority: 'none' });
    expect(clear.json.ok).toBe(true);
  });

  it('rejects invalid priority values with 422', async () => {
    const r = await post(`/api/conversations/999999/priority`, { priority: 'SUPER' });
    expect(r.status).toBe(422);
    const r2 = await post(`/api/conversations/999999/priority`, {});
    expect(r2.status).toBe(422);
  });

  it('lists the six seeded states + creates/updates/deletes a custom state', async () => {
    const list = await get('/api/ticket-states');
    expect(list.status).toBe(200);
    expect((list.json.states as Json[]).map((s) => s.key)).toEqual(['new', 'investigating', 'waiting-customer', 'waiting-engineering', 'ready-verify', 'resolved']);
    expect((list.json.bottlenecks as Json[])).toBeInstanceOf(Array);

    const create = await post('/api/ticket-states', { name: 'Awaiting Payment', color: '#f472b6' });
    expect(create.status).toBe(200);
    const stateId = (create.json.state as Json).id as number;

    const patch = await post(`/api/ticket-states/${stateId}`, { name: 'Payment Pending' }, 'PATCH');
    expect(patch.status).toBe(200);
    expect((patch.json.state as Json).name).toBe('Payment Pending');

    const del = await post(`/api/ticket-states/${stateId}`, undefined, 'DELETE');
    expect(del.status).toBe(200);
    expect(del.json.ok).toBe(true);
  });

  it('guards built-in states from deletion', async () => {
    const list = await get('/api/ticket-states');
    const newId = ((list.json.states as Json[]).find((s) => s.key === 'new') as Json).id as number;
    const del = await post(`/api/ticket-states/${newId}`, undefined, 'DELETE');
    expect(del.status).toBe(422);
    expect(del.json.ok).toBe(false);
  });

  it('sets a ticket state, records the transition, lifecycle metrics and filters by it', async () => {
    const states = (await get('/api/ticket-states')).json.states as Json[];
    const investigating = states.find((s) => s.key === 'investigating') as Json;

    const set = await post(`/api/conversations/${convId}/state`, { stateId: investigating.id, reason: 'e2e triage' });
    expect(set.status).toBe(200);
    expect(set.json.ok).toBe(true);

    const detail = await get(`/api/conversations/${convId}`);
    const activity = detail.json.activity as Json;
    expect((activity.ticket_state as Json).key).toBe('investigating');
    expect((activity.state_history as Json[]).length).toBe(1);
    expect((activity.state_lifecycle as Json).transitions).toBe(1);
    expect((activity.state_lifecycle as Json).current_state).toBeTruthy();

    // Filter by ticket state finds the conversation
    const filtered = await get(`/api/conversations?view=all&ticketStateId=${investigating.id}&pageSize=100`);
    expect((filtered.json.conversations as Json[]).some((c) => c.id === convId)).toBe(true);

    // ticket_state_changed event recorded
    const events = await get(`/api/conversations/${convId}/events`);
    expect((events.json.events as Json[]).some((e) => e.event_type === 'ticket_state_changed')).toBe(true);

    // Second transition -> history grows; clear -> three transitions
    const resolved = states.find((s) => s.key === 'resolved') as Json;
    await post(`/api/conversations/${convId}/state`, { stateId: resolved.id });
    const cleared = await post(`/api/conversations/${convId}/state`, { stateId: null, reason: 'done in e2e' });
    expect(cleared.json.ok).toBe(true);
    const detail2 = await get(`/api/conversations/${convId}`);
    expect(((detail2.json.activity as Json).state_history as Json[]).length).toBe(3);
    expect((detail2.json.activity as Json).ticket_state).toBeNull();
  });

  it('rejects bad state payloads with 422 and 404s for missing conversations', async () => {
    const bad = await post(`/api/conversations/${convId}/state`, { stateId: 'one' });
    expect(bad.status).toBe(422);
    const missing = await post('/api/conversations/99999999/state', { stateId: 1 });
    expect(missing.status).toBe(404);
    const missingEvents = await get('/api/conversations/99999999/events');
    expect(missingEvents.status).toBe(404);
  });
});

describe('v1.7.0 event timeline + rebuild (HTTP)', () => {
  it('serves a chronological timeline with honest sources for the demo corpus', async () => {
    const list = await get('/api/conversations?view=all&pageSize=100');
    const conv = (list.json.conversations as Json[])[0] as Json;
    const r = await get(`/api/conversations/${conv.id}/events`);
    expect(r.status).toBe(200);
    const events = r.json.events as Json[];
    expect(events.length).toBeGreaterThan(0);
    // The demo corpus was mirrored, not born locally -> rebuild-derived events
    expect(events.some((e) => e.source === 'rebuild' || e.source === 'sync')).toBe(true);
    // Chronological ordering
    const times = events.map((e) => Date.parse(String(e.occurred_at ?? e.created_at)));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
    // Counts object
    expect(typeof r.json.counts).toBe('object');
  });

  it('rebuild is idempotent: no duplicate events on re-run', async () => {
    const before = await get('/api/conversations?view=all&pageSize=1');
    const convId = ((before.json.conversations as Json[])[0] as Json).id as number;
    const e1 = await get(`/api/conversations/${convId}/events`);
    const count1 = (e1.json.events as Json[]).length;
    const rebuild = await post('/api/conversations/activity/rebuild');
    expect(rebuild.status).toBe(200);
    expect(rebuild.json.ok).toBe(true);
    const e2 = await get(`/api/conversations/${convId}/events`);
    expect((e2.json.events as Json[]).length).toBe(count1);
  });
});

describe('v1.7.0 saved Inbox Views (HTTP)', () => {
  it('full lifecycle: create -> run (dynamic date) -> preview -> update -> delete', async () => {
    // A view meaning "customer replied today and no agent response"
    const definition = {
      combinator: 'all',
      conditions: [
        { kind: 'response_state', states: ['needs_first_response', 'customer_waiting'] },
        { kind: 'date_activity', activityField: 'last_customer_reply_at', mode: 'today' }
      ]
    };
    const create = await post('/api/inbox-views', { name: 'Customer replied today', definition });
    expect(create.status).toBe(200);
    const viewId = (create.json.view as Json).id as number;

    // Running the view through the inbox list
    const run = await get(`/api/conversations?view=all&savedViewId=${viewId}&timezone=UTC&pageSize=100`);
    expect(run.status).toBe(200);
    for (const c of run.json.conversations as Json[]) {
      expect(['needs_first_response', 'customer_waiting']).toContain(c.response_state);
    }
    expect(JSON.stringify(run.json.notes)).toContain('Customer replied today');

    // Dry-run preview endpoint
    const preview = await post('/api/inbox-views/preview', { definition, timezone: 'UTC' });
    expect(preview.status).toBe(200);
    expect(typeof preview.json.matched).toBe('number');
    expect(typeof preview.json.timezone).toBe('string');

    // Update bumps version only on definition change
    const rename = await post(`/api/inbox-views/${viewId}`, { name: 'Customer replied today (v2)' }, 'PATCH');
    expect(rename.json.ok).toBe(true);
    expect((rename.json.view as Json).version).toBe(1);
    const redefine = await post(`/api/inbox-views/${viewId}`, { definition: { combinator: 'any', conditions: [{ kind: 'status', statuses: ['active'] }] } }, 'PATCH');
    expect((redefine.json.view as Json).version).toBe(2);

    // List + get
    const list = await get('/api/inbox-views');
    expect((list.json.views as Json[]).some((v) => v.id === viewId)).toBe(true);
    const one = await get(`/api/inbox-views/${viewId}`);
    expect((one.json.definition as Json).combinator).toBe('any');

    // Delete
    const del = await post(`/api/inbox-views/${viewId}`, undefined, 'DELETE');
    expect(del.json.ok).toBe(true);
    const gone = await get(`/api/inbox-views/${viewId}`);
    expect(gone.status).toBe(404);
    const runGone = await get(`/api/conversations?view=all&savedViewId=${viewId}`);
    expect(runGone.status).toBe(404);
  });

  it('rejects invalid definitions and never accepts raw SQL', async () => {
    const cases = [
      { name: 'evil', definition: { combinator: 'all', conditions: [{ kind: 'status; DROP TABLE conversations;--', statuses: ['active'] }] } },
      { name: 'empty-name', definition: { combinator: 'all', conditions: [] } },
      { name: 'sql-body', definition: "SELECT * FROM conversations" },
      { name: 'deep', definition: { combinator: 'all', conditions: [nestDeep(12)] } }
    ];
    for (const body of cases) {
      const r = await post('/api/inbox-views', body.name === 'empty-name' ? { name: '', definition: body.definition } : body);
      expect(r.status).toBe(422);
    }
    // The conversations table is intact
    const health = await get('/api/conversations?view=all&pageSize=1');
    expect(health.status).toBe(200);
  });

  it('preview rejects invalid definitions too', async () => {
    const r = await post('/api/inbox-views/preview', { definition: { combinator: 'all', conditions: [{ kind: 'drop_table', statuses: [] }] } });
    expect(r.status).toBe(422);
  });
});

function nestDeep(n: number): unknown {
  if (n === 0) return { kind: 'status', statuses: ['active'] };
  return { kind: 'group', combinator: 'all', children: [nestDeep(n - 1)] };
}
