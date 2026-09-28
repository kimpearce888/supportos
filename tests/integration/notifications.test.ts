import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { NotificationRepository } from '../../src/server/database/repositories/notificationRepo.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';
import { SideThreadRepository, } from '../../src/server/database/repositories/sideThreadRepo.js';
import { SlaService } from '../../src/server/analytics/slaService.js';
import { NotificationSweep } from '../../src/server/notifications/notificationSweep.js';
import { SideThreadService } from '../../src/server/collaboration/sideThreadService.js';
import { buildMentionDirectory, parseMentions } from '../../src/server/collaboration/mentionParser.js';

/**
 * v1.8.0 integration tests (M2): the Notification Center store, the sweep
 * (single notification producer), and side collaboration threads + mentions,
 * on a REAL SQLite database with migration 012 applied.
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let notifications: NotificationRepository;
let settings: SettingsRepository;
let sweep: NotificationSweep;
let sideThreads: SideThreadService;
let sideThreadRepo: SideThreadRepository;

function nowIso(): string {
  return new Date().toISOString();
}
function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60000).toISOString();
}
function soonIso(): string {
  return new Date(Date.now() + 5 * 60000).toISOString();
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  notifications = new NotificationRepository(db);
  settings = new SettingsRepository(db);
  const sla = new SlaService(db);
  sweep = new NotificationSweep(db, notifications, sla, settings);
  sideThreads = new SideThreadService(db, sweep);
  sideThreadRepo = new SideThreadRepository(db);

  // Reference world: 2 mailboxes, 3 users (mention names), 2 teams, 2 customers.
  // Local ids are RESOLVED (never assumed): users 1/2/3 by insert order, but
  // every assertion goes through these constants.
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (201, 'Support', 'support'), (202, 'Billing', 'billing')").run();
  db.prepare("INSERT INTO users (remote_id, first_name, last_name, mention) VALUES (1001, 'Alex', 'Rivera', 'alex'), (1002, 'Priya', 'Nair', 'priya'), (1003, 'Tom', 'Bright', 'tom')").run();
  db.prepare("INSERT INTO teams (remote_id, name) VALUES (501, 'Tier 1'), (502, 'Escalations')").run();
  const alex = Number((db.prepare('SELECT id FROM users WHERE remote_id = 1001').get() as Row).id);
  const priya = Number((db.prepare('SELECT id FROM users WHERE remote_id = 1002').get() as Row).id);
  const tom = Number((db.prepare('SELECT id FROM users WHERE remote_id = 1003').get() as Row).id);
  const tier1 = Number((db.prepare('SELECT id FROM teams WHERE remote_id = 501').get() as Row).id);
  const escalations = Number((db.prepare('SELECT id FROM teams WHERE remote_id = 502').get() as Row).id);
  db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?), (?, ?), (?, ?)').run(tier1, alex, tier1, priya, escalations, tom);
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name) VALUES (601, 'Ada', 'Lovelace'), (602, 'Grace', 'Hopper')").run();
  // Identity: the connected user is Priya
  settings.set('me_remote_id', 1002);
  // The mirror is settled for these tests (the sweep defers its cursor
  // initialization while a first sync is still running).
  settings.set('sync_state', 'LIVE');
  ALEX = alex;
  PRIYA = priya;
  TOM = tom;
  TIER1 = tier1;
});

let ALEX: number;
let PRIYA: number;
let TOM: number;
let TIER1: number;

afterAll(() => {
  closeDatabase(db);
});

describe('NotificationRepository', () => {
  it('inserts with dedup: re-inserting the same key is a no-op', () => {
    const a = notifications.insert({ type: 'customer_replied', title: 'A', dedup_key: 'x:1' });
    const b = notifications.insert({ type: 'customer_replied', title: 'A2', dedup_key: 'x:1' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(notifications.list({ meUserLocalId: null }).total).toBe(1);
  });

  it('targeting: broadcast rows visible to everyone, targeted rows only to their target', () => {
    notifications.insert({ type: 'sla_breach', title: 'B', dedup_key: 'x:2', target_user_local_id: null });
    notifications.insert({ type: 'ticket_assigned', title: 'C', dedup_key: 'x:3', target_user_local_id: PRIYA });
    notifications.insert({ type: 'ticket_assigned', title: 'D', dedup_key: 'x:4', target_user_local_id: ALEX });
    const forPriya = notifications.list({ meUserLocalId: PRIYA }).notifications;
    const forAlex = notifications.list({ meUserLocalId: ALEX }).notifications;
    const forTom = notifications.list({ meUserLocalId: TOM }).notifications;
    expect(forPriya.map((n) => n.title).sort()).toEqual(['A', 'B', 'C']); // A is broadcast too
    expect(forAlex.map((n) => n.title).sort()).toEqual(['A', 'B', 'D']);
    expect(forTom.map((n) => n.title).sort()).toEqual(['A', 'B']);
  });

  it('unread counts, markRead (visibility-checked) and markAllRead', () => {
    expect(notifications.unreadCount(PRIYA)).toBe(3); // A (broadcast) + B + C
    expect(notifications.markRead(999, PRIYA)).toBe(false); // nonexistent
    const priyaRows = notifications.list({ meUserLocalId: PRIYA }).notifications;
    const targeted = priyaRows.find((n) => n.title === 'C')!;
    // Alex cannot mark Priya's targeted row read
    expect(notifications.markRead(targeted.id, ALEX)).toBe(false);
    expect(notifications.markRead(targeted.id, PRIYA)).toBe(true);
    expect(notifications.unreadCount(PRIYA)).toBe(2);
    expect(notifications.markAllRead(PRIYA)).toBe(2);
    expect(notifications.unreadCount(PRIYA)).toBe(0);
  });

  it('mentionsForMe returns only mention-type notifications targeting the user', () => {
    notifications.insert({ type: 'mentioned', title: 'M1', dedup_key: 'x:5', target_user_local_id: PRIYA });
    notifications.insert({ type: 'mentioned', title: 'M2', dedup_key: 'x:6', target_user_local_id: ALEX });
    notifications.insert({ type: 'team_mentioned', title: 'M3', dedup_key: 'x:7', target_user_local_id: PRIYA });
    const mine = notifications.mentionsForMe(PRIYA);
    expect(mine.map((n) => n.title).sort()).toEqual(['M1', 'M3']);
  });

  it('preferences: missing row = default (on), setPref flips, disabled types insert nothing', () => {
    expect(notifications.prefFor('customer_replied')).toBe(true);
    notifications.setPref('customer_replied', false);
    expect(notifications.prefFor('customer_replied')).toBe(false);
    const prefs = notifications.listPrefs();
    expect(prefs.find((p) => p.type === 'customer_replied')?.enabled).toBe(false);
    expect(prefs.find((p) => p.type === 'sla_breach')?.enabled).toBe(true);
    notifications.setPref('customer_replied', true);
  });

  it('prunes old rows by created_at and read_at (julianday comparisons)', () => {
    notifications.insert({ type: 'customer_event', title: 'OLD', dedup_key: 'x:8' });
    db.prepare("UPDATE notifications SET created_at = datetime('now', '-40 days') WHERE dedup_key = 'x:8'").run();
    notifications.insert({ type: 'customer_event', title: 'READ-OLD', dedup_key: 'x:9' });
    db.prepare("UPDATE notifications SET read_at = datetime('now', '-40 days') WHERE dedup_key = 'x:9'").run();
    const removed = notifications.pruneOlderThan(new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19));
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(notifications.list({ meUserLocalId: null }).notifications.find((n) => n.title === 'OLD')).toBeUndefined();
  });
});

describe('NotificationSweep', () => {
  // ---- a conversation world to sweep over ----
  let convId: number;
  let convAssignedId: number;

  function insertConversation(opts: { remote: number; number: number; status?: string; assignee?: number | null; mailbox?: number }): number {
    db.prepare(
      `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, assignee_local_id, remote_created_at, local_created_at, local_updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))`
    ).run(opts.remote, opts.number, `Subject ${opts.number}`, opts.status ?? 'active', opts.mailbox ?? 1, opts.assignee ?? null, minutesAgo(600));
    return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(opts.remote) as Row).id);
  }

  function insertThread(conv: number, remote: number, type: string, fromType: string, byUser: number | null, body: string, at: string): number {
    const r = db.prepare(
      `INSERT INTO threads (remote_id, conversation_id, type, state, body_text, from_type, created_by_user_id, remote_created_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?, ?)`
    ).run(remote, conv, type, body, fromType, byUser, at);
    return Number(r.lastInsertRowid);
  }

  function insertEvent(conv: number, type: string, dedup: string, thread: number | null, actor: number | null, metadata: Record<string, unknown> = {}): number {
    const r = db.prepare(
      `INSERT INTO conversation_events (conversation_id, thread_local_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
       VALUES (?, ?, ?, 'user', ?, ?, 'sync', ?, ?)`
    ).run(conv, thread, type, actor, minutesAgo(10), JSON.stringify(metadata), dedup);
    return Number(r.lastInsertRowid);
  }

  it('first sweep defers while the initial sync runs, then initializes silently', () => {
    // While the first sync is still running (NEW/INITIALIZING/BACKFILLING),
    // the sweep must NOT initialize its cursor - otherwise the entire
    // first-sync history would arrive after the cursor and notify (the
    // fresh-install spam bug, found live during browser verification).
    settings.set('sync_state', 'INITIALIZING');
    expect(sweep.sweep()).toEqual({ created: 0 });
    expect(settings.get<number | null>('notif_event_cursor', null)).toBeNull();
    settings.set('sync_state', 'BACKFILLING');
    expect(sweep.sweep()).toEqual({ created: 0 });
    expect(settings.get<number | null>('notif_event_cursor', null)).toBeNull();
    // Mirror settled: initialize silently (history never notifies)
    settings.set('sync_state', 'LIVE');
    const result = sweep.sweep();
    expect(result.created).toBe(0);
    expect(settings.get<number | null>('notif_event_cursor', null)).toBeTypeOf('number');
  });

  it('customer_message events notify the assignee (or broadcast when unassigned)', () => {
    convId = insertConversation({ remote: 9001, number: 101 });
    const t = insertThread(convId, 11001, 'customer', 'customer', null, 'Where is my order?', minutesAgo(9));
    insertEvent(convId, 'customer_message', `thread:11001`, t, null);
    const created = sweep.sweep();
    expect(created.created).toBe(1);
    const list = notifications.list({ meUserLocalId: null }).notifications;
    const n = list.find((x) => x.type === 'customer_replied')!;
    expect(n.target_user_local_id).toBeNull(); // unassigned -> broadcast
    expect(n.conversation_number).toBe(101);
    expect(n.title).toContain('#101');
    expect(n.body).toContain('Where is my order?');
  });

  it('re-running the sweep never duplicates (event dedup keys are reused)', () => {
    const before = notifications.list({ meUserLocalId: null }).total;
    const again = sweep.sweep();
    expect(again.created).toBe(0);
    expect(notifications.list({ meUserLocalId: null }).total).toBe(before);
  });

  it('assignment_changed notifies the NEW assignee (not the actor, not broadcasts)', () => {
    convAssignedId = insertConversation({ remote: 9002, number: 102, assignee: ALEX });
    insertEvent(convAssignedId, 'assignment_changed', `assignment_changed:9002:${nowIso()}`, null, ALEX, { previous: null, next: ALEX });
    // self-assignment (actor == next) must NOT notify
    const created = sweep.sweep();
    expect(created.created).toBe(0);
    // a change by someone else TO Priya notifies Priya
    insertEvent(convAssignedId, 'assignment_changed', `assignment_changed:9002:${nowIso()}b`, null, ALEX, { previous: ALEX, next: PRIYA });
    const created2 = sweep.sweep();
    expect(created2.created).toBe(1);
    const n = notifications.list({ meUserLocalId: PRIYA }).notifications.find((x) => x.type === 'ticket_assigned')!;
    expect(n.target_user_local_id).toBe(PRIYA);
    expect(n.title).toContain('Priya');
  });

  it('internal_note mentions notify the mentioned user (not the author)', () => {
    const conv = insertConversation({ remote: 9003, number: 103, assignee: ALEX });
    const note = insertThread(conv, 11003, 'note', 'user', ALEX, '@priya can you take this one?', minutesAgo(5));
    insertEvent(conv, 'internal_note', 'thread:11003', note, ALEX);
    const created = sweep.sweep();
    expect(created.created).toBe(1);
    const n = notifications.list({ meUserLocalId: PRIYA }).notifications.find((x) => x.type === 'mentioned')!;
    expect(n.target_user_local_id).toBe(PRIYA);
    expect(n.title).toContain('mentioned you');
    expect(n.conversation_number).toBe(103);
  });

  it('SLA at-risk and breach notifications (business minutes, day dedup)', () => {
    // 24/7 business hours, first-response target 60 minutes
    db.prepare(
      `INSERT INTO mailbox_business_hours (mailbox_local_id, timezone, days, start_minute, end_minute, first_response_target_min, resolution_target_min, updated_at)
       VALUES (2, 'UTC', '[0,1,2,3,4,5,6]', 0, 1440, 60, 480, datetime('now'))`
    ).run();
    // breached: customer message 120 minutes ago, no reply
    const breached = insertConversation({ remote: 9101, number: 201, mailbox: 2 });
    insertThread(breached, 12001, 'customer', 'customer', null, 'help', minutesAgo(120));
    db.prepare('UPDATE conversations SET last_customer_reply_at = ? WHERE id = ?').run(minutesAgo(120), breached);
    // at risk: customer message 50 minutes ago (>= 80% of 60)
    const atRisk = insertConversation({ remote: 9102, number: 202, mailbox: 2 });
    insertThread(atRisk, 12002, 'customer', 'customer', null, 'hello', minutesAgo(50));
    db.prepare('UPDATE conversations SET last_customer_reply_at = ? WHERE id = ?').run(minutesAgo(50), atRisk);

    sweep.sweep();
    const list = notifications.list({ meUserLocalId: null }).notifications;
    const breach = list.find((n) => n.type === 'sla_breach');
    const risk = list.find((n) => n.type === 'sla_risk');
    expect(breach).toBeTruthy();
    expect(risk).toBeTruthy();
    expect(breach!.conversation_number).toBe(201);
    expect(risk!.conversation_number).toBe(202);
    expect(risk!.severity).toBe('warning');
    expect(breach!.severity).toBe('critical');
    // day-dedup: same-day re-sweep creates nothing new
    const again = sweep.sweep();
    expect(again.created).toBe(0);
  });

  it('automation approval jobs notify once per job', () => {
    const jobId = db
      .prepare(`INSERT INTO jobs (queue, type, status, payload, priority) VALUES ('ai', 'automation_action_awaiting_approval', 'parked', ?, 2)`)
      .run(JSON.stringify({ ruleId: 1, conversationId: convId, action: { kind: 'add_tag', params: { tag: 'vip' } } }));
    const created = sweep.sweep();
    expect(created.created).toBe(1);
    const n = notifications.list({ meUserLocalId: null }).notifications.find((x) => x.type === 'automation_approval')!;
    expect(n.job_id).toBe(Number(jobId.lastInsertRowid));
    expect(n.title).toContain('add_tag');
    const again = sweep.sweep();
    expect(again.created).toBe(0);
  });

  it('failed jobs notify when they fail after the last sweep', () => {
    const fail = db
      .prepare(`INSERT INTO jobs (queue, type, status, error, created_at, completed_at) VALUES ('api', 'add_tag', 'failed', 'boom', datetime('now'), datetime('now', '+1 minute'))`)
      .run();
    const created = sweep.sweep();
    expect(created.created).toBe(1);
    const n = notifications.list({ meUserLocalId: null }).notifications.find((x) => x.type === 'job_failure')!;
    expect(n.job_id).toBe(Number(fail.lastInsertRowid));
    expect(n.body).toContain('boom');
    const again = sweep.sweep();
    expect(again.created).toBe(0); // dedup per job id
  });

  it('sync ERROR state notifies once per day', () => {
    settings.set('sync_state', 'ERROR');
    const created = sweep.sweep();
    expect(created.created).toBe(1);
    expect(notifications.list({ meUserLocalId: null }).notifications.find((n) => n.type === 'sync_failure')).toBeTruthy();
    expect(sweep.sweep().created).toBe(0);
    settings.set('sync_state', 'LIVE');
  });

  it('known issues, issue spikes, campaign replies, ratings and AI escalations notify', () => {
    // known issue created "after" the last sweep stamp (same-second inserts
    // would be skipped as already-seen, so +1 minute is the honest stamp)
    const ki = db.prepare(`INSERT INTO known_issues (title, status, created_at) VALUES ('Login broken', 'investigating', datetime('now', '+1 minute'))`).run();
    // issue cluster trending up, updated after the last sweep
    db.prepare(`INSERT INTO issue_clusters (title, trend, conversation_count, updated_at) VALUES ('Login broken', 'rising', 5, datetime('now', '+1 minute'))`).run();
    // campaign with a replied recipient
    const campaign = db.prepare(`INSERT INTO outreach_campaigns (name, subject, body, mailbox_local_id, status) VALUES ('Winback', 'We miss you', 'hi', 1, 'completed')`).run();
    db.prepare(
      `INSERT INTO outreach_recipients (campaign_id, customer_local_id, snapshot, state, replied_at) VALUES (?, 1, '{}', 'replied', ?)`
    ).run(Number(campaign.lastInsertRowid), soonIso());
    // not-good rating
    db.prepare(`INSERT INTO ratings (remote_id, conversation_id, rating, comments, customer_local_id, remote_created_at) VALUES (77701, ?, 'not-good', 'still broken', 1, ?)`).run(convId, soonIso());
    // AI escalation: latest analysis with critical urgency, high confidence, open conversation
    db.prepare(
      `INSERT INTO ai_runs (type, conversation_id, status, output, created_at) VALUES ('ticket_analysis', ?, 'completed', ?, datetime('now', '+1 minute'))`
    ).run(convId, JSON.stringify({ urgency: 'critical', sentiment: 'neutral', confidence: 'high' }));

    sweep.sweep();
    const list = notifications.list({ meUserLocalId: null }).notifications;
    expect(list.find((n) => n.type === 'known_issue_detected')!.issue_id).toBe(Number(ki.lastInsertRowid));
    expect(list.find((n) => n.type === 'issue_spike')).toBeTruthy();
    expect(list.find((n) => n.type === 'campaign_reply')!.campaign_id).toBe(Number(campaign.lastInsertRowid));
    expect(list.find((n) => n.type === 'customer_event')!.title).toContain('Not-good rating');
    expect(list.find((n) => n.type === 'ai_escalation')!.conversation_number).toBe(101);
    // idempotent
    expect(sweep.sweep().created).toBe(0);
  });

  it('a disabled preference type produces no row at all', () => {
    notifications.setPref('job_failure', false);
    db.prepare(`INSERT INTO jobs (queue, type, status, error, created_at, completed_at) VALUES ('api', 'add_tag', 'failed', 'boom2', datetime('now'), datetime('now', '+1 minute'))`).run();
    const created = sweep.sweep();
    expect(created.created).toBe(0);
    notifications.setPref('job_failure', true);
  });
});

describe('Side threads + mentions', () => {
  let convId: number;

  beforeAll(() => {
    db.prepare(
      `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, local_created_at, local_updated_at)
       VALUES (9501, 301, 'Side thread host', 'active', 1, 1, datetime('now'), datetime('now'), datetime('now'))`
    ).run();
    convId = Number((db.prepare('SELECT id FROM conversations WHERE remote_id = 9501').get() as Row).id);
  });

  it('creates a thread with participants, creator auto-joined', () => {
    const created = sideThreads.createThread(convId, { title: 'Engineering', participant_user_ids: [ALEX], team_local_id: null, first_message: 'Investigating now @priya' }, ALEX);
    expect(created).not.toBeNull();
    expect(created!.messages).toHaveLength(1);
    // author + the auto-joined @priya mention from the first message
    expect(created!.participants.map((p) => p.user_local_id).sort()).toEqual([ALEX, PRIYA]);
  });

  it('mention auto-joins the mentioned user as participant', () => {
    const thread = sideThreads.getThread(1)!;
    expect(thread.participants.map((p) => p.user_local_id)).toContain(PRIYA);
  });

  it('user mention in a message creates a targeted notification immediately', () => {
    const before = notifications.list({ meUserLocalId: PRIYA }).total;
    const { thread } = sideThreads.addMessage(1, '@tom please check the logs', ALEX);
    expect(thread!.messages).toHaveLength(2);
    const list = notifications.list({ meUserLocalId: TOM }).notifications;
    const n = list.find((x) => x.type === 'mentioned' && x.side_thread_id === 1);
    expect(n).toBeTruthy();
    expect(n!.target_user_local_id).toBe(TOM);
    expect(notifications.list({ meUserLocalId: PRIYA }).total).toBe(before);
  });

  it('team mention fans out to every member except the author', () => {
    sideThreads.addMessage(1, 'looping in @Tier 1 for visibility', PRIYA);
    const forAlex = notifications.list({ meUserLocalId: ALEX }).notifications.find((x) => x.type === 'team_mentioned');
    const forTom = notifications.list({ meUserLocalId: TOM }).notifications.filter((x) => x.type === 'team_mentioned');
    expect(forAlex).toBeTruthy(); // Tier 1 = [Alex, Priya], author Priya skipped
    expect(forTom).toHaveLength(0); // Tom is Escalations, not Tier 1
  });

  it('mention rows power the mentions-for-me queue with conversation links', () => {
    const forPriya = sideThreadRepo.mentionsForUser(PRIYA);
    expect(forPriya.length).toBeGreaterThanOrEqual(1);
    expect(forPriya[0]!.conversation_id).toBe(convId);
    expect(forPriya[0]!.thread_title).toBe('Engineering');
  });

  it('resolve blocks new messages (409-style error) and reopen unblocks', () => {
    expect(sideThreads.setStatus(1, 'resolved', PRIYA)).toBe(true);
    expect(() => sideThreads.addMessage(1, 'late message', ALEX)).toThrow(/resolved/);
    expect(sideThreads.setStatus(1, 'open', PRIYA)).toBe(true);
    const { thread } = sideThreads.addMessage(1, 'back open', ALEX);
    expect(thread!.messages.length).toBeGreaterThanOrEqual(4);
  });

  it('adding participants is audited and idempotent (auto-join covered the rest)', () => {
    // The @tom mention already auto-joined Tom to thread 1 - adding him again
    // is a no-op (ON CONFLICT DO NOTHING).
    expect(sideThreads.addParticipants(1, [TOM], ALEX)).toEqual([]);
    const thread = sideThreads.getThread(1)!;
    expect(thread.participants.map((p) => p.user_local_id).sort()).toEqual([ALEX, PRIYA, TOM]);
    // A fresh thread exercises the ADD path + its audit entry.
    const fresh = sideThreads.createThread(thread.conversation_id, { title: 'Billing', participant_user_ids: [ALEX] }, ALEX)!;
    expect(sideThreads.addParticipants(fresh.id, [TOM], ALEX)).toEqual([TOM]);
    expect(sideThreads.addParticipants(fresh.id, [TOM], ALEX)).toEqual([]);
  });

  it('every mutation wrote audit_log entries', () => {
    const audit = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'side_thread%' ORDER BY id").all() as Row[];
    const actions = audit.map((a) => String(a.action));
    expect(actions).toContain('side_thread_created');
    expect(actions).toContain('side_thread_message');
    expect(actions).toContain('side_thread_participants_added');
    expect(actions).toContain('side_thread_resolved');
    expect(actions).toContain('side_thread_reopened');
  });

  it('unknown @tokens in side thread bodies create no notifications', () => {
    const before = notifications.list({ meUserLocalId: null }).total;
    sideThreads.addMessage(1, '@who-is-this exactly?', 1);
    expect(notifications.list({ meUserLocalId: null }).total).toBe(before);
  });
});

describe('mention directory against the DB', () => {
  it('resolves mention names, first names and full names to local ids', () => {
    const dir = buildMentionDirectory(db);
    expect(dir.userByName.get('alex')).toBe(ALEX);
    expect(dir.userByName.get('priya')).toBe(PRIYA);
    expect(dir.userByName.get('tom')).toBe(TOM);
    expect(dir.userByName.get('alex rivera')).toBe(ALEX);
    expect(dir.teamByName.get('tier 1')).toBe(TIER1);
    const m = parseMentions('cc @Alex Rivera and @tom', dir);
    expect(m.map((x) => x.user_local_id).sort((a, b) => a - b)).toEqual([ALEX, TOM]);
  });
});
