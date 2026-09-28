import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { GraphService } from '../../src/server/graph/graphService.js';
import { CustomerMemoryService } from '../../src/server/memory/customerMemoryService.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { InteractionEngine } from '../../src/server/ai/interaction/engine.js';

/**
 * v2.2.0 (M6, plan Phase 41 + 48) performance regression guards. A synthetic
 * large world (2,000 conversations x threads, 400 customers) exercises the
 * hot read paths with generous CI-safe budgets plus DETERMINISTIC index-usage
 * assertions via EXPLAIN QUERY PLAN (timing budgets can flake on shared
 * runners; plan-shape assertions cannot).
 */

const CONVERSATIONS = 2000;
const CUSTOMERS = 400;

let db: ReturnType<typeof openTestDatabase>;
let graph: GraphService;
let memory: CustomerMemoryService;
let conversationRepo: ConversationRepository;
let hubCustomer: number;
let hubConversation: number;

function insertConversation(remote: number, number: number, customer: number, createdAt: string, closed: boolean): number {
  db.prepare(
    `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, closed_at, local_created_at, local_updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(remote, number, `Ticket ${number} about exports and timeouts and billing`, closed ? 'closed' : 'active', customer, createdAt, closed ? createdAt : null);
  return Number((db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(remote) as { id: number }).id);
}

function insertThread(convId: number, remote: number, type: 'customer' | 'reply', body: string, at: string): void {
  db.prepare(
    `INSERT INTO threads (remote_id, conversation_id, type, body_text, state, remote_created_at, local_created_at)
     VALUES (?, ?, ?, ?, 'published', ?, datetime('now'))`
  ).run(remote, convId, type, body, at);
}

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (501, 'Support', 'support')").run();
  db.prepare("INSERT INTO organizations (remote_id, name, domains) VALUES (701, 'Bulk Inc', 'bulk.example')").run();

  const insertCustomer = db.prepare('INSERT INTO customers (remote_id, first_name, last_name, organization_id, remote_created_at) VALUES (?, ?, ?, 1, ?)');
  const customerIds: number[] = [];
  for (let i = 0; i < CUSTOMERS; i++) {
    const info = insertCustomer.run(9000 + i, `First${i}`, `Last${i}`, `2025-01-${(i % 28) + 1} 10:00:00`);
    customerIds.push(Number(info.lastInsertRowid));
  }

  // Hub customer: 150 conversations (a large-but-realistic account).
  hubCustomer = customerIds[0]!;
  let convCount = 0;
  const insertBatch = db.transaction(() => {
    for (let i = 0; i < CONVERSATIONS; i++) {
      const customer = i < 150 ? hubCustomer : customerIds[Math.floor(i / 5) % CUSTOMERS]!;
      const closed = i % 3 === 0;
      const conv = insertConversation(10000 + i, 2000 + i, customer, `2026-08-${(i % 28) + 1} 10:00:00`, closed);
      convCount++;
      insertThread(conv, 200000 + i * 3, 'customer', 'My export fails with a timeout error when the file is large. What is the default timeout for the compute API and does it retry automatically?', `2026-08-${(i % 28) + 1} 10:05:00`);
      insertThread(conv, 200001 + i * 3, 'reply', 'Thanks for reaching out. The default timeout is 30 seconds. Could you confirm your account email so we can check the logs?', `2026-08-${(i % 28) + 1} 11:00:00`);
      if (closed) {
        insertThread(conv, 200002 + i * 3, 'customer', 'Thanks, that solved it.', `2026-08-${(i % 28) + 1} 12:00:00`);
      }
    }
  });
  insertBatch();
  expect(convCount).toBe(CONVERSATIONS);
  hubConversation = Number((db.prepare('SELECT id FROM conversations WHERE customer_local_id = ? ORDER BY id LIMIT 1').get(hubCustomer) as { id: number }).id);

  // Interaction intelligence over the hub customer only (bounded setup time).
  const engine = new InteractionEngine(db);
  const hubConvs = db.prepare('SELECT id FROM conversations WHERE customer_local_id = ?').all(hubCustomer) as { id: number }[];
  for (const c of hubConvs) {
    engine.recordCurrentInteraction(c.id, { rebuildBaseline: false });
    engine.computeOutcome(c.id);
  }
  engine.rebuildBaseline(hubCustomer);

  graph = new GraphService(db);
  memory = new CustomerMemoryService(db);
  conversationRepo = new ConversationRepository(db);
}, 120_000);

afterAll(() => {
  closeDatabase(db);
});

describe('performance regression guards (Phase 41 / Phase 48)', () => {
  it('serves the hot conversation list path within budget on 2,000 conversations', () => {
    const start = performance.now();
    const page = conversationRepo.listConversations({ page: 1, pageSize: 50 });
    const ms = performance.now() - start;
    expect(page.conversations.length).toBeLessThanOrEqual(50);
    expect(ms).toBeLessThan(1000);
  });

  it('resolves graph neighbors for a hub conversation within budget (no N+1 label lookups)', () => {
    const start = performance.now();
    const nb = graph.neighbors('conversation', hubConversation, { limit: 200 });
    const ms = performance.now() - start;
    expect(nb).not.toBeNull();
    expect(ms).toBeLessThan(1500);
  });

  it('resolves graph neighbors for the hub CUSTOMER (150 conversations) within budget', () => {
    const start = performance.now();
    const nb = graph.neighbors('customer', hubCustomer, { limit: 200 });
    const ms = performance.now() - start;
    expect(nb).not.toBeNull();
    expect(nb!.total_edges).toBeGreaterThanOrEqual(150);
    expect(ms).toBeLessThan(2000);
  });

  it('composes the full customer memory profile within budget', () => {
    const start = performance.now();
    const profile = memory.profile(hubCustomer);
    const ms = performance.now() - start;
    expect(profile).not.toBeNull();
    const resolutions = profile!.sections.find((s) => s.section === 'previous_resolutions')!.entries.length;
    expect(resolutions).toBe(25); // bounded by design (LIMIT 25, plan Phase 41)
    expect(ms).toBeLessThan(2500);
  });

  it('uses an index for the hot customer-conversations lookup (deterministic plan check)', () => {
    const plans = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE customer_local_id = ? AND deleted_at IS NULL').all(hubCustomer) as { detail: string }[];
    const detail = plans.map((p) => p.detail).join(' ').toLowerCase();
    expect(detail).toContain('index');
    expect(detail).not.toContain('scan conversations');
  });

  it('uses an index for the memory campaign-history lookup', () => {
    const plans = db.prepare('EXPLAIN QUERY PLAN SELECT campaign_id FROM outreach_recipients WHERE customer_local_id = ?').all(hubCustomer) as { detail: string }[];
    const detail = plans.map((p) => p.detail).join(' ').toLowerCase();
    expect(detail).toContain('index');
    expect(detail).not.toContain('scan outreach_recipients');
  });

  it('keeps the interaction card build cheap after coverage exists (count-guarded backfill)', () => {
    const engine = new InteractionEngine(db);
    // First build may compute; the second must not re-run the backfill
    // (cheap COUNT guard short-circuits when coverage is complete).
    engine.buildCard(hubConversation);
    const start = performance.now();
    const card = engine.buildCard(hubConversation);
    const ms = performance.now() - start;
    expect(card).not.toBeNull();
    expect(ms).toBeLessThan(2000);
  });

  it('bounds graph search across every node kind within budget', () => {
    const start = performance.now();
    const results = graph.search('Ticket');
    const ms = performance.now() - start;
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(80);
    expect(ms).toBeLessThan(1500);
  });
});
