import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { CustomerEventRepository } from '../../src/server/database/repositories/customerEventsRepo.js';
import { CustomerEventSweep } from '../../src/server/timeline/customerEventSweep.js';
import { SupportHealthService } from '../../src/server/analytics/supportHealth.js';
import { KnowledgeFreshnessService } from '../../src/server/knowledge/freshness.js';
import { AnalyticsService } from '../../src/server/analytics/analyticsService.js';
import { IncidentRepository } from '../../src/server/database/repositories/incidentRepo.js';
import { IssueRepository } from '../../src/server/database/repositories/issueRepo.js';
import { KnowledgeRepository } from '../../src/server/database/repositories/knowledgeRepo.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';

/**
 * v2.0.0 (M4) integration tests, part 4 (plan Phases 20, 23, 24, 25): the
 * customer event timeline (idempotent derivation, honest absence), support
 * health (operational facts only, no score), knowledge freshness (stale/
 * review/usage flags, human-only stamps) and the extended Issue Radar
 * (concentration, reappearing, burst correlation, repeated unresolved,
 * global volume spike - association wording only).
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let events: CustomerEventRepository;
let sweep: CustomerEventSweep;
let health: SupportHealthService;
let freshness: KnowledgeFreshnessService;
let analytics: AnalyticsService;
let incidents: IncidentRepository;
let issues: IssueRepository;
let settings: SettingsRepository;

function insertConversation(remote: number, number: number, customer: number | null, createdAt: string, closed = false): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, closed_at, customer_waiting_since, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number}`, closed ? 'closed' : 'active', customer, createdAt, closed ? createdAt : null, closed ? null : createdAt);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

function insertThread(remote: number, convId: number, body: string, at: string): void {
  db.prepare(
    `INSERT INTO threads (remote_id, conversation_id, type, state, body_text, from_type, from_name, created_by_customer_id, remote_created_at)
     VALUES (?, ?, 'customer', 'published', ?, 'customer', 'Customer', NULL, ?)`
  ).run(remote, convId, body, at);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  events = new CustomerEventRepository(db);
  sweep = new CustomerEventSweep(db, events);
  health = new SupportHealthService(db);
  settings = new SettingsRepository(db);
  freshness = new KnowledgeFreshnessService(db, settings);
  analytics = new AnalyticsService(db);
  incidents = new IncidentRepository(db);
  issues = new IssueRepository(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (701, 'Support', 'support')").run();
  // A settled mirror: the sweep's first-sync guard must not silence these tests.
  db.prepare("INSERT OR REPLACE INTO application_settings (key, value) VALUES ('sync_state', '\"LIVE\"')").run();
  db.prepare("INSERT INTO organizations (remote_id, name) VALUES (7801, 'Compute Inc')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id, remote_created_at) VALUES (9601, 'Ada', 'Byron', 1, '2026-01-15 09:00:00')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id, remote_created_at) VALUES (9602, 'Grace', 'Hopper', 1, '2026-02-20 09:00:00')").run();
  db.prepare("INSERT INTO organizations (remote_id, name) VALUES (7802, 'Cipher Ltd')").run();
});

afterAll(() => {
  closeDatabase(db);
});

describe('customer event timeline (Phase 23)', () => {
  it('derives signup, conversation, first-message and rating events idempotently', () => {
    const conv = insertConversation(9701, 1001, 1, '2026-09-01 10:00:00');
    insertThread(98001, conv, 'Please help with the export feature', '2026-09-01 10:00:00');
    insertConversation(9702, 1002, 1, '2026-09-05 10:00:00', true);
    db.prepare("INSERT INTO ratings (remote_id, conversation_id, rating, comments, customer_local_id, remote_created_at) VALUES (5001, ?, 'not-good', 'slow', 1, '2026-09-06 08:00:00')").run(conv);
    const first = sweep.rebuild();
    expect(first.created).toBeGreaterThan(0);
    const before = events.listForCustomer(1, null, 200, 0).total;
    expect(before).toBeGreaterThanOrEqual(5); // signup + created x2 + closed + first message + rating
    const second = sweep.rebuild();
    expect(second.created).toBe(0); // idempotent - dedup keys hold
    expect(events.listForCustomer(1, null, 200, 0).total).toBe(before);
  });

  it('exposes honest absence: kinds without an observable source stay absent', () => {
    const kinds = events.kindCounts(1).map((k) => k.kind);
    for (const absent of ['subscription_event', 'account_event', 'product_event', 'integration_event']) {
      expect(kinds).not.toContain(absent);
    }
  });

  it('derives incident exposure and custom object events; org timeline unions members', () => {
    const inc = incidents.create({ title: 'Exposure incident', severity: 'sev2' });
    const convA = insertConversation(9711, 1101, 1, '2026-09-20 10:00:00');
    const convB = insertConversation(9712, 1102, 2, '2026-09-21 10:00:00');
    incidents.linkConversation(inc.id, convA, 'human', null);
    incidents.linkConversation(inc.id, convB, 'human', null);
    const sweepResult = sweep.sweep();
    expect(sweepResult.created).toBeGreaterThanOrEqual(2);
    const ada = events.listForCustomer(1, 'incident_exposure', 50, 0);
    expect(ada.total).toBe(1);
    expect(ada.events[0]?.title).toContain('Exposure incident');
    // Resolving the incident does not erase history (append-only log).
    incidents.patch(inc.id, { status: 'resolved' }, null);
    expect(events.listForCustomer(1, 'incident_exposure', 50, 0).total).toBe(1);

    // Custom object link produces a custom_object_event.
    const objType = db.prepare('INSERT INTO custom_object_types (name, slug) VALUES (\'Account\', \'account\')').run();
    const obj = db.prepare("INSERT INTO custom_objects (type_id, title, properties, search_text) VALUES (?, 'Ada account', '{}', '')").run(Number(objType.lastInsertRowid));
    db.prepare('INSERT INTO custom_object_links (object_id, target_kind, target_local_id) VALUES (?, \'customer\', 1)').run(Number(obj.lastInsertRowid));
    sweep.sweep();
    expect(events.listForCustomer(1, 'custom_object_event', 50, 0).total).toBe(1);

    // Organization timeline = union over member customers.
    const orgEvents = events.listForOrganization(1, null, 200, 0);
    expect(orgEvents.total).toBeGreaterThanOrEqual(events.listForCustomer(1, null, 200, 0).total);
    expect(orgEvents.events.every((e) => e.customer_name != null)).toBe(true);
  });

  it('the sweep stays silent while the first sync is still populating', () => {
    db.prepare("UPDATE application_settings SET value = '\"BACKFILLING\"' WHERE key = 'sync_state'").run();
    expect(sweep.sweep().created).toBe(0);
    db.prepare("UPDATE application_settings SET value = '\"LIVE\"' WHERE key = 'sync_state'").run();
  });
});

describe('customer support health (Phase 24)', () => {
  it('reports operational metrics with definitions and evidence - and no aggregate score', () => {
    const r = health.forCustomer(1)!;
    expect(r.subject_kind).toBe('customer');
    expect(r.metrics.length).toBeGreaterThan(5);
    const keys = r.metrics.map((m) => m.key);
    expect(keys).toContain('open_conversations');
    expect(keys).toContain('waiting_count');
    expect(keys).toContain('negative_outcomes_90d');
    expect(keys).toContain('customer_effort_msgs');
    expect(keys).toContain('incident_exposure');
    // Every metric carries a plain-language definition (transparency rule).
    expect(r.metrics.every((m) => m.definition.length > 10)).toBe(true);
    // There is deliberately NO single psychological score.
    expect(Object.keys(r)).not.toContain('score');
    expect(r.note).toContain('No psychological or personal judgments');
  });

  it('flags waiting, incident exposure and evidence-backed attention states', () => {
    // Customer 1 has an open conversation waiting since 2026-09-01 (long ago).
    const r = health.forCustomer(1)!;
    const waitingFlag = r.flags.find((f) => f.key === 'waiting_long');
    expect(waitingFlag).toBeTruthy();
    expect(['warning', 'critical']).toContain(waitingFlag?.severity);
    expect(waitingFlag?.evidence_conversation_ids.length).toBeGreaterThan(0);
    expect(health.forCustomer(999999)).toBeNull();
  });

  it('rolls up organization health across member customers', () => {
    const r = health.forOrganization(1)!;
    expect(r.subject_kind).toBe('organization');
    expect(r.metrics.find((m) => m.key === 'open_conversations')!.value).toBeGreaterThanOrEqual(2); // Ada + Grace
    expect(health.forOrganization(999999)).toBeNull();
    const emptyOrg = health.forOrganization(2);
    expect(emptyOrg?.metrics.find((m) => m.key === 'open_conversations')?.value).toBe(0);
  });
});

describe('knowledge freshness (Phase 25)', () => {
  it('flags stale documents, records usage and human review/verify stamps', () => {
    const knowledge = new KnowledgeRepository(db);
    const source = knowledge.createSource('Freshness test', 'manual', 'customer_safe');
    // A doc "updated" long ago (stale) and a fresh one.
    const stale = knowledge.upsertDocument(source, 'Ancient runbook', 'old content about exports', { visibility: 'customer_safe', format: 'markdown' });
    const fresh = knowledge.upsertDocument(source, 'Modern guide', 'new content about imports', { visibility: 'customer_safe', format: 'markdown' });
    db.prepare("UPDATE knowledge_documents SET updated_at = datetime('now', '-400 days') WHERE id = ?").run(stale.id);
    db.prepare("UPDATE knowledge_documents SET updated_at = datetime('now', '-2 days') WHERE id = ?").run(fresh.id);
    let report = freshness.report();
    const staleRow = report.find((d) => d.document_id === stale.id);
    const freshRow = report.find((d) => d.document_id === fresh.id);
    expect(staleRow?.flags.stale).toBe(true);
    expect(staleRow?.flags.unreviewed_long).toBe(true);
    expect(freshRow?.flags.stale).toBe(false);
    // Usage bumps through the same call the search route makes.
    freshness.recordUsage([stale.id]);
    freshness.recordUsage([stale.id]);
    report = freshness.report();
    expect(report.find((d) => d.document_id === stale.id)?.search_hits).toBe(2);
    // Human-only stamps clear the review gap; nothing auto-publishes.
    expect(freshness.markReviewed(stale.id)).toBe(true);
    expect(freshness.markVerified(stale.id)).toBe(true);
    expect(freshness.markReviewed(999999)).toBe(false);
    report = freshness.report();
    const reviewed = report.find((d) => d.document_id === stale.id)!;
    expect(reviewed.last_reviewed_at).toBeTruthy();
    expect(reviewed.last_verified_at).toBeTruthy();
    expect(reviewed.flags.unreviewed_long).toBe(false);
  });

  it('marks conflict candidates from title-term overlap', () => {
    const knowledge = new KnowledgeRepository(db);
    const source = knowledge.getSource('Freshness test')?.id ?? knowledge.createSource('Freshness test', 'manual', 'customer_safe');
    const a = knowledge.upsertDocument(source, 'Export CSV timezone guide', 'content a', { visibility: 'customer_safe', format: 'markdown' });
    knowledge.upsertDocument(source, 'Export CSV timezone manual', 'content b', { visibility: 'customer_safe', format: 'markdown' });
    const report = freshness.report();
    const row = report.find((d) => d.document_id === a.id);
    expect(row?.flags.conflict_candidate).toBe(true);
    expect(row?.conflict_candidates.length).toBeGreaterThan(0);
  });
});

describe('Issue Radar extensions (Phase 20)', () => {
  it('emits the new association kinds with evidence links (never causation)', () => {
    // Build a cluster with customer concentration + inbox concentration +
    // a burst window + repeated unresolved pattern for customer 1.
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const convIds: number[] = [];
    // 5 conversations from 2 customers (concentration), all in mailbox 1,
    // 4 of them inside one 7-day burst, 2 from the same customer 14+ days apart.
    convIds.push(insertConversation(9721, 1201, 1, daysAgo(30)));
    convIds.push(insertConversation(9722, 1202, 1, daysAgo(2)));
    convIds.push(insertConversation(9723, 1203, 1, daysAgo(3)));
    convIds.push(insertConversation(9724, 1204, 2, daysAgo(4)));
    convIds.push(insertConversation(9725, 1205, 2, daysAgo(5)));
    issues.upsertCluster({
      title: 'concentration burst cluster',
      summary: 'Test cluster for radar extensions.',
      conversation_ids: convIds
    });
    issues.computeTrends();
    const alerts = analytics.issueRadar();
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('customer_concentration');
    expect(kinds).toContain('inbox_concentration');
    expect(kinds).toContain('release_correlation');
    expect(kinds).toContain('repeated_unresolved');
    for (const alert of alerts) {
      // Every alert carries evidence conversation links (or a global sample).
      expect(alert.conversation_ids.length).toBeGreaterThan(0);
      if (alert.kind === 'release_correlation' || alert.kind === 'volume_spike' || alert.kind === 'customer_concentration') {
        expect(alert.detail.toLowerCase()).not.toContain('caused by');
      }
    }
    const conc = alerts.find((a) => a.kind === 'customer_concentration')!;
    expect(conc.detail).toContain('distinct customers');
  });

  it('detects reappearing issues (quiet then back) with association wording', () => {
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const ids = [
      insertConversation(9731, 1301, 1, daysAgo(45)),
      insertConversation(9732, 1302, 2, daysAgo(40)),
      insertConversation(9733, 1303, 1, daysAgo(10)),
      insertConversation(9734, 1304, 2, daysAgo(5))
    ];
    issues.upsertCluster({ title: 'reappearing topic cluster', summary: 'Went quiet and came back.', conversation_ids: ids });
    const alerts = analytics.issueRadar();
    const re = alerts.find((a) => a.kind === 'reappearing_issue' && a.cluster_id != null && a.title.includes('reappearing topic cluster'));
    expect(re).toBeTruthy();
    expect(re?.detail).toContain('came back');
  });

  it('flags unusual global support volume as an association', () => {
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    // 12 conversations in the last 7 days vs a quiet previous week.
    for (let i = 0; i < 12; i++) {
      insertConversation(9800 + i, 1400 + i, 1, daysAgo(i % 6));
    }
    const alerts = analytics.issueRadar();
    const spike = alerts.find((a) => a.kind === 'volume_spike' && a.cluster_id == null);
    expect(spike).toBeTruthy();
    expect(spike?.detail).toContain('not a causal claim');
  });
});
