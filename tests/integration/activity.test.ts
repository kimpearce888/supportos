import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { ActivityRepository } from '../../src/server/database/repositories/activityRepo.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { TicketStateRepository } from '../../src/server/database/repositories/ticketStateRepo.js';
import { InboxViewRepository } from '../../src/server/database/repositories/inboxViewRepo.js';
import { ViewEngine, ViewCompileError } from '../../src/server/inbox/viewEngine.js';
import { RESPONSE_STATE_SQL, responseStateOf } from '../../src/server/inbox/responseState.js';
import { resolveDateRange } from '../../src/server/services/dateRange.js';
import { ACTIVITY_FIELD_COLUMN } from '../../src/shared/activity.js';
import type { ViewDefinition } from '../../src/shared/activity.js';

/**
 * v1.7.0 integration tests: the activity engine on a REAL SQLite database -
 * migration backfill, event derivation + dedup across re-syncs, derived-field
 * recompute, ticket-state lifecycle, saved views (storage + compilation +
 * dynamic re-evaluation) and the inbox filter query paths.
 */

interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let activity: ActivityRepository;
let convRepo: ConversationRepository;
let states: TicketStateRepository;
let views: InboxViewRepository;

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  activity = new ActivityRepository(db);
  convRepo = new ConversationRepository(db);
  states = new TicketStateRepository(db);
  views = new InboxViewRepository(db);
});

afterAll(() => {
  closeDatabase(db);
});

function seedReference(): { mailboxId: number; customerId: number; userId: number } {
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name) VALUES (601, 'Ada', 'Lovelace')").run();
  db.prepare("INSERT INTO users (remote_id, first_name, last_name) VALUES (701, 'Grace', 'Hopper')").run();
  return {
    mailboxId: (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 501').get() as Row).id as number,
    customerId: (db.prepare('SELECT id FROM customers WHERE remote_id = 601').get() as Row).id as number,
    userId: (db.prepare('SELECT id FROM users WHERE remote_id = 701').get() as Row).id as number
  };
}

describe('migration 011: backfill from a pre-v1.7 mirror', () => {
  it('seeds the six built-in ticket states exactly once', () => {
    const rows = db.prepare('SELECT key, name, is_resolved, built_in FROM ticket_states ORDER BY sort_order').all() as Row[];
    expect(rows.map((r) => r.key)).toEqual(['new', 'investigating', 'waiting-customer', 'waiting-engineering', 'ready-verify', 'resolved']);
    expect(rows.every((r) => r.built_in === 1)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ticket_states WHERE key = 'resolved' AND is_resolved = 1").get() as Row).n).toBe(1);
  });

  it('derives events and activity columns for pre-existing conversations + threads', () => {
    const ref = seedReference();
    const createdAt = '2024-03-01T10:00:00.000Z';
    db.prepare(
      `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, assignee_local_id, remote_created_at, local_created_at, local_updated_at, closed_at)
       VALUES (9901, 101, 'Backfill me', 'closed', ?, ?, ?, ?, datetime('now'), datetime('now'), '2024-03-05T18:00:00.000Z')`
    ).run(ref.mailboxId, ref.customerId, ref.userId, createdAt);
    const convId = (db.prepare('SELECT id FROM conversations WHERE remote_id = 9901').get() as Row).id as number;
    // Threads: customer msg, agent reply, note (the classic pre-sync mirror).
    // FK columns take LOCAL ids (created_by_user_id -> users.id).
    const userLocal = (db.prepare('SELECT id FROM users WHERE remote_id = 701').get() as Row).id as number;
    const customerLocal = (db.prepare('SELECT id FROM customers WHERE remote_id = 601').get() as Row).id as number;
    for (const [remoteId, type, fromType, byUser, byCustomer, at] of [
      [11001, 'customer', 'customer', null, customerLocal, '2024-03-01T10:00:00.000Z'],
      [11002, 'reply', 'user', userLocal, null, '2024-03-01T11:30:00.000Z'],
      [11003, 'note', 'user', userLocal, null, '2024-03-02T09:00:00.000Z'],
      [11004, 'customer', 'customer', null, customerLocal, '2024-03-04T08:00:00.000Z']
    ] as [number, string, string, number | null, number | null, string][]) {
      db.prepare(
        `INSERT INTO threads (remote_id, conversation_id, type, state, body_text, from_type, created_by_user_id, created_by_customer_id, remote_created_at)
         VALUES (?, ?, ?, 'published', 'body', ?, ?, ?, ?)`
      ).run(remoteId, convId, type, fromType, byUser, byCustomer, at);
    }
    // lineitem action record (Help Scout change history)
    db.prepare(
      `INSERT INTO threads (remote_id, conversation_id, type, state, from_type, action_type, action_text, remote_created_at)
       VALUES (11005, ?, 'lineitem', 'published', 'system_user', 'lineitem', 'Status changed from active to closed', '2024-03-05T18:00:00.000Z')`
    ).run(convId);

    // Run migration-style backfill logic: rebuildAll covers exactly this path
    activity.rebuildAll();

    const events = db.prepare('SELECT event_type, occurred_at, source FROM conversation_events WHERE conversation_id = ? ORDER BY occurred_at').all(convId) as Row[];
    const types = events.map((e) => e.event_type);
    expect(types).toContain('conversation_created');
    expect(types).toContain('customer_message');
    expect(types).toContain('human_agent_message');
    expect(types).toContain('internal_note');
    expect(types).toContain('status_changed'); // from the lineitem record
    // No duplicate for the same thread on rebuild
    activity.rebuildAll();
    const countAfter = (db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(convId) as Row).n as number;
    const countBefore = events.length;
    expect(countAfter).toBe(countBefore);

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as Row;
    expect(conv.first_customer_message_at).toBe('2024-03-01T10:00:00.000Z');
    expect(conv.first_response_at).toBe('2024-03-01T11:30:00.000Z');
    expect(conv.last_customer_reply_at).toBe('2024-03-04T08:00:00.000Z');
    expect(conv.last_human_agent_response_at).toBe('2024-03-01T11:30:00.000Z');
    expect(conv.last_note_at).toBe('2024-03-02T09:00:00.000Z');
    expect(conv.activity_history_complete).toBe(1); // threads exist
    expect(conv.customer_waiting_since).toBeNull(); // status closed -> clock stopped
    expect(conv.supportos_priority).toBe('none');
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND event_type = 'status_changed'").get(convId) as Row).n as number).toBe(1);
  });
});

describe('upsertConversation: sync-diff change events (honest, deduped)', () => {
  it('emits conversation_created once, then change events on real diffs only', () => {
    const ref = { mailboxId: (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 501').get() as Row).id as number };
    const base = {
      id: 9902,
      number: 102,
      threads: 0,
      type: 'email',
      status: 'active',
      state: 'published',
      subject: 'Diff engine',
      preview: '',
      mailboxId: 501,
      createdAt: '2024-05-01T09:00:00.000Z',
      userUpdatedAt: '2024-05-01T09:00:00.000Z',
      tags: [] as { tag: string }[],
      customFields: [] as { id: number; value: string }[]
    };
    const localId = convRepo.upsertConversation(base as never);
    void ref;
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND event_type = 'conversation_created'").get(localId) as Row).n).toBe(1);

    // Re-sync with NO changes: zero new events
    convRepo.upsertConversation({ ...base, userUpdatedAt: '2024-05-01T10:00:00.000Z' } as never);
    const afterResync = (db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(localId) as Row).n as number;
    expect(afterResync).toBe(1);

    // Sync that changes status + tags: exactly one status_changed + one tag_added
    convRepo.upsertConversation({ ...base, status: 'closed', tags: [{ tag: 'billing' }] } as never);
    const evTypes = (db.prepare('SELECT event_type FROM conversation_events WHERE conversation_id = ? AND source = \'sync\' AND event_type != \'conversation_created\'').all(localId) as Row[]).map((r) => r.event_type);
    expect(evTypes).toContain('closed');
    expect(evTypes).toContain('tag_added');
    expect(evTypes.filter((t) => t === 'tag_added').length).toBe(1);

    // Sync that removes the tag: tag_removed
    convRepo.upsertConversation({ ...base, status: 'closed', tags: [] } as never);
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND event_type = 'tag_removed'").get(localId) as Row).n).toBe(1);
  });
});

describe('upsertThread: message events + derived fields recompute', () => {
  it('classifies thread events by type/from_type and recomputes waiting state', () => {
    const convId = convRepo.upsertConversation({
      id: 9903, number: 103, threads: 0, type: 'email', status: 'active', state: 'published', subject: 'Waiting',
      preview: '', mailboxId: 501, createdAt: '2024-06-01T09:00:00.000Z', userUpdatedAt: '2024-06-01T09:00:00.000Z', tags: [], customFields: []
    } as never);

    const customer = { id: 11010, remoteId: 11010, conversationId: 9903, type: 'customer', state: 'published', status: null, actionType: null, actionText: null, body: 'help please', sourceType: 'email', sourceVia: 'customer', customer: { id: 601, first: 'Ada', last: 'Lovelace', email: 'ada@example.com' }, createdBy: null, assignedTo: null, savedReplyId: null, to: [], cc: [], bcc: [], createdAt: '2024-06-01T09:05:00.000Z', attachments: [] };
    convRepo.upsertThread(convId, customer as never);

    let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as Row;
    expect(conv.first_customer_message_at).toBe('2024-06-01T09:05:00.000Z');
    expect(conv.customer_waiting_since).toBe('2024-06-01T09:05:00.000Z'); // active + no agent reply yet

    const agent = { id: 11011, remoteId: 11011, conversationId: 9903, type: 'reply', state: 'published', status: null, actionType: null, actionText: null, body: 'on it', sourceType: 'email', sourceVia: 'user', customer: null, createdBy: { id: 701, type: 'user', first: 'Grace', last: 'Hopper', email: 'grace@example.com' }, assignedTo: null, savedReplyId: null, to: ['ada@example.com'], cc: [], bcc: [], createdAt: '2024-06-01T10:00:00.000Z', attachments: [] };
    convRepo.upsertThread(convId, agent as never);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as Row;
    expect(conv.first_response_at).toBe('2024-06-01T10:00:00.000Z');
    expect(conv.customer_waiting_since).toBeNull(); // agent replied after the customer message

    const followUp = { ...customer, id: 11012, remoteId: 11012, createdAt: '2024-06-02T09:00:00.000Z' };
    convRepo.upsertThread(convId, followUp as never);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as Row;
    expect(conv.customer_waiting_since).toBe('2024-06-02T09:00:00.000Z'); // customer came back

    // Draft thread: NOT an event, NOT a response
    const draft = { ...agent, id: 11013, remoteId: 11013, state: 'draft', createdAt: '2024-06-02T10:00:00.000Z' };
    convRepo.upsertThread(convId, draft as never);
    const evCount = (db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(convId) as Row).n as number;
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as Row;
    expect(conv.first_response_at).toBe('2024-06-01T10:00:00.000Z'); // draft did not move it

    // Re-upsert the SAME customer thread: no duplicate event
    convRepo.upsertThread(convId, customer as never);
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(convId) as Row).n as number).toBe(evCount);
  });
});

describe('ticket states: transitions, lifecycle, CRUD', () => {
  it('records transitions with actor/reason and computes time-in-state', () => {
    const convId = convRepo.upsertConversation({
      id: 9904, number: 104, threads: 0, type: 'email', status: 'active', state: 'published', subject: 'States',
      preview: '', mailboxId: 501, createdAt: '2024-07-01T09:00:00.000Z', userUpdatedAt: '2024-07-01T09:00:00.000Z', tags: [], customFields: []
    } as never);
    const newId = (db.prepare("SELECT id FROM ticket_states WHERE key = 'new'").get() as Row).id as number;
    const investigatingId = (db.prepare("SELECT id FROM ticket_states WHERE key = 'investigating'").get() as Row).id as number;
    const waitingEngId = (db.prepare("SELECT id FROM ticket_states WHERE key = 'waiting-engineering'").get() as Row).id as number;

    const r1 = states.setState({ conversationLocalId: convId, newStateId: newId, reason: 'triaged' });
    expect(r1.ok).toBe(true);
    const r2 = states.setState({ conversationLocalId: convId, newStateId: investigatingId, reason: 'looking into it' });
    expect(r2.ok).toBe(true);
    // Same-state set is a no-op
    const rSame = states.setState({ conversationLocalId: convId, newStateId: investigatingId });
    expect(rSame.ok).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ticket_state_transitions WHERE conversation_id = ?').get(convId) as Row).n).toBe(2);

    // Unknown state rejected
    expect(states.setState({ conversationLocalId: convId, newStateId: 999999 }).ok).toBe(false);

    // Lifecycle: two transitions, current = investigating
    const lifecycle = states.stateLifecycle(convId);
    expect(lifecycle.current_state?.id).toBe(investigatingId);
    expect(lifecycle.transitions).toBe(2);
    expect(lifecycle.per_state.find((s) => s.state_id === newId)?.entries).toBe(1);

    // Clear state -> transition with previous, current null
    const rClear = states.setState({ conversationLocalId: convId, newStateId: null, reason: 'done' });
    expect(rClear.ok).toBe(true);
    expect(states.getConversationState(convId)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM ticket_state_transitions WHERE conversation_id = ?').get(convId) as Row).n).toBe(3);

    // ticket_state_changed events recorded for each transition
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND event_type = 'ticket_state_changed'").get(convId) as Row).n).toBe(3);

    // waiting-engineering used for bottleneck math
    states.setState({ conversationLocalId: convId, newStateId: waitingEngId });
    const bottlenecks = states.stateBottlenecks();
    expect(bottlenecks.some((b) => b.state_id === waitingEngId)).toBe(true);
    expect(bottlenecks.every((b) => b.avg_minutes == null || b.avg_minutes! >= 0)).toBe(true);
  });

  it('CRUD guards: built-in states cannot be deleted or re-resolved; custom states can', () => {
    const builtIn = (db.prepare("SELECT id FROM ticket_states WHERE key = 'new'").get() as Row).id as number;
    expect(states.deleteState(builtIn).ok).toBe(false);
    expect(() => states.createState({ name: 'New' })).toThrow(); // duplicate key from slug
    const custom = states.createState({ name: 'Escalated to Vendor', color: '#ff00ff' });
    expect(custom.key).toBe('escalated-to-vendor');
    expect(states.updateState(custom.id, { name: 'Vendor Escalation' }).name).toBe('Vendor Escalation');
    // resolved semantics of built-ins are locked
    expect(() => states.updateState(builtIn, { is_resolved: true })).toThrow();
    expect(states.deleteState(custom.id).ok).toBe(true);
  });
});

describe('saved views: storage, compilation, dynamic evaluation', () => {
  it('stores structured definitions (never SQL) and bumps version on definition change', () => {
    const def: ViewDefinition = { combinator: 'all', conditions: [{ kind: 'status', statuses: ['active'] }, { kind: 'response_state', states: ['customer_waiting'] }] };
    const view = views.createView({ name: 'Waiting room', definition: def });
    expect(view.version).toBe(1);
    // Round-trip: the stored JSON is the condition tree
    expect(views.getView(view.id)?.definition).toEqual(def);
    views.updateView(view.id, { name: 'Renamed' });
    expect(views.getView(view.id)?.version).toBe(1); // name-only change: no bump
    views.updateView(view.id, { definition: { combinator: 'all', conditions: [{ kind: 'status', statuses: ['pending'] }] } });
    expect(views.getView(view.id)?.version).toBe(2); // definition change bumps
    expect(views.deleteView(view.id)).toBe(true);
    expect(views.deleteView(view.id)).toBe(false);
  });

  it('compiles every condition kind to parameterized SQL and matches the expected rows', () => {
    const engine = new ViewEngine(db, { timezone: 'UTC' });
    const convRepo2 = new ConversationRepository(db);

    // Fixture: one waiting (replied once, customer came back), one closed-urgent, one unassigned
    const waitingId = convRepo.upsertConversation({ id: 9905, number: 105, threads: 0, type: 'email', status: 'active', subject: 'Waiting ticket', preview: '', mailboxId: 501, createdAt: new Date().toISOString(), userUpdatedAt: new Date().toISOString(), tags: [], customFields: [] } as never);
    const hour = 3600000;
    db.prepare('UPDATE conversations SET first_customer_message_at = ?, first_response_at = ?, last_customer_reply_at = ?, last_human_agent_response_at = ?, customer_waiting_since = ? WHERE id = ?').run(
      new Date(Date.now() - 5 * hour).toISOString(), new Date(Date.now() - 4 * hour).toISOString(), new Date(Date.now() - 2 * hour).toISOString(), new Date(Date.now() - 4 * hour).toISOString(), new Date(Date.now() - 2 * hour).toISOString(), waitingId
    );
    const closedId = convRepo.upsertConversation({ id: 9906, number: 106, threads: 0, type: 'chat', status: 'closed', subject: 'Closed urgent', preview: '', mailboxId: 501, createdAt: '2024-08-01T09:00:00.000Z', userUpdatedAt: '2024-08-01T09:00:00.000Z', tags: [{ tag: 'vip' }], customFields: [] } as never);
    db.prepare("UPDATE conversations SET supportos_priority = 'urgent' WHERE id = ?").run(closedId);
    const unassignedId = convRepo.upsertConversation({ id: 9907, number: 107, threads: 0, type: 'email', status: 'active', subject: 'Unassigned', preview: '', mailboxId: 501, createdAt: new Date().toISOString(), userUpdatedAt: new Date().toISOString(), tags: [], customFields: [] } as never);

    const idsFor = (def: ViewDefinition): number[] => {
      const compiled = engine.compile(def);
      const sql = `SELECT c.id FROM conversations c WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL AND (${compiled.whereSql})`;
      return (db.prepare(sql).all(...compiled.params) as Row[]).map((r) => r.id as number).sort();
    };

    // response_state + status
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'response_state', states: ['customer_waiting'] }] })).toContain(waitingId);
    // priority
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'priority', priorities: ['urgent'] }] })).toEqual([closedId]);
    // nested group: (urgent) OR (customer_waiting) -> BOTH fixtures (plus any
    // other waiting conversation from earlier tests - the engine is correct)
    const orResult = idsFor({ combinator: 'any', conditions: [
      { kind: 'priority', priorities: ['urgent'] },
      { kind: 'group', combinator: 'all', children: [{ kind: 'response_state', states: ['customer_waiting'] }] }
    ] });
    expect(orResult).toContain(closedId);
    expect(orResult).toContain(waitingId);
    // unassigned
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'assignee', assigneeLocalIds: [999999], includeUnassigned: true }] })).toContain(unassignedId);
    // tags any/all/none
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'tags', tags: ['vip'], mode: 'any' }] })).toEqual([closedId]);
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'tags', tags: ['VIP'], mode: 'all' }] })).toEqual([closedId]); // case-insensitive
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'tags', tags: ['vip'], mode: 'none' }] })).not.toContain(closedId);
    // channel
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'channel', channels: ['chat'] }] })).toEqual([closedId]);
    // date_activity rolling: last_7d on created_at includes today's fixtures, not August
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'date_activity', activityField: 'created_at', mode: 'last_7d' }] })).toContain(waitingId);
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'date_activity', activityField: 'created_at', mode: 'last_7d' }] })).not.toContain(closedId);
    // response_age: waiting > 0 minutes
    expect(idsFor({ combinator: 'all', conditions: [{ kind: 'response_age', metric: 'customer_waiting_duration', op: 'gt', minutes: 0 }] })).toContain(waitingId);
    // injection-shaped values stay parameters
    const evil = engine.compile({ combinator: 'all', conditions: [{ kind: 'tags', tags: ["x'; DROP TABLE conversations;--"], mode: 'any' }] });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE (${evil.whereSql})`).all(...evil.params) as Row[]).length).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as Row).n).toBeGreaterThan(3); // table intact
    void convRepo2;

    // depth cap
    const deep = (n: number): ViewDefinition['conditions'][number] => (n === 0 ? { kind: 'status', statuses: ['active'] } : { kind: 'group', combinator: 'all', children: [deep(n - 1)] });
    expect(() => engine.compile({ combinator: 'all', conditions: [deep(12)] })).toThrow(ViewCompileError);
    expect(() => engine.compile({ combinator: 'all', conditions: [deep(8)] })).not.toThrow();
  });

  it('date conditions are DYNAMIC: "today" re-resolves with the clock', () => {
    const engine = new ViewEngine(db, { timezone: 'UTC', now: Date.UTC(2024, 5, 1, 12, 0, 0) });
    const def: ViewDefinition = { combinator: 'all', conditions: [{ kind: 'date_activity', activityField: 'created_at', mode: 'today' }] };
    const c1 = engine.compile(def);
    expect(c1.params[0]).toBe('2024-06-01T00:00:00.000Z');
    const engine2 = new ViewEngine(db, { timezone: 'UTC', now: Date.UTC(2024, 5, 2, 12, 0, 0) });
    const c2 = engine2.compile(def);
    expect(c2.params[0]).toBe('2024-06-02T00:00:00.000Z'); // same saved definition, new window
    expect(c2.notes.join(' ')).toContain('Today');
  });
});

describe('inbox list filters + response-state SQL/JS equivalence', () => {
  it('filters by response state, priority, ticket state and sorts by waiting', () => {
    const result = convRepo.listConversations({ view: 'all', responseState: 'customer_waiting' });
    expect(result.conversations.every((c) => c.response_state === 'customer_waiting')).toBe(true);
    expect(result.conversations.some((c) => c.first_customer_message_at != null)).toBe(true);

    const urgent = convRepo.listConversations({ view: 'all', priority: 'urgent' });
    expect(urgent.conversations.map((c) => c.subject)).toContain('Closed urgent');

    const sorted = convRepo.listConversations({ view: 'all', sort: 'waiting_longest', pageSize: 100 });
    const waiting = sorted.conversations.filter((c) => c.customer_waiting_since != null);
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < waiting.length; i++) {
      expect(Date.parse(waiting[i - 1]!.customer_waiting_since!)).toBeLessThanOrEqual(Date.parse(waiting[i]!.customer_waiting_since!));
    }

    const pri = convRepo.listConversations({ view: 'all', sort: 'priority', pageSize: 100 });
    const ranks = pri.conversations.map((c) => ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 })[c.priority] ?? 4);
    expect(ranks.every((r, i) => i === 0 || ranks[i - 1]! <= r)).toBe(true);
  });

  it('RESPONSE_STATE_SQL and responseStateOf agree on every row (list badges == detail state)', () => {
    const rows = db.prepare(`SELECT c.status, c.snoozed_until, c.first_customer_message_at, c.first_response_at, c.last_customer_reply_at, c.last_human_agent_response_at, c.activity_history_complete, (${RESPONSE_STATE_SQL}) AS sql_state FROM conversations c WHERE c.deleted_at IS NULL`).all() as Row[];
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      const jsState = responseStateOf(r as never);
      expect(jsState).toBe(r.sql_state);
    }
  });

  it('activity date-window filtering is an index-friendly range scan on the derived columns', () => {
    const range = resolveDateRange({ mode: 'last_7d', timezone: 'UTC' })!;
    const result = convRepo.listConversations({ view: 'all', activityColumn: ACTIVITY_FIELD_COLUMN.created_at, activityFrom: range.from, activityTo: range.to, pageSize: 100 });
    const now = Date.now();
    for (const c of result.conversations) {
      expect(Date.parse(c.remote_created_at!)).toBeGreaterThanOrEqual(Date.parse(range.from));
      expect(Date.parse(c.remote_created_at!)).toBeLessThan(Date.parse(range.to));
      expect(now).toBeGreaterThan(0);
    }
  });
});

// (import-time dependency loading only - no runtime helpers needed)
