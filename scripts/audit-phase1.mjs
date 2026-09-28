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

  console.log('\n== H. v1.7.0 activity engine (black-box) ==');
  // H1. New summary fields present and typed on every row
  {
    const list = (await req('GET', '/api/conversations?view=all&pageSize=100')).json;
    const rows = list?.conversations ?? [];
    if (rows.length === 0) finding('medium', 'no conversations to audit', 'demo corpus empty');
    for (const c of rows) {
      if (typeof c.response_state !== 'string') { finding('medium', 'response_state missing on a row', `conv ${c.id}`); break; }
      if (typeof c.priority !== 'string') { finding('medium', 'priority missing on a row', `conv ${c.id}`); break; }
      if (typeof c.activity_history_complete !== 'number') { finding('medium', 'activity_history_complete missing', `conv ${c.id}`); break; }
    }
    // Notes surface resolution semantics (honest labeling)
    if (Array.isArray(list?.notes) && list.notes.length > 0 && !/calendar|rolling|exact/.test(list.notes.join(' '))) {
      finding('low', 'filter notes do not state boundary semantics', JSON.stringify(list.notes));
    }
  }
  // H2. Adversarial filter params -> 422, never 500
  for (const p of [
    '/api/conversations?view=all&responseState=happy',
    '/api/conversations?view=all&priority=ULTRA',
    '/api/conversations?view=all&activityField=shard;DROP TABLE conversations;--&dateMode=today',
    '/api/conversations?view=all&activityField=created_at&dateMode=whenever',
    '/api/conversations?view=all&activityField=created_at&dateMode=exact_date&from=2024-02-31',
    '/api/conversations?view=all&activityField=created_at&dateMode=custom_range&from=%27OR%271%27%3D%271&to=2024-01-01',
    '/api/conversations?view=all&sort=;DELETE FROM users',
    '/api/conversations?view=all&savedViewId=999999999',
    '/api/conversations?view=all&ticketStateId=-5'
  ]) {
    r = await req('GET', p);
    if (r.status === 500) finding('high', `filter param crashed: ${p}`, 'status 500');
    else if (r.status !== 422 && r.status !== 404) finding('medium', `hostile filter not rejected: ${p}`, `status ${r.status}`);
  }
  // H3. Saved-view endpoints: hostile definitions never persist, never execute
  {
    const evilDefs = [
      { combinator: 'all', conditions: [{ kind: 'status', statuses: ["'; DROP TABLE conversations;--"] }] },
      { combinator: 'all', conditions: [{ kind: 'date_activity', activityField: 'created_at', mode: 'today', from: '2024-01-01', fromTime: '99:99' }] },
      { combinator: 'all', conditions: [{ kind: 'response_age', metric: 'time_since_customer_reply', op: 'gt', minutes: 1e12 }] },
      'SELECT * FROM conversations',
      { combinator: 'all', conditions: [{ kind: 'group', combinator: 'all', children: [] }] }
    ];
    for (const def of evilDefs) {
      r = await req('POST', '/api/inbox-views', { name: 'audit-probe', definition: def });
      if (r.status === 500) finding('high', 'hostile view definition crashed create', JSON.stringify(def).slice(0, 80));
      else if (r.status === 200) {
        finding('medium', 'hostile view definition was ACCEPTED', JSON.stringify(def).slice(0, 80));
        await req('DELETE', `/api/inbox-views/${r.json?.view?.id}`);
      }
    }
    r = await req('POST', '/api/inbox-views/preview', { definition: { combinator: 'all', conditions: [{ kind: 'drop', statuses: [] }] } });
    if (r.status !== 422) finding('medium', 'preview did not reject hostile definition', `status ${r.status}`);
    // The conversations table must still exist and answer
    r = await req('GET', '/api/conversations?view=active&pageSize=1');
    if (r.status !== 200) finding('high', 'conversations table damaged after injection probes', `status ${r.status}`);
  }
  // H4. Priority/state write paths: valid ops work, hostile payloads rejected
  {
    const first = (await req('GET', '/api/conversations?view=active&pageSize=1')).json?.conversations?.[0];
    if (first) {
      r = await req('POST', `/api/conversations/${first.id}/priority`, { priority: 'high' });
      if (r.status !== 200) finding('medium', 'valid priority write failed', `status ${r.status}`);
      r = await req('POST', `/api/conversations/${first.id}/priority`, { priority: "high', (SELECT password FROM oauth_tokens), '" });
      if (r.status === 422) finding('low', 'injection-shaped priority returned 422 (acceptable)', 'confirm bound params');
      else if (r.status !== 422) finding('medium', 'injection-shaped priority not rejected', `status ${r.status}`);
      const states = (await req('GET', '/api/ticket-states')).json?.states ?? [];
      if (states.length < 6) finding('medium', 'built-in ticket states not seeded', `${states.length} states`);
      if (states.length > 0) {
        r = await req('POST', `/api/conversations/${first.id}/state`, { stateId: states[0].id, reason: "'; DELETE FROM ticket_state_transitions;--" });
        if (r.status !== 200) finding('medium', 'valid state write failed', `status ${r.status}`);
        r = await req('POST', `/api/conversations/${first.id}/state`, { stateId: 1e9 });
        if (r.status !== 422) finding('medium', 'unknown stateId not rejected', `status ${r.status}`);
      }
      // Timeline: chronological, honest sources, deduped
      r = await req('GET', `/api/conversations/${first.id}/events?limit=1000`);
      if (r.status === 200) {
        const evs = r.json?.events ?? [];
        let ordered = true;
        for (let i = 1; i < evs.length; i++) if (evs[i].id === evs[i - 1].id) ordered = false;
        const times = evs.map((e) => Date.parse(e.occurred_at ?? e.created_at));
        for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) ordered = false;
        if (!ordered) finding('medium', 'event timeline not chronological', `conv ${first.id}`);
        const keys = new Set(evs.map((e) => e.event_type + ':' + (e.metadata?.thread_remote_id ?? e.metadata?.tag ?? e.metadata?.next ?? '')));
        if (keys.size !== evs.length) finding('low', 'possible duplicate events in timeline', `${evs.length} events, ${keys.size} identities`);
        const rebuilt = await req('POST', '/api/conversations/activity/rebuild');
        if (rebuilt.status !== 200) finding('medium', 'activity rebuild failed', `status ${rebuilt.status}`);
        const after = (await req('GET', `/api/conversations/${first.id}/events?limit=1000`)).json?.events ?? [];
        if (after.length !== evs.length) finding('medium', 'rebuild changed event count (dup or loss)', `${evs.length} -> ${after.length}`);
      } else {
        finding('high', 'event timeline endpoint failed', `status ${r.status}`);
      }
    }
  }

  console.log('\n== J. v1.8.0 collaboration layer — black-box ==');
  // J1. Operations Center: hostile scope + params never 500
  for (const p of [
    '/api/operations/center?mailboxes=1,abc,-5,99999999999999999999',
    '/api/operations/center?mailboxes=' + encodeURIComponent("' OR 1=1 --"),
    '/api/operations/center?mailboxes=1&mailboxes=2',
    '/api/conversations?view=active&ops=urgent;DROP TABLE conversations;--',
    '/api/conversations?view=active&ops=' + encodeURIComponent("')( OR '1'='1"),
    '/api/operations/suggested-assignees?limit=abc',
    '/api/operations/suggested-assignees?limit=-999',
    '/api/operations/suggested-assignees?limit=1e9'
  ]) {
    r = await req('GET', p);
    if (r.status >= 500) finding('high', `operations route crashed: ${p}`, `status ${r.status}`);
  }
  // J2. Tile count == drill-down total (the one-fragment invariant, live)
  {
    const snap = (await req('GET', '/api/operations/center')).json;
    const tiles = new Map((snap?.tiles ?? []).map((t) => [t.key, t.count]));
    if ((snap?.tiles ?? []).length !== 16) finding('medium', 'operations center does not expose 16 tiles', `${(snap?.tiles ?? []).length} tiles`);
    for (const key of ['unassigned', 'needs_first_response', 'customer_waiting', 'urgent', 'high_effort', 'known_issue', 'ai_escalation']) {
      const list = await req('GET', `/api/conversations?view=active&ops=${key}&pageSize=100`);
      if (list.status !== 200) { finding('high', `ops drill broken for ${key}`, `status ${list.status}`); continue; }
      if (list.json?.total !== tiles.get(key)) finding('medium', `tile/drill mismatch for ${key}`, `tile=${tiles.get(key)} list=${list.json?.total}`);
    }
  }
  // J3. Capacity model + threshold: hostile values rejected, never stored corrupt
  for (const body of [
    { default_max_open: -5, per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } },
    { default_max_open: 1e9, per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } },
    { default_max_open: 'lots', per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } },
    { default_max_open: 10, per_user_max: { "'; DROP TABLE users;--": 5 }, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } },
    { default_max_open: 10, per_user_max: {}, weights: { urgent: -99, sla: 2, waiting: 1.5, open: 1 } },
    null
  ]) {
    r = await req('PUT', '/api/operations/capacity', body);
    if (r.status !== 422) finding('medium', 'hostile capacity model accepted', JSON.stringify(body).slice(0, 80));
  }
  r = await req('PUT', '/api/operations/waiting-threshold', { minutes: -1 });
  if (r.status !== 422) finding('medium', 'negative waiting threshold accepted', `status ${r.status}`);
  r = await req('PUT', '/api/operations/waiting-threshold', { minutes: 'soon' });
  if (r.status !== 422) finding('medium', 'string waiting threshold accepted', `status ${r.status}`);
  // J4. Notification hardening: hostile ids/types/bodies
  for (const p of [
    '/api/notifications?type=' + encodeURIComponent("' OR 1=1 --"),
    '/api/notifications?limit=abc&page=-5',
    '/api/notifications?unreadOnly=maybe'
  ]) {
    r = await req('GET', p);
    if (r.status >= 500) finding('high', `notifications route crashed: ${p}`, `status ${r.status}`);
  }
  r = await req('POST', '/api/notifications/0/read', { read: true });
  if (r.status !== 422) finding('medium', 'notification id 0 not rejected', `status ${r.status}`);
  r = await req('POST', '/api/notifications/-1/read', { read: true });
  if (r.status !== 422) finding('medium', 'negative notification id not rejected', `status ${r.status}`);
  r = await req('POST', '/api/notifications/1/read', { read: 'yes please' });
  if (r.status !== 422) finding('medium', 'non-boolean read flag not rejected', `status ${r.status}`);
  r = await req('PUT', '/api/notifications/prefs/' + encodeURIComponent("'; DROP TABLE notification_prefs;--"), { enabled: false });
  if (r.status !== 422) finding('medium', 'hostile pref type not rejected', `status ${r.status}`);
  // J5. Sweep idempotence over HTTP: run twice, second run creates nothing
  {
    const s1 = await req('POST', '/api/notifications/sweep');
    if (s1.status !== 200) finding('high', 'manual sweep failed', `status ${s1.status}`);
    const s2 = await req('POST', '/api/notifications/sweep');
    if (s2.status !== 200 || (s2.json?.created ?? 0) !== 0) finding('medium', 'sweep not idempotent over HTTP', `second run created ${s2.json?.created}`);
  }
  // J6. Side threads: XSS-shaped payloads stored safely, hostile tokens inert
  {
    const convs = (await req('GET', '/api/conversations?view=active&pageSize=1')).json?.conversations ?? [];
    if (convs.length > 0) {
      const xss = '<script>alert(1)</script><img src=x onerror=alert(2)> @DROP TABLE users @1=1';
      r = await req('POST', `/api/conversations/${convs[0].id}/side-threads`, { title: `t ${xss}`, first_message: `m ${xss}` });
      if (r.status !== 200) finding('medium', 'xss-shaped side thread refused at create', `status ${r.status}`);
      else {
        const tid = r.json?.side_thread?.id;
        const detail = await req('GET', `/api/side-threads/${tid}`);
        if (detail.status !== 200) finding('high', 'side thread unreadable after xss payload', `status ${detail.status}`);
        // hostile mention tokens must resolve to NOTHING (no notifications)
        const before = (await req('GET', '/api/notifications?limit=200')).json?.notifications?.length ?? 0;
        r = await req('POST', `/api/side-threads/${tid}/messages`, { body: '@DROP TABLE users @1=1 @nonexistent-person @' + "x'.repeat(50)" });
        if (r.status !== 200) finding('medium', 'hostile-mention message refused', `status ${r.status}`);
        const after = (await req('GET', '/api/notifications?limit=200')).json?.notifications?.length ?? 0;
        if (after > before) finding('high', 'hostile @token created a notification (identity guessing!)', `before=${before} after=${after}`);
        // resolve/reopen conflict cycle: 409s, never 500
        await req('POST', `/api/side-threads/${tid}/resolve`);
        r = await req('POST', `/api/side-threads/${tid}/resolve`);
        if (r.status >= 500) finding('high', 'double resolve crashed', `status ${r.status}`);
        r = await req('POST', `/api/side-threads/${tid}/messages`, { body: 'too late' });
        if (r.status !== 409) finding('medium', 'message to resolved thread not 409', `status ${r.status}`);
        await req('POST', `/api/side-threads/${tid}/reopen`);
      }
      // hostile participant payloads
      r = await req('POST', `/api/conversations/${convs[0].id}/side-threads`, { title: 'p' });
      if (r.status === 200) {
        const tid2 = r.json?.side_thread?.id;
        for (const body of [{ user_local_ids: [-5] }, { user_local_ids: [1e12] }, { user_local_ids: 'not-array' }, { user_local_ids: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }]) {
          const pr = await req('POST', `/api/side-threads/${tid2}/participants`, body);
          if (pr.status !== 422 && pr.status !== 200) finding('medium', 'hostile participant payload mis-handled', `${JSON.stringify(body).slice(0, 50)} -> ${pr.status}`);
          if (pr.status >= 500) finding('high', 'participant payload crashed route', JSON.stringify(body).slice(0, 50));
        }
      }
      // oversized bodies
      r = await req('POST', `/api/conversations/${convs[0].id}/side-threads`, { title: 'x'.repeat(500) });
      if (r.status !== 422) finding('medium', 'oversized side-thread title accepted', `status ${r.status}`);
      r = await req('POST', `/api/conversations/${convs[0].id}/side-threads`, { title: 'ok', first_message: 'x'.repeat(9000) });
      if (r.status !== 422) finding('medium', 'oversized first_message accepted', `status ${r.status}`);
    }
    // mention directory shape
    r = await req('GET', '/api/mention-directory');
    if (r.status !== 200 || !Array.isArray(r.json?.users) || !Array.isArray(r.json?.teams)) finding('high', 'mention directory broken', `status ${r.status}`);
    // mentions queue never 500s even when empty
    r = await req('GET', '/api/notifications/mentions');
    if (r.status !== 200) finding('high', 'mentions queue broken', `status ${r.status}`);
  }
  // J7. The conversations table must still answer after all injection probes
  r = await req('GET', '/api/conversations?view=active&pageSize=1');
  if (r.status !== 200) finding('high', 'conversations table damaged by J-section probes', `status ${r.status}`);

  console.log('\n== K. v1.9.0 — Copilot, attribute layer, AI escalation rules ==');
  // K1. catalog is the closed list with the honest-unknown note
  r = await req('GET', '/api/attributes/catalog');
  if (r.status !== 200) finding('high', 'attribute catalog broken', `status ${r.status}`);
  else {
    const keys = (r.json?.catalog ?? []).map((d) => d.key);
    if (keys.length !== 14) finding('medium', 'catalog key count changed', `got ${keys.length}`);
    if (!String(r.json?.note ?? '').includes('unknown')) finding('low', 'catalog note lost the honest-unknown wording', 'review note');
  }
  // K2. attribute routes: hostile ids and unknown keys
  for (const p of ['/api/attributes/conversation/0', '/api/attributes/conversation/-1', '/api/attributes/conversation/abc']) {
    r = await req('GET', p);
    if (r.status !== 422) finding('medium', `hostile attribute id accepted (${p})`, `status ${r.status}`);
  }
  r = await req('GET', '/api/attributes/conversation/999999');
  if (r.status !== 404) finding('medium', 'missing conversation should 404', `status ${r.status}`);
  r = await req('GET', '/api/attributes/conversation/1/history/; DROP TABLE ai_attributes;--');
  if (r.status !== 422) finding('medium', 'injection-shaped attribute key in history route', `status ${r.status}`);
  r = await req('GET', '/api/attributes/values/../../etc/passwd');
  if (r.status !== 422 && r.status !== 404) finding('medium', 'path-shaped attribute key mis-handled', `status ${r.status} (404 = Fastify path normalization keeps it out of the handler - safe)`);
  // K3. drill-down with injection-shaped values (LIKE wildcard + SQL)
  const injectAttr = "' OR 1=1 --; DROP TABLE ai_attributes;--";
  r = await req('GET', `/api/attributes/conversations?attribute=product&op=contains&value=${encodeURIComponent(injectAttr)}&limit=5`);
  if (r.status !== 200) finding('high', 'injection-shaped attribute value crashed drill-down', `status ${r.status}`);
  r = await req('GET', `/api/attributes/conversations?attribute=product&op=contains&value=${encodeURIComponent('%'.repeat(50))}&limit=5`);
  if (r.status !== 200) finding('medium', 'wildcard-only attribute value crashed drill-down', `status ${r.status}`);
  r = await req('GET', '/api/attributes/conversations?attribute=known_issue&op=equals&value=TRUE&limit=999999');
  if (r.status !== 200) finding('medium', 'case-variant boolean + giant limit crashed drill-down', `status ${r.status}`);
  // K4. recompute on a real conversation, then live-filter parity
  const convList = (await req('GET', '/api/conversations?view=active&pageSize=1')).json?.conversations ?? [];
  if (convList.length > 0) {
    const cid = convList[0].id;
    r = await req('POST', `/api/attributes/conversation/${cid}/recompute`, { force: true });
    if (r.status !== 200) finding('high', 'recompute failed on a real conversation', `status ${r.status}: ${r.text.slice(0, 120)}`);
    else {
      const snap = (await req('GET', `/api/attributes/conversation/${cid}`)).json;
      const ki = (snap?.attributes ?? []).find((a) => a.attribute === 'known_issue');
      if (!ki) finding('medium', 'known_issue missing after recompute (deterministic slot must always exist)', 'check deterministic layer');
      // live inbox filter must agree with the snapshot (drill == list parity)
      const filtered = await req('GET', `/api/conversations?aiAttribute=known_issue&aiAttrValue=${ki.value}&pageSize=100`);
      if (filtered.status !== 200) finding('high', 'live ai-attribute filter crashed', `status ${filtered.status}`);
      else if (!(filtered.json?.conversations ?? []).some((c) => c.id === cid)) finding('medium', 'live filter disagrees with attribute snapshot (parity break)', `snapshot=${ki.value}`);
    }
  }
  // K5. live filter hostile parameters
  r = await req('GET', `/api/conversations?aiAttribute=not_a_key&aiAttrValue=${encodeURIComponent(injectAttr)}`);
  if (r.status !== 422) finding('high', 'unknown ai-attribute key accepted by live filter', `status ${r.status}`);
  r = await req('GET', '/api/conversations?aiAttribute=urgency&aiAttrOp=hax&aiAttrValue=high');
  if (r.status !== 422) finding('medium', 'unknown ai-attribute operator accepted', `status ${r.status}`);
  r = await req('GET', '/api/conversations?aiAttribute=question_count&aiAttrOp=gt&aiAttrValue=1e999');
  if (r.status !== 422 && r.status !== 200) finding('medium', 'infinity-shaped numeric value mis-handled', `status ${r.status}`);
  // K6. saved views carrying ai_attribute conditions: save-time compile checks
  r = await req('POST', '/api/inbox-views', { name: 'audit-attr-inject', definition: { combinator: 'all', conditions: [{ kind: 'ai_attribute', attribute: 'product', op: 'contains', value: injectAttr }] } });
  if (r.status !== 200) finding('low', 'injection value in saved-view ai_attribute rejected (acceptable but check parity)', `status ${r.status}`);
  else {
    const vid = r.json?.view?.id;
    const applied = await req('GET', `/api/conversations?savedViewId=${vid}&pageSize=5`);
    if (applied.status !== 200) finding('high', 'saved view with injection-shaped attribute value crashes at open time', `status ${applied.status}`);
    await req('DELETE', `/api/inbox-views/${vid}`);
  }
  r = await req('POST', '/api/inbox-views', { name: 'audit-attr-badkey', definition: { combinator: 'all', conditions: [{ kind: 'ai_attribute', attribute: 'nope', op: 'equals', value: 'x' }] } });
  if (r.status < 400 || r.status >= 500) finding('high', 'unknown attribute key in saved view must be a clean 4xx', `status ${r.status}`);
  // K7. copilot surface: read-only definitions, hostile bodies, honest 503
  r = await req('GET', '/api/copilot/tools');
  if (r.status !== 200) finding('high', 'copilot tools listing broken', `status ${r.status}`);
  else {
    const names = (r.json?.tools ?? []).map((t) => t.name);
    if (names.includes('execute_sql') || names.includes('write_reply')) finding('high', 'write-shaped tool exposed to the model', JSON.stringify(names));
    if (!String(r.json?.note ?? '').includes('read-only')) finding('low', 'tools note lost read-only wording', 'review note');
  }
  r = await req('POST', '/api/copilot/chat', {});
  if (r.status !== 422) finding('medium', 'empty copilot chat body must 422', `status ${r.status}`);
  r = await req('POST', '/api/copilot/chat', 'not-json', { 'Content-Type': 'application/json' });
  if (r.status >= 500) finding('high', 'non-JSON copilot body crashed', `status ${r.status}`);
  r = await req('POST', '/api/copilot/chat', { question: 'x'.repeat(5000) });
  if (r.status !== 422) finding('medium', 'oversized copilot question accepted', `status ${r.status}`);
  r = await req('POST', '/api/copilot/chat', { question: 'hi', conversationId: 999999 });
  if (r.status !== 404) finding('medium', 'copilot chat with unknown conversation must 404', `status ${r.status}`);
  r = await req('POST', '/api/copilot/chat', { question: 'hi', sessionId: 999999 });
  if (r.status !== 404) finding('high', 'unknown copilot session must be a clean 404', `status ${r.status}`);
  // honest degradation: with LM Studio unreachable the chat is a 503, never a hang or fake answer
  r = await req('POST', '/api/copilot/chat', { question: 'what is this about?' });
  if (r.status !== 503) finding('medium', 'copilot chat with AI offline should be an honest 503', `status ${r.status}`);
  for (const p of ['/api/copilot/sessions/0', '/api/copilot/sessions/abc', '/api/copilot/starter-questions/-1']) {
    r = await req('GET', p);
    if (r.status !== 422) finding('medium', `hostile copilot id accepted (${p})`, `status ${r.status}`);
  }
  r = await req('DELETE', '/api/copilot/sessions/999999');
  if (r.status !== 404) finding('medium', 'deleting a missing copilot session must 404', `status ${r.status}`);
  // K8. AI escalation rules: closed vocabulary at the API boundary
  r = await req('POST', '/api/automation/rules', { name: 'audit-bad', trigger: 'new_conversation', conditions: [{ field: 'ai_attribute', operator: 'equals', value: 'high' }], actions: [{ kind: 'analyze_ticket', params: {} }], requires_approval: true });
  if (r.status !== 400) finding('medium', 'ai_attribute condition without catalog key must 400', `status ${r.status}`);
  r = await req('POST', '/api/automation/rules', { name: 'audit-bad-2', trigger: 'new_conversation', conditions: [{ field: 'ai_verification', operator: 'equals', value: 'DROP TABLE' }], actions: [{ kind: 'analyze_ticket', params: {} }], requires_approval: true });
  if (r.status !== 400) finding('medium', 'ai_verification condition outside closed values must 400', `status ${r.status}`);
  // K9. attribute report still healthy after every probe above
  r = await req('GET', '/api/attributes/report');
  if (r.status !== 200 || !Array.isArray(r.json?.distributions)) finding('high', 'attribute report broken after K-section probes', `status ${r.status}`);

  console.log('\n== I. rate limiting on mutations ==');
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
