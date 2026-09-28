import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import type { FastifyInstance } from 'fastify';

// PORT must be set BEFORE the config module evaluates (it reads env at import
// time, exactly like production startup) so the CORS allowlist includes this port.
vi.hoisted(() => {
  process.env.PORT = '3127'; // v2.2.1 audit fix: was 3113 - collided with realtime_docs.e2e when files ran in parallel
});

/**
 * E2E regression tests for the v1.2.0 independent audit: every test names the
 * audit finding it locks down. Boots the real app in demo mode on a custom
 * PORT (which itself exercises the dynamic CORS allowlist).
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;
let convId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-audit-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'audit.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'audit.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3127, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3127';
  await ctx.coordinator.initialSync();
  ctx.workers.start();
  const list = (await (await fetch(`${baseUrl}/api/conversations`)).json()) as { conversations: { id: number }[] };
  convId = list.conversations[0]!.id;
});

afterAll(async () => {
  const ctx = getContext({ dbPath: path.join(tmpDir, 'audit.db'), demoMode: true });
  ctx.workers.stop();
  await app.close();
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('audit fixes (v1.2.0): HTTP hardening', () => {
  it('NaN pagination params are clamped, not 500 (audit: datatype mismatch crash)', async () => {
    const res = await fetch(`${baseUrl}/api/conversations?page=abc&pageSize=xyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; page_size: number };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
    const queue = await fetch(`${baseUrl}/api/queue?limit=abc`);
    expect(queue.status).toBe(200);
    const audit = await fetch(`${baseUrl}/api/audit?limit=abc`);
    expect(audit.status).toBe(200);
  });

  it('zod validation failures return 422, never 500 (audit: wrong error semantics + error-log pollution)', async () => {
    const res = await fetch(`${baseUrl}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 123 }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('ValidationError');
    expect(body.message).toContain('query');
  });

  it('schedule publish/delete tolerate missing bodies with 422, not a crash (audit: undefined threadId)', async () => {
    const pub = await fetch(`${baseUrl}/api/conversations/${convId}/schedule/publish`, { method: 'POST' });
    expect(pub.status).toBe(422);
    const del = await fetch(`${baseUrl}/api/conversations/${convId}/schedule`, { method: 'DELETE' });
    expect(del.status).toBe(422);
  });

  it('CORS allows the configured custom port origin (audit: hardcoded 3000/5173 broke custom PORTs)', async () => {
    // v2.2.1: the suite now runs on port 3127 (was 3113, which collided with
    // realtime_docs.e2e under file parallelism); the CORS allowlist is derived
    // from the CONFIGURED port, so the probed origin follows it.
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3127', 'Access-Control-Request-Method': 'POST' }
    });
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3127');
  });

  it('CORS cleanly denies foreign origins without an error (audit: 500 instead of deny)', async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('settings PATCH rejects unknown/internal keys with 422 (audit: settings poisoning, NaN sync loop, AI traffic redirect)', async () => {
    const bad = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lmstudio_base_url: 'http://evil.example:1234', hack_key: 'x' })
    });
    expect(bad.status).toBe(422);
    const nan = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_interval_minutes: {} })
    });
    expect(nan.status).toBe(422);
    const settings = (await (await fetch(`${baseUrl}/api/settings`)).json()) as { sync_interval_minutes: number };
    expect(Number.isFinite(settings.sync_interval_minutes)).toBe(true);
  });

  it('demo mode cannot import arbitrary machine files (audit: demo-mode file disclosure)', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/import-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/hostname', visibility: 'internal_only' })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('knowledge-import');
  });

  it('AI evaluation mode blocks replies end-to-end (audit: guard missing on sendReply)', async () => {
    await fetch(`${baseUrl}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai_evaluation_mode: true }) });
    const res = await fetch(`${baseUrl}/api/conversations/${convId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'should be blocked by evaluation mode', draft: false })
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('evaluation mode');
    await fetch(`${baseUrl}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai_evaluation_mode: false }) });
  });

  it('draft-then-send of the same text is not treated as a duplicate send (audit: idempotency key ignored the draft flag)', async () => {
    const text = `audit draft-then-send ${Date.now()}`;
    const draft = await fetch(`${baseUrl}/api/conversations/${convId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, draft: true })
    });
    expect(draft.status).toBe(200);
    const send = await fetch(`${baseUrl}/api/conversations/${convId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, draft: false })
    });
    expect(send.status).toBe(200);
    const sendBody = (await send.json()) as { ok: boolean; message: string };
    expect(sendBody.ok).toBe(true);
    // A true duplicate SEND is still blocked
    const dup = await fetch(`${baseUrl}/api/conversations/${convId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, draft: false })
    });
    const dupBody = (await dup.json()) as { ok: boolean; message: string };
    expect(dupBody.ok).toBe(false);
    expect(dupBody.message).toContain('duplicate');
  });

  it('reads are not rate-limited; mutations are (audit: global limiter 429d the SPA itself)', async () => {
    // 320 rapid GETs (beyond the old 300/min limit) must all succeed
    let allOk = true;
    for (let i = 0; i < 320; i++) {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (res.status === 429) allOk = false;
    }
    expect(allOk).toBe(true);
  });

  it('interaction refresh returns 404 for unknown conversations (audit: was 503)', async () => {
    const res = await fetch(`${baseUrl}/api/interaction/999999/refresh`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('interaction profile returns 404 for unknown customers (audit: empty 200)', async () => {
    const res = await fetch(`${baseUrl}/api/interaction/profile/999999`);
    expect(res.status).toBe(404);
    const nan = await fetch(`${baseUrl}/api/interaction/profile/abc`);
    expect(nan.status).toBe(400);
  });

  it('attachment file endpoint validates ids and serves downloads with safe headers (audit: prod 404 + dev inline html)', async () => {
    const bad = await fetch(`${baseUrl}/api/attachments/abc/file`);
    expect(bad.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/attachments/999999/file`);
    expect(missing.status).toBe(404);
  });
});
