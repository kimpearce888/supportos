import type { DB } from '../database/connection.js';
import type { HelpScoutProvider } from '../integrations/helpscout/provider.js';
import { ReferenceRepository } from '../database/repositories/referenceRepo.js';
import { PeopleRepository } from '../database/repositories/peopleRepo.js';
import { ConversationRepository } from '../database/repositories/conversationRepo.js';
import { DocsRepository } from '../database/repositories/docsRepo.js';
import { SyncRepository } from '../database/repositories/syncRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import type { HsConversation, HsThread } from '../integrations/helpscout/provider.js';
import { HelpScoutApiError } from '../integrations/helpscout/client.js';
import { INITIAL_SYNC_ORDER, SYNC_OVERLAP_MINUTES, PRIORITY } from '../../shared/constants.js';
import { serverEventBus } from '../services/eventBus.js';
import type { SyncState } from '../../shared/types.js';

export interface ResourceSyncResult {
  resource: string;
  processed: number;
  failed: number;
  error?: string;
}

export interface ReconciliationResult {
  checked: number;
  added: number;
  updated: number;
  deleted: number;
  merged: number;
  failed: number;
  skipped: number;
  details: string[];
}

/**
 * SyncCoordinator (spec #8-#12): maintains the local mirror of Help Scout data.
 * Polling + incremental synchronization is the PRIMARY mechanism; webhooks are optional.
 * Checkpoints make every step resumable after restart without deleting the database.
 */
export class SyncCoordinator {
  private ref: ReferenceRepository;
  private people: PeopleRepository;
  private conv: ConversationRepository;
  private docs: DocsRepository;
  private sync: SyncRepository;
  private jobs: JobRepository;
  running = false;
  private cancellationRequested = false;

  constructor(
    private db: DB,
    private provider: HelpScoutProvider
  ) {
    this.ref = new ReferenceRepository(db);
    this.people = new PeopleRepository(db);
    this.conv = new ConversationRepository(db);
    this.docs = new DocsRepository(db);
    this.sync = new SyncRepository(db);
    this.jobs = new JobRepository(db);
  }

  requestCancellation(): void {
    this.cancellationRequested = true;
  }

  getState(): SyncState {
    return this.sync.getState();
  }

  // =================================================================
  // INITIAL SYNC - dependency-aware order (spec #10)
  // =================================================================
  async initialSync(): Promise<ResourceSyncResult[]> {
    if (this.running) throw new Error('A sync is already running');
    this.running = true;
    this.cancellationRequested = false;
    const runId = this.sync.startRun('initial');
    this.sync.setState('INITIALIZING');
    const results: ResourceSyncResult[] = [];
    try {
      for (const resource of INITIAL_SYNC_ORDER) {
        if (this.cancellationRequested) break;
        this.sync.setCheckpointRunning(resource, true);
        this.sync.updateRun(runId, { resources_total: INITIAL_SYNC_ORDER.length, resources_done: results.length });
        const r = await this.syncResource(resource, true);
        results.push(r);
        if (r.error) {
          this.sync.recordFailure(resource, r.error, r.failed);
        } else {
          this.sync.recordSuccess(resource, r.processed);
        }
        this.sync.updateRun(runId, { resources_done: results.length, records_processed: results.reduce((a, b) => a + b.processed, 0), errors: results.filter((r) => r.error).length });
      }
      const failed = results.filter((r) => r.error).length;
      this.sync.setState(failed === 0 ? 'LIVE' : failed < results.length / 2 ? 'CATCHING_UP' : 'ERROR');
      this.sync.updateRun(runId, { finished: true, state: failed === 0 ? 'LIVE' : 'ERROR' });
      serverEventBus.emit('sync-completed', {
        kind: 'initial',
        processed: results.reduce((a, b) => a + b.processed, 0),
        errors: failed,
        at: new Date().toISOString()
      });
      return results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sync.setState('ERROR');
      this.sync.updateRun(runId, { finished: true, state: 'ERROR', detail: { error: msg } });
      this.jobs.logError('sync', `Initial sync failed: ${msg}`);
      return results;
    } finally {
      this.running = false;
    }
  }

  // =================================================================
  // INCREMENTAL SYNC (spec #11)
  // =================================================================
  async incrementalSync(): Promise<ResourceSyncResult[]> {
    if (this.running) throw new Error('A sync is already running');
    this.running = true;
    this.cancellationRequested = false;
    const runId = this.sync.startRun('incremental');
    if (this.sync.getState() !== 'LIVE') this.sync.setState('CATCHING_UP');
    const results: ResourceSyncResult[] = [];
    try {
      // 1. Reference data refresh (cheap) + docs mirror (separate Docs API key)
      for (const resource of ['mailboxes', 'folders', 'tags', 'users', 'workflows', 'saved_replies', 'inbox_fields', 'docs_collections', 'docs_articles']) {
        if (this.cancellationRequested) break;
        const r = await this.syncResource(resource, false);
        results.push(r);
        if (r.error) this.sync.recordFailure(resource, r.error, r.failed);
        else this.sync.recordSuccess(resource, r.processed);
      }
      // 2. Customers changed since checkpoint
      {
        const since = this.sync.getIncrementalSince('customers', SYNC_OVERLAP_MINUTES);
        const r = await this.syncCustomers(since);
        results.push(r);
        if (r.error) this.sync.recordFailure('customers', r.error, r.failed);
        else this.sync.recordSuccess('customers', r.processed);
      }
      // 3. Conversations changed since checkpoint (with overlap window)
      {
        const since = this.sync.getIncrementalSince('conversations', SYNC_OVERLAP_MINUTES);
        const r = await this.syncConversations(since, false);
        results.push(r);
        if (r.error) this.sync.recordFailure('conversations', r.error, r.failed);
        else this.sync.recordSuccess('conversations', r.processed);
      }
      const failed = results.filter((r) => r.error).length;
      this.sync.setState(failed === 0 ? 'LIVE' : 'CATCHING_UP');
      this.sync.updateRun(runId, { finished: true, state: failed === 0 ? 'LIVE' : 'CATCHING_UP', records_processed: results.reduce((a, b) => a + b.processed, 0), errors: failed });
      serverEventBus.emit('sync-completed', {
        kind: 'incremental',
        processed: results.reduce((a, b) => a + b.processed, 0),
        errors: failed,
        at: new Date().toISOString()
      });
      return results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sync.setState('ERROR');
      this.sync.updateRun(runId, { finished: true, state: 'ERROR', detail: { error: msg } });
      this.jobs.logError('sync', `Incremental sync failed: ${msg}`);
      return results;
    } finally {
      this.running = false;
    }
  }

  // =================================================================
  // RECONCILIATION (spec #12)
  // =================================================================
  async reconcile(): Promise<ReconciliationResult> {
    if (this.running) throw new Error('A sync is already running');
    this.running = true;
    const runId = this.sync.startRun('reconciliation');
    this.sync.setState('RECONCILING');
    const result: ReconciliationResult = { checked: 0, added: 0, updated: 0, deleted: 0, merged: 0, failed: 0, skipped: 0, details: [] };
    try {
      // Phase 1: full remote listing - find missing local records
      const remoteIds = new Set<number>();
      let cursor: string | null = null;
      do {
        const page = await this.provider.listConversations({ status: 'all', cursor });
        for (const c of page.items) {
          remoteIds.add(c.remoteId);
          const existing = this.conv.getConversationByRemoteId(c.remoteId);
          if (!existing) {
            await this.ingestConversation(c, [], true);
            result.added++;
            result.details.push(`Added missing conversation #${c.number}`);
          } else {
            const rawHashExisting = existing.raw_json;
            if (!rawHashExisting || (JSON.parse(rawHashExisting) as Record<string, unknown>).userUpdatedAt !== (c.userUpdatedAt ?? (JSON.parse(rawHashExisting) as Record<string, unknown>).createdAt)) {
              await this.ingestConversation(c, [], true);
              result.updated++;
            } else {
              result.skipped++;
            }
          }
          result.checked++;
        }
        cursor = page.nextCursor;
      } while (cursor);

      // Phase 2: local records missing remotely (merged / deleted)
      const locals = this.db.prepare('SELECT id, remote_id, number, merged_into_conversation_id, deleted_at FROM conversations').all() as { id: number; remote_id: number; number: number; merged_into_conversation_id: number | null; deleted_at: string | null }[];
      for (const local of locals) {
        if (local.merged_into_conversation_id) continue;
        result.checked++;
        if (remoteIds.has(local.remote_id)) continue;
        try {
          const remote = await this.provider.getConversation(local.remote_id);
          if (remote) {
            await this.ingestConversation(remote, [], true);
            result.updated++;
            result.details.push(`Refreshed stale conversation #${local.number}`);
          } else {
            this.conv.softDeleteByRemoteId(local.remote_id);
            result.deleted++;
            result.details.push(`Conversation #${local.number} no longer exists remotely - marked deleted locally`);
          }
        } catch (e) {
          if (e instanceof HelpScoutApiError && e.statusCode === 301) {
            const targetStr = e.message.match(/merged into (\d+)/)?.[1];
            const target = targetStr ? this.conv.getConversationByRemoteId(parseInt(targetStr, 10)) : undefined;
            if (target) {
              this.conv.markMerged(local.remote_id, target.id);
              result.merged++;
              result.details.push(`Conversation #${local.number} merged into #${target.number}`);
            }
          } else if (e instanceof HelpScoutApiError && e.statusCode === 404) {
            this.conv.softDeleteByRemoteId(local.remote_id);
            result.deleted++;
            result.details.push(`Conversation #${local.number} no longer exists remotely - marked deleted locally`);
          } else {
            result.failed++;
          }
        }
      }

      // Phase 3: orphaned threads (conversation deleted locally but threads remain impossible via FK; detect index failures)
      const orphans = (this.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE fts_indexed = 0 AND body_text IS NOT NULL AND LENGTH(body_text) > 0').get() as { n: number }).n;
      if (orphans > 0) {
        this.db.exec(
          `INSERT INTO fts_threads (body, thread_id, conversation_id)
           SELECT t.body_text, t.id, t.conversation_id FROM threads t
           WHERE t.fts_indexed = 0 AND t.body_text IS NOT NULL AND LENGTH(t.body_text) > 0
             AND NOT EXISTS (SELECT 1 FROM fts_threads f WHERE f.thread_id = t.id)`
        );
        this.db.exec('UPDATE threads SET fts_indexed = 1 WHERE fts_indexed = 0 AND body_text IS NOT NULL AND LENGTH(body_text) > 0');
        result.details.push(`Rebuilt FTS index for ${orphans} threads`);
      }

      this.sync.setState('LIVE');
      this.sync.updateRun(runId, { finished: true, state: 'LIVE', detail: { ...result } });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sync.setState('ERROR');
      this.sync.updateRun(runId, { finished: true, state: 'ERROR', detail: { error: msg } });
      this.jobs.logError('sync', `Reconciliation failed: ${msg}`);
      result.failed++;
      return result;
    } finally {
      this.running = false;
    }
  }

  // =================================================================
  // Single-conversation sync (used by webhooks + manual refresh)
  // =================================================================
  async syncSingleConversation(remoteId: number): Promise<boolean> {
    try {
      const remote = await this.provider.getConversation(remoteId);
      if (!remote) {
        this.conv.softDeleteByRemoteId(remoteId);
        return true;
      }
      const threads = await this.provider.listThreads(remoteId);
      await this.ingestConversation(remote, threads, false);
      return true;
    } catch (e) {
      if (e instanceof HelpScoutApiError && e.statusCode === 301) {
        const targetStr = e.message.match(/merged into (\d+)/)?.[1];
        const target = targetStr ? this.conv.getConversationByRemoteId(parseInt(targetStr, 10)) : undefined;
        if (target) this.conv.markMerged(remoteId, target.id);
        return true;
      }
      if (e instanceof HelpScoutApiError && e.statusCode === 404) {
        this.conv.softDeleteByRemoteId(remoteId);
        return true;
      }
      throw e;
    }
  }

  // =================================================================
  // Resource sync implementations
  // =================================================================
  private async syncResource(resource: string, initial: boolean): Promise<ResourceSyncResult> {
    try {
      switch (resource) {
        case 'account': {
          const me = await this.provider.getMe();
          this.ref.upsertAccount({ plan: me.role, companyName: null, raw: me });
          this.ref.upsertUser({ remote_id: me.remoteId, firstName: me.firstName, lastName: me.lastName, email: me.email, role: me.role, type: 'user', timezone: me.timezone, photoUrl: me.photoUrl, initials: me.initials, mention: me.mention, jobTitle: me.jobTitle, createdAt: me.createdAt, updatedAt: me.updatedAt, raw: me });
          return { resource, processed: 1, failed: 0 };
        }
        case 'users': {
          let processed = 0;
          let page = 1;
          for (;;) {
            const res = await this.provider.listUsers(page);
            for (const u of res.items) {
              this.ref.upsertUser({ remote_id: u.remoteId, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role, type: u.type, timezone: u.timezone, photoUrl: u.photoUrl, initials: u.initials, mention: u.mention, jobTitle: u.jobTitle, phone: u.phone, alternateEmails: u.alternateEmails, createdAt: u.createdAt, updatedAt: u.updatedAt, raw: u });
              processed++;
            }
            const totalPages = res.page?.totalPages ?? 1;
            if (page >= totalPages || !res.items.length) break;
            page++;
          }
          return { resource, processed, failed: 0 };
        }
        case 'system_users': {
          const users = await this.provider.listSystemUsers();
          for (const u of users) this.ref.upsertSystemUser({ remote_id: u.remoteId, firstName: u.firstName, lastName: u.lastName, initials: u.initials, timezone: u.timezone, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt, raw: u });
          return { resource, processed: users.length, failed: 0 };
        }
        case 'teams': {
          const teams = await this.provider.listTeams();
          for (const t of teams) {
            const teamLocal = this.ref.upsertTeam({ remote_id: t.remoteId, name: t.name, raw: t });
            const memberLocals = t.memberUserIds.map((uid) => this.ref.getLocalId('users', uid)).filter((x): x is number => x != null);
            this.ref.upsertTeamMembers(teamLocal, memberLocals);
          }
          return { resource, processed: teams.length, failed: 0 };
        }
        case 'mailboxes': {
          const mbs = await this.provider.listMailboxes();
          for (const m of mbs) this.ref.upsertMailbox({ remote_id: m.remoteId, name: m.name, slug: m.slug, email: m.email, createdAt: m.createdAt, updatedAt: m.updatedAt, raw: m });
          return { resource, processed: mbs.length, failed: 0 };
        }
        case 'folders': {
          let processed = 0;
          for (const m of await this.provider.listMailboxes()) {
            const folders = await this.provider.listFolders(m.remoteId);
            const mailboxLocal = this.ref.getLocalId('mailboxes', m.remoteId);
            if (mailboxLocal) {
              this.ref.upsertFolders(mailboxLocal, folders.map((f) => ({ remote_id: f.remoteId, name: f.name, type: f.type, userId: f.userId, totalCount: f.totalCount, activeCount: f.activeCount, raw: f })));
              processed += folders.length;
            }
          }
          return { resource, processed, failed: 0 };
        }
        case 'tags': {
          const tags = await this.provider.listTags();
          for (const t of tags) this.ref.upsertTag({ remote_id: t.remoteId, name: t.name, slug: t.slug, color: t.color, ticketCount: t.ticketCount, createdAt: t.createdAt, updatedAt: t.updatedAt, raw: t });
          return { resource, processed: tags.length, failed: 0 };
        }
        case 'inbox_fields': {
          let processed = 0;
          for (const m of await this.provider.listMailboxes()) {
            const fields = await this.provider.listInboxFields(m.remoteId);
            const mailboxLocal = this.ref.getLocalId('mailboxes', m.remoteId);
            if (mailboxLocal) {
              for (const f of fields) {
                this.ref.upsertInboxField(mailboxLocal, { remote_id: f.remoteId, name: f.name, type: f.type, systemType: f.systemType, required: f.required, order: f.order, options: f.options, raw: f });
                processed++;
              }
            }
          }
          return { resource, processed, failed: 0 };
        }
        case 'customer_property_definitions': {
          const defs = await this.provider.listCustomerPropertyDefinitions();
          this.ref.upsertPropertyDefinitions('customer', defs.map((d) => ({ remote_id: d.remoteId, name: d.name, slug: d.slug, type: d.type, order: d.order, raw: d })));
          return { resource, processed: defs.length, failed: 0 };
        }
        case 'organization_property_definitions': {
          const defs = await this.provider.listOrganizationPropertyDefinitions();
          this.ref.upsertPropertyDefinitions('organization', defs.map((d) => ({ remote_id: d.remoteId, name: d.name, slug: d.slug, type: d.type, order: d.order, raw: d })));
          return { resource, processed: defs.length, failed: 0 };
        }
        case 'customers': {
          const since = initial ? null : this.sync.getIncrementalSince('customers', SYNC_OVERLAP_MINUTES);
          return this.syncCustomers(since);
        }
        case 'organizations': {
          const orgs = await this.provider.listOrganizations();
          for (const o of orgs) this.people.upsertOrganization({ id: o.remoteId, name: o.name, domains: o.domains, createdAt: o.createdAt, updatedAt: o.updatedAt, raw: o });
          return { resource, processed: orgs.length, failed: 0 };
        }
        case 'saved_replies': {
          let processed = 0;
          for (const m of await this.provider.listMailboxes()) {
            const mailboxLocal = this.ref.getLocalId('mailboxes', m.remoteId);
            const replies = await this.provider.listSavedReplies(m.remoteId);
            for (const r of replies) {
              this.ref.upsertSavedReply({ remote_id: r.remoteId, mailboxLocalId: mailboxLocal, name: r.name, preview: r.preview, text: r.text, raw: r });
              processed++;
            }
          }
          return { resource, processed, failed: 0 };
        }
        case 'workflows': {
          const wfs = await this.provider.listWorkflows();
          for (const w of wfs) {
            const mailboxLocal = w.mailboxId ? this.ref.getLocalId('mailboxes', w.mailboxId) : null;
            this.ref.upsertWorkflow({ remote_id: w.remoteId, mailboxLocalId: mailboxLocal, name: w.name, type: w.type, status: w.status, order: w.order, raw: w });
          }
          return { resource, processed: wfs.length, failed: 0 };
        }
        case 'conversations':
        case 'threads': {
          return this.syncConversations(null, initial);
        }
        case 'chats': {
          // Beacon chat catch-up: chat sessions are type='chat' conversations, so the
          // main conversation pass already mirrors them. This pass heals gaps (chats that
          // fell outside the listing window) and gives chat sessions their own checkpoint.
          const chats = await this.provider.listChatSessions();
          let processed = 0;
          for (const c of chats) {
            const existing = this.conv.getConversationByRemoteId(c.remoteId);
            if (!existing) {
              await this.ingestConversation(c, [], true);
              processed++;
            }
          }
          return { resource, processed, failed: 0 };
        }
        case 'docs_collections': {
          const collections = await this.provider.listDocCollections();
          let processed = 0;
          for (const col of collections) {
            const localId = this.docs.upsertCollection(col);
            const categories = await this.provider.listDocCategories(col.remoteId);
            this.docs.upsertCategories(localId, categories);
            processed++;
          }
          return { resource, processed, failed: 0 };
        }
        case 'docs_articles': {
          let processed = 0;
          const collections = this.db.prepare('SELECT id, remote_id FROM docs_collections').all() as { id: number; remote_id: number }[];
          for (const col of collections) {
            const articles = await this.provider.listDocArticles(col.remote_id);
            for (const a of articles) {
              this.docs.upsertArticle(a, col.id);
              processed++;
            }
          }
          // v1.4.0: semantic docs search - chunk embeddings are built after the
          // mirror pass (the job is a no-op until an embedding model is configured).
          if (processed > 0) this.jobs.enqueue('embeddings', 'embed_docs_chunks', {}, PRIORITY.INDEXING, 2);
          return { resource, processed, failed: 0 };
        }
        case 'attachments': {
          // Metadata already stored with threads; enqueue downloads for enabled auto-download
          const pending = this.conv.listAttachmentsWithoutFile(50);
          return { resource, processed: pending.length, failed: 0 };
        }
        case 'ratings': {
          const ratings = await this.provider.listAllRatings();
          let fresh = 0;
          for (const r of ratings) {
            const convRow = r.conversationId ? this.conv.getConversationByRemoteId(r.conversationId) : undefined;
            const inserted = this.people.upsertRating({
              remote_id: r.remoteId,
              conversation_local_id: convRow?.id ?? null,
              rating: r.rating,
              comments: r.comments,
              customer_local_id: r.customerId ? this.ref.getLocalId('customers', r.customerId) : null,
              user_local_id: r.userId ? this.ref.getLocalId('users', r.userId) : null,
              createdAt: r.createdAt,
              raw: r
            });
            if (inserted) {
              fresh++;
              serverEventBus.emit('rating-received', {
                rating: r.rating,
                conversationId: convRow?.id ?? null,
                conversationNumber: convRow?.number ?? null,
                customerId: r.customerId ? this.ref.getLocalId('customers', r.customerId) : null,
                customerName: r.customerName ?? null,
                comments: r.comments,
                at: new Date().toISOString()
              });
            }
          }
          if (fresh > 0) serverEventBus.emit('ratings-refreshed', { processed: ratings.length, fresh, at: new Date().toISOString() });
          return { resource, processed: ratings.length, failed: 0 };
        }
        case 'user_statuses': {
          const users = this.db.prepare('SELECT id, remote_id FROM users WHERE deleted_at IS NULL').all() as { id: number; remote_id: number }[];
          let processed = 0;
          for (const u of users) {
            const s = await this.provider.getUserStatus(u.remote_id);
            if (s) {
              this.ref.upsertUserStatus(u.id, { email: { status: s.emailStatus, updatedAt: s.emailUpdatedAt }, chat: { status: s.chatStatus, mailboxStatuses: s.mailboxStatuses }, raw: s });
              processed++;
            }
          }
          return { resource, processed, failed: 0 };
        }
        case 'report_data': {
          // Reports are fetched on demand (Sync Health / Reports page) - no bulk sync
          return { resource, processed: 0, failed: 0 };
        }
        default:
          return { resource, processed: 0, failed: 0, error: `Unknown resource ${resource}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.jobs.logError('sync', `Resource ${resource} failed: ${msg}`);
      return { resource, processed: 0, failed: 1, error: msg };
    }
  }

  private async syncCustomers(since: string | null): Promise<ResourceSyncResult> {
    try {
      let processed = 0;
      let cursor: string | null = null;
      do {
        const page = await this.provider.listCustomers({ modifiedSince: since ?? undefined, cursor });
        for (const c of page.items) {
          this.people.upsertCustomer({
            id: c.remoteId,
            firstName: c.firstName,
            lastName: c.lastName,
            photoUrl: c.photoUrl,
            jobTitle: c.jobTitle,
            emails: c.emails.map((e) => ({ value: e.value, type: e.type })),
            phones: c.phones.map((p) => ({ value: p.value, type: p.type })),
            websites: c.websites,
            socialProfiles: c.socialProfiles,
            address: c.address,
            organization: c.organization,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          });
          processed++;
        }
        cursor = page.nextCursor;
        if (since && page.items.length === 0) break;
      } while (cursor);
      return { resource: 'customers', processed, failed: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { resource: 'customers', processed: 0, failed: 1, error: msg };
    }
  }

  private async syncConversations(since: string | null, initial: boolean): Promise<ResourceSyncResult> {
    try {
      let processed = 0;
      let cursor: string | null = null;
      const useThreadsEmbed = initial; // v3 supports embed=threads (chat threads may truncate - acceptable for backfill; full fetch happens on change)
      do {
        const page = await this.provider.listConversations({
          status: 'all',
          modifiedSince: since ?? undefined,
          cursor,
          embed: useThreadsEmbed ? 'threads' : undefined
        });
        const embeddedThreads = page.embeddedThreads ?? [];
        for (const c of page.items) {
          const threads = embeddedThreads.filter((t) => t.conversationId === c.remoteId);
          await this.ingestConversation(c, threads, !useThreadsEmbed);
          processed++;
        }
        cursor = page.nextCursor;
        if (!initial && page.items.length === 0) break;
      } while (cursor);
      return { resource: 'conversations', processed, failed: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { resource: 'conversations', processed: 0, failed: 1, error: msg };
    }
  }

  /** Persist one conversation (+threads) locally. Fetches threads when needed. */
  private async ingestConversation(c: HsConversation, threads: HsThread[], fetchThreadsIfNeeded: boolean): Promise<void> {
    // Ensure mailbox reference exists
    if (!this.ref.getLocalId('mailboxes', c.mailboxId)) {
      const mbs = await this.provider.listMailboxes();
      for (const m of mbs) if (!this.ref.getLocalId('mailboxes', m.remoteId)) this.ref.upsertMailbox({ remote_id: m.remoteId, name: m.name, slug: m.slug, email: m.email, createdAt: m.createdAt, updatedAt: m.updatedAt, raw: m });
    }
    // Ensure primary customer exists locally (may be newer than the customers checkpoint)
    if (c.primaryCustomerId && !this.ref.getLocalId('customers', c.primaryCustomerId)) {
      const cust = await this.provider.getCustomer(c.primaryCustomerId);
      if (cust) {
        this.people.upsertCustomer({
          id: cust.remoteId,
          firstName: cust.firstName,
          lastName: cust.lastName,
          photoUrl: cust.photoUrl,
          jobTitle: cust.jobTitle,
          emails: cust.emails,
          phones: cust.phones,
          websites: cust.websites,
          socialProfiles: cust.socialProfiles,
          address: cust.address,
          organization: cust.organization,
          createdAt: cust.createdAt,
          updatedAt: cust.updatedAt
        });
      }
    }
    this.conv.upsertConversation({
      id: c.remoteId,
      number: c.number,
      threads: c.threadCount,
      type: c.type,
      source: c.sourceType ? { type: c.sourceType, via: c.sourceVia ?? null } : null,
      folderId: c.folderId,
      status: c.status,
      state: c.state,
      subject: c.subject,
      preview: c.preview,
      mailboxId: c.mailboxId,
      assignee: c.assigneeId ? { id: c.assigneeId, type: c.assigneeType ?? 'user' } : null,
      assignedTeam: c.assignedTeamId ? { id: c.assignedTeamId } : null,
      closedAt: c.closedAt,
      createdAt: c.createdAt,
      userUpdatedAt: c.userUpdatedAt,
      tags: c.tags.map((t) => ({ id: t.remoteId ?? undefined, tag: t.name, color: t.color })),
      cc: c.cc,
      bcc: c.bcc,
      primaryCustomer: c.primaryCustomerId ? { id: c.primaryCustomerId, first: c.primaryCustomerName?.split(' ')[0], last: c.primaryCustomerName?.split(' ')[1], email: c.primaryCustomerEmail } : null,
      snooze: c.snoozedUntil ? { snoozedUntil: c.snoozedUntil } : null,
      customFields: c.customFields.map((f) => ({ id: f.fieldId, name: undefined, value: f.value, text: f.text, systemType: f.systemType })),
      raw: c
    });
    const local = this.conv.getConversationByRemoteId(c.remoteId);
    if (!local) return;

    let list = threads;
    if (fetchThreadsIfNeeded || threads.length === 0) {
      try {
        list = await this.provider.listThreads(c.remoteId);
      } catch (e) {
        // Threads fetch can fail for locked conversations - conversation data is still preserved
        this.jobs.logError('sync', `Thread fetch failed for conversation ${c.remoteId}: ${e instanceof Error ? e.message : String(e)}`);
        list = [];
      }
    }
    const seenRemoteIds = new Set<number>();
    for (const t of list) {
      seenRemoteIds.add(t.remoteId);
      this.conv.upsertThread(local.id, {
        id: t.remoteId,
        type: t.type,
        status: t.status,
        state: t.state,
        action: t.actionType ? { type: t.actionType, text: t.actionText } : null,
        body: t.body,
        source: t.sourceType ? { type: t.sourceType, via: t.sourceVia } : null,
        customer: t.customer,
        createdBy: t.createdBy,
        assignedTo: t.assignedTo,
        savedReplyId: t.savedReplyId,
        to: t.to,
        cc: t.cc,
        bcc: t.bcc,
        createdAt: t.createdAt,
        attachments: t.attachments,
        raw: t
      });
    }
    // Remove local threads that no longer exist remotely (deleted/merged upstream)
    if (list.length > 0 || threads.length > 0) {
      const localThreads = this.db.prepare('SELECT id, remote_id FROM threads WHERE conversation_id = ? AND remote_id IS NOT NULL').all(local.id) as { id: number; remote_id: number }[];
      const stale = localThreads.filter((lt) => !seenRemoteIds.has(lt.remote_id));
      if (stale.length > 0) {
        const del = this.db.prepare('DELETE FROM threads WHERE id = ?');
        const tx = this.db.transaction(() => stale.forEach((s) => del.run(s.id)));
        tx();
      }
    }
    this.conv.refreshConversationActivity(local.id);
  }
}
