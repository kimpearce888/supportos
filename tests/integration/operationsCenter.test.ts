import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';
import { SlaService } from '../../src/server/analytics/slaService.js';
import { OperationsCenterService } from '../../src/server/operations/operationsCenter.js';
import { WorkloadService, CAPACITY_SETTING_KEY } from '../../src/server/operations/workloadService.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { tileFragment } from '../../src/server/operations/tileFragments.js';

/**
 * v1.8.0 integration tests (M2): the Operations Center snapshot (16 tiles,
 * mailbox scope, tile==drill parity via the SAME fragment) and the
 * workload/capacity engine (pressure tiers, capacity overrides, team
 * aggregation, suggested assignee ranking).
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let settings: SettingsRepository;
let ops: OperationsCenterService;
let workload: WorkloadService;
let convRepo: ConversationRepository;

function insertConversation(opts: {
  remote: number; number: number; status?: string; assignee?: number | null; mailbox?: number;
  priority?: string; waitingSince?: string | null; firstCustomerAt?: string | null; firstResponseAt?: string | null; lastCustomerAt?: string | null; lastAgentAt?: string | null;
}): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, assignee_local_id,
       supportos_priority, customer_waiting_since, first_customer_message_at, first_response_at, last_customer_reply_at, last_human_agent_response_at,
       remote_created_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, datetime('now','-2 days'), datetime('now'), datetime('now'))`
  ).run(
    opts.remote, opts.number, `S${opts.number}`, opts.status ?? 'active', opts.mailbox ?? 1, opts.assignee ?? null,
    opts.priority ?? 'none', opts.waitingSince ?? null, opts.firstCustomerAt ?? null, opts.firstResponseAt ?? null, opts.lastCustomerAt ?? null, opts.lastAgentAt ?? null
  );
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(opts.remote) as Row).id);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  settings = new SettingsRepository(db);
  const sla = new SlaService(db);
  ops = new OperationsCenterService(db, sla, settings);
  workload = new WorkloadService(db, sla, settings);
  convRepo = new ConversationRepository(db);

  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (201, 'Support', 'support'), (202, 'Billing', 'billing')").run();
  db.prepare("INSERT INTO users (remote_id, first_name, last_name, mention) VALUES (1001, 'Alex', 'Rivera', 'alex'), (1002, 'Priya', 'Nair', 'priya')").run();
  db.prepare("INSERT INTO teams (remote_id, name) VALUES (501, 'Tier 1')").run();
  const alex = Number((db.prepare('SELECT id FROM users WHERE remote_id = 1001').get() as Row).id);
  const priya = Number((db.prepare('SELECT id FROM users WHERE remote_id = 1002').get() as Row).id);
  const tier1 = Number((db.prepare('SELECT id FROM teams WHERE remote_id = 501').get() as Row).id);
  db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?), (?, ?)').run(tier1, alex, tier1, priya);
  db.prepare("INSERT INTO customers (remote_id, first_name) VALUES (601, 'Ada'), (602, 'Grace')").run();
  db.prepare('INSERT INTO user_statuses (user_local_id, email_status, chat_status) VALUES (?, ?, ?), (?, ?, ?)').run(alex, 'active', 'active', priya, 'away', 'away');

  // ---- operational world ----
  // unassigned, waiting 5h (over the 240min default threshold)
  insertConversation({ remote: 1, number: 1, waitingSince: new Date(Date.now() - 5 * 3600000).toISOString(), firstCustomerAt: new Date(Date.now() - 5 * 3600000).toISOString(), lastCustomerAt: new Date(Date.now() - 5 * 3600000).toISOString() });
  // unassigned, never replied, waiting 30min (below threshold)
  insertConversation({ remote: 2, number: 2, waitingSince: new Date(Date.now() - 30 * 60000).toISOString(), firstCustomerAt: new Date(Date.now() - 30 * 60000).toISOString(), lastCustomerAt: new Date(Date.now() - 30 * 60000).toISOString() });
  // urgent + assigned to Alex
  insertConversation({ remote: 3, number: 3, assignee: alex, priority: 'urgent' });
  // urgent in the BILLING mailbox (scope test)
  insertConversation({ remote: 4, number: 4, mailbox: 2, priority: 'high' });
  // high effort: strong frustration signal
  const highEffort = insertConversation({ remote: 5, number: 5 });
  db.prepare('INSERT INTO client_current_signals (conversation_id, customer_id, signals_json, message_stats_json) VALUES (?, 1, ?, ?)').run(
    highEffort,
    JSON.stringify([{ dimension: 'frustration', value: 'strong', confidence: 'medium', source: 'heuristic' }]),
    JSON.stringify({ customer_messages: 2 })
  );
  // high effort via message count
  const manyMessages = insertConversation({ remote: 6, number: 6 });
  db.prepare('INSERT INTO client_current_signals (conversation_id, customer_id, signals_json, message_stats_json) VALUES (?, 2, ?, ?)').run(
    manyMessages,
    JSON.stringify([{ dimension: 'frustration', value: 'none', confidence: 'low', source: 'heuristic' }]),
    JSON.stringify({ customer_messages: 6 })
  );
  // known issue (unresolved) linked to two conversations from the SAME customer -> repeated issue
  const ki = db.prepare(`INSERT INTO known_issues (title, status, created_at) VALUES ('Sync loop', 'investigating', datetime('now'))`).run();
  const repeat1 = insertConversation({ remote: 7, number: 7 });
  const repeat2 = insertConversation({ remote: 8, number: 8 });
  db.prepare('INSERT INTO known_issue_conversations (known_issue_id, conversation_id) VALUES (?, ?), (?, ?)').run(Number(ki.lastInsertRowid), repeat1, Number(ki.lastInsertRowid), repeat2);
  // ai escalation: critical urgency analysis on an open conversation
  const escalated = insertConversation({ remote: 9, number: 9 });
  db.prepare(`INSERT INTO ai_runs (type, conversation_id, status, output) VALUES ('ticket_analysis', ?, 'completed', ?)`).run(
    escalated,
    JSON.stringify({ urgency: 'critical', sentiment: 'neutral', confidence: 'high' })
  );
  // closed + spam stay out of operational tiles
  insertConversation({ remote: 10, number: 10, status: 'closed' });
  insertConversation({ remote: 11, number: 11, status: 'spam' });
  // Alex: one closed in the last 7 days
  const closed = insertConversation({ remote: 12, number: 12, status: 'closed', assignee: alex });
  db.prepare("UPDATE conversations SET closed_at = datetime('now', '-1 day') WHERE id = ?").run(closed);
  // customer_waiting: replied once, customer wrote again 5h ago (over threshold)
  const h = (hours: number): string => new Date(Date.now() - hours * 3600000).toISOString();
  insertConversation({ remote: 13, number: 13, firstCustomerAt: h(6), firstResponseAt: h(5.5), lastCustomerAt: h(5), lastAgentAt: h(5.5), waitingSince: h(5) });
  // customer_waiting under the threshold: customer wrote again 30min ago
  insertConversation({ remote: 14, number: 14, firstCustomerAt: h(2), firstResponseAt: h(1.5), lastCustomerAt: h(0.5), lastAgentAt: h(1.5), waitingSince: h(0.5) });
});

afterAll(() => {
  closeDatabase(db);
});

describe('OperationsCenterService.snapshot', () => {
  it('returns all 16 tiles with the expected unassigned count', () => {
    const snap = ops.snapshot(null);
    expect(snap.tiles).toHaveLength(16);
    const by = new Map(snap.tiles.map((t) => [t.key, t.count]));
    // open+unassigned: 1,2,4,5,6,7,8,9,13,14 (3 assigned to Alex; 10/12 closed; 11 spam)
    expect(by.get('unassigned')).toBe(10);
  });

  it('computes conversation tiles exactly (unassigned, urgent, high effort, known issue, repeated issue, ai escalation)', () => {
    const snap = ops.snapshot(null);
    const by = new Map(snap.tiles.map((t) => [t.key, t.count]));
    expect(by.get('unassigned')).toBe(10);
    expect(by.get('needs_first_response')).toBe(2); // #1 and #2: customer wrote, no reply ever
    expect(by.get('customer_waiting')).toBe(2); // #13 and #14: replied once, customer answered again
    expect(by.get('waiting_over_threshold')).toBe(1); // only #13 waited 5h (default threshold 240)
    expect(by.get('urgent')).toBe(2); // #3 urgent + #4 high
    expect(by.get('high_effort')).toBe(2); // strong frustration + 6 messages
    expect(by.get('known_issue')).toBe(2); // repeat1 + repeat2 open, linked to unresolved issue
    expect(by.get('repeated_issue')).toBe(2); // same customer, 2 convs on the same known issue
    expect(by.get('ai_escalation')).toBe(1); // #9 critical analysis
  });

  it('scopes tiles to the selected mailboxes', () => {
    const billing = ops.snapshot([2]);
    const by = new Map(billing.tiles.map((t) => [t.key, t.count]));
    expect(by.get('unassigned')).toBe(1); // only #4 lives in Billing
    expect(by.get('urgent')).toBe(1);
    expect(by.get('high_effort')).toBe(0);
    expect(billing.mailbox_scope).toEqual([2]);
  });

  it('tile counts EQUAL the drill-down list totals (one fragment, one truth)', () => {
    const snap = ops.snapshot(null);
    const by = new Map(snap.tiles.map((t) => [t.key, t.count]));
    for (const key of ['unassigned', 'needs_first_response', 'customer_waiting', 'waiting_over_threshold', 'urgent', 'high_effort', 'repeated_issue', 'known_issue', 'ai_escalation'] as const) {
      const frag = tileFragment(key, snap.waiting_threshold_minutes);
      const rows = db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${frag.whereSql}`).all(...frag.params) as Row[];
      expect(Number(rows[0]!.n), `tile ${key}`).toBe(by.get(key));
      // and the same fragment through the repo list path (extraWhere)
      const list = convRepo.listConversations({ view: 'all', page: 1, pageSize: 100, extraWhere: frag.whereSql, extraParams: frag.params });
      expect(list.total, `repo drill ${key}`).toBe(by.get(key));
    }
  });

  it('waiting threshold is configurable and clamped', () => {
    ops.setWaitingThresholdMinutes(20);
    expect(ops.waitingThresholdMinutes()).toBe(20);
    let snap = ops.snapshot(null);
    expect(new Map(snap.tiles.map((t) => [t.key, t.count])).get('waiting_over_threshold')).toBe(2); // #1 (5h) and #2 (30min)
    ops.setWaitingThresholdMinutes(0); // clamps to 1
    expect(ops.waitingThresholdMinutes()).toBe(1);
    ops.setWaitingThresholdMinutes(999999); // clamps to 20160
    expect(ops.waitingThresholdMinutes()).toBe(20160);
    snap = ops.snapshot(null);
    expect(new Map(snap.tiles.map((t) => [t.key, t.count])).get('waiting_over_threshold')).toBe(0);
    ops.setWaitingThresholdMinutes(240); // restore default
  });

  it('non-conversation tiles read their real sources', () => {
    db.prepare(`INSERT INTO jobs (queue, type, status, payload) VALUES ('ai', 'automation_action_awaiting_approval', 'parked', '{}')`).run();
    db.prepare(`INSERT INTO issue_clusters (title, trend) VALUES ('Spike', 'rising')`).run();
    db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('sync_state', '\"ERROR\"', datetime('now'))").run();
    db.prepare(`INSERT INTO application_errors (service, message, timestamp) VALUES ('sync', 'boom', datetime('now'))`).run();
    const snap = ops.snapshot(null);
    const by = new Map(snap.tiles.map((t) => [t.key, t.count]));
    expect(by.get('automation_approvals')).toBe(1);
    expect(by.get('issue_spike')).toBe(1);
    expect(by.get('sync_problems')).toBe(2); // ERROR state + 1 error in 24h
    expect(new Map(snap.tiles.map((t) => [t.key, t.severity])).get('sync_problems')).toBe('critical');
  });
});

describe('WorkloadService', () => {
  const ALEX = 1;
  const PRIYA = 2;

  it('computes per-agent workload with tiered pressure', () => {
    // Alex: #3 (urgent, assigned) + closed-7d 1. Priya: no open work.
    const snap = workload.snapshot();
    const alex = snap.agents.find((a) => a.user_local_id === ALEX)!;
    const priya = snap.agents.find((a) => a.user_local_id === PRIYA)!;
    expect(alex.open_workload).toBe(1);
    expect(alex.urgent_workload).toBe(1);
    expect(alex.weighted_load).toBe(3); // default urgent weight
    expect(alex.capacity).toBe(25); // default model
    expect(alex.pressure).toBe(0.12); // 3/25
    expect(alex.recent_closed_7d).toBe(1);
    expect(priya.open_workload).toBe(0);
    expect(priya.pressure).toBe(0);
    expect(snap.unassigned_work).toBe(10);
    // availability is reported as synced (never guessed)
    expect(alex.availability).toEqual({ email_status: 'active', chat_status: 'active', source: 'user_statuses' });
    expect(priya.availability.email_status).toBe('away');
  });

  it('capacity model round-trips with per-user overrides and custom weights', () => {
    workload.setCapacityModel({ default_max_open: 10, per_user_max: { [String(ALEX)]: 4 }, weights: { urgent: 5, sla: 2, waiting: 1.5, open: 1 } });
    const snap = workload.snapshot();
    const alex = snap.agents.find((a) => a.user_local_id === ALEX)!;
    expect(alex.capacity).toBe(4);
    expect(alex.weighted_load).toBe(5); // urgent weight now 5
    expect(alex.pressure).toBe(1.25); // 5/4
    // restore
    workload.setCapacityModel({ default_max_open: 25, per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } });
  });

  it('an invalid stored capacity model falls back to defaults (never guesses)', () => {
    settings.set(CAPACITY_SETTING_KEY, { default_max_open: 'lots' });
    const snap = workload.snapshot();
    expect(snap.capacity_model.default_max_open).toBe(25);
    expect(snap.agents.find((a) => a.user_local_id === ALEX)!.capacity).toBe(25);
    settings.set(CAPACITY_SETTING_KEY, { default_max_open: 25, per_user_max: {}, weights: { urgent: 3, sla: 2, waiting: 1.5, open: 1 } });
  });

  it('team workload aggregates members', () => {
    const snap = workload.snapshot();
    const tier1 = snap.teams[0]!;
    expect(tier1.name).toBe('Tier 1');
    expect(tier1.member_user_local_ids.sort()).toEqual([ALEX, PRIYA].sort());
    expect(tier1.open_workload).toBe(1); // Alex's urgent conversation
    expect(tier1.capacity).toBe(50);
    expect(tier1.available_members).toBe(1); // only Alex is active
    expect(tier1.total_members).toBe(2);
  });

  it('suggests the available agent with the lowest resulting pressure (read-only)', () => {
    const suggestions = workload.suggestedAssignees(5);
    expect(suggestions.length).toBeGreaterThan(0);
    // The top unassigned conversation is urgent (#4 in Billing or others); the
    // suggestion must be Priya (away=0 open) vs Alex? No: Alex is AVAILABLE,
    // Priya is AWAY - availability ranks first even with more pressure.
    const top = suggestions[0]!;
    expect(top.suggested_user_local_id).toBe(ALEX); // available beats lower load
    expect(top.reason).toContain('available');
    expect(top.all_away).toBe(false);
    // The response is data-only: nothing was reassigned by computing it.
    const stillUnassigned = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ? AND assignee_local_id IS NULL').get(top.conversation_id) as Row;
    expect(Number(stillUnassigned.n)).toBe(1);
  });
});
