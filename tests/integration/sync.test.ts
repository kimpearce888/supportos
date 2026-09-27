import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncRepository } from '../../src/server/database/repositories/syncRepo.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';
import { ReferenceRepository } from '../../src/server/database/repositories/referenceRepo.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';

async function setup(): Promise<{ coordinator: SyncCoordinator; provider: FakeHelpScoutProvider; db: ReturnType<typeof openTestDatabase> }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  return { coordinator, provider, db };
}

describe('initial synchronization (spec #8, #10)', () => {
  it('populates all resources and reaches LIVE state', async () => {
    const { coordinator, provider, db } = await setup();
    const results = await coordinator.initialSync();
    expect(coordinator.getState()).toBe('LIVE');
    const failed = results.filter((r) => r.error);
    expect(failed).toEqual([]);
    // reference data
    const ref = new ReferenceRepository(db);
    expect(ref.getMailboxes().length).toBe(2);
    expect(ref.getUsers().length).toBe(3);
    expect(ref.getSystemUsers().length).toBe(1);
    expect(ref.getTeams().length).toBe(2);
    expect(ref.getTags().length).toBe(13);
    expect(ref.getInboxFields().length).toBeGreaterThanOrEqual(3);
    expect(ref.getSavedReplies().length).toBe(5);
    expect(ref.getWorkflows().length).toBe(3);
    // people
    const people = new PeopleRepository(db);
    const customers = people.listCustomers(1, 100);
    expect(customers.total).toBe(8);
    expect(people.listOrganizations(1, 50).total).toBe(2);
    // conversations + threads
    const conv = new ConversationRepository(db);
    const all = conv.listConversations({ view: 'all', pageSize: 100 });
    expect(all.total).toBe(14); // 15 (12 + 3 Ravi history tickets) minus the merged one
    const withThreads = all.conversations.filter((c) => c.thread_count > 0);
    expect(withThreads.length).toBe(14);
    // ratings (fake provider provides them)
    const ratings = (db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n;
    expect(ratings).toBe(4);
    // raw JSON retained (spec #16)
    const raw = (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE raw_json IS NOT NULL AND raw_json_hash IS NOT NULL').get() as { n: number }).n;
    expect(raw).toBe(14);
    closeDatabase();
    void provider;
  });

  it('is idempotent: re-running initial sync does not duplicate records (spec #8 duplicate prevention)', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
    const threadsBefore = (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
    await coordinator.initialSync();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
    const threadsAfter = (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
    expect(after).toBe(before);
    expect(threadsAfter).toBe(threadsBefore);
    closeDatabase();
  });

  it('records checkpoints for every resource (spec #8)', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const sync = new SyncRepository(db);
    const checkpoints = sync.getAllCheckpoints();
    expect(checkpoints.length).toBeGreaterThanOrEqual(19);
    expect(checkpoints.every((c) => c.status === 'ok')).toBe(true);
    expect(sync.lastSuccessfulSync()).not.toBeNull();
    closeDatabase();
  });
});

describe('incremental synchronization (spec #11)', () => {
  it('detects new and changed conversations since the checkpoint', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    // A new conversation arrives remotely
    const created = provider.createConversationOnRemote({
      subject: 'New integration question',
      preview: 'How do webhooks work?',
      mailboxId: 201,
      customerRemoteId: 3008,
      body: 'Hello, can you explain how webhooks work?'
    });
    const results = await coordinator.incrementalSync();
    const conv = new ConversationRepository(db);
    const found = conv.getConversationByRemoteId(created.remoteId);
    expect(found).toBeDefined();
    expect(found?.subject).toBe('New integration question');
    const failed = results.filter((r) => r.error);
    expect(failed).toEqual([]);
    closeDatabase();
  });

  it('picks up remote changes to existing conversations (threads added)', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    const world = provider.world;
    const target = world.conversations.find((c) => c.number === 5001)!;
    const threadsBefore = (db.prepare('SELECT COUNT(*) AS n FROM threads WHERE conversation_id = (SELECT id FROM conversations WHERE remote_id = ?)').get(target.remoteId) as { n: number }).n;
    provider.customerReplies(target.remoteId, 'One more follow-up question about the second report.');
    await coordinator.incrementalSync();
    const threadsAfter = (db.prepare('SELECT COUNT(*) AS n FROM threads WHERE conversation_id = (SELECT id FROM conversations WHERE remote_id = ?)').get(target.remoteId) as { n: number }).n;
    expect(threadsAfter).toBe(threadsBefore + 1);
    closeDatabase();
  });
});

describe('merged conversations (spec #67)', () => {
  it('stores merged_into_conversation_id when Help Scout answers 301 (documented behavior)', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const provider = new FakeHelpScoutProvider();
    // Start with the conversation NOT merged, so the initial sync stores it
    const mergedConv = provider.world.conversations.find((c) => (c as { mergedInto?: number }).mergedInto != null)!;
    const targetRemote = (mergedConv as { mergedInto?: number }).mergedInto!;
    delete (mergedConv as { mergedInto?: number }).mergedInto;
    const coordinator = new SyncCoordinator(db, provider);
    await coordinator.initialSync();
    const convRepo = new ConversationRepository(db);
    const localMerged = convRepo.getConversationByRemoteId(mergedConv.remoteId);
    expect(localMerged).toBeDefined();
    expect(localMerged?.merged_into_conversation_id).toBeNull();
    // The conversation gets merged remotely (old ID answers 301 with Location)
    (mergedConv as { mergedInto?: number }).mergedInto = targetRemote;
    await coordinator.syncSingleConversation(mergedConv.remoteId);
    const after = convRepo.getConversationByRemoteId(mergedConv.remoteId);
    expect(after?.merged_into_conversation_id).not.toBeNull();
    const targetLocal = convRepo.getConversationByRemoteId(targetRemote);
    expect(after?.merged_into_conversation_id).toBe(targetLocal?.id);
    closeDatabase();
  });
});

describe('reconciliation (spec #12)', () => {
  it('detects remote deletions and marks records deleted locally', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    const world = provider.world;
    const victim = world.conversations.find((c) => !((c as { mergedInto?: number }).mergedInto))!;
    provider.deleteConversationRemote(victim.remoteId);
    const result = await coordinator.reconcile();
    expect(result.deleted).toBe(1);
    const conv = new ConversationRepository(db);
    const local = conv.getConversationByRemoteId(victim.remoteId);
    expect(local?.deleted_at).not.toBeNull();
    closeDatabase();
  });

  it('adds back conversations that exist remotely but are missing locally', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    // Simulate a local data loss
    db.prepare('DELETE FROM conversations WHERE number = 5003').run();
    const result = await coordinator.reconcile();
    expect(result.added).toBe(1);
    const conv = new ConversationRepository(db);
    const restored = conv.getConversationByNumber(5003);
    expect(restored).toBeDefined();
    closeDatabase();
  });
});

describe('single conversation sync (webhook path)', () => {
  it('syncs one conversation on demand', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    const created = provider.createConversationOnRemote({ subject: 'Webhook-triggered ticket', preview: 'async event', mailboxId: 201, customerRemoteId: 3005, body: 'Created via webhook simulation' });
    await coordinator.syncSingleConversation(created.remoteId);
    const conv = new ConversationRepository(db);
    expect(conv.getConversationByRemoteId(created.remoteId)).toBeDefined();
    const jobs = new JobRepository(db);
    closeDatabase();
    void jobs;
  });
});
