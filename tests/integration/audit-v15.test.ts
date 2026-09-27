/**
 * NEUTRAL AUDIT — Phase 3: upgrade path + crash recovery (v1.5.0)
 *
 * A v1.4.0 database (migrations 1-8, real demo data) is upgraded in place to
 * v1.5.0; then the outreach pipeline is crash-tested mid-batch to prove the
 * stuck-'sending' reclaim works and no recipient is double-sent.
 */
import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { closeDatabase, openTestDatabase } from '../../src/server/database/connection.js';
import { migration001 } from '../../src/server/database/migrations/001_core.js';
import { migration002 } from '../../src/server/database/migrations/002_sync_jobs.js';
import { migration003 } from '../../src/server/database/migrations/003_ai_knowledge.js';
import { migration004 } from '../../src/server/database/migrations/004_fts.js';
import { migration005 } from '../../src/server/database/migrations/005_interaction_intelligence.js';
import { migration006 } from '../../src/server/database/migrations/006_interaction_integrity.js';
import { migration007 } from '../../src/server/database/migrations/007_channels_docs.js';
import { migration008 } from '../../src/server/database/migrations/008_semantic_docs_sla.js';
import { migration009 } from '../../src/server/database/migrations/009_outreach_semantic_sync.js';
import { migration010 } from '../../src/server/database/migrations/010_audit_hardening.js';
import { migration011 } from '../../src/server/database/migrations/011_activity_engine.js';
import { CampaignService } from '../../src/server/outreach/campaignService.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { getContext, resetContext } from '../../src/server/services/context.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { SegmentEngine } from '../../src/server/segmentation/segmentEngine.js';
import type { SegmentDefinition } from '../../src/shared/segmentation.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('neutral audit phase 3: v1.4 -> v1.5 upgrade', () => {
  it('a v1.4 schema upgrades in place: rows survive, new columns are null-safe, backfills work', async () => {
    const db = openTestDatabase();
    // Build the v1.4.0 schema exactly as a v1.4 binary would have it
    // (migrations 1-8, no schema_migrations rows, no v1.5 columns/tables).
    for (const m of [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008]) m.up(db);

    // Insert v1.4-shaped rows a real v1.4 database would contain
    db.prepare(
      `INSERT INTO customers (remote_id, first_name, last_name, job_title, raw_json, remote_created_at, remote_updated_at, last_seen_at, last_synced_at)
       VALUES (91001, 'Old', 'Customer', 'CTO', ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))`
    ).run(JSON.stringify({ id: 91001, firstName: 'Old', lastName: 'Customer', emails: [{ value: 'old@example.com' }] }));
    db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (999, 'Legacy Mailbox', 'legacy')").run();
    const legacyMailboxId = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 999').get() as { id: number }).id;
    const legacyCustomerId = (db.prepare('SELECT id FROM customers WHERE remote_id = 91001').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO conversations (remote_id, number, subject, status, mailbox_local_id, customer_local_id, remote_created_at, local_created_at, local_updated_at)
       VALUES (99001, 9001, 'Legacy ticket', 'closed', ?, ?, datetime('now', '-30 days'), datetime('now'), datetime('now'))`
    ).run(legacyMailboxId, legacyCustomerId);
    const customersBefore = (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
    const conversationsBefore = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
    expect(customersBefore).toBe(1);
    expect(conversationsBefore).toBe(1);

    // ---- THE UPGRADE (runs at boot, before any sync) ----
    migration009.up(db);
    migration009.up(db); // idempotency: a double-run must not throw or duplicate
    migration010.up(db); // v1.6.0 hardening (docs content_hash + embedding attempts)
    migration010.up(db); // idempotency
    migration011.up(db); // v1.7.0 activity engine (events + derived columns + states + views)
    migration011.up(db); // idempotency

    // Rows survived; new columns are NULL on old rows (not garbage)
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n).toBe(conversationsBefore);
    const oldCustomer = db.prepare('SELECT background, age, gender, location FROM customers WHERE remote_id = 91001').get() as { background: string | null; age: string | null; gender: string | null; location: string | null };
    expect(oldCustomer.background).toBeNull();
    expect(oldCustomer.location).toBeNull();
    // New tables exist and start empty
    for (const t of ['segments', 'outreach_campaigns', 'outreach_recipients', 'outreach_attempts', 'outreach_events', 'do_not_contact', 'conversation_chunks', 'encrypted_sync_log']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
    // v1.7.0 tables exist; default ticket states are seeded; legacy rows derive activity honestly
    for (const t of ['conversation_events', 'ticket_states', 'ticket_state_transitions', 'inbox_views']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBeGreaterThanOrEqual(0);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM ticket_states WHERE built_in = 1").get() as { n: number }).n).toBe(6);
    const legacyActivity = db.prepare('SELECT activity_history_complete, first_customer_message_at, customer_waiting_since, supportos_priority FROM conversations WHERE remote_id = 99001').get() as { activity_history_complete: number; first_customer_message_at: string | null; customer_waiting_since: string | null; supportos_priority: string };
    expect(legacyActivity.supportos_priority).toBe('none');
    // No threads for the legacy ticket -> history honestly incomplete, not guessed
    expect(legacyActivity.activity_history_complete).toBe(0);

    // After the upgrade, the v1.5 sync path works on the upgraded schema
    const provider = new FakeHelpScoutProvider();
    const coordinator = new SyncCoordinator(db, provider);
    const results = await coordinator.initialSync();
    const failures = results.filter((r) => r.error);
    expect(failures).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n).toBeGreaterThan(conversationsBefore);

    // Property values persisted by the v1.5 sync path; the raw_json backfill
    // heals a database whose sync predated property persistence
    const people = new PeopleRepository(db);
    const propsAfterSync = (db.prepare('SELECT COUNT(*) AS n FROM customer_properties').get() as { n: number }).n;
    console.log('AUDITDBG propsAfterSync:', propsAfterSync, 'failures:', JSON.stringify(results.filter((r) => r.error).map((r) => r.resource)));
    expect(propsAfterSync).toBeGreaterThan(0);
    db.exec('DELETE FROM customer_properties');
    const healed = people.backfillPropertiesFromRawJson();
    console.log('AUDITDBG healed:', healed);
    expect(healed).toBeGreaterThan(0);

    // The segment engine is immediately useful on upgraded data
    const engine = new SegmentEngine(db);
    const plan = (db.prepare("SELECT id FROM customer_property_definitions WHERE name = 'Plan'").get() as { id: number }).id;
    const pros = engine.preview({ combinator: 'all', conditions: [{ kind: 'customer_property', definitionId: plan, name: 'Plan', type: 'dropdown', op: 'equals', value: 'Pro' }], exclude: [] }, 1, 10);
    expect(pros.matched).toBe(3); // Lucía, Mateo, Ravi are Pro in the demo world

    // Conversation chunk backfill: the same loop the v1.5 worker boot runs
    const convRepo = new ConversationRepository(db);
    const ids = db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all() as { id: number }[];
    for (const c of ids) convRepo.rechunkConversation(c.id);
    expect((db.prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM conversation_chunks').get() as { n: number }).n).toBe(ids.length);
    closeDatabase();
  });
});

describe('neutral audit phase 3: outreach crash recovery', () => {
  it('a crash mid-batch leaves no stuck recipients; restart reclaims and completes without double-sends', async () => {
    closeDatabase(); // defensive isolation from any earlier test failure
    resetContext();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-crash-'));
    const dbPath = path.join(tmpDir, 'crash.db');
    const ctx = getContext({ dbPath, demoMode: true, fresh: true });
    await ctx.coordinator.initialSync();

    const engine = ctx.segmentEngine;
    const outreach = ctx.outreachRepo;
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const preview = engine.preview(tree, 1, 100);
    const mailboxLocal = (ctx.db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = outreach.createCampaign({
      name: 'Crash test',
      subject: 'Hello {{first_name}}',
      body: 'Test',
      mailbox_local_id: mailboxLocal,
      tags: [],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({ customer_local_id: r.customer_local_id, customer_remote_id: r.customer_remote_id, email: r.chosen_email, why: r.why, matching_tickets: r.matching_tickets, property_values: r.properties }))
    });
    ctx.campaigns.queue(campaignId);

    // Simulate the aftermath of a hard crash mid-batch: one recipient was
    // claimed (state='sending') when the process died, so nothing will ever
    // finish it. The queue still holds the rest.
    ctx.db.prepare(
      "UPDATE outreach_recipients SET state = 'sending' WHERE id = (SELECT id FROM outreach_recipients WHERE campaign_id = ? AND state IN ('selected','queued') ORDER BY id LIMIT 1)"
    ).run(campaignId);
    const stuckBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND state = 'sending'").get(campaignId) as { n: number }).n;
    expect(stuckBefore).toBe(1);
    const sentBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND state = 'sent'").get(campaignId) as { n: number }).n;
    expect(sentBefore).toBe(0);

    // "Restart": a fresh service instance over the same database
    const people = new PeopleRepository(ctx.db);
    const jobs = new JobRepository(ctx.db);
    const campaigns2 = new CampaignService(ctx.db, ctx.provider, outreach, people, jobs);
    await campaigns2.sendBatch(campaignId); // must reclaim the stuck row first
    for (let i = 0; i < 30; i++) {
      const job = jobs.claimNext('outreach');
      if (!job) break;
      await campaigns2.executeJob(job.type, job.payload ?? {});
      jobs.completeJob(job.id);
    }
    const detail = outreach.getCampaign(campaignId)!;
    expect(detail.status).toBe('completed');
    expect(detail.sent).toBe(preview.matched); // EVERYONE sent exactly once - no double-send
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND state = 'sending'").get(campaignId) as { n: number }).n).toBe(0);
    expect(detail.sent).toBeGreaterThanOrEqual(sentBefore);
    // The fake provider created exactly one conversation per recipient
    const sentRows = ctx.db.prepare('SELECT customer_local_id, hs_conversation_remote_id FROM outreach_recipients WHERE campaign_id = ? AND state = ?').all(campaignId, 'sent') as { customer_local_id: number; hs_conversation_remote_id: number }[];
    const remoteIds = sentRows.map((r) => r.hs_conversation_remote_id);
    expect(new Set(remoteIds).size).toBe(remoteIds.length); // no duplicate conversations

    ctx.workers.stop();
    resetContext();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('neutral audit phase 3: worker drains the outreach queue through the real loop', () => {
  it('WorkerManager tick executes outreach jobs end-to-end', async () => {
    closeDatabase(); // defensive isolation from any earlier test failure
    resetContext();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-worker-'));
    const ctx = getContext({ dbPath: path.join(tmpDir, 'w.db'), demoMode: true, fresh: true });
    await ctx.coordinator.initialSync();
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['viewer'], tagMode: 'any' }], exclude: [] };
    const preview = ctx.segmentEngine.preview(tree, 1, 100);
    const mailboxLocal = (ctx.db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = ctx.outreachRepo.createCampaign({
      name: 'Worker loop test',
      subject: 'Hi {{first_name}}',
      body: 'Hello',
      mailbox_local_id: mailboxLocal,
      tags: [],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({ customer_local_id: r.customer_local_id, customer_remote_id: r.customer_remote_id, email: r.chosen_email, why: r.why, matching_tickets: r.matching_tickets, property_values: r.properties }))
    });
    ctx.campaigns.queue(campaignId);
    ctx.workers.start();
    // wait for the 2s tick loop to drain the queue
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const c = ctx.outreachRepo.getCampaign(campaignId);
      if (c?.status === 'completed') break;
    }
    const detail = ctx.outreachRepo.getCampaign(campaignId)!;
    expect(detail.status).toBe('completed');
    expect(detail.sent).toBe(preview.matched);
    ctx.workers.stop();
    resetContext();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
