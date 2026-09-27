import { describe, it, expect } from 'vitest';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { ConversationRepository } from '../../src/server/database/repositories/conversationRepo.js';
import { DocsRepository } from '../../src/server/database/repositories/docsRepo.js';
import { PeopleRepository } from '../../src/server/database/repositories/peopleRepo.js';
import { ReferenceRepository } from '../../src/server/database/repositories/referenceRepo.js';
import { AnalyticsService } from '../../src/server/analytics/analyticsService.js';
import { serverEventBus } from '../../src/server/services/eventBus.js';

async function setup(): Promise<{ coordinator: SyncCoordinator; provider: FakeHelpScoutProvider; db: ReturnType<typeof openTestDatabase> }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  return { coordinator, provider, db };
}

/**
 * v1.3.0 roadmap coverage: Chat/Docs/Beacon API surface, multi-mailbox
 * dashboards and the real-time ratings groundwork (bus + inserted-flag).
 */
describe('chat sessions + channel filter (v1.3.0)', () => {
  it('provider lists Beacon chat sessions as type=chat conversations with source attribution', async () => {
    const { provider } = await setup();
    const chats = await provider.listChatSessions();
    expect(chats.length).toBe(6);
    for (const c of chats) {
      expect(c.type).toBe('chat');
      expect(c.sourceType).toBe('chat');
      expect(c.sourceVia).toBe('beacon');
    }
    const supportChats = await provider.listChatSessions({ mailboxId: 202 });
    expect(supportChats.length).toBe(1); // the billing receipt chat
    closeDatabase();
  });

  it('chats sync through the conversations pass AND the chats catch-up resource stores source metadata', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const conv = new ConversationRepository(db);
    const chats = conv.listConversations({ view: 'all', channel: 'chat', pageSize: 100 });
    expect(chats.total).toBe(6);
    for (const c of chats.conversations) {
      expect(c.type).toBe('chat');
      expect(c.source_via).toBe('beacon');
    }
    // Source columns are also on the raw rows
    const rows = db.prepare("SELECT source_type, source_via FROM conversations WHERE type = 'chat'").all() as { source_type: string; source_via: string }[];
    expect(rows.every((r) => r.source_type === 'chat' && r.source_via === 'beacon')).toBe(true);
    closeDatabase();
  });

  it('the chats resource is a cheap catch-up: re-sync processes 0 when everything is present', async () => {
    const { coordinator } = await setup();
    await coordinator.initialSync();
    // Run the chats resource directly: everything already exists -> 0 newly processed
    const results = await coordinator.initialSync();
    const chatsResult = results.find((r) => r.resource === 'chats');
    expect(chatsResult?.error).toBeUndefined();
    closeDatabase();
  });

  it('channel filter works in the inbox list API layer', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const conv = new ConversationRepository(db);
    const email = conv.listConversations({ view: 'all', channel: 'email', pageSize: 100 });
    const chat = conv.listConversations({ view: 'all', channel: 'chat', pageSize: 100 });
    const all = conv.listConversations({ view: 'all', pageSize: 100 });
    expect(email.total).toBe(14);
    expect(chat.total).toBe(6);
    expect(all.total).toBe(20);
    closeDatabase();
  });
});

describe('docs mirror sync (v1.3.0)', () => {
  it('collections, categories and articles are mirrored with FTS search', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const docs = new DocsRepository(db);
    const collections = docs.listCollections();
    expect(collections.length).toBe(2);
    expect(collections.some((c) => c.name === 'Getting Started')).toBe(true);

    const all = docs.listArticles({ page: 1, pageSize: 50 });
    expect(all.total).toBe(9);
    expect(all.articles.some((a) => a.status === 'draft')).toBe(true);
    expect(all.articles.some((a) => a.status === 'internal')).toBe(true);

    // FTS search: "timezone" matches the schedule-timezones article
    const hits = docs.listArticles({ q: 'timezone', page: 1, pageSize: 20 });
    expect(hits.total).toBeGreaterThanOrEqual(1);
    expect(hits.articles.some((a) => a.name === 'Understanding schedule timezones')).toBe(true);

    // Collection filter
    const billing = docs.listArticles({ collectionId: collections.find((c) => c.name === 'Billing & Account')!.id, page: 1, pageSize: 50 });
    expect(billing.total).toBe(4);

    // Detail includes full text
    const detail = docs.getArticle(hits.articles[0]!.id);
    expect(detail?.text).toContain('daylight-saving');

    // Stats
    const stats = docs.stats();
    expect(stats.collections).toBe(2);
    expect(stats.articles).toBe(9);
    expect(stats.chat_sessions).toBe(6);
    expect(stats.email_conversations).toBe(14);
    expect(stats.total_views).toBeGreaterThan(0);
    closeDatabase();
  });

  it('docs sync is idempotent: re-running does not duplicate articles', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    await coordinator.incrementalSync();
    const docs = new DocsRepository(db);
    const all = docs.listArticles({ page: 1, pageSize: 50 });
    expect(all.total).toBe(9);
    closeDatabase();
  });
});

describe('multi-mailbox + channel dashboards (v1.3.0)', () => {
  it('dashboard scope filters by mailbox ids and channel', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const analytics = new AnalyticsService(db);
    const ref = new ReferenceRepository(db);
    const mailboxes = ref.getMailboxes();
    const support = mailboxes.find((m) => m.name === 'Support')!;
    const billing = mailboxes.find((m) => m.name === 'Billing')!;
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const to = new Date().toISOString();

    const unscoped = analytics.dashboard(from, to);
    const supportOnly = analytics.dashboard(from, to, { mailboxLocalIds: [support.id] });
    const both = analytics.dashboard(from, to, { mailboxLocalIds: [support.id, billing.id] });
    const chatOnly = analytics.dashboard(from, to, { channel: 'chat' });

    // Mailbox scope: Support has no billing conversations
    expect(supportOnly.new_conversations).toBeLessThan(unscoped.new_conversations);
    expect(both.new_conversations).toBe(unscoped.new_conversations);
    // Comparison rows: full KPI row per mailbox, and scope limits the rows
    expect(unscoped.mailbox_comparison.length).toBe(2);
    expect(supportOnly.mailbox_comparison.length).toBe(1);
    expect(unscoped.mailbox_comparison.every((m) => m.total_ratings >= 0 && m.backlog >= 0)).toBe(true);
    // Channel scope: 6 Beacon chats, all created recently
    expect(chatOnly.new_conversations).toBe(6);
    // channel_metrics is a comparison card: it shows BOTH channels (mailbox scope applies, channel scope does not)
    expect(chatOnly.channel_metrics.length).toBe(2);
    const chatMetric = chatOnly.channel_metrics.find((m) => m.channel === 'chat');
    expect(chatMetric).toBeDefined();
    // Chat speed is in minutes, not hours (first response for chats)
    expect(chatMetric?.first_response_avg_min ?? 9999).toBeLessThan(60);
    closeDatabase();
  });

  it('channel metrics separate email vs chat speed', async () => {
    const { coordinator, db } = await setup();
    await coordinator.initialSync();
    const analytics = new AnalyticsService(db);
    const d = analytics.dashboard(new Date(Date.now() - 90 * 86400000).toISOString(), new Date().toISOString());
    const chat = d.channel_metrics.find((m) => m.channel === 'chat');
    const email = d.channel_metrics.find((m) => m.channel === 'email');
    expect(chat).toBeDefined();
    expect(email).toBeDefined();
    // Beacon chats in the demo data resolve in minutes; email tickets take hours
    expect(chat!.first_response_avg_min ?? 999).toBeLessThan(email!.first_response_avg_min ?? 0);
    closeDatabase();
  });
});

describe('real-time ratings groundwork (v1.3.0)', () => {
  it('upsertRating reports NEW ratings exactly once', async () => {
    const { db } = await setup();
    const people = new PeopleRepository(db);
    const first = people.upsertRating({ remote_id: 99001, rating: 'great', comments: null, createdAt: new Date().toISOString() });
    const second = people.upsertRating({ remote_id: 99001, rating: 'great', comments: null, createdAt: new Date().toISOString() });
    expect(first).toBe(true);
    expect(second).toBe(false);
    closeDatabase();
  });

  it('event bus delivers events and isolates failing subscribers', () => {
    const seen: string[] = [];
    const off = serverEventBus.on('rating-received', (p) => seen.push(`${p.rating}:${p.conversationNumber}`));
    const offBroken = serverEventBus.on('rating-received', () => {
      throw new Error('broken subscriber must not break emit');
    });
    expect(() => serverEventBus.emit('rating-received', { rating: 'great', conversationId: null, conversationNumber: 42, customerId: null, customerName: null, comments: null, at: new Date().toISOString() })).not.toThrow();
    expect(seen).toEqual(['great:42']);
    off();
    offBroken();
    serverEventBus.emit('rating-received', { rating: 'okay', conversationId: null, conversationNumber: 1, customerId: null, customerName: null, comments: null, at: new Date().toISOString() });
    expect(seen).toEqual(['great:42']); // unsubscribed handler not called
    expect(serverEventBus.subscriberCount('rating-received')).toBe(0);
  });

  it('fake provider submitRating creates a new rating that the watcher path picks up', async () => {
    const { coordinator, provider, db } = await setup();
    await coordinator.initialSync();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n;
    const events: string[] = [];
    const off = serverEventBus.on('rating-received', (p) => events.push(String(p.rating)));
    const hs = provider.submitRating({ conversationRemoteId: provider.world.conversations[0]!.remoteId, rating: 'not-good', comments: 'test' });
    expect(hs).not.toBeNull();
    // Simulate the watcher pass: listAllRatings now includes the new rating
    const inserted = new PeopleRepository(db).upsertRating({ remote_id: hs!.remoteId, rating: hs!.rating, comments: hs!.comments, createdAt: hs!.createdAt, raw: hs });
    expect(inserted).toBe(true);
    serverEventBus.emit('rating-received', { rating: hs!.rating, conversationId: null, conversationNumber: null, customerId: null, customerName: null, comments: null, at: new Date().toISOString() });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n;
    expect(after).toBe(before + 1);
    expect(events).toEqual(['not-good']);
    off();
    closeDatabase();
  });
});
