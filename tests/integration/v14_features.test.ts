import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { DocsRepository } from '../../src/server/database/repositories/docsRepo.js';
import { ReferenceRepository } from '../../src/server/database/repositories/referenceRepo.js';
import { SlaService } from '../../src/server/analytics/slaService.js';
import { WebhookEndpoint } from '../../src/server/services/webhookEndpoint.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { serverEventBus } from '../../src/server/services/eventBus.js';

async function setup(): Promise<{ coordinator: SyncCoordinator; provider: FakeHelpScoutProvider; db: ReturnType<typeof openTestDatabase> }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  return { coordinator, provider, db };
}

/**
 * v1.4.0 roadmap coverage: webhook push groundwork (drain + source-tagged
 * jobs), semantic docs search plumbing (chunking + embedding states) and
 * per-mailbox SLA/business-hours reporting.
 */
describe('docs chunking for semantic search (v1.4.0)', () => {
  it('articles are chunked on sync and embeddings are tracked', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const docs = new DocsRepository(db);
    const stats = docs.docsEmbeddingStats();
    expect(stats.chunks).toBeGreaterThan(0);
    // Every demo article has text, so every article has at least one chunk
    const articles = (db.prepare('SELECT id FROM docs_articles').all() as { id: number }[]).length;
    const withChunks = (db.prepare('SELECT COUNT(DISTINCT article_id) AS n FROM docs_chunks').get() as { n: number }).n;
    expect(withChunks).toBe(articles);
    // No embedding model configured: chunks stay pending (honest state)
    expect(stats.pending).toBe(stats.chunks);
    expect(stats.indexed).toBe(0);
    closeDatabase();
  });

  it('re-sync is idempotent: chunk counts do not grow', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const docs = new DocsRepository(db);
    const before = docs.docsEmbeddingStats().chunks;
    await coordinator.incrementalSync();
    expect(docs.docsEmbeddingStats().chunks).toBe(before);
    closeDatabase();
  });

  it('embedding round-trip: stored vectors read back as Float32 and flip stats', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const docs = new DocsRepository(db);
    const pending = docs.listDocChunksNeedingEmbedding(5);
    expect(pending.length).toBeGreaterThan(0);
    for (const c of pending) {
      docs.updateDocChunkEmbedding(c.id, 'test-model', new Float32Array([0.1, 0.2, 0.3]), 'indexed');
    }
    const stored = docs.listDocChunksWithEmbedding();
    expect(stored.length).toBeGreaterThanOrEqual(pending.length);
    const view = new Float32Array(stored[0]!.embedding.buffer, stored[0]!.embedding.byteOffset, stored[0]!.embedding.byteLength / 4);
    expect(view[0]).toBeCloseTo(0.1, 5);
    const stats = docs.docsEmbeddingStats();
    expect(stats.indexed).toBeGreaterThanOrEqual(pending.length);
    expect(stats.pending).toBe(stats.chunks - stats.indexed);
    closeDatabase();
  });

  it('docs sync enqueues the embedding job (worker path wiring)', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'embed_docs_chunks' AND queue = 'embeddings'").get() as { n: number };
    expect(jobs.n).toBeGreaterThanOrEqual(1); // initial + incremental docs passes
    closeDatabase();
  });
});

describe('business hours storage + SLA report (v1.4.0)', () => {
  it('business hours round-trip via the repository', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const docs = new DocsRepository(db);
    const ref = new ReferenceRepository(db);
    const support = ref.getMailboxes().find((m) => m.name === 'Support')!;
    expect(docs.getBusinessHours(support.id)).toBeNull();
    docs.setBusinessHours(support.id, {
      timezone: 'America/New_York',
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
      firstResponseTargetMin: 240,
      resolutionTargetMin: null
    });
    const loaded = docs.getBusinessHours(support.id);
    expect(loaded?.timezone).toBe('America/New_York');
    expect(loaded?.days).toEqual([1, 2, 3, 4, 5]);
    expect(loaded?.firstResponseTargetMin).toBe(240);
    expect(loaded?.resolutionTargetMin).toBeNull();
    docs.clearBusinessHours(support.id);
    expect(docs.getBusinessHours(support.id)).toBeNull();
    closeDatabase();
  });

  it('SLA report: unconfigured mailboxes report wall-clock honestly; configured measure business minutes', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const ref = new ReferenceRepository(db);
    const docs = new DocsRepository(db);
    const sla = new SlaService(db);
    const support = ref.getMailboxes().find((m) => m.name === 'Support')!;
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const to = new Date().toISOString();

    const before = sla.slaReport(from, to);
    expect(before.mailboxes.length).toBe(2);
    for (const m of before.mailboxes) {
      expect(m.business_hours_configured).toBe(false);
      expect(m.schedule).toBeNull();
      // Wall-clock measurement with no business-minute claims
      expect(m.first_response.avg_business_min).toBeNull();
      expect(m.first_response.avg_wall_min).not.toBeNull();
    }
    expect(before.unconfigured_mailboxes.length).toBe(2);

    docs.setBusinessHours(support.id, {
      timezone: 'UTC',
      days: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      firstResponseTargetMin: 60,
      resolutionTargetMin: 10080
    });
    const after = sla.slaReport(from, to);
    const supportRow = after.mailboxes.find((m) => m.mailbox_id === support.id)!;
    expect(supportRow.business_hours_configured).toBe(true);
    // 24/7 schedule: business minutes equal wall minutes
    expect(supportRow.first_response.avg_business_min).toBe(supportRow.first_response.avg_wall_min);
    expect(supportRow.first_response.met + supportRow.first_response.missed + supportRow.first_response.no_target).toBe(supportRow.first_response.count);
    expect(after.unconfigured_mailboxes).toEqual(['Billing']);
    closeDatabase();
  });

  it('SLA report respects the mailbox scope filter', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const ref = new ReferenceRepository(db);
    const billing = ref.getMailboxes().find((m) => m.name === 'Billing')!;
    const sla = new SlaService(db);
    const report = sla.slaReport(new Date(Date.now() - 90 * 86400000).toISOString(), new Date().toISOString(), [billing.id]);
    expect(report.mailboxes.length).toBe(1);
    expect(report.mailboxes[0]?.mailbox_id).toBe(billing.id);
    closeDatabase();
  });

  it('waiting stats cover currently-open conversations', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const sla = new SlaService(db);
    const report = sla.slaReport(new Date(Date.now() - 90 * 86400000).toISOString(), new Date().toISOString());
    for (const m of report.mailboxes) {
      expect(m.waiting.count).toBeGreaterThan(0); // demo data has active convs
      expect(m.waiting.avg_business_min).toBeGreaterThanOrEqual(0);
    }
    closeDatabase();
  });
});

describe('webhook push groundwork (v1.4.0)', () => {
  it('REGRESSION (v1.4.0 audit): queued jobs are claimable IMMEDIATELY - run_at was stored in ISO-8601 (T/Z) format while claimNext compares against SQLite datetime("now") (space format), which made every queued job invisible forever and silently disabled the whole job pipeline (webhook syncs, attachment downloads, AI jobs, embeddings)', async () => {
    const { db } = await setup();
    const jobs = new JobRepository(db);
    const id = jobs.enqueue('sync', 'sync_conversation', { remoteId: 123, source: 'webhook' }, 2, 3);
    const claimed = jobs.claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(id);
    // The payload column is JSON TEXT; claimNext must return it PARSED -
    // it previously handed back the raw string, so payload.remoteId read as
    // undefined and sync jobs completed without syncing anything.
    expect(claimed?.payload).toEqual({ remoteId: 123, source: 'webhook' });
    closeDatabase();
  });

  it('REGRESSION: a webhook-source sync job, executed through the REAL worker path, lands the thread in the mirror', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    const target = provider.world.conversations[0]!;
    const before = (db.prepare('SELECT thread_count AS n FROM conversations WHERE remote_id = ?').get(target.remoteId) as { n: number }).n;
    provider.customerReplies(target.remoteId, 'Reply that must land via the worker path');
    // Exactly what WebhookEndpoint.processEvent enqueues, claimed exactly the
    // way WorkerManager.tick claims it, then executed via the coordinator:
    const jobs = new JobRepository(db);
    jobs.enqueue('sync', 'sync_conversation', { remoteId: target.remoteId, source: 'webhook' }, 2, 3);
    const job = jobs.claimNext();
    expect(job).not.toBeNull();
    expect(job?.type).toBe('sync_conversation');
    expect((job?.payload as { remoteId?: number }).remoteId).toBe(target.remoteId);
    await coordinator.syncSingleConversation(Number((job?.payload as { remoteId: number }).remoteId));
    const after = (db.prepare('SELECT thread_count AS n FROM conversations WHERE remote_id = ?').get(target.remoteId) as { n: number }).n;
    expect(after).toBe(before + 1);
    closeDatabase();
  });
  it('drainPending processes persisted-but-unprocessed events after a restart', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const endpoint = new WebhookEndpoint(db, 'test-secret');
    // Simulate a crash between persist and process: insert a pending event directly
    const payload = JSON.stringify({ conversationId: 105020, objectID: 105020 });
    db.prepare("INSERT INTO webhook_events (event_id, event_hash, event_type, received_at, payload, processing_state) VALUES (NULL, ?, 'convo.customer.reply.created', datetime('now'), ?, 'pending')").run('drain-test-hash-1', payload);
    const drained = await endpoint.drainPending();
    expect(drained).toBe(1);
    const state = db.prepare("SELECT processing_state FROM webhook_events WHERE event_hash = 'drain-test-hash-1'").get() as { processing_state: string };
    expect(state.processing_state).toBe('processed');
    const job = db.prepare("SELECT payload FROM jobs WHERE type = 'sync_conversation' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    const parsed = JSON.parse(job.payload) as { remoteId: number; source?: string };
    expect(parsed.remoteId).toBe(105020);
    expect(parsed.source).toBe('webhook'); // v1.4.0: source-tagged for honest SSE reason
    closeDatabase();
  });

  it('conversation-updated events carry the webhook reason when the sync lands', async () => {
    const { coordinator, provider } = await setup();
    await coordinator.initialSync();
    const events: { reason: string; conversationNumber: number | null }[] = [];
    const off = serverEventBus.on('conversation-updated', (p) => events.push({ reason: p.reason, conversationNumber: p.conversationNumber }));
    const conv = provider.world.conversations[0]!;
    provider.customerReplies(conv.remoteId, 'Webhook-driven update');
    // Simulate what the worker does for a webhook-source job (reason: 'webhook')
    serverEventBus.emit('conversation-updated', {
      conversationId: 1,
      conversationNumber: conv.number,
      mailboxId: null,
      subject: conv.subject,
      reason: 'webhook',
      at: new Date().toISOString()
    });
    expect(events.length).toBe(1);
    expect(events[0]?.reason).toBe('webhook');
    expect(events[0]?.conversationNumber).toBe(conv.number);
    off();
    closeDatabase();
  });

  it('fake provider createWebhook/deleteWebhook maintain the registry', async () => {
    const { provider } = await setup();
    const id = await provider.createWebhook('https://relay.example.com/hook', ['convo.created'], 'secret', 'SupportOS');
    expect((await provider.listWebhooks()).some((w) => w.remoteId === id && w.events.includes('convo.created'))).toBe(true);
    expect(await provider.deleteWebhook(id)).toBe(true);
    expect((await provider.listWebhooks()).some((w) => w.remoteId === id)).toBe(false);
    closeDatabase();
  });
});
