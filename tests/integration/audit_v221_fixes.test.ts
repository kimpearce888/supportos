import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { ReportBuilderService } from '../../src/server/analytics/reportBuilder.js';
import { AiRepository } from '../../src/server/database/repositories/aiRepo.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';

/**
 * v2.2.1 regression tests: every test here locks a bug found by the fresh
 * full-project audit. Each block names the exact defect it pins so a future
 * change cannot silently reintroduce it.
 */
interface Row { [k: string]: unknown }

let db: ReturnType<typeof openTestDatabase>;

function insertConversation(remote: number, number: number, customer: number | null, createdAt: string, closed = false, mailbox = 1, assignee: number | null = null): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, assignee_local_id, remote_created_at, closed_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number}`, closed ? 'closed' : 'active', mailbox, customer, assignee, createdAt, closed ? createdAt : null);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as Row).id);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (502, 'Billing', 'billing')").run();
  db.prepare("INSERT INTO users (remote_id, first_name, last_name) VALUES (601, 'Ava', 'Chen')").run();
  db.prepare("INSERT INTO organizations (remote_id, name, domains) VALUES (701, 'Compute Inc', '[\"compute.example\"]')").run();
  db.prepare("INSERT INTO organizations (remote_id, name, domains) VALUES (702, 'Vector Ltd', '[\"vector.example\"]')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (901, 'Ada', 'Byron', 1)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (902, 'Grace', 'Hopper', 1)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (903, 'Edsger', 'Dijkstra', 2)").run();
  db.prepare("INSERT INTO customers (remote_id, first_name, last_name, organization_id) VALUES (904, 'No', 'Org', NULL)").run();
});

afterAll(() => {
  closeDatabase(db);
});

describe('v2.2.1 fix: organizations report metric (was: SQL referenced a nonexistent c.organization_id column)', () => {
  it('counts distinct customer organizations across conversations without throwing', () => {
    const builder = new ReportBuilderService(db);
    insertConversation(2001, 101, 1, '2026-09-01 10:00:00');
    insertConversation(2002, 102, 2, '2026-09-02 10:00:00');
    insertConversation(2003, 103, 3, '2026-09-03 10:00:00');
    insertConversation(2004, 104, 4, '2026-09-04 10:00:00');
    const result = builder.run({ metric: 'organizations', dimension: 'none', dateFrom: '2026-09-01', dateTo: '2026-09-30', comparison: 'none', sort: 'metric_desc' });
    // Compute Inc (2 customers), Vector Ltd (1), no-org (1) -> 2 distinct named orgs
    expect(result.rows[0]?.value).toBe(2);
  });

  it('groups organizations by mailbox through the customer join', () => {
    const builder = new ReportBuilderService(db);
    insertConversation(2005, 105, 1, '2026-08-05 10:00:00', false, 1);
    insertConversation(2006, 106, 3, '2026-08-06 10:00:00', false, 2);
    const result = builder.run({ metric: 'organizations', dimension: 'mailbox', dateFrom: '2026-08-01', dateTo: '2026-08-31', comparison: 'none', sort: 'metric_desc' });
    const byLabel = new Map(result.rows.map((r) => [r.dimension_label, r.value]));
    expect(byLabel.get('Support')).toBe(1);
    expect(byLabel.get('Billing')).toBe(1);
  });
});

describe('v2.2.1 fix: report builder sample conversations (was: display LABEL bound against the id GROUP KEY - samples always empty)', () => {
  it('resolves sample conversation ids for mailbox/assignee dimensions and NULL groups', () => {
    const builder = new ReportBuilderService(db);
    const inMailbox = insertConversation(2011, 111, 1, '2026-09-10 10:00:00', false, 1);
    insertConversation(2012, 112, 2, '2026-09-11 10:00:00', false, 2);
    const assigned = insertConversation(2013, 113, 3, '2026-09-12 10:00:00', false, 1, 1);
    insertConversation(2014, 114, 4, '2026-09-13 10:00:00', false, 1);

    const byMailbox = builder.run({ metric: 'conversations', dimension: 'mailbox', dateFrom: '2026-09-01', dateTo: '2026-09-30', comparison: 'none', sort: 'metric_desc' });
    const supportRow = byMailbox.rows.find((r) => r.dimension_label === 'Support');
    expect(supportRow).toBeDefined();
    expect(supportRow!.sample_conversation_ids).toContain(inMailbox);

    const byAssignee = builder.run({ metric: 'conversations', dimension: 'assignee', dateFrom: '2026-09-01', dateTo: '2026-09-30', comparison: 'none', sort: 'metric_desc' });
    const avaRow = byAssignee.rows.find((r) => r.dimension_label === 'Ava Chen');
    expect(avaRow).toBeDefined();
    expect(avaRow!.sample_conversation_ids).toContain(assigned);
    // NULL group ('(unassigned)') must match via IS NULL, never '= label'
    const unassignedRow = byAssignee.rows.find((r) => r.dimension_label === '(unassigned)');
    expect(unassignedRow).toBeDefined();
    expect(unassignedRow!.sample_conversation_ids.length).toBeGreaterThan(0);
  });

  it('applies the aggregate conversation filters to samples (status filter)', () => {
    const builder = new ReportBuilderService(db);
    const closed = insertConversation(2021, 121, 1, '2026-09-14 10:00:00', true);
    const active = insertConversation(2022, 122, 1, '2026-09-15 10:00:00', false);
    const result = builder.run({
      metric: 'conversations',
      dimension: 'none',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      comparison: 'none',
      sort: 'metric_desc',
      filters: { statuses: ['closed'] }
    });
    expect(result.rows[0]?.value).toBe(1);
    expect(result.rows[0]?.sample_conversation_ids).toEqual([closed]);
    expect(result.rows[0]?.sample_conversation_ids).not.toContain(active);
  });
});

describe('v2.2.1 fix: customer memory upsert conflict labeling (was: ON CONFLICT never updated source/provenance)', () => {
  it('never lets an AI write clobber a human-authored entry', () => {
    const repo = new AiRepository(db);
    repo.upsertMemory(1, 'plan', 'enterprise', { source: 'human', origin: 'manual', confidence: 'high' });
    repo.upsertMemory(1, 'plan', 'unknown', { source: 'ai', origin: 'conversation', confidence: 'low' });
    const row = db.prepare('SELECT value, source, provenance FROM customer_memories WHERE customer_id = 1 AND key = ?').get('plan') as Row;
    expect(row.value).toBe('enterprise');
    expect(row.source).toBe('human');
    expect(row.provenance).toBe('human_local');
  });

  it('relabels honestly when a human overwrites an AI entry', () => {
    const repo = new AiRepository(db);
    repo.upsertMemory(2, 'preferred channel', 'email (AI guess)', { source: 'ai', origin: 'conversation', confidence: 'medium' });
    repo.upsertMemory(2, 'preferred channel', 'phone', { source: 'human', origin: 'manual', confidence: 'high' });
    const row = db.prepare('SELECT value, source, provenance FROM customer_memories WHERE customer_id = 2 AND key = ?').get('preferred channel') as Row;
    expect(row.value).toBe('phone');
    expect(row.source).toBe('human');
    expect(row.provenance).toBe('human_local');
  });

  it('AI-over-AI updates keep source=ai', () => {
    const repo = new AiRepository(db);
    repo.upsertMemory(3, 'environment', 'staging', { source: 'ai', origin: 'conversation', confidence: 'low' });
    repo.upsertMemory(3, 'environment', 'production', { source: 'ai', origin: 'conversation', confidence: 'high' });
    const row = db.prepare('SELECT value, source, provenance FROM customer_memories WHERE customer_id = 3 AND key = ?').get('environment') as Row;
    expect(row.value).toBe('production');
    expect(row.source).toBe('ai');
    expect(row.provenance).toBe('ai_generated');
  });
});

describe('v2.2.1 fix: stale running-job sweep (was: stuck jobs waited forever for a restart)', () => {
  it('requeues running jobs older than the threshold and leaves fresh ones alone', () => {
    const jobs = new JobRepository(db);
    const stale = jobs.enqueue('sync', 'sync_conversation', { id: 1 }, 1, 3);
    db.prepare("UPDATE jobs SET status='running', started_at=datetime('now', '-45 minutes') WHERE id = ?").run(stale);
    const fresh = jobs.enqueue('sync', 'sync_conversation', { id: 2 }, 1, 3);
    db.prepare("UPDATE jobs SET status='running', started_at=datetime('now') WHERE id = ?").run(fresh);

    const requeued = jobs.requeueStaleRunningJobs(30);
    expect(requeued).toBeGreaterThanOrEqual(1);
    const staleRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(stale) as Row;
    const freshRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get(fresh) as Row;
    expect(staleRow.status).toBe('queued');
    expect(freshRow.status).toBe('running');
  });
});

describe('v2.2.1 fix: customer/org search LIKE wildcards (was: % and _ acted as patterns)', () => {
  it('treats % and _ in the query as literals', () => {
    const people = new PeopleRepository(db);
    const page = people.listCustomers(1, 50, '50%');
    expect(page.customers.length).toBe(0);
    const orgs = people.listOrganizations(1, 50, 'Compute_Inc');
    expect(orgs.organizations.length).toBe(0);
    // and literal text still matches
    expect(people.listCustomers(1, 50, 'Ada').customers.length).toBe(1);
    expect(people.listOrganizations(1, 50, 'Compute').organizations.length).toBe(1);
  });
});

describe('v2.2.1 fix: knowledge related-ticket estimate (was: knowledge FTS self-match count, not tickets)', () => {
  it('counts distinct conversations whose AI runs cited the document', () => {
    db.prepare("INSERT OR IGNORE INTO knowledge_sources (id, name, kind) VALUES (1, 'Manual', 'manual')").run();
    db.prepare("INSERT INTO knowledge_documents (source_id, title, content, visibility) VALUES (1, 'Exporting data', 'How to export', 'customer_safe')").run();
    const docId = Number((db.prepare("SELECT id FROM knowledge_documents WHERE title = 'Exporting data'").get() as Row).id);
    const citedConv = insertConversation(2031, 131, 1, '2026-09-16 10:00:00');
    const run1 = Number(db.prepare('SELECT id FROM ai_runs ORDER BY id DESC LIMIT 1 OFFSET 0').get()?.id ?? 0) + 1;
    db.prepare('INSERT INTO ai_runs (id, conversation_id, type, created_at) VALUES (?, ?, ?, datetime(\'now\'))').run(run1, citedConv, 'ticket_analysis');
    db.prepare('INSERT INTO ai_sources (run_id, source_type, source_id, title) VALUES (?, ?, ?, ?)').run(run1, 'knowledge_document', docId, 'Exporting data');
    const run2 = run1 + 1;
    db.prepare('INSERT INTO ai_runs (id, conversation_id, type, created_at) VALUES (?, ?, ?, datetime(\'now\'))').run(run2, citedConv, 'draft_generation');
    db.prepare('INSERT INTO ai_sources (run_id, source_type, source_id, title) VALUES (?, ?, ?, ?)').run(run2, 'knowledge_document', docId, 'Exporting data');
    // The SQL the route now runs (kept in lockstep with routes/knowledge.ts):
    const n = (db
      .prepare(
        `SELECT COUNT(DISTINCT r.conversation_id) AS n
           FROM ai_sources s JOIN ai_runs r ON r.id = s.run_id
          WHERE s.source_type = 'knowledge_document' AND s.source_id = ? AND r.conversation_id IS NOT NULL`
      )
      .get(docId) as { n: number }).n;
    expect(n).toBe(1); // two citations, ONE distinct conversation
  });
});
