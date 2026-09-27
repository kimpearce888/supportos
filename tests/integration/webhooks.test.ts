import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncRepository } from '../../src/server/database/repositories/syncRepo.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { WebhookEndpoint } from '../../src/server/services/webhookEndpoint.js';

function computeSignature(raw: string, secret: string): string {
  return crypto.createHmac('sha1', secret).update(Buffer.from(raw, 'utf8')).digest('base64');
}

describe('webhook signature verification (spec #13)', () => {
  it('verifies a valid Help Scout signature (base64 HMAC-SHA1 of the raw body)', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const endpoint = new WebhookEndpoint(db, 'test-secret');
    const raw = JSON.stringify({ id: 1, objectID: 105001 });
    const sig = computeSignature(raw, 'test-secret');
    expect(endpoint.verifySignature(raw, sig, 'test-secret')).toBe(true);
    expect(endpoint.verifySignature(raw, 'wrong', 'test-secret')).toBe(false);
    expect(endpoint.verifySignature(raw, sig, 'other-secret')).toBe(false);
    expect(endpoint.verifySignature(raw, undefined, 'test-secret')).toBe(false);
    closeDatabase();
  });
});

describe('webhook event processing (spec #14)', () => {
  it('persists events first, dedupes identical events, and enqueues async processing', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const provider = new FakeHelpScoutProvider();
    const coordinator = new SyncCoordinator(db, provider);
    await coordinator.initialSync();
    const endpoint = new WebhookEndpoint(db, '');
    const sync = new SyncRepository(db);
    const payload = JSON.stringify({ id: 99, objectID: 105001 });

    const first = sync.insertWebhookEvent('convo.created', payload, '99');
    expect(first.duplicate).toBe(false);
    await endpoint.processEvent(first.id, 'convo.created', payload);
    expect(sync.getWebhookStats().processed).toBe(1);

    // Duplicate delivery of the identical event: same hash -> deduped (never processed twice)
    const second = sync.insertWebhookEvent('convo.created', payload, '99');
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    if (second.duplicate) sync.setWebhookEventState(second.id, 'duplicate');
    expect(sync.getWebhookStats().duplicates).toBe(1);
    expect(sync.getWebhookStats().total).toBe(1);

    const jobs = new JobRepository(db);
    const allJobs = [...jobs.listJobs({ status: 'queued' }), ...jobs.listJobs({ status: 'completed' })];
    expect(allJobs.some((j) => j.type === 'sync_conversation' && (j.payload as { remoteId?: number }).remoteId === 105001)).toBe(true);
    closeDatabase();
  });

  it('routes event types to the right queue jobs', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const endpoint = new WebhookEndpoint(db, '');
    const sync = new SyncRepository(db);
    const cases: { type: string; payload: string; expectedJob: string }[] = [
      { type: 'convo.customer.reply.created', payload: JSON.stringify({ objectID: 105002 }), expectedJob: 'sync_conversation' },
      { type: 'convo.deleted', payload: JSON.stringify({ objectID: 105003 }), expectedJob: 'delete_conversation' },
      { type: 'customer.updated', payload: JSON.stringify({ objectID: 3001 }), expectedJob: 'sync_customer' },
      { type: 'tag.updated', payload: JSON.stringify({}), expectedJob: 'sync_tags' },
      { type: 'user.status.changed', payload: JSON.stringify({}), expectedJob: 'sync_user_statuses' },
      { type: 'satisfaction.ratings', payload: JSON.stringify({ objectID: 105004 }), expectedJob: 'sync_conversation_ratings' }
    ];
    for (const c of cases) {
      const inserted = sync.insertWebhookEvent(c.type, c.payload, 'x-' + c.type);
      await endpoint.processEvent(inserted.id, c.type, c.payload);
    }
    const jobs = new JobRepository(db);
    const allJobs = [...jobs.listJobs({ status: 'queued' }), ...jobs.listJobs({ status: 'completed' })];
    for (const c of cases) {
      expect(allJobs.some((j) => j.type === c.expectedJob), `expected job ${c.expectedJob} for event ${c.type}`).toBe(true);
    }
    closeDatabase();
  });

  it('survives unparseable payloads without crashing (marks failed)', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const endpoint = new WebhookEndpoint(db, '');
    const sync = new SyncRepository(db);
    const inserted = sync.insertWebhookEvent('convo.created', 'not-json{{', 'x1');
    await endpoint.processEvent(inserted.id, 'convo.created', 'not-json{{');
    const events = sync.listWebhookEvents(10);
    const failed = events.find((e) => e.id === inserted.id);
    expect(failed?.processing_state).toBe('failed');
    closeDatabase();
  });
});
