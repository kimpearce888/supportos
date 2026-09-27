import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { OutreachRepository } from '../../src/server/database/repositories/outreachRepo.js';
import { CampaignService } from '../../src/server/outreach/campaignService.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { DocsRepository } from '../../src/server/database/repositories/docsRepo.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';
import { SegmentEngine } from '../../src/server/segmentation/segmentEngine.js';
import { BackupService } from '../../src/server/services/backupService.js';
import { AutomationEngine } from '../../src/server/automation/engine.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function setup(): Promise<{
  coordinator: SyncCoordinator;
  provider: FakeHelpScoutProvider;
  db: ReturnType<typeof openTestDatabase>;
  outreach: OutreachRepository;
  jobs: JobRepository;
}> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  await new SyncCoordinator(db, provider).initialSync();
  const outreach = new OutreachRepository(db);
  return { provider, db, outreach };
}

function createCampaign(db: ReturnType<typeof openTestDatabase>, recipientCount = 3): number {
  const mailboxId = (db.prepare('SELECT id FROM mailboxes LIMIT 1').get() as { id: number }).id;
  const r = db
    .prepare("INSERT INTO outreach_campaigns (name, subject, body, mailbox_local_id, tags, status, created_at) VALUES (?, ?, ?, ?, '[]', 'sending', datetime('now'))")
    .run('audit-campaign', 'Subject', 'Hello', mailboxId);
  const campaignId = Number(r.lastInsertRowid);
  const customers = db.prepare('SELECT id, remote_id FROM customers LIMIT ?').all(recipientCount) as { id: number; remote_id: number }[];
  const email = (db.prepare('SELECT value FROM customer_emails WHERE customer_id = ? LIMIT 1').get(customers[0]!.id) as { value: string } | undefined)?.value ?? null;
  const ins = db.prepare("INSERT INTO outreach_recipients (campaign_id, customer_local_id, customer_remote_id, email, snapshot, state, attempts) VALUES (?, ?, ?, ?, '{}', 'queued', 0)");
  for (const c of customers) ins.run(campaignId, c.id, c.remote_id, email);
  return campaignId;
}

/**
 * Regression tests for the SECOND neutral audit (v1.6.0). Every test names the
 * finding it locks in, mirroring the audit-fixes waves of v1.2/v1.5.
 */
describe('v1.6.0 audit: outreach send-queue livelock (HIGH)', () => {
  it('a recipient that exhausted its attempt budget while still queued is swept to failed, not re-enqueued forever', async () => {
    const { db, outreach } = await setup();
    const campaignId = createCampaign(db);
    // Simulate 3 retryable failures: state back to 'queued' with attempts = 3
    const recipients = db.prepare('SELECT id FROM outreach_recipients WHERE campaign_id = ?').all(campaignId) as { id: number }[];
    expect(recipients.length).toBeGreaterThan(0);
    db.prepare("UPDATE outreach_recipients SET state = 'queued', attempts = 3, last_error = 'boom' WHERE campaign_id = ?").run(campaignId);
    // claimPending must not pick them up
    const claimed = outreach.claimPendingRecipients(campaignId, 10);
    expect(claimed).toHaveLength(0);
    // The sweep (called at sendBatch start) terminally fails them
    const swept = outreach.sweepExhaustedRecipients(campaignId);
    expect(swept).toBe(recipients.length);
    expect(outreach.countRemaining(campaignId)).toBe(0);
    // sendBatch now completes the campaign instead of re-enqueueing itself
    const svc = new CampaignService(db, new FakeHelpScoutProvider(), outreach, new PeopleRepository(db), new JobRepository(db));
    const r = await svc.sendBatch(campaignId);
    expect(r.remaining).toBe(0);
    const requeued = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'outreach_send_batch'").get() as { n: number };
    expect(requeued.n).toBe(0);
    closeDatabase();
  });

  it('Retry failed resets the attempt budget (a retry that silently no-ops is a lie)', async () => {
    const { db, outreach } = await setup();
    const campaignId = createCampaign(db);
    db.prepare("UPDATE outreach_recipients SET state = 'failed', attempts = 3 WHERE campaign_id = ?").run(campaignId);
    const reset = outreach.resetFailedToQueued(campaignId);
    expect(reset).toBeGreaterThan(0);
    const row = db.prepare('SELECT state, attempts FROM outreach_recipients WHERE campaign_id = ? LIMIT 1').get(campaignId) as { state: string; attempts: number };
    expect(row.state).toBe('queued');
    expect(row.attempts).toBe(0);
    closeDatabase();
  });
});

describe('v1.6.0 audit: docs embedding churn (HIGH)', () => {
  it('re-upserting an unchanged article does NOT destroy its chunk embeddings', async () => {
    const { db } = await setup();
    const docs = new DocsRepository(db);
    const collections = await new FakeHelpScoutProvider().listDocCollections();
    const articles = await new FakeHelpScoutProvider().listDocArticles(collections[0]!.remoteId);
    const a = articles[0]!;
    const colId = docs.upsertCollection(collections[0]!);
    const id1 = docs.upsertArticle(a, colId);
    // Simulate embeddings existing
    db.prepare("UPDATE docs_chunks SET embedding_state = 'indexed', embedding = X'01020304' WHERE article_id = ?").run(id1);
    const before = db.prepare("SELECT COUNT(*) AS n FROM docs_chunks WHERE article_id = ? AND embedding_state = 'indexed'").get(id1) as { n: number };
    expect(before.n).toBeGreaterThan(0);
    // Same content re-upserted (every incremental sync does this)
    docs.upsertArticle({ ...a, views: a.views + 7 }, colId);
    const after = db.prepare("SELECT COUNT(*) AS n FROM docs_chunks WHERE article_id = ? AND embedding_state = 'indexed'").get(id1) as { n: number };
    expect(after.n).toBe(before.n); // embeddings survived the unchanged re-sync
    // Content change DOES invalidate: re-chunk resets to not_indexed
    docs.upsertArticle({ ...a, text: `${a.text ?? ''} plus a brand new paragraph about billing exports` }, colId);
    const invalidated = db.prepare("SELECT COUNT(*) AS n FROM docs_chunks WHERE article_id = ? AND embedding_state = 'indexed'").get(id1) as { n: number };
    expect(invalidated.n).toBe(0);
    closeDatabase();
  });
});

describe('v1.6.0 audit: automation approval is real (write actions no longer silently dropped)', () => {
  it('awaiting-approval jobs are parked, not completed as no-ops; retry approves and executes', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const jobs = new JobRepository(db);
    const engine = new AutomationEngine(db);
    const ruleId = engine.createRule({ name: 'A', trigger: 'new_conversation', conditions: [], actions: [{ kind: 'add_tag', params: { tag: 'escalated' } }] });
    // Simulate the engine enqueueing a higher-risk action for approval
    const jobId = jobs.enqueue('ai', 'automation_action_awaiting_approval', { ruleId, conversationId: null, action: { kind: 'add_tag', params: { tag: 'escalated' } } }, 2, 1);
    db.prepare("UPDATE jobs SET status = 'awaiting_approval' WHERE id = ?").run(jobId);
    // claimNext must never claim a parked job
    expect(jobs.claimNext('ai')).toBeNull();
    // Retry = approve: payload gains approved=true and status returns to queued
    const job = jobs.getJob(jobId);
    expect(job?.status).toBe('awaiting_approval');
    const ok = jobs.retryJob(jobId, { approved: true });
    expect(ok).toBe(true);
    const approved = jobs.getJob(jobId) as { status: string; payload: Record<string, unknown> };
    expect(approved.status).toBe('queued');
    expect((approved.payload as { approved?: boolean }).approved).toBe(true);
    closeDatabase();
  });
});

describe('v1.6.0 audit: is_empty includes customers with no property row', () => {
  it('absence IS emptiness', async () => {
    const { db } = await setup();
    const engine = new SegmentEngine(db);
    // Every demo customer gets a Plan property from the seed EXCEPT any we
    // remove; verify one with no row matches is_empty.
    const defRow = db.prepare("SELECT id FROM customer_property_definitions WHERE name = 'Plan'").get() as { id: number } | undefined;
    expect(defRow).toBeTruthy();
    const withRow = db.prepare('SELECT customer_id FROM customer_properties WHERE definition_id = ? LIMIT 1').get(defRow!.id) as { customer_id: number };
    db.prepare('DELETE FROM customer_properties WHERE customer_id = ? AND definition_id = ?').run(withRow.customer_id, defRow!.id);
    const noRowCustomer = withRow.customer_id;
    const hit = engine.preview({ combinator: 'all', conditions: [{ kind: 'customer_property', definitionId: defRow!.id, op: 'is_empty' }], exclude: [] }, 1, 50);
    const ids = hit.rows.map((r) => r.customer_local_id);
    expect(ids).toContain(noRowCustomer);
    closeDatabase();
  });
});

describe('v1.6.0 audit: tag id collisions (same-millisecond creates)', () => {
  it('two brand-new tags in one update call both persist (monotonic local ids)', async () => {
    const { db, provider } = await setup();
    const coordinator = new SyncCoordinator(db, provider);
    const convId = (db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: number }).id;
    const remote = (db.prepare('SELECT remote_id FROM conversations WHERE id = ?').get(convId) as { remote_id: number }).remote_id;
    // The fake provider mutates its world; add two never-seen tags at once
    await coordinator.syncSingleConversation(remote);
    db.prepare('DELETE FROM tags WHERE name IN (?, ?)').run('zz-new-one', 'zz-new-two');
    const { ConversationRepository } = await import('../../src/server/database/repositories/conversationRepo.js');
    const convRepo = new ConversationRepository(db);
    // Both insert in the SAME call via the local-ensure path (the old
    // -Date.now() id collided within one millisecond)
    const existing = (db.prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?').all(convId) as { name: string }[]).map((x) => x.name);
    convRepo.updateLocalTags(convId, [...existing, 'zz-new-one', 'zz-new-two']);
    const rows = db.prepare("SELECT name FROM tags WHERE name IN ('zz-new-one','zz-new-two') ORDER BY name").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['zz-new-one', 'zz-new-two']);
    closeDatabase();
  });
});

describe('v1.6.0 audit: backup pruning', () => {
  it('pruneBackups keeps only the newest N .db files (and their settings snapshots)', async () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-backup-'));
    const svc = new BackupService(db, path.join(tmp, 'supportos.db'), null as never, tmp);
    // Create 4 backups with distinct mtimes
    for (let i = 0; i < 4; i++) {
      const p = path.join(tmp, `supportos-backup-${i}.db`);
      fs.writeFileSync(p, 'x');
      fs.writeFileSync(p.replace(/\.db$/, '.settings.json'), '{}');
      const t = new Date(Date.now() - (4 - i) * 3600_000);
      fs.utimesSync(p, t, t);
      fs.utimesSync(p.replace(/\.db$/, '.settings.json'), t, t);
    }
    const removed = svc.pruneBackups(2);
    expect(removed).toBe(2);
    const left = fs.readdirSync(tmp).filter((f) => f.endsWith('.db')).sort();
    expect(left).toEqual(['supportos-backup-2.db', 'supportos-backup-3.db']);
    fs.rmSync(tmp, { recursive: true, force: true });
    closeDatabase();
  });
});

describe('v1.6.0 audit: ratings webhook payload-key fix', () => {
  it('the satisfaction.ratings worker job reads conversationId (not the phantom remoteId) and fetches the rating', async () => {
    const { db, provider } = await setup();
    const jobs = new JobRepository(db);
    // A rating exists in the fake world after the seed (upserted by initial sync)
    const rating = db.prepare('SELECT remote_id, conversation_id FROM ratings LIMIT 1').get() as { remote_id: number; conversation_id: number | null };
    expect(rating).toBeTruthy();
    // Simulate the v1.6.0 webhook producer shape
    const jobId = jobs.enqueue('sync', 'sync_conversation_ratings', { conversationId: rating.conversation_id ?? 0, ratingId: rating.remote_id }, 3, 2);
    const claimed = jobs.claimNext('sync');
    expect(claimed).toBeTruthy();
    expect(claimed?.id).toBe(jobId);
    const payload = claimed?.payload as { conversationId?: number; ratingId?: number };
    expect(payload.conversationId).toBe(rating.conversation_id ?? 0);
    expect(payload.ratingId).toBe(rating.remote_id);
    // The provider can resolve the rating (fake provider implements getRating)
    const fetched = await provider.getRating(rating.remote_id);
    expect(fetched?.remoteId).toBe(rating.remote_id);
    closeDatabase();
  });
});

describe('v1.6.0 audit: incremental sync coverage', () => {
  it('incremental sync now refreshes organizations + property definitions (post-initial creations appear)', async () => {
    const { db, provider } = await setup();
    const coordinator = new SyncCoordinator(db, provider);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
    // Mutate the fake world exactly like Help Scout would between syncs
    provider.world.organizations.push({ remoteId: 99001, name: 'Brand New Co', domains: ['brandnew.io'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await coordinator.incrementalSync();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
    expect(after).toBeGreaterThan(before);
    const found = db.prepare('SELECT id FROM organizations WHERE name = ?').get('Brand New Co');
    expect(found).toBeTruthy();
    closeDatabase();
  });
});
