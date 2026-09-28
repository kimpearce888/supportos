/* Live smoke test for M2 endpoints on the real demo DB (a copy).
 * Starts the server in demo mode on a scratch port and exercises every new
 * v1.8.0 route. Run: npx tsx scripts/smoke-m2.ts */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const SRC = 'data/supportos.db';
const DB = '/tmp/m2_smoke.db';
// Copy the demo DB safely: checkpoint WAL first (the demo preview server may
// have it open), then plain copy.
try {
  const src = new Database(SRC);
  src.pragma('wal_checkpoint(TRUNCATE)');
  src.close();
} catch { /* checkpoint is best-effort */ }
try { fs.copyFileSync(SRC, DB); } catch { /* DB may be absent in CI */ }
// Act as Priya (remote_id 1002): mention notifications target HER, and the
// notifications route only shows broadcasts + rows targeting "me".
try {
  const db = new Database(DB);
  db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('me_remote_id', '1002', datetime('now'))").run();
  db.close();
} catch { /* best-effort */ }
const PORT = 3199;

async function main(): Promise<void> {
  const server = spawn('node', ['dist/server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, LOCAL_DEMO_MODE: 'true', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  });
  server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));
  // Never leak the child, whatever exit path this script takes.
  const killServer = (): void => {
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  };
  process.on('exit', killServer);
  process.on('SIGINT', () => { killServer(); process.exit(130); });
  process.on('uncaughtException', () => { killServer(); process.exit(1); });

  const base = `http://127.0.0.1:${PORT}`;
  const get = async (p: string): Promise<{ status: number; body: unknown }> => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = async (p: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // wait for health
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error('server did not start');
  console.log('server up');

  const checks: string[] = [];
  const assert = (name: string, ok: boolean, extra = ''): void => {
    checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) process.exitCode = 1;
  };

  // 1. operations center
  const ops = await get('/api/operations/center');
  assert('GET /api/operations/center 200', ops.status === 200);
  const tiles = ((ops.body as { tiles?: { key: string; count: number }[] })?.tiles) ?? [];
  assert('16 tiles present', tiles.length === 16, `got ${tiles.length}`);
  console.log('tiles:', tiles.map((t) => `${t.key}=${t.count}`).join(' '));

  // 2. scoped snapshot
  const opsScoped = await get('/api/operations/center?mailboxes=1');
  assert('scoped snapshot 200', opsScoped.status === 200);

  // 3. workload
  const wl = await get('/api/operations/workload');
  assert('GET /api/operations/workload 200', wl.status === 200);
  const agents = ((wl.body as { agents?: unknown[] })?.agents) ?? [];
  console.log('agents:', agents.length, 'teams:', ((wl.body as { teams?: unknown[] })?.teams) ?? []);

  // 4. suggested assignees
  const sug = await get('/api/operations/suggested-assignees?limit=5');
  assert('GET /api/operations/suggested-assignees 200', sug.status === 200);
  console.log('suggestions:', ((sug.body as { suggestions?: unknown[] })?.suggestions ?? []).length);

  // 5. capacity PUT round-trip
  const cap = await fetch(`${base}/api/operations/capacity`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_max_open: 30, per_user_max: { '1': 40 }, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } }) });
  assert('PUT /api/operations/capacity 200', cap.status === 200);

  // 6. notifications empty then sweep
  const before = await get('/api/notifications/unread-count');
  assert('GET /api/notifications/unread-count 200', before.status === 200);
  const sweep = await post('/api/notifications/sweep');
  assert('POST /api/notifications/sweep 200', sweep.status === 200);
  console.log('sweep created:', (sweep.body as { created?: number })?.created);

  // 7. mention directory
  const dir = await get('/api/mention-directory');
  assert('GET /api/mention-directory 200', dir.status === 200);
  console.log('mention users:', ((dir.body as { users?: unknown[] })?.users ?? []).length);

  // 8. side threads: create on a real conversation
  const convs = await get('/api/conversations?view=active&pageSize=1');
  const first = ((convs.body as { conversations?: { id: number; number: number }[] })?.conversations ?? [])[0];
  assert('active conversation available', first != null);
  if (first) {
    const created = await post(`/api/conversations/${first.id}/side-threads`, { title: 'Smoke: Engineering', participant_user_ids: [1], first_message: 'Looking at this now @priya can you check the logs?' });
    assert('POST side-thread 200', created.status === 200, JSON.stringify(created.body).slice(0, 200));
    const thread = (created.body as { side_thread?: { id: number; messages: { body: string }[]; participants: unknown[] } })?.side_thread;
    if (thread) {
      console.log('side thread', thread.id, 'messages:', thread.messages.length, 'participants:', thread.participants.length);
      const msg = await post(`/api/side-threads/${thread.id}/messages`, { body: 'Update: fixed in build 2.5.1 @Tier 1' });
      assert('POST side-thread message 200', msg.status === 200);
      const resolved = await post(`/api/side-threads/${thread.id}/resolve`);
      assert('POST side-thread resolve 200', resolved.status === 200);
      const afterResolve = await post(`/api/side-threads/${thread.id}/messages`, { body: 'should 409' });
      assert('message on resolved thread 409', afterResolve.status === 409, `got ${afterResolve.status}`);
    }
    const list = await get(`/api/conversations/${first.id}/side-threads`);
    assert('GET side-threads list 200', list.status === 200);
  }

  // 9. notifications after side-thread mentions (immediate fan-out).
  // Acting as Priya (user 3): the @priya self-mention is SKIPPED (correct),
  // and the @Tier 1 team fan-out notified Alex (user 1) - correctly INVISIBLE
  // to Priya via the targeting filter.
  const after = await get('/api/notifications?limit=50');
  const notifs = (after.body as { notifications?: { type: string; title: string }[] })?.notifications ?? [];
  console.log('notifications visible to me:', notifs.length);
  assert('self-mention produced no notification for the author', !notifs.some((n) => n.type === 'mentioned'));
  // Raw-table truth: the team fan-out row for Alex must exist.
  const raw = new (await import('better-sqlite3')).default(DB);
  const rawRows = raw.prepare("SELECT type, target_user_local_id, title FROM notifications WHERE type IN ('mentioned','team_mentioned')").all() as { type: string; target_user_local_id: number; title: string }[];
  raw.close();
  console.log('raw mention rows:', JSON.stringify(rawRows));
  assert('team mention fanned out to the other member', rawRows.length === 1 && rawRows[0]!.type === 'team_mentioned' && rawRows[0]!.target_user_local_id === 1, `got ${JSON.stringify(rawRows)}`);

  // 10. mentions queue: the @priya side-thread mention targets me, even
  // though it authored by me (the queue reflects the mention rows).
  const mentions = await get('/api/notifications/mentions');
  assert('GET /api/notifications/mentions 200', mentions.status === 200);
  const stm = (mentions.body as { side_thread_mentions?: unknown[] })?.side_thread_mentions ?? [];
  console.log('side thread mentions for me:', stm.length);
  assert('mentions queue has the @priya mention', stm.length >= 1);

  // 11. prefs
  const prefs = await get('/api/notifications/prefs');
  assert('GET /api/notifications/prefs 200', prefs.status === 200);
  const prefPut = await fetch(`${base}/api/notifications/prefs/issue_spike`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert('PUT prefs 200', prefPut.status === 200);
  const badPref = await fetch(`${base}/api/notifications/prefs/not_a_type`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert('PUT prefs invalid type 422', badPref.status === 422, `got ${badPref.status}`);

  // 12. mark read / read-all
  const readAll = await post('/api/notifications/read-all');
  assert('POST read-all 200', readAll.status === 200);
  const unreadAfter = await get('/api/notifications/unread-count');
  assert('unread now 0', ((unreadAfter.body as { unread?: number })?.unread ?? -1) === 0, JSON.stringify(unreadAfter.body));

  // 13. ops drill-down filter parity
  if (first) {
    const tile = tiles.find((t) => t.key === 'unassigned');
    const list = await get('/api/conversations?view=active&ops=unassigned&pageSize=100');
    assert('ops=unassigned drill 200', list.status === 200);
    const total = (list.body as { total?: number })?.total;
    assert('tile count == drill-down total', tile != null && total === tile.count, `tile=${tile?.count} list=${total}`);
    const badOps = await get('/api/conversations?view=active&ops=bogus');
    assert('ops=bogus 422', badOps.status === 422, `got ${badOps.status}`);
  }

  // 14. waiting threshold
  const thr = await fetch(`${base}/api/operations/waiting-threshold`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: 120 }) });
  assert('PUT waiting-threshold 200', thr.status === 200);

  console.log('\n' + checks.join('\n'));
  server.kill('SIGTERM');
  fs.rmSync(DB, { force: true });
  fs.rmSync(`${DB}-wal`, { force: true });
  fs.rmSync(`${DB}-shm`, { force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
