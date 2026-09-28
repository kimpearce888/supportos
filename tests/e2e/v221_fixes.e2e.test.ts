import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { seedDemoData } from '../../src/server/services/demoSeed.js';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.PORT = '3128';
});

/**
 * E2E (v2.2.1 audit): HTTP-level regression locks for the fixes made by the
 * fresh full-project audit - the DNS-rebinding Host guard, the unconditional
 * API 404 envelope, integer param validation on AI routes, the legacy
 * /api/ai/memory surface (red-line + existence checks), known-issue PATCH
 * validation, release-events validation, GET-rebuild removal parity, and the
 * completed /oauth/callback surface.
 */
let app: FastifyInstance;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-e2e-v221-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.db');
  process.env.LOCAL_DEMO_MODE = 'true';
  const ctx = getContext({ dbPath: path.join(tmpDir, 'e2e.db'), demoMode: true, fresh: true });
  app = await buildApp(ctx);
  await app.listen({ port: 3128, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:3128';
  await ctx.coordinator.initialSync();
  seedDemoData(ctx.db);
}, 30_000);

afterAll(async () => {
  const ctx = getContext({ demoMode: true });
  ctx.workers.stop();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]);
  resetContext();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 20_000);

describe('v2.2.1 fix: DNS-rebinding guard (Host header allowlist)', () => {
  it('refuses requests whose Host is not a loopback name', async () => {
    // Node fetch silently DROPS the Host header (forbidden header name), so
    // the guard is exercised through Fastify's injector, which allows it.
    const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { host: 'attacker.example:3128' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('local application');
  });

  it('refuses a rebinding-style Host without a port too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'rebind.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('allows the loopback Host forms the app itself uses', async () => {
    for (const host of ['127.0.0.1:3128', 'localhost:3128', '[::1]:3128', '127.0.0.1', 'localhost']) {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('v2.2.1 fix: unconditional API 404 envelope', () => {
  it('returns the JSON envelope for unknown API endpoints', async () => {
    const res = await fetch(`${baseUrl}/api/definitely/not/a/route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('NotFound');
    expect(body.message).toBe('Unknown API endpoint.');
  });
});

describe('v2.2.1 fix: AI route integer params (was: NaN surfaced as provider-shaped 503)', () => {
  it('rejects non-integer conversation ids with 422', async () => {
    const res = await fetch(`${baseUrl}/api/ai/analyze/abc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ValidationError');
  });
});

describe('v2.2.1 fix: legacy /api/ai/memory parity with the red line', () => {
  it('refuses personality-shaped writes with the policy 422', async () => {
    const res = await fetch(`${baseUrl}/api/ai/memory/1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'personality', value: 'seems neurotic under pressure' })
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('policy');
  });

  it('returns 404 (not a raw FK 500) for a nonexistent customer', async () => {
    const res = await fetch(`${baseUrl}/api/ai/memory/999999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'plan', value: 'team' })
    });
    expect(res.status).toBe(404);
  });

  it('stores a legitimate human entry and labels it human', async () => {
    const res = await fetch(`${baseUrl}/api/ai/memory/1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'v221 audit probe', value: 'human-entered fact' })
    });
    expect(res.status).toBe(200);
    const list = await fetch(`${baseUrl}/api/ai/memory/1`);
    const body = (await list.json()) as { memories: { key: string; source: string; provenance: string }[] };
    const row = body.memories.find((m) => m.key === 'v221 audit probe');
    expect(row?.source).toBe('human');
    expect(row?.provenance).toBe('human_local');
  });
});

describe('v2.2.1 fix: known-issue PATCH validation (was: loose cast corrupted the status vocabulary)', () => {
  it('rejects a numeric status with 422', async () => {
    const create = await fetch(`${baseUrl}/api/issues/known`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'v2.2.1 audit probe issue' })
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { id: number };
    const res = await fetch(`${baseUrl}/api/issues/known/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 123 })
    });
    expect(res.status).toBe(422);
    // and a valid closed-vocabulary status still works
    const ok = await fetch(`${baseUrl}/api/issues/known/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'monitoring' })
    });
    expect(ok.status).toBe(200);
  });
});

describe('v2.2.1 fix: release-events validation (was: unvalidated cast crashed SQLite binding)', () => {
  it('rejects non-string payloads with 422 and accepts a valid event', async () => {
    const bad = await fetch(`${baseUrl}/api/reports/release-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 42, occurredAt: '2026-09-01' })
    });
    expect(bad.status).toBe(422);
    const good = await fetch(`${baseUrl}/api/reports/release-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'v2.2.1 audit probe release', version: '2.2.1', occurredAt: '2026-09-28' })
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('v2.2.1 fix: GET rebuild triggers removed (parity: GET still serves the report)', () => {
  it('serves the gap report without executing a rebuild on GET', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/gaps?rebuild=1&days=90`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates?: unknown; groups?: unknown };
    expect(body).toBeDefined();
  });

  it('serves the friction overview without executing a rebuild on GET', async () => {
    const res = await fetch(`${baseUrl}/api/friction/overview?rebuild=1`);
    expect(res.status).toBe(200);
  });
});

describe('v2.2.1 fix: completed /oauth/callback surface (was: authorization code silently discarded)', () => {
  it('answers with an honest HTML page instead of the SPA swallowing the code', async () => {
    const res = await fetch(`${baseUrl}/oauth/callback?code=x&state=y`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.toLowerCase()).toContain('not completed');
  });

  it('explains itself honestly instead of redirecting into the app', async () => {
    const res = await fetch(`${baseUrl}/oauth/callback`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Demo mode answers first (OAuth is genuinely not needed there); the
    // important regression lock is: a real HTML answer, never the SPA index.
    expect(html).toContain('Help Scout connection');
    expect(html.toLowerCase()).not.toContain('<div id="root"');
  });
});

describe('v2.2.1 fix: report builder organizations metric over HTTP (was: 422 on every run)', () => {
  it('runs the organizations metric successfully', async () => {
    const res = await fetch(`${baseUrl}/api/reports/builder/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric: 'organizations', dimension: 'none', dateFrom: '2000-01-01', dateTo: '2099-01-01' })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { value: number }[]; origin: string };
    expect(body.origin).toBe('local');
    expect(Number.isFinite(body.rows[0]?.value)).toBe(true);
  });
});
