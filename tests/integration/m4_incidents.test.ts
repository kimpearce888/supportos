import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { IncidentRepository } from '../../src/server/database/repositories/incidentRepo.js';
import { IssueImpactService } from '../../src/server/issues/impact.js';
import { IssueRepository } from '../../src/server/database/repositories/issueRepo.js';

/**
 * v2.0.0 (M4) integration tests, part 1 (plan Phases 18-19): the incident
 * workspace - CRUD with generated INC codes, conversation links, affected
 * customers/organizations DERIVED from links (never stored), the append-only
 * idempotent timeline, and issue impact intelligence (customers are COUNT
 * DISTINCT - a ticket count is never a customer count; growth/trend math;
 * release correlation as a temporal association).
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;
let incidents: IncidentRepository;
let impact: IssueImpactService;
let issues: IssueRepository;

function insertConversation(remote: number, number: number, customer: number | null, createdAt: string, closed = false): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, closed_at, customer_waiting_since, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number}`, closed ? 'closed' : 'active', customer, createdAt, closed ? createdAt : null, closed ? null : createdAt);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  incidents = new IncidentRepository(db);
  impact = new IssueImpactService(db);
  issues = new IssueRepository(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO organizations (remote_id, name) VALUES (701, 'Compute Inc')").run();
  db.prepare("INSERT INTO organizations (remote_id, name) VALUES (702, 'Cipher Ltd')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (901, 'Ada', 'Byron', 1)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (902, 'Grace', 'Hopper', 1)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (903, 'Alan', 'Turing', 2)").run();
});

afterAll(() => {
  closeDatabase(db);
});

describe('incident workspace (Phase 18)', () => {
  it('creates incidents with sequential INC codes and links conversations', () => {
    const a = incidents.create({ title: 'Slack outage', severity: 'sev2', conversationIds: [] });
    const b = incidents.create({ title: 'DST drift', severity: 'sev3', conversationIds: [] });
    expect(a.code).toMatch(/^INC-\d{3}$/);
    expect(b.code).toMatch(/^INC-\d{3}$/);
    expect(Number(b.code.slice(4))).toBe(Number(a.code.slice(4)) + 1);
    // created timeline event exists exactly once
    const events = incidents.listEvents(a.id);
    expect(events.filter((e) => e.event_type === 'created')).toHaveLength(1);
  });

  it('links and unlinks conversations with idempotent timeline events', () => {
    const inc = incidents.create({ title: 'Link test' });
    const conv1 = insertConversation(9901, 101, 1, '2026-09-01 10:00:00');
    expect(incidents.linkConversation(inc.id, conv1, 'human', null)).toBe(true);
    expect(incidents.linkConversation(inc.id, conv1, 'human', null)).toBe(false); // already linked
    expect(incidents.linkConversation(inc.id, 999999, 'human', null)).toBe(false); // unknown conversation
    expect(incidents.listConversations(inc.id)).toHaveLength(1);
    const linked = incidents.listEvents(inc.id).filter((e) => e.event_type === 'conversation_linked');
    expect(linked).toHaveLength(1); // dedup key prevents double events
    expect(incidents.unlinkConversation(inc.id, conv1, null)).toBe(true);
    expect(incidents.unlinkConversation(inc.id, conv1, null)).toBe(false);
    expect(incidents.listConversations(inc.id)).toHaveLength(0);
  });

  it('derives affected customers and organizations from linked conversations', () => {
    const inc = incidents.create({ title: 'Affected derivation' });
    // 4 tickets: 2 from Ada, 1 from Grace (org 1), 1 from Alan (org 2).
    const c1 = insertConversation(9911, 201, 1, '2026-09-10 09:00:00');
    const c2 = insertConversation(9912, 202, 1, '2026-09-12 09:00:00');
    const c3 = insertConversation(9913, 203, 2, '2026-09-14 09:00:00');
    const c4 = insertConversation(9914, 204, 3, '2026-09-16 09:00:00');
    for (const c of [c1, c2, c3, c4]) incidents.linkConversation(inc.id, c, 'human', null);
    const customers = incidents.affectedCustomers(inc.id);
    expect(customers).toHaveLength(3); // Ada, Grace, Alan - NOT 4 (ticket count)
    expect(customers.find((c) => c.name === 'Ada Byron')?.conversations).toBe(2);
    const orgs = incidents.affectedOrganizations(inc.id);
    expect(orgs).toHaveLength(2);
    expect(orgs.find((o) => o.name === 'Compute Inc')?.customers).toBe(2);
    expect(orgs.find((o) => o.name === 'Cipher Ltd')?.customers).toBe(1);
  });

  it('status transitions keep resolved_at consistent and record timeline events', () => {
    const inc = incidents.create({ title: 'Transitions', status: 'investigating' });
    incidents.patch(inc.id, { status: 'resolved' }, null);
    const resolved = incidents.get(inc.id)!;
    expect(resolved.resolved_at).toBeTruthy();
    const reopened = incidents.patch(inc.id, { status: 'investigating' }, null)!;
    expect(reopened.resolved_at).toBeNull();
    const events = incidents.listEvents(inc.id);
    expect(events.some((e) => e.event_type === 'status_changed')).toBe(true);
    // Re-patching the same status does not double-record.
    incidents.patch(inc.id, { status: 'investigating' }, null);
    expect(incidents.listEvents(inc.id).filter((e) => e.event_type === 'status_changed')).toHaveLength(2);
  });

  it('notes, refs, releases and related entities attach and list', () => {
    const inc = incidents.create({ title: 'Full workspace' });
    incidents.addNote(inc.id, 'Confirmed with 3 workspaces.', null);
    incidents.addRef(inc.id, { system: 'linear', reference: 'ENG-4471', url: 'https://linear.app/x' });
    incidents.addRelease(inc.id, { versionLabel: 'v4.12.0', releasedAt: '2026-09-20' });
    const ki = issues.createKnownIssue({ title: 'KI', symptoms: 's', status: 'open', provenance: 'human_local' });
    incidents.addRelated(inc.id, 'known_issue', ki, null, null);
    expect(incidents.listNotes(inc.id)).toHaveLength(1);
    expect(incidents.listRefs(inc.id)[0]?.reference).toBe('ENG-4471');
    expect(incidents.listReleases(inc.id)[0]?.version_label).toBe('v4.12.0');
    expect(incidents.listRelated(inc.id)[0]?.target_label).toContain('KI');
  });

  it('activeIncidentForConversation returns the highest-severity open incident', () => {
    const conv = insertConversation(9921, 301, 1, '2026-09-18 09:00:00');
    expect(incidents.activeIncidentForConversation(conv)).toBeNull();
    const incLow = incidents.create({ title: 'low', severity: 'sev4' });
    const incHigh = incidents.create({ title: 'high', severity: 'sev1' });
    incidents.linkConversation(incLow.id, conv, 'human', null);
    incidents.linkConversation(incHigh.id, conv, 'human', null);
    const active = incidents.activeIncidentForConversation(conv);
    expect(active?.incident_id).toBe(incHigh.id);
    incidents.patch(incHigh.id, { status: 'resolved' }, null);
    expect(incidents.activeIncidentForConversation(conv)?.incident_id).toBe(incLow.id);
  });
});

describe('issue impact intelligence (Phase 19)', () => {
  it('computes distinct counts, growth, trend, distribution and waiting for an incident', () => {
    const inc = incidents.create({ title: 'Impact subject' });
    // Two windows: 3 tickets in the last 7 days, 1 in the 7-14d window, 1 older.
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const c1 = insertConversation(9931, 401, 1, daysAgo(2));
    const c2 = insertConversation(9932, 402, 2, daysAgo(3));
    const c3 = insertConversation(9933, 403, 3, daysAgo(5), true);
    const c4 = insertConversation(9934, 404, 1, daysAgo(10), true);
    const c5 = insertConversation(9935, 405, 2, daysAgo(40), true);
    for (const c of [c1, c2, c3, c4, c5]) incidents.linkConversation(inc.id, c, 'human', null);

    const r = impact.forIncident(inc.id)!;
    expect(r.affected_conversations).toBe(5);
    expect(r.affected_customers).toBe(3);       // distinct - never the ticket count
    expect(r.affected_organizations).toBe(2);
    expect(r.open_closed_distribution).toEqual({ open: 2, closed: 3 });
    expect(r.customer_waiting_count).toBe(2);   // open + waiting marker set
    expect(r.growth_rate_7d.recent).toBe(3);
    expect(r.growth_rate_7d.previous).toBe(1);
    expect(r.growth_rate_7d.direction).toBe('rising');
    expect(['new', 'rising', 'stable']).toContain(r.trend);
    expect(r.note).toContain('never ticket counts');
  });

  it('reports release correlation as a temporal association only', () => {
    const inc = incidents.create({ title: 'Release association' });
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    incidents.addRelease(inc.id, { versionLabel: 'v9.9.9', releasedAt: daysAgo(3) });
    const c1 = insertConversation(9941, 501, 1, daysAgo(2));
    const c2 = insertConversation(9942, 502, 2, daysAgo(1));
    incidents.linkConversation(inc.id, c1, 'human', null);
    incidents.linkConversation(inc.id, c2, 'human', null);
    const r = impact.forIncident(inc.id)!;
    expect(r.release_correlation_candidates).toHaveLength(1);
    expect(r.release_correlation_candidates[0]?.version_label).toBe('v9.9.9');
    expect(r.release_correlation_candidates[0]?.conversations_within_7d).toBe(2);
    expect(r.release_correlation_candidates[0]?.note).toContain('not a causal claim');
  });

  it('serves the SAME metric shape for known issues (no parallel implementation)', () => {
    const conv = insertConversation(9951, 601, 1, new Date().toISOString().replace('T', ' ').slice(0, 19));
    const ki = issues.createKnownIssue({ title: 'Impact KI', symptoms: 's', status: 'open', conversation_ids: [conv], provenance: 'human_local' });
    const r = impact.forKnownIssue(ki);
    expect(r).not.toBeNull();
    expect(r?.subject_kind).toBe('known_issue');
    expect(r?.affected_conversations).toBe(1);
    expect(r?.affected_customers).toBe(1);
    expect(impact.forKnownIssue(999999)).toBeNull();
    expect(impact.forIncident(999999)).toBeNull();
  });
});
