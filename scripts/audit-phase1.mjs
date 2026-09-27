#!/usr/bin/env node
/**
 * NEUTRAL AUDIT — Phase 1: black-box runtime probing (v1.5.0)
 *
 * This script behaves like an external security/QA reviewer who has NOT read
 * the test suite: it boots the real production build in demo mode against a
 * THROWAWAY database and fires malformed, hostile and edge-case requests at
 * every new (and a sample of old) endpoints, recording status codes, body
 * shapes and anything that smells like a leak, a crash or a lie.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-audit-'));
const findings = [];
let checks = 0;

function finding(severity, title, detail) {
  findings.push({ severity, title, detail });
  console.log(`  [${severity.toUpperCase()}] ${title} — ${detail}`);
}

async function req(method, p, body, headers = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  checks++;
  return { status: res.status, text, json };
}

function expect(cond, ok, fail) {
  if (!cond) finding('medium', ok, fail);
}

async function main() {
  // ---- boot the PRODUCTION build (not tsx dev) on a throwaway DB ----
  const server = spawn('node', ['dist/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: path.join(tmpDir, 'audit.db'), LOCAL_DEMO_MODE: 'true', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverLogs = [];
  server.stdout.on('data', (d) => serverLogs.push(d.toString()));
  server.stderr.on('data', (d) => serverLogs.push(d.toString()));
  await new Promise((r) => setTimeout(r, 4000));

  console.log('\n== A. health & readiness ==');
  const health = await req('GET', '/health');
  if (health.status !== 200 || health.json?.status !== 'ok') finding('high', 'health endpoint broken', `status ${health.status}`);
  await new Promise((r) => setTimeout(r, 3000)); // let demo seed+sync finish

  console.log('\n== B. outreach API — malformed input ==');
  // B1: non-object body
  let r = await req('POST', '/api/outreach/segments/preview', 'not-json-at-all', { 'Content-Type': 'application/json' });
  expect(r.status >= 400 && r.status < 500, 'non-JSON preview body rejected politely', `status ${r.status}`);
  // B2: missing tree fields
  r = await req('POST', '/api/outreach/segments/preview', { combinator: 'all' });
  expect(r.status === 422, 'partial tree rejected', `status ${r.status}`);
  // B3: SQL injection attempts inside every string field of the tree
  const inject = "' OR 1=1 --; DROP TABLE customers;--";
  r = await req('POST', '/api/outreach/segments/preview', {
    combinator: 'all',
    conditions: [
      { kind: 'customer_property', definitionId: 1, name: 'Plan', type: 'text', op: 'contains', value: inject },
      { kind: 'contact', field: 'email', op: 'contains', value: `%${inject}%` },
      { kind: 'ticket', tags: [inject, 'timezone"; DROP TABLE conversations;--'], tagMode: 'any', statuses: ["active' OR '1'='1"], createdWithinDays: 5 },
      { kind: 'history_tag', tag: inject }
    ],
    exclude: []
  });
  if (r.status !== 200) finding('high', 'injection-shaped input crashes preview', `status ${r.status}: ${r.text.slice(0, 120)}`);
  else {
    const tables = await req('GET', '/api/outreach/meta');
    if (tables.status !== 200) finding('high', 'meta endpoint died after injection attempt', `status ${tables.status}`);
  }
  // B4: DEEPLY NESTED group tree (recursion depth attack) - built as a raw
  // JSON STRING so the audit client itself never recurses.
  const DEPTH = 20000;
  const deepJson = '{"kind":"group","combinator":"all","children":'.repeat(DEPTH) + '{"kind":"ticket","tags":[]}' + ']'.repeat(DEPTH);
  r = await req('POST', '/api/outreach/segments/preview', '{"combinator":"all","conditions":[' + deepJson + '],"exclude":[]}');
  if (r.status >= 500) finding('high', 'deeply nested condition tree crashes the server (stack overflow / OOM)', `status ${r.status}`);
  else if (r.status < 400) finding('medium', 'deeply nested tree was accepted without limit', `status ${r.status} - DoS via unbounded recursion is possible`);
  else console.log(`  deep-tree -> ${r.status} (rejected)`);
  // B5: giant arrays
  r = await req('POST', '/api/outreach/segments/preview', { combinator: 'all', conditions: Array.from({ length: 100000 }, () => ({ kind: 'ticket', tags: [] })), exclude: [] });
  if (r.status >= 500) finding('high', '100k conditions crash preview', `status ${r.status}`);
  else console.log(`  100k-conditions -> ${r.status}`);
  // B6: negative/absurd numbers
  r = await req('POST', '/api/outreach/segments/preview', {
    combinator: 'all',
    conditions: [{ kind: 'history', metric: 'ticket_count', op: 'gte', value: -1e12 }, { kind: 'ticket', createdWithinDays: -999, numberMin: -5, numberMax: 1e15 }],
    exclude: []
  });
  if (r.status !== 200) finding('low', 'absurd numeric inputs rejected', `status ${r.status}`);

  console.log('\n== C. outreach campaigns — hostile creation ==');
  const meta = (await req('GET', '/api/outreach/meta')).json;
  const mailboxId = meta?.mailboxes?.[0]?.local_id;
  // C1: campaign without definition/segment
  r = await req('POST', '/api/outreach/campaigns', { name: 'x', subject: 'x', body: 'x', mailbox_local_id: mailboxId });
  expect(r.status === 422, 'campaign without audience refused', `status ${r.status}`);
  // C2: unknown mailbox
  r = await req('POST', '/api/outreach/campaigns', { name: 'x', subject: 'x', body: 'x', mailbox_local_id: 99999, definition: { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'] }], exclude: [] } });
  expect(r.status === 422, 'unknown mailbox refused', `status ${r.status}`);
  // C3: XSS payloads in subject/body/name (stored; must be escaped by React at render)
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  r = await req('POST', '/api/outreach/campaigns', {
    name: `x${xss}`,
    subject: `s${xss}`,
    body: `b${xss}`,
    mailbox_local_id: mailboxId,
    definition: { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'] }], exclude: [] }
  });
  if (r.status === 200) {
    const cid = r.json.id;
    const detail = await req('GET', `/api/outreach/campaigns/${cid}`);
    expect(detail.status === 200, 'xss campaign readable', `status ${detail.status}`);
    // C4: queue then delete draft
    const del = await req('DELETE', `/api/outreach/campaigns/${cid}`);
    expect(del.status === 200 || del.json?.ok === true, 'draft campaign deletable', JSON.stringify(del.json).slice(0, 80));
  } else {
    finding('low', 'xss-shaped campaign body refused at create', `status ${r.status}`);
  }
  // C5: campaign id confusion
  r = await req('GET', '/api/outreach/campaigns/999999');
  expect(r.status === 404, 'unknown campaign 404', `status ${r.status}`);
  r = await req('GET', '/api/outreach/campaigns/not-a-number');
  expect(r.status === 404 || r.status === 422, 'non-numeric campaign id rejected', `status ${r.status}`);
  r = await req('POST', '/api/outreach/campaigns/999999/queue');
  expect(r.status === 200 ? r.json?.ok === false : r.status < 500, 'queueing unknown campaign does not 500', `status ${r.status}`);

  console.log('\n== D. DNC + segments ==');
  r = await req('POST', '/api/outreach/dnc', {});
  expect(r.status === 422, 'DNC without customer id refused', `status ${r.status}`);
  r = await req('POST', '/api/outreach/dnc', { customer_local_id: -5 });
  expect(r.status === 422, 'DNC negative id refused', `status ${r.status}`);
  r = await req('DELETE', '/api/outreach/dnc/999999');
  expect(r.status < 500, 'DNC remove unknown id safe', `status ${r.status}`);
  r = await req('POST', '/api/outreach/segments', { name: '' });
  expect(r.status === 422, 'segment without name refused', `status ${r.status}`);

  console.log('\n== E. encrypted sync — hostile bundles ==');
  // E1: short passphrase
  r = await req('POST', '/api/sync/encrypted/export', { passphrase: 'short' });
  expect(r.json?.ok === false, 'short passphrase refused', JSON.stringify(r.json).slice(0, 80));
  // E2: verify a nonexistent path
  r = await req('POST', '/api/sync/encrypted/verify', { path: '/nonexistent/bundle.sosync', passphrase: 'whatever-pass' });
  expect(r.json?.ok === false, 'nonexistent bundle refused', JSON.stringify(r.json).slice(0, 80));
  // E3: path traversal attempt
  r = await req('POST', '/api/sync/encrypted/verify', { path: '../../etc/passwd', passphrase: 'whatever-pass' });
  expect(r.json?.ok === false, 'path traversal refused', JSON.stringify(r.json).slice(0, 100));
  // E4: import a random local file as a bundle
  r = await req('POST', '/api/sync/encrypted/import', { path: '/etc/hostname', passphrase: 'whatever-pass' });
  expect(r.json?.ok === false, 'random file import refused', JSON.stringify(r.json).slice(0, 100));
  // E5: genuine export then wrong-passphrase import
  const exp = await req('POST', '/api/sync/encrypted/export', { passphrase: 'audit-passphrase-42' });
  if (exp.json?.ok !== true) finding('high', 'export failed on healthy DB', JSON.stringify(exp.json).slice(0, 120));
  else {
    r = await req('POST', '/api/sync/encrypted/import', { path: exp.json.path, passphrase: 'wrong' });
    if (r.json?.ok !== false) finding('high', 'wrong passphrase import not refused!', JSON.stringify(r.json).slice(0, 120));
    r = await req('POST', '/api/sync/encrypted/verify', { path: exp.json.path, passphrase: 'audit-passphrase-42' });
    if (r.json?.ok !== true) finding('high', 'verify with correct passphrase failed', JSON.stringify(r.json).slice(0, 120));
  }
  // E6: upload a bogus octet-stream
  const up = await fetch(`${BASE}/api/sync/encrypted/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('A'.repeat(64)) });
  checks++;
  if (up.status !== 422) finding('medium', 'upload accepts non-SOSYNC payload', `status ${up.status}`);

  console.log('\n== F. SLA alerts + search ==');
  r = await req('GET', '/api/issues/sla-alerts');
  if (r.status !== 200) finding('high', 'sla-alerts broken', `status ${r.status}`);
  else if (typeof r.json?.total_breached !== 'number') finding('medium', 'sla-alerts shape unexpected', r.text.slice(0, 120));
  // search with injection + weird scope
  r = await req('POST', '/api/search', { query: '" OR 1=1; DROP TABLE conversations;--', scope: 'tickets', filters: {} });
  if (r.status !== 200) finding('high', 'search crashes on injection-shaped query', `status ${r.status}`);
  r = await req('POST', '/api/search', { query: 'x'.repeat(10000), scope: 'bogus', filters: { status: 'bogus' } });
  if (r.status >= 500) finding('high', 'search 500s on weird scope', `status ${r.status}`);
  // search with object-injection filters
  r = await req('POST', '/api/search', { query: 'timezone', filters: { mailbox_id: 'inject', since_days: 'DROP', tag: null } });
  if (r.status >= 500) finding('high', 'search 500s on malformed filters', `status ${r.status}`);

  console.log('\n== G. old-surface regression probe ==');
  for (const p of ['/api/analytics/dashboard', '/api/conversations?view=active', '/api/customers', '/api/issues/clusters', '/api/docs/collections', '/api/settings', '/api/queue', '/api/sync/status', '/api/reports/sla', '/api/system/capabilities']) {
    r = await req('GET', p);
    if (r.status !== 200) finding('high', `regression: ${p} not 200`, `status ${r.status}`);
  }
  // conversation detail + write-path guard (notes with XSS)
  const convs = (await req('GET', '/api/conversations?view=active&pageSize=5')).json?.conversations ?? [];
  if (convs.length > 0) {
    r = await req('GET', `/api/conversations/${convs[0].id}`);
    expect(r.status === 200, 'conversation detail loads', `status ${r.status}`);
  }

  console.log('\n== H. rate limiting on mutations ==');
  let last429 = 0;
  for (let i = 0; i < 320; i++) {
    const rr = await req('POST', '/api/outreach/segments/estimate', { combinator: 'all', conditions: [], exclude: [] });
    if (rr.status === 429) {
      last429 = rr.status;
      break;
    }
  }
  if (last429 !== 429) finding('low', 'mutation rate limit did not trigger in 320 rapid posts', 'check RATE_LIMIT_MAX');

  console.log('\n== I. server log hygiene ==');
  const logs = serverLogs.join('');
  if (/stack trace|at .*\(.+\)/i.test(logs) && !/warn/.test(logs)) finding('low', 'stack traces visible in server logs during audit', 'review error handler');
  const fatalCount = (logs.match(/"level":"error"/g) ?? []).length;
  if (fatalCount > 0) finding('medium', `${fatalCount} error-level log entries during audit traffic`, 'inspect server.log output');

  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n================ AUDIT PHASE 1 SUMMARY ================`);
  console.log(`checks fired: ${checks}`);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  console.log(`findings: ${findings.length} (high: ${bySeverity.high}, medium: ${bySeverity.medium}, low: ${bySeverity.low})`);
  fs.writeFileSync('/tmp/audit-phase1-findings.json', JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error('AUDIT SCRIPT ITSELF FAILED:', e);
  process.exit(1);
});
