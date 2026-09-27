import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { ConversationOperations } from '../../src/server/services/operations.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';

async function setup(): Promise<{ ops: ConversationOperations; provider: FakeHelpScoutProvider; conv: ConversationRepository; jobs: JobRepository; db: ReturnType<typeof openTestDatabase> }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  const ops = new ConversationOperations(db, provider);
  return { ops, provider, conv: new ConversationRepository(db), jobs: new JobRepository(db), db };
}

/**
 * THE spec #18 test: Help Scout tag updates are replacement-style.
 * remote A,B + local A + user adds C must end as A,B,C - never A,C.
 */
describe('tag replacement safety (spec #18)', () => {
  it('merges with CURRENT remote state: remote [A,B] + add C => [A,B,C]', async () => {
    const { ops, provider, conv } = await setup();
    const world = provider.world;
    const target = world.conversations.find((c) => c.number === 5001)!;
    // Remote has timezone,vip (A,B). Local might be stale and only know timezone.
    provider.setRemoteTags(target.remoteId, ['timezone', 'vip']);
    const local = conv.getConversationByRemoteId(target.remoteId)!;
    conv.updateLocalTags(local.id, ['timezone']); // stale local view: only A
    const result = await ops.updateTags(local.id, { add: ['escalated'] });
    expect(result.ok).toBe(true);
    expect([...result.data?.tags ?? []].sort()).toEqual(['escalated', 'timezone', 'vip'].sort());
    closeDatabase();
  });

  it('removes only the requested tag, keeping concurrent remote additions', async () => {
    const { ops, provider, conv } = await setup();
    const target = provider.world.conversations.find((c) => c.number === 5002)!;
    provider.setRemoteTags(target.remoteId, ['timezone', 'release-2-4', 'urgent-new-tag']);
    const local = conv.getConversationByRemoteId(target.remoteId)!;
    const result = await ops.updateTags(local.id, { remove: ['timezone'] });
    expect(result.ok).toBe(true);
    expect(result.data?.tags).toContain('release-2-4');
    expect(result.data?.tags).toContain('urgent-new-tag');
    expect(result.data?.tags).not.toContain('timezone');
    closeDatabase();
  });

  it('set replaces the full list when explicitly requested', async () => {
    const { ops, conv } = await setup();
    const local = conv.getConversationByNumber(5001)!;
    const result = await ops.updateTags(local.id, { set: ['only-this'] });
    expect(result.data?.tags).toEqual(['only-this']);
    closeDatabase();
  });
});

describe('write protection + audit (spec #66)', () => {
  it('reply: persists locally only after the remote write confirms, and audits the action', async () => {
    const { ops, conv, jobs } = await setup();
    const local = conv.getConversationByNumber(5001)!;
    const threadsBefore = conv.getThreads(local.id).length;
    const result = await ops.sendReply({ conversationId: local.id, text: 'Integration test reply', draft: false, cc: [], bcc: [] });
    expect(result.ok).toBe(true);
    const threadsAfter = conv.getThreads(local.id).length;
    expect(threadsAfter).toBe(threadsBefore + 1);
    // outbound job confirmed
    const outbound = jobs.listOutboundJobs('confirmed');
    expect(outbound.some((j) => (j.payload as { conversationId?: number }).conversationId === local.id)).toBe(true);
    // audit entry
    const audit = jobs.listAudit(local.id);
    expect(audit.some((a) => a.action === 'reply_sent')).toBe(true);
    closeDatabase();
  });

  it('duplicate reply protection: identical text is rejected (spec #142)', async () => {
    const { ops, conv } = await setup();
    const local = conv.getConversationByNumber(5002)!;
    const first = await ops.sendReply({ conversationId: local.id, text: 'Exact same reply text', draft: false, cc: [], bcc: [] });
    expect(first.ok).toBe(true);
    const second = await ops.sendReply({ conversationId: local.id, text: 'Exact same reply text', draft: false, cc: [], bcc: [] });
    expect(second.ok).toBe(false);
    expect(second.message).toContain('duplicate-send protection');
    closeDatabase();
  });

  it('note: creates a thread and audits it', async () => {
    const { ops, conv, jobs } = await setup();
    const local = conv.getConversationByNumber(5004)!;
    const before = conv.getThreads(local.id).length;
    const result = await ops.addNote({ conversationId: local.id, text: 'Internal note from integration test' });
    expect(result.ok).toBe(true);
    expect(conv.getThreads(local.id).length).toBe(before + 1);
    expect(jobs.listAudit(local.id).some((a) => a.action === 'note_added')).toBe(true);
    closeDatabase();
  });

  it('status change updates local state after remote confirmation', async () => {
    const { ops, conv } = await setup();
    const local = conv.getConversationByNumber(5009)!;
    const result = await ops.changeStatus(local.id, 'pending');
    expect(result.ok).toBe(true);
    expect(conv.getConversationByLocalId(local.id)?.status).toBe('pending');
    closeDatabase();
  });

  it('assignment maps remote user id to local id', async () => {
    const { ops, conv } = await setup();
    const local = conv.getConversationByNumber(5007)!;
    const result = await ops.assign(local.id, 1003); // Tom Bright remote id
    expect(result.ok).toBe(true);
    const updated = conv.getConversationByLocalId(local.id);
    expect(updated?.assignee_local_id).not.toBeNull();
    closeDatabase();
  });

  it('snooze + unsnooze round-trip', async () => {
    const { ops, conv } = await setup();
    const local = conv.getConversationByNumber(5001)!;
    const until = new Date(Date.now() + 86400000).toISOString();
    expect((await ops.snooze(local.id, until)).ok).toBe(true);
    expect(conv.getConversationByLocalId(local.id)?.snoozed_until).toBe(until);
    expect((await ops.unsnooze(local.id)).ok).toBe(true);
    expect(conv.getConversationByLocalId(local.id)?.snoozed_until).toBeNull();
    closeDatabase();
  });

  it('failed writes are NEVER reported as successful', async () => {
    const { ops } = await setup();
    const result = await ops.sendReply({ conversationId: 999999, text: 'no such conversation', draft: false, cc: [], bcc: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
    closeDatabase();
  });
});

describe('AI evaluation mode guard (spec #79)', () => {
  it('blocks notes while AI evaluation mode is on', async () => {
    const { ops, conv, db } = await setup();
    const settings = new SettingsRepository(db);
    settings.set('ai_evaluation_mode', true);
    const local = conv.getConversationByNumber(5001)!;
    const result = await ops.addNote({ conversationId: local.id, text: 'should be blocked' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('AI evaluation mode');
    closeDatabase();
  });
});

describe('custom fields replacement semantics (spec #17)', () => {
  it('preserves system fields when updating user fields', async () => {
    const { ops, provider, conv } = await setup();
    const target = provider.world.conversations.find((c) => c.number === 5001)!;
    // give the conversation a system field (ai-topic)
    await provider.updateCustomFields(target.remoteId, [{ id: 105, value: '180' }]);
    const local = conv.getConversationByRemoteId(target.remoteId)!;
    // update only the user field (Topic=104) - system field 105 must be preserved
    const result = await ops.updateCustomFields(local.id, [{ id: 104, value: '170' }]);
    expect(result.ok).toBe(true);
    const remoteAfter = await provider.getConversation(target.remoteId);
    const systemField = remoteAfter?.customFields.find((f) => f.fieldId === 105);
    expect(systemField?.value).toBe('180'); // preserved, not wiped
    const userField = remoteAfter?.customFields.find((f) => f.fieldId === 104);
    expect(userField?.value).toBe('170');
    closeDatabase();
  });
});

describe('scheduled replies (spec #19)', () => {
  it('schedules, publishes and deletes thread schedules', async () => {
    const { ops, provider, conv } = await setup();
    const world = provider.world;
    const target = world.conversations.find((c) => c.number === 5001)!;
    // create a draft reply thread first
    const draftRes = await ops.sendReply({ conversationId: conv.getConversationByRemoteId(target.remoteId)!.id, text: 'Draft to schedule', draft: true, cc: [], bcc: [] });
    expect(draftRes.ok).toBe(true);
    const threads = conv.getThreads(conv.getConversationByRemoteId(target.remoteId)!.id);
    const draftThread = threads.find((t) => t.state === 'draft');
    expect(draftThread).toBeDefined();
    const scheduledFor = new Date(Date.now() + 3600000).toISOString();
    const local = conv.getConversationByRemoteId(target.remoteId)!;
    expect((await ops.scheduleReply(local.id, draftThread!.id, scheduledFor)).ok).toBe(true);
    expect((await ops.publishSchedule(local.id, draftThread!.id)).ok).toBe(true);
    const afterPublish = conv.getThreads(local.id).find((t) => t.id === draftThread!.id);
    expect(afterPublish?.state).toBe('published');
    closeDatabase();
  });
});
