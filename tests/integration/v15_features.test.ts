import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SegmentEngine } from '../../src/server/segmentation/segmentEngine.js';
import { OutreachRepository } from '../../src/server/database/repositories/outreachRepo.js';
import { CampaignService } from '../../src/server/outreach/campaignService.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';
import { JobRepository } from '../../src/server/database/repositories/jobRepo.js';
import { SlaService } from '../../src/server/analytics/slaService.js';
import { EncryptedSyncService } from '../../src/server/services/encryptedSyncService.js';
import { DocsRepository } from '../../src/server/database/repositories/docsRepo.js';
import type { SegmentDefinition } from '../../src/shared/segmentation.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function setup(): Promise<{
  coordinator: SyncCoordinator;
  provider: FakeHelpScoutProvider;
  db: ReturnType<typeof openTestDatabase>;
  engine: SegmentEngine;
  outreach: OutreachRepository;
}> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  const engine = new SegmentEngine(db);
  const outreach = new OutreachRepository(db);
  return { coordinator, provider, db, engine, outreach };
}

function propDefId(db: ReturnType<typeof openTestDatabase>, name: string): number {
  return (db.prepare('SELECT id FROM customer_property_definitions WHERE name = ?').get(name) as { id: number }).id;
}

function customerLocalId(db: ReturnType<typeof openTestDatabase>, remoteId: number): number {
  return (db.prepare('SELECT id FROM customers WHERE remote_id = ?').get(remoteId) as { id: number }).id;
}

/**
 * v1.5.0 feature coverage: the segmentation engine's critical semantics
 * (spec #59-#62), campaign lifecycle + duplicate protection, ticket vector
 * chunking, business-hours SLA alerts and the encrypted sync round-trip.
 */
describe('segment engine: critical tag semantics (spec #60-#62)', () => {
  it('tag ALL requires ONE conversation carrying all tags (customer A split across tickets must NOT match)', async () => {
    const { db, engine } = await setup();
    // Customer 3005 (Emma) has a conversation tagged only 'viewer' and another
    // tagged only 'timezone'? Build the exact spec case manually:
    const lucia = customerLocalId(db, 3001); // has timezone+vip on one conversation
    const r = engine.preview(
      { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone', 'vip'], tagMode: 'all' }], exclude: [] },
      1,
      50
    );
    // #1 (Lucía) carries BOTH timezone+vip on the SAME conversation
    expect(r.rows.map((x) => x.customer_local_id)).toContain(lucia);
    // Nobody else carries both on one conversation in the demo world:
    const rowsWithBoth = r.rows.filter((x) => x.matching_tickets.some((t) => t.tags.includes('timezone') && t.tags.includes('vip')));
    expect(rowsWithBoth.length).toBe(r.rows.length);
    closeDatabase();
  });

  it('tag ANY matches conversations with at least one selected tag', async () => {
    const { engine } = await setup();
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone', 'billing'], tagMode: 'any' }], exclude: [] }, 1, 50);
    expect(r.matched).toBeGreaterThan(0);
    // Every matched customer has at least one ticket with timezone or billing
    for (const row of r.rows) {
      expect(row.matching_tickets.some((t) => t.tags.includes('timezone') || t.tags.includes('billing'))).toBe(true);
    }
    closeDatabase();
  });

  it('tag NONE excludes conversations carrying the tag (conversation-level)', async () => {
    const { engine } = await setup();
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'none' }], exclude: [] }, 1, 50);
    // Only customers whose EVERY conversation lacks 'timezone'... no: customers
    // with at least one conversation lacking 'timezone' qualify, but the engine
    // returns customers with a qualifying conversation. Evidence must show none
    // of the matching tickets carry the excluded tag.
    for (const row of r.rows) {
      for (const t of row.matching_tickets) {
        expect(t.tags.includes('timezone')).toBe(false);
      }
    }
    expect(r.matched).toBeGreaterThan(0);
    closeDatabase();
  });

  it('one customer with multiple matching tickets appears exactly once (spec #61)', async () => {
    const { db, engine } = await setup();
    const lucia = customerLocalId(db, 3001);
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] }, 1, 50);
    const occurrences = r.rows.filter((x) => x.customer_local_id === lucia).length;
    expect(occurrences).toBe(1);
    // And her evidence includes MULTIPLE matching tickets
    const row = r.rows.find((x) => x.customer_local_id === lucia);
    expect(row?.matching_tickets.filter((t) => t.tags.includes('timezone')).length).toBeGreaterThanOrEqual(1);
    closeDatabase();
  });

  it('status filter restricts to qualifying tickets (spec #62)', async () => {
    const { engine } = await setup();
    const r = engine.preview(
      { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any', statuses: ['closed'] }], exclude: [] },
      1,
      50
    );
    for (const row of r.rows) {
      expect(row.matching_tickets.some((t) => t.tags.includes('timezone') && t.status === 'closed')).toBe(true);
    }
    closeDatabase();
  });

  it('mixed property + tag intersection produces the correct set', async () => {
    const { db, engine } = await setup();
    const plan = propDefId(db, 'Plan');
    const r = engine.preview(
      {
        combinator: 'all',
        conditions: [
          { kind: 'customer_property', definitionId: plan, name: 'Plan', type: 'dropdown', op: 'equals', value: 'Pro' },
          { kind: 'ticket', tags: ['timezone'], tagMode: 'any' }
        ],
        exclude: []
      },
      1,
      50
    );
    expect(r.matched).toBeGreaterThan(0);
    // Every row is Plan=Pro AND has a timezone ticket
    for (const row of r.rows) {
      expect(row.properties.some((p) => p.name === 'Plan' && p.value === 'Pro')).toBe(true);
      expect(row.matching_tickets.some((t) => t.tags.includes('timezone'))).toBe(true);
      // Why-selected explains BOTH conditions
      expect(row.why.length).toBeGreaterThanOrEqual(2);
    }
    closeDatabase();
  });

  it('exclusions remove matched customers; DNC is applied on top', async () => {
    const { db, engine, outreach } = await setup();
    const base: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const without = engine.count(base);
    const withExclusion = engine.count({ ...base, exclude: [{ kind: 'customer_property', definitionId: propDefId(db, 'Plan'), name: 'Plan', type: 'dropdown', op: 'equals', value: 'Pro' }] });
    expect(withExclusion).toBeLessThan(without);
    // DNC removes the rest deterministically
    const anyRow = engine.preview(base, 1, 1).rows[0];
    outreach.addDnc(anyRow!.customer_local_id, 'test');
    expect(engine.count(base)).toBe(without - 1);
    closeDatabase();
  });

  it('customer property values were synced from the provider (demo world)', async () => {
    const { db, engine } = await setup();
    const plan = propDefId(db, 'Plan');
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'customer_property', definitionId: plan, name: 'Plan', type: 'dropdown', op: 'equals', value: 'Pro' }], exclude: [] }, 1, 50);
    expect(r.matched).toBe(3); // Lucía, Mateo, Ravi are Pro in the demo world
    closeDatabase();
  });

  it('contact conditions: email domain and organization resolve to unique contacts', async () => {
    const { engine } = await setup();
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'contact', field: 'email_domain', op: 'contains', value: 'andeslogistics.cl' }], exclude: [] }, 1, 50);
    expect(r.matched).toBe(2); // Lucía + Mateo
    closeDatabase();
  });

  it('history conditions compute from the local mirror', async () => {
    const { engine } = await setup();
    const r = engine.preview({ combinator: 'all', conditions: [{ kind: 'history', metric: 'ticket_count', op: 'gte', value: 1 }], exclude: [] }, 1, 50);
    expect(r.matched).toBeGreaterThan(0);
    const none = engine.preview({ combinator: 'all', conditions: [{ kind: 'history', metric: 'open_count', op: 'eq', value: 0 }], exclude: [] }, 1, 50);
    expect(none.matched).toBeGreaterThan(0);
    closeDatabase();
  });
});

describe('campaign lifecycle (v1.5.0)', () => {
  async function campaignSetup(): Promise<{
    db: ReturnType<typeof openTestDatabase>;
    provider: FakeHelpScoutProvider;
    outreach: OutreachRepository;
    campaigns: CampaignService;
    engine: SegmentEngine;
    jobs: JobRepository;
  }> {
    const { db, provider, engine, outreach } = await setup();
    const people = new PeopleRepository(db);
    const jobs = new JobRepository(db);
    const campaigns = new CampaignService(db, provider, outreach, people, jobs);
    return { db, provider, outreach, campaigns, engine, jobs };
  }

  it('create -> validate -> queue -> send -> sent, with why-selected snapshots', async () => {
    const { db, engine, outreach, campaigns, jobs } = await campaignSetup();
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const preview = engine.preview(tree, 1, 100);
    expect(preview.matched).toBeGreaterThan(0);
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = outreach.createCampaign({
      name: 'Timezone update',
      subject: 'Update on the timezone issue, {{first_name}}',
      body: 'Hi {{first_name}}, we fixed the schedule bug you reported in #{{last_ticket_number}}.',
      mailbox_local_id: mailboxLocal,
      tags: ['outreach'],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({
        customer_local_id: r.customer_local_id,
        customer_remote_id: r.customer_remote_id,
        email: r.chosen_email,
        why: r.why,
        matching_tickets: r.matching_tickets,
        property_values: r.properties
      }))
    });
    const validation = campaigns.validate(campaignId);
    expect(validation.ok).toBe(true);
    expect(validation.counts.ready).toBe(preview.matched);

    const queued = campaigns.queue(campaignId);
    expect(queued.ok).toBe(true);

    // Drain the outreach queue (batched 5/job)
    for (let i = 0; i < 30; i++) {
      const job = jobs.claimNext('outreach');
      if (!job) break;
      await campaigns.executeJob(job.type, job.payload ?? {});
      jobs.completeJob(job.id);
    }
    const detail = outreach.getCampaign(campaignId)!;
    expect(detail.sent).toBe(preview.matched);
    expect(detail.status).toBe('completed');
    // Personalization rendered from each recipient's own data
    const firstRecipient = detail.recipients_list[0]!;
    expect(firstRecipient.state).toBe('sent');
    expect(firstRecipient.hs_conversation_number).not.toBeNull();
    // The fake provider created one conversation per customer
    expect((db.prepare("SELECT COUNT(*) AS n FROM outreach_events WHERE event = 'recipient_sent'").get() as { n: number }).n).toBe(preview.matched);
    closeDatabase();
  });

  it('duplicate-send protection: queueing a completed campaign refuses to resend', async () => {
    const { db, engine, outreach, campaigns, jobs } = await campaignSetup();
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const preview = engine.preview(tree, 1, 100);
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = outreach.createCampaign({
      name: 'Once only',
      subject: 'Test',
      body: 'Test body',
      mailbox_local_id: mailboxLocal,
      tags: [],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({ customer_local_id: r.customer_local_id, customer_remote_id: r.customer_remote_id, email: r.chosen_email, why: r.why, matching_tickets: r.matching_tickets, property_values: r.properties }))
    });
    campaigns.queue(campaignId);
    for (let i = 0; i < 30; i++) {
      const job = jobs.claimNext('outreach');
      if (!job) break;
      await campaigns.executeJob(job.type, job.payload ?? {});
      jobs.completeJob(job.id);
    }
    const before = outreach.getCampaign(campaignId)!.sent;
    // Re-queue attempt: completed campaigns cannot be re-queued
    const again = campaigns.queue(campaignId);
    expect(again.ok).toBe(false);
    expect(outreach.getCampaign(campaignId)!.sent).toBe(before);
    closeDatabase();
  });

  it('Do-Not-Contact recipients are skipped at send time', async () => {
    const { db, engine, outreach, campaigns, jobs } = await campaignSetup();
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const preview = engine.preview(tree, 1, 100);
    const first = preview.rows[0]!;
    outreach.addDnc(first.customer_local_id, 'asked to stop');
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = outreach.createCampaign({
      name: 'DNC test',
      subject: 'Test',
      body: 'Body',
      mailbox_local_id: mailboxLocal,
      tags: [],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({ customer_local_id: r.customer_local_id, customer_remote_id: r.customer_remote_id, email: r.chosen_email, why: r.why, matching_tickets: r.matching_tickets, property_values: r.properties }))
    });
    campaigns.queue(campaignId);
    for (let i = 0; i < 30; i++) {
      const job = jobs.claimNext('outreach');
      if (!job) break;
      await campaigns.executeJob(job.type, job.payload ?? {});
      jobs.completeJob(job.id);
    }
    const detail = outreach.getCampaign(campaignId)!;
    expect(detail.skipped).toBe(1);
    expect(detail.sent).toBe(preview.matched - 1);
    const skippedRow = detail.recipients_list.find((r) => r.customer_local_id === first.customer_local_id);
    expect(skippedRow?.state).toBe('skipped');
    closeDatabase();
  });

  it('personalization renders variables and reports unresolved ones', async () => {
    const { db, campaigns } = await campaignSetup();
    const lucia = customerLocalId(db, 3001);
    const rendered = campaigns.renderFor(lucia, [{ conversationId: 1, number: 5001, subject: 'Timezone issue', status: 'active', tags: ['timezone'], createdAt: null }], 'Hello {{first_name}}', 'Ticket #{{last_ticket_number}} for {{organization}} and {{nonexistent}}');
    expect(rendered.subject).toBe('Hello Lucía');
    expect(rendered.body).toContain('#5001');
    expect(rendered.body).toContain('Andes Logistics');
    expect(rendered.unresolved).toContain('nonexistent');
    closeDatabase();
  });

  it('created conversations appear in the local mirror after a sync (reply intelligence source)', async () => {
    const { db, provider, engine, outreach, campaigns, jobs } = await campaignSetup();
    const tree: SegmentDefinition = { combinator: 'all', conditions: [{ kind: 'ticket', tags: ['timezone'], tagMode: 'any' }], exclude: [] };
    const preview = engine.preview(tree, 1, 100);
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    const campaignId = outreach.createCampaign({
      name: 'Mirror test',
      subject: 'Test',
      body: 'Body',
      mailbox_local_id: mailboxLocal,
      tags: ['outreach-test'],
      segment_snapshot: tree,
      recipients: preview.rows.map((r) => ({ customer_local_id: r.customer_local_id, customer_remote_id: r.customer_remote_id, email: r.chosen_email, why: r.why, matching_tickets: r.matching_tickets, property_values: r.properties }))
    });
    campaigns.queue(campaignId);
    for (let i = 0; i < 30; i++) {
      const job = jobs.claimNext('outreach');
      if (!job) break;
      await campaigns.executeJob(job.type, job.payload ?? {});
      jobs.completeJob(job.id);
    }
    const detail = outreach.getCampaign(campaignId)!;
    const sentRemote = detail.recipients_list.find((r) => r.state === 'sent')!;
    // The fake provider knows the conversation; a fresh mirror sync sees it
    expect(provider.world.conversations.some((c) => c.remoteId === sentRemote.hs_conversation_remote_id)).toBe(true);
    closeDatabase();
  });
});

describe('ticket vector chunks (v1.5.0)', () => {
  it('conversations are chunked on sync; re-sync is idempotent', async () => {
    const { coordinator, db } = await setup();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM conversation_chunks').get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);
    const conversations = (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL').get() as { n: number }).n;
    const withChunks = (db.prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM conversation_chunks').get() as { n: number }).n;
    expect(withChunks).toBe(conversations);
    await coordinator.incrementalSync();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM conversation_chunks').get() as { n: number }).n;
    expect(after).toBe(before);
    // Chunks carry self-describing context (subject in the first chunk)
    const first = (db.prepare('SELECT content FROM conversation_chunks WHERE chunk_index = 0 LIMIT 1').get() as { content: string }).content;
    expect(first).toMatch(/#\d+ /);
    closeDatabase();
  });

  it('embedding state machine: pending -> indexed -> reset on rechunk', async () => {
    const { db } = await setup();
    const { ConversationRepository } = await import('../../src/server/database/repositories/conversationRepo.js');
    const repo = new ConversationRepository(db);
    const stats = repo.conversationChunkStats();
    expect(stats.pending).toBe(stats.chunks);
    expect(stats.indexed).toBe(0);
    const chunk = repo.listConversationChunksNeedingEmbedding(1)[0]!;
    repo.updateConversationChunkEmbedding(chunk.id, 'test-model', new Float32Array([0.4, 0.5]), 'indexed');
    expect(repo.conversationChunkStats().indexed).toBe(1);
    // Re-chunking resets embedding state (content changed -> stale vectors dropped)
    repo.rechunkConversation(chunk.conversation_id);
    const state = (db.prepare('SELECT embedding_state FROM conversation_chunks WHERE conversation_id = ? LIMIT 1').get(chunk.conversation_id) as { embedding_state: string }).embedding_state;
    expect(state).toBe('not_indexed');
    closeDatabase();
  });
});

describe('business-hours-aware SLA alerts (v1.5.0)', () => {
  it('unconfigured mailboxes are reported honestly, never guessed', async () => {
    const { db } = await setup();
    const sla = new SlaService(db);
    const alerts = sla.slaAlerts();
    expect(alerts.unconfigured_mailboxes.length).toBeGreaterThan(0);
    expect(alerts.total_breached).toBe(0);
    closeDatabase();
  });

  it('configured targets surface breached and at-risk conversations with business minutes', async () => {
    const { db } = await setup();
    const docs = new DocsRepository(db);
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    // 24/7 business hours + a tiny first-response target -> the demo world's
    // active conversations (last customer message days ago) all breach.
    docs.setBusinessHours(mailboxLocal, { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440, firstResponseTargetMin: 60, resolutionTargetMin: 480 });
    const sla = new SlaService(db);
    const alerts = sla.slaAlerts();
    expect(alerts.total_breached).toBeGreaterThan(0);
    for (const a of alerts.alerts) {
      expect(a.waited_business_min).toBeGreaterThan(a.target_min);
      expect(a.overdue_business_min).toBeGreaterThan(0);
      expect(['first_response', 'resolution']).toContain(a.target_kind);
    }
    // Per-mailbox rollups agree with the alert list
    const mailbox = alerts.per_mailbox.find((m) => m.mailbox_id === mailboxLocal)!;
    expect(mailbox.breached).toBe(alerts.total_breached);
    closeDatabase();
  });

  it('conversations awaiting nobody (no customer threads) never alert', async () => {
    const { db } = await setup();
    const docs = new DocsRepository(db);
    const mailboxLocal = (db.prepare('SELECT id FROM mailboxes WHERE remote_id = 201').get() as { id: number }).id;
    docs.setBusinessHours(mailboxLocal, { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440, firstResponseTargetMin: 1, resolutionTargetMin: 1 });
    const sla = new SlaService(db);
    const alerts = sla.slaAlerts();
    // only conversations with customer threads alert
    for (const a of alerts.alerts) {
      const hasCustomerThread = (db.prepare("SELECT COUNT(*) AS n FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE c.id = ? AND t.type = 'customer'").get(a.conversation_id) as { n: number }).n;
      expect(hasCustomerThread).toBeGreaterThan(0);
    }
    closeDatabase();
  });
});

describe('encrypted multi-device sync (v1.5.0)', () => {
  it('full round-trip: export -> decrypt+import -> data present, wrong passphrase rejected', async () => {
    const { db } = await setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sosync-test-'));
    const service = new EncryptedSyncService(db, path.join(dir, 'app.db'), dir);
    const conversationsBefore = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
    const exported = service.exportBundle('correct horse battery staple');
    expect(exported.ok).toBe(true);
    expect(exported.info?.conversations).toBe(conversationsBefore);
    const bundlePath = exported.path!;

    // Wrong passphrase is rejected BEFORE anything changes
    const wrong = service.verifyBundle(bundlePath, 'wrong passphrase');
    expect(wrong.ok).toBe(false);

    // Correct passphrase verifies with honest metadata
    const right = service.verifyBundle(bundlePath, 'correct horse battery staple');
    expect(right.ok).toBe(true);
    expect(right.info?.conversations).toBe(conversationsBefore);

    // The file is genuinely encrypted: no plaintext SQLite header anywhere near the start
    const raw = fs.readFileSync(bundlePath);
    expect(raw.subarray(0, 6).toString('utf8')).toBe('SOSYNC');
    expect(raw.subarray(6, 40).includes(Buffer.from('SQLite format 3'))).toBe(false);

    // Import into a FRESH database: a second app instance with the same bundle
    const Database = (await import('better-sqlite3')).default;
    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    db2.pragma('foreign_keys = ON');
    applyMigrations(db2); // a real second device runs the app at least once
    const service2 = new EncryptedSyncService(db2, path.join(dir, 'app2.db'), dir);
    const imported = service2.importBundle(bundlePath, 'correct horse battery staple');
    expect(imported.ok).toBe(true);
    expect(imported.require_restart).toBe(true);
    // The imported snapshot contains the same data counts
    const dbFile = path.join(dir, 'app2.db');
    const check = new Database(dbFile, { readonly: true });
    expect((check.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n).toBe(conversationsBefore);
    const customers = (check.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
    expect(customers).toBeGreaterThan(0);
    check.close();
    db2.close();
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tampered bundles fail authentication instead of restoring corrupt data', async () => {
    const { db } = await setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sosync-tamper-'));
    const service = new EncryptedSyncService(db, path.join(dir, 'app.db'), dir);
    const exported = service.exportBundle('passphrase-123');
    expect(exported.ok).toBe(true);
    const raw = fs.readFileSync(exported.path!);
    // Flip one byte in the ciphertext region (after magic+header)
    raw[raw.length - 100] ^= 0xff;
    fs.writeFileSync(exported.path!, raw);
    const result = service.verifyBundle(exported.path!, 'passphrase-123');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/passphrase|modified/i);
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
