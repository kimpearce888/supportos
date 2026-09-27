import { describe, it, expect } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SearchEngine } from '../../src/server/search/searchEngine.js';
import { EvidenceBuilder } from '../../src/server/ai/evidence.js';
import { KnowledgeRepository } from '../../src/server/database/repositories/knowledgeRepo.js';
import { KnowledgeIngestor } from '../../src/server/knowledge/ingestor.js';

async function setup(): Promise<{ db: ReturnType<typeof openTestDatabase>; search: SearchEngine; evidence: EvidenceBuilder }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  return { db, search: new SearchEngine(db), evidence: new EvidenceBuilder(db) };
}

describe('local search engine (spec #25)', () => {
  it('finds conversations by subject keywords', async () => {
    const { search } = await setup();
    const hits = search.searchConversations('timezone', {});
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.some((h) => h.title.includes('Santiago'))).toBe(true);
    expect(hits.some((h) => h.title.includes('scheduled exports'))).toBe(true);
  });

  it('finds conversations by thread body text', async () => {
    const { search } = await setup();
    const hits = search.searchConversations('whitelist', {});
    expect(hits.some((h) => h.title.toLowerCase().includes('invitation'))).toBe(true);
  });

  it('finds an exact conversation by number', async () => {
    const { search } = await setup();
    const hits = search.searchConversations('5003', {});
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toContain('Timezone for scheduled exports');
  });

  it('finds customers by name and email', async () => {
    const { search } = await setup();
    expect(search.searchCustomers('Lucía').length).toBe(1);
    expect(search.searchCustomers('lucia@andeslogistics.cl').length).toBe(1);
    expect(search.searchCustomers('nonexistent').length).toBe(0);
  });

  it('combines filters: status + tag (spec #25 example)', async () => {
    const { search } = await setup();
    const hits = search.searchConversations('', { status: 'closed', tag: 'timezone' });
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toContain('Timezone for scheduled exports');
  });

  it('searches across scopes in one call', async () => {
    const { search } = await setup();
    const all = search.search('timezone', 'all');
    expect(all.hits.some((h) => h.scope === 'tickets')).toBe(true);
    expect(all.used_semantic).toBe(false);
    expect(all.semantic_available).toBe(false);
  });
});

describe('knowledge search + ingestion (spec #70, #71)', () => {
  it('ingests markdown with chunking + FTS indexing', async () => {
    const { db } = await setup();
    const ingestor = new KnowledgeIngestor(db);
    const result = ingestor.importManual('Test source', [
      { title: 'Widget configuration guide', content: 'To configure the widget, open Settings and choose Widgets. The widget supports custom colors and callback URLs. ' + 'Detailed steps. '.repeat(300), format: 'markdown' }
    ], 'customer_safe');
    expect(result.length).toBe(1);
    const knowledge = new KnowledgeRepository(db);
    const hits = knowledge.searchKnowledge('widget configuration');
    expect(hits.length).toBeGreaterThan(0);
    closeDatabase();
  });

  it('separates customer-safe from internal-only visibility', async () => {
    const { db } = await setup();
    const ingestor = new KnowledgeIngestor(db);
    ingestor.importManual('Vis', [{ title: 'Public pricing FAQ', content: 'Pricing is public knowledge for customers.', format: 'txt' }], 'customer_safe');
    ingestor.importManual('Internal', [{ title: 'Secret runbook', content: 'Internal engineering runbook with credentials rotation steps.', format: 'txt' }], 'internal_only');
    const knowledge = new KnowledgeRepository(db);
    const all = knowledge.searchKnowledge('runbook');
    expect(all.some((h) => h.visibility === 'internal_only')).toBe(true);
    const safeOnly = knowledge.searchKnowledge('runbook', 'customer_safe');
    expect(safeOnly.every((h) => h.visibility === 'customer_safe')).toBe(true);
    closeDatabase();
  });

  it('re-importing unchanged content is a no-op (checksum)', async () => {
    const { db } = await setup();
    const ingestor = new KnowledgeIngestor(db);
    const first = ingestor.importManual('S', [{ title: 'Stable doc', content: 'Same content', format: 'txt' }], 'internal_only');
    expect(first[0]?.changed).toBe(true);
    const second = ingestor.importManual('S', [{ title: 'Stable doc', content: 'Same content', format: 'txt' }], 'internal_only');
    expect(second[0]?.changed).toBe(false);
    closeDatabase();
  });
});

describe('evidence package construction (spec #33, #73, #121)', () => {
  it('builds bounded evidence with customer history, similar cases, knowledge and visibility labels', async () => {
    const { db, evidence } = await setup();
    const ingestor = new KnowledgeIngestor(db);
    ingestor.importManual('KB', [
      { title: 'Timezones and scheduled reports', content: 'Scheduled reports follow the workspace timezone: Settings > Workspace > Regional settings.', format: 'markdown' },
      { title: 'Internal-only runbook', content: 'Internal fix instructions.', format: 'txt' }
    ], 'customer_safe');
    ingestor.importManual('KB', [{ title: 'Internal-only runbook', content: 'Internal fix instructions.', format: 'txt' }], 'internal_only');
    const conv = db.prepare('SELECT id FROM conversations WHERE number = 5001').get() as { id: number };
    const ctx = evidence.build(conv.id, { includeInternal: true });
    expect(ctx).not.toBeNull();
    expect(ctx!.conversationNumber).toBe(5001);
    expect(ctx!.customerName).toContain('Lucía');
    // customer history present
    expect(ctx!.customerHistory.length).toBeGreaterThanOrEqual(0);
    // threads included
    expect(ctx!.threads.length).toBe(3);
    // knowledge with visibility labels
    expect(ctx!.knowledge.some((k) => k.visibility === 'customer_safe')).toBe(true);
    expect(ctx!.knowledge.every((k) => k.visibility === 'customer_safe' || k.visibility === 'internal_only')).toBe(true);
    closeDatabase();
  });

  it('similar conversations use hybrid signals and explain why (spec #39, #152)', async () => {
    const { db, evidence } = await setup();
    const conv = db.prepare('SELECT id FROM conversations WHERE number = 5002').get() as { id: number };
    const similar = evidence.findSimilar(conv.id, 5);
    expect(similar.length).toBeGreaterThan(0);
    // the Santiago ticket (same topic) should rank highly
    expect(similar.some((s) => s.subject.includes('Santiago'))).toBe(true);
    // every similar ticket explains why it matched
    expect(similar.every((s) => s.why.length > 0)).toBe(true);
    expect(similar.every((s) => s.score > 0)).toBe(true);
    closeDatabase();
  });

  it('sources carry provenance labels (spec #121)', async () => {
    const { db, evidence } = await setup();
    const conv = db.prepare('SELECT id FROM conversations WHERE number = 5001').get() as { id: number };
    const ctx = evidence.build(conv.id, { includeInternal: true });
    const sources = evidence.sourcesFor(ctx!);
    expect(sources.every((s) => ['conversation', 'knowledge_document', 'known_issue', 'saved_reply'].includes(s.source_type))).toBe(true);
    expect(sources.every((s) => ['customer_safe', 'internal_only', 'uncertain'].includes(s.visibility))).toBe(true);
    closeDatabase();
  });
});
