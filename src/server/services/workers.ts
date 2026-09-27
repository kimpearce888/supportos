import type { AppContext } from './context.js';
import type { SyncCoordinator } from '../sync/coordinator.js';
import type { AiPipeline } from '../ai/pipeline.js';
import { ConversationOperations } from './operations.js';
import { PRIORITY, RATINGS_REFRESH_DEFAULT_SECONDS } from '../../shared/constants.js';
import { serverEventBus } from './eventBus.js';
import { WebhookEndpoint } from './webhookEndpoint.js';
import { createLogger, type StructuredLogger } from '../config/logger.js';

/**
 * WorkerManager (spec #110): explicit queues for sync, api, attachments,
 * embeddings, AI analysis/drafting/verification, reports, maintenance,
 * reconciliation. Background work NEVER blocks request handling; jobs are
 * claimed atomically from SQLite and survive restarts.
 */
export class WorkerManager {
  private logger: StructuredLogger;
  private timers: NodeJS.Timeout[] = [];
  private loopTimer: NodeJS.Timeout | null = null;
  private coordinator: SyncCoordinator;
  private pipeline: AiPipeline;
  private operations: ConversationOperations;
  private webhook: WebhookEndpoint;
  private running = false;
  private processing = false;
  private stopped = false;
  private refreshingRatings = false;
  private lastAiHealthCheck: { at: string; connected: boolean } | null = null;

  constructor(private ctx: AppContext) {
    this.logger = createLogger(ctx.config.logLevel).child({ service: 'workers' });
    this.coordinator = ctx.coordinator;
    this.pipeline = ctx.aiPipeline;
    this.operations = ctx.operations;
    // Webhook drain endpoint shares the same secret + repositories as the HTTP one
    // (v1.4.0: leftover pending events after a crash are re-processed on boot).
    this.webhook = new WebhookEndpoint(ctx.db, ctx.config.helpscout.webhookSecret);
  }

  rebindCoordinator(coordinator: SyncCoordinator): void {
    this.coordinator = coordinator;
    this.operations = new ConversationOperations(this.ctx.db, this.ctx.provider);
  }

  rebindPipeline(pipeline: AiPipeline): void {
    this.pipeline = pipeline;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    // Recover stale jobs from a previous run (spec: survive restart)
    const recovered = this.ctx.jobsRepo.recoverStaleJobs();
    if (recovered > 0) this.logger.info('Recovered stale jobs after restart', { operation: 'recover', count: recovered });
    // v1.5.0: one-time backfills for pre-1.5 databases (ticket chunks + property values)
    this.backfillV150();
    // Recover webhook events that were persisted but never processed (v1.4.0):
    // the endpoint persists FIRST and acknowledges, so a crash in between used
    // to leave events pending forever.
    void this.webhook.drainPending().then((n) => {
      if (n > 0) this.logger.info('Drained pending webhook events after restart', { operation: 'webhook_drain', count: n });
    });
    // Main job loop every 2s
    this.loopTimer = setInterval(() => void this.tick(), 2000);
    this.timers.push(this.loopTimer);
    // Periodic incremental sync (guard against a malformed stored interval:
    // a NaN/0 value previously collapsed setInterval to a 1ms runaway loop)
    const rawSyncMinutes = Number(this.ctx.settingsRepo.get('sync_interval_minutes', 5));
    const syncMinutes = Number.isFinite(rawSyncMinutes) ? Math.min(1440, Math.max(1, rawSyncMinutes)) : 5;
    const syncTimer = setInterval(() => void this.autoSync(), syncMinutes * 60_000);
    this.timers.push(syncTimer);
    // Real-time ratings refresh (v1.3.0): a LIGHTWEIGHT loop, decoupled from the
    // full sync, that re-checks ratings and pushes new ones over SSE immediately.
    // The real provider has no list-ratings endpoint (webhooks are the primary
    // path there); the watcher still runs - it is cheap, and demo/fake mode plus
    // any future list endpoint light up without configuration.
    const rawRatingsSeconds = Number(this.ctx.settingsRepo.get('ratings_refresh_seconds', RATINGS_REFRESH_DEFAULT_SECONDS));
    const ratingsSeconds = Number.isFinite(rawRatingsSeconds) ? Math.min(3600, Math.max(0, Math.trunc(rawRatingsSeconds))) : RATINGS_REFRESH_DEFAULT_SECONDS;
    if (ratingsSeconds > 0) {
      const ratingsTimer = setInterval(() => void this.refreshRatings(), ratingsSeconds * 1000);
      this.timers.push(ratingsTimer);
    }
    // Maintenance: backup + cluster trends + cleanup every 6h
    const maintenanceTimer = setInterval(() => void this.maintenance(), 6 * 3600_000);
    this.timers.push(maintenanceTimer);
    this.logger.info('Background workers started', { operation: 'start', sync_interval_minutes: syncMinutes, ratings_refresh_seconds: ratingsSeconds });
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.loopTimer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async autoSync(): Promise<void> {
    if (this.stopped) return;
    const state = this.ctx.syncRepo.getState();
    if (state === 'NEW' || state === 'INITIALIZING' || state === 'BACKFILLING') return; // initial sync handled explicitly
    try {
      await this.coordinator.incrementalSync();
      this.logger.debug('Incremental sync completed', { operation: 'incremental_sync' });
    } catch (e) {
      this.logger.warn('Incremental sync failed', { operation: 'incremental_sync', error: String(e) });
    }
  }

  /**
   * Ratings-only refresh (real-time path, v1.3.0): fetch ratings from the
   * provider, upsert, and emit rating-received for every NEW rating so SSE
   * subscribers (dashboard) update within seconds instead of waiting for a
   * full sync pass. Failures are logged and never retried within the tick -
   * the next interval picks them up.
   */
  private async refreshRatings(): Promise<void> {
    if (this.stopped || this.refreshingRatings) return;
    this.refreshingRatings = true;
    try {
      const ratings = await this.ctx.provider.listAllRatings();
      let fresh = 0;
      for (const r of ratings) {
        const convRow = r.conversationId ? this.ctx.conversationRepo.getConversationByRemoteId(r.conversationId) : undefined;
        const inserted = this.ctx.peopleRepo.upsertRating({
          remote_id: r.remoteId,
          conversation_local_id: convRow?.id ?? null,
          rating: r.rating,
          comments: r.comments,
          customer_local_id: r.customerId ? this.ctx.referenceRepo.getLocalId('customers', r.customerId) : null,
          user_local_id: r.userId ? this.ctx.referenceRepo.getLocalId('users', r.userId) : null,
          createdAt: r.createdAt,
          raw: r
        });
        if (inserted) {
          fresh++;
          serverEventBus.emit('rating-received', {
            rating: r.rating,
            conversationId: convRow?.id ?? null,
            conversationNumber: convRow?.number ?? null,
            customerId: r.customerId ? this.ctx.referenceRepo.getLocalId('customers', r.customerId) : null,
            customerName: r.customerName ?? null,
            comments: r.comments,
            at: new Date().toISOString()
          });
        }
      }
      if (fresh > 0) {
        serverEventBus.emit('ratings-refreshed', { processed: ratings.length, fresh, at: new Date().toISOString() });
        this.logger.info('Ratings refresh pushed new ratings', { operation: 'ratings_refresh', fresh, processed: ratings.length });
      }
    } catch (e) {
      this.logger.warn('Ratings refresh failed', { operation: 'ratings_refresh', error: String(e) });
    } finally {
      this.refreshingRatings = false;
    }
  }

  private async maintenance(): Promise<void> {
    try {
      this.ctx.issueRepo.computeTrends();
      const backupHours = this.ctx.settingsRepo.get<number | null>('backup_interval_hours', 24);
      if (backupHours && backupHours > 0) {
        const result = this.ctx.backup.backup();
        if (result.ok) this.logger.info('Automatic backup created', { operation: 'backup' });
      }
      this.enforceRetention();
    } catch (e) {
      this.logger.warn('Maintenance failed', { operation: 'maintenance', error: String(e) });
    }
  }

  /**
   * Data-retention window (Settings > Data): prunes LOCAL operational data
   * older than retention_days - webhook events, application errors, audit log
   * entries and AI run records. Conversations/threads/customers are NOT
   * pruned: they mirror Help Scout and would simply re-sync; delete them in
   * Help Scout itself. 0/null disables pruning.
   */
  private enforceRetention(): void {
    const days = Number(this.ctx.settingsRepo.get<number | null>('retention_days', null));
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const tables: [string, string][] = [
      ['webhook_events', 'received_at'],
      ['application_errors', 'timestamp'],
      ['audit_log', 'timestamp'],
      ['ai_runs', 'created_at']
    ];
    for (const [table, column] of tables) {
      try {
        const result = this.ctx.db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
        if (result.changes > 0) this.logger.info('Retention pruning', { operation: 'retention', table, removed: result.changes });
      } catch {
        /* table/column missing on older schemas - skip */
      }
    }
  }

  /** One pass over the job queues (bounded so the loop never blocks on stuck jobs). */
  private async tick(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      for (let i = 0; i < 10; i++) {
        const job = this.ctx.jobsRepo.claimNext();
        if (!job) break;
        await this.execute(job.id, job.queue, job.type, job.payload ?? {}, job.attempt, job.max_attempts);
      }
    } catch (e) {
      this.logger.warn('Worker tick error', { operation: 'tick', error: String(e) });
    } finally {
      this.processing = false;
    }
  }

  async execute(jobId: number, queue: string, type: string, payload: Record<string, unknown>, attempt: number, maxAttempts: number): Promise<void> {
    const started = Date.now();
    try {
      switch (type) {
        // ---------- sync queue ----------
        case 'initial_sync': {
          await this.coordinator.initialSync();
          await this.onAfterInitialSync();
          break;
        }
        case 'incremental_sync': {
          await this.coordinator.incrementalSync();
          break;
        }
        case 'reconciliation': {
          await this.coordinator.reconcile();
          break;
        }
        case 'sync_conversation':
        case 'sync_conversation_merge': {
          await this.coordinator.syncSingleConversation(Number(payload.remoteId));
          if (type === 'sync_conversation') {
            const local = this.ctx.conversationRepo.getConversationByRemoteId(Number(payload.remoteId));
            if (local) {
              // v1.4.0: real-time push for single-conversation updates (webhook path)
              serverEventBus.emit('conversation-updated', {
                conversationId: local.id,
                conversationNumber: local.number,
                mailboxId: local.mailbox_local_id ?? null,
                subject: local.subject ?? null,
                reason: payload.source === 'webhook' ? 'webhook' : 'sync',
                at: new Date().toISOString()
              });
              await this.onConversationChanged(local.id, 'sync');
            }
          }
          break;
        }
        case 'delete_conversation': {
          this.ctx.conversationRepo.softDeleteByRemoteId(Number(payload.remoteId));
          break;
        }
        case 'sync_customer': {
          const customer = await this.ctx.provider.getCustomer(Number(payload.remoteId));
          if (customer) this.ctx.peopleRepo.upsertCustomer(customer as unknown as Parameters<typeof this.ctx.peopleRepo.upsertCustomer>[0]);
          break;
        }
        case 'delete_customer': {
          this.ctx.db.prepare('UPDATE customers SET deleted_at = datetime(\'now\') WHERE remote_id = ?').run(Number(payload.remoteId));
          break;
        }
        case 'sync_organizations': {
          const orgs = await this.ctx.provider.listOrganizations();
          for (const o of orgs) this.ctx.peopleRepo.upsertOrganization({ id: o.remoteId, name: o.name, domains: o.domains, createdAt: o.createdAt, updatedAt: o.updatedAt, raw: o });
          break;
        }
        case 'sync_tags': {
          const tags = await this.ctx.provider.listTags();
          for (const t of tags) this.ctx.referenceRepo.upsertTag({ remote_id: t.remoteId, name: t.name, slug: t.slug, color: t.color, ticketCount: t.ticketCount, createdAt: t.createdAt, updatedAt: t.updatedAt, raw: t });
          break;
        }
        case 'sync_user_statuses': {
          const users = this.ctx.db.prepare('SELECT id, remote_id FROM users WHERE deleted_at IS NULL').all() as { id: number; remote_id: number }[];
          for (const u of users) {
            const s = await this.ctx.provider.getUserStatus(u.remote_id);
            if (s) this.ctx.referenceRepo.upsertUserStatus(u.id, { email: { status: s.emailStatus, updatedAt: s.emailUpdatedAt }, chat: { status: s.chatStatus, mailboxStatuses: s.mailboxStatuses }, raw: s });
          }
          break;
        }
        case 'sync_conversation_ratings': {
          // Ratings arrive via satisfaction.ratings webhook; re-sync the conversation to pick up embedded state
          if (payload.remoteId) await this.coordinator.syncSingleConversation(Number(payload.remoteId));
          break;
        }
        // ---------- ai queue ----------
        case 'analyze_ticket': {
          await this.pipeline.processNewTicket(Number(payload.conversationId));
          break;
        }
        case 'generate_draft': {
          await this.pipeline.generateDraft(Number(payload.conversationId), { mode: 'verified_answer' });
          break;
        }
        case 'create_ai_note': {
          const { analysis } = await this.pipeline.analyzeTicket(Number(payload.conversationId));
          const similar = this.ctx.evidenceBuilder.findSimilar(Number(payload.conversationId), 3);
          const note = this.pipeline.buildAiNote(Number(payload.conversationId), analysis, similar, analysis.known_issue_candidate);
          await this.operations.addNote({ conversationId: Number(payload.conversationId), text: note, aiGenerated: true });
          break;
        }
        case 'cluster_issues': {
          await this.pipeline.clusterIssues(Number(payload.days ?? 60));
          break;
        }
        case 'automation_action_awaiting_approval': {
          // Awaiting approval jobs stay queued until a human approves them in the Queue panel
          this.ctx.jobsRepo.completeJob(jobId);
          break;
        }
        // ---------- api queue (writes + bulk) ----------
        case 'bulk_tag':
        case 'bulk_untag':
        case 'add_tag': {
          const tag = String(payload.tag ?? '');
          if (tag) await this.operations.updateTags(Number(payload.conversationId), { add: [tag] });
          break;
        }
        case 'bulk_assign': {
          const userId = payload.userId != null ? Number(payload.userId) : null;
          await this.operations.assign(Number(payload.conversationId), userId);
          break;
        }
        case 'bulk_unassign': {
          await this.operations.assign(Number(payload.conversationId), null);
          break;
        }
        case 'bulk_status':
        case 'bulk_close': {
          const status = type === 'bulk_close' ? 'closed' : String(payload.status ?? 'closed');
          await this.operations.changeStatus(Number(payload.conversationId), status as 'active' | 'closed' | 'pending' | 'spam');
          break;
        }
        // ---------- attachments queue ----------
        case 'download_attachment': {
          await this.operations.downloadAttachment(Number(payload.attachmentId), this.ctx.config.attachmentsPath);
          break;
        }
        case 'download_recent_attachments': {
          const pending = this.ctx.conversationRepo.listAttachmentsWithoutFile(20);
          for (const a of pending) {
            await this.operations.downloadAttachment(a.id, this.ctx.config.attachmentsPath);
          }
          break;
        }
        // ---------- embeddings queue ----------
        case 'embed_knowledge_chunks': {
          await this.embedPendingKnowledge();
          break;
        }
        case 'embed_docs_chunks': {
          // v1.4.0: semantic docs search - chunk embeddings, Qdrant + local fallback
          await this.embedPendingDocs();
          break;
        }
        case 'embed_conversation_chunks': {
          // v1.5.0: semantic ticket/thread search - same pattern as docs chunks
          await this.embedPendingConversationChunks();
          break;
        }
        // ---------- outreach queue (v1.5.0) ----------
        case 'outreach_send_batch': {
          await this.ctx.campaigns.sendBatch(Number(payload.campaignId));
          break;
        }
        case 'outreach_reconcile': {
          await this.ctx.campaigns.reconcile(Number(payload.campaignId));
          break;
        }
        // ---------- reports queue ----------
        case 'refresh_report': {
          await this.ctx.analytics.dashboard(String(payload.from ?? new Date(Date.now() - 30 * 86400000).toISOString()), String(payload.to ?? new Date().toISOString()));
          break;
        }
        // ---------- maintenance queue ----------
        case 'rebuild_search_index': {
          // Atomic rebuild: wiping FTS outside a transaction left search empty
          // or degraded if the process died mid-rebuild.
          const convCount = this.ctx.db.transaction(() => {
            this.ctx.db.exec('DELETE FROM fts_conversations');
            this.ctx.db.exec('DELETE FROM fts_threads');
            const convIds = this.ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all() as { id: number }[];
            for (const c of convIds) this.ctx.conversationRepo.reindexConversationFts(c.id);
            this.ctx.db.exec(
              `INSERT INTO fts_threads (body, thread_id, conversation_id)
               SELECT t.body_text, t.id, t.conversation_id FROM threads t
               WHERE t.body_text IS NOT NULL AND LENGTH(t.body_text) > 0 AND t.deleted_at IS NULL`
            );
            this.ctx.db.exec('UPDATE threads SET fts_indexed = 1 WHERE body_text IS NOT NULL AND LENGTH(body_text) > 0');
            this.ctx.settingsRepo.setIndexVersion('fts_version', 3);
            return convIds.length;
          })() as number;
          this.logger.info('Search index rebuilt', { operation: 'rebuild_search_index', conversations: convCount });
          break;
        }
        case 'rebuild_embeddings': {
          this.ctx.db.prepare("UPDATE knowledge_chunks SET embedding_state = 'not_indexed'").run();
          this.ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, PRIORITY.INDEXING, 2);
          break;
        }
        default: {
          this.ctx.jobsRepo.failJob(jobId, `Unknown job type: ${type}`, false);
          return;
        }
      }
      this.ctx.jobsRepo.completeJob(jobId);
      this.logger.debug('Job completed', { jobId, operation: type, latency: Date.now() - started });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = attempt < maxAttempts;
      this.ctx.jobsRepo.failJob(jobId, msg, retryable);
      this.ctx.jobsRepo.logError('workers', `Job ${type} failed: ${msg}`, undefined, { jobId });
      this.logger.warn('Job failed', { jobId, operation: type, error: msg, retryable });
    }
  }

  /** After initial sync: enqueue attachment downloads + first embedding pass. */
  private async onAfterInitialSync(): Promise<void> {
    if (this.ctx.settingsRepo.get('attachment_auto_download', true)) {
      this.ctx.jobsRepo.enqueue('attachments', 'download_recent_attachments', {}, PRIORITY.INDEXING, 2);
    }
    this.ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, PRIORITY.INDEXING, 2);
    // v1.5.0: semantic ticket search over the fresh mirror
    this.ctx.jobsRepo.enqueue('embeddings', 'embed_conversation_chunks', {}, PRIORITY.INDEXING, 2);
    // Client Interaction Intelligence: build behavioral baselines from all history
    // (deterministic — no AI needed) so profiles are populated immediately (spec #59).
    try {
      const engine = this.ctx.aiPipeline.interactionEngine();
      const convs = this.ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY id').all() as { id: number }[];
      for (const c of convs) {
        engine.recordCurrentInteraction(c.id);
        engine.computeOutcome(c.id);
      }
      const customers = this.ctx.db.prepare('SELECT DISTINCT customer_local_id AS cid FROM conversations WHERE customer_local_id IS NOT NULL AND deleted_at IS NULL').all() as { cid: number }[];
      for (const cu of customers) engine.rebuildBaseline(cu.cid);
    } catch {
      /* interaction intelligence never breaks sync */
    }
    if (this.ctx.settingsRepo.get('ai_enabled', true) && this.ctx.settingsRepo.get('automatic_analysis_enabled', true)) {
      const newConversations = this.ctx.db
        .prepare("SELECT id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM ai_runs a WHERE a.conversation_id = c.id AND a.type='ticket_analysis' AND a.status='completed') AND c.deleted_at IS NULL ORDER BY id LIMIT 50")
        .all() as { id: number }[];
      for (const c of newConversations) {
        this.ctx.jobsRepo.enqueue('ai', 'analyze_ticket', { conversationId: c.id }, PRIORITY.ANALYTICS, 2);
      }
    }
  }

  /**
   * v1.5.0 one-time backfills for databases created before this version:
   * - ticket vector chunks (semantic search) for every mirrored conversation;
   * - customer property values harvested from stored raw_json snapshots.
   * Both are idempotent and cheap; they run once per boot, not per tick.
   */
  private backfillV150(): void {
    try {
      const conversations = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL').get() as { n: number }).n;
      const chunked = (this.ctx.db.prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM conversation_chunks').get() as { n: number }).n;
      if (conversations > 0 && chunked === 0) {
        const ids = this.ctx.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all() as { id: number }[];
        for (const c of ids) this.ctx.conversationRepo.rechunkConversation(c.id);
        this.ctx.jobsRepo.enqueue('embeddings', 'embed_conversation_chunks', {}, PRIORITY.INDEXING, 2);
        this.logger.info('v1.5.0 backfill: conversation chunks created', { operation: 'backfill', conversations: ids.length });
      }
      const propRows = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM customer_properties').get() as { n: number }).n;
      if (propRows === 0) {
        const healed = this.ctx.peopleRepo.backfillPropertiesFromRawJson();
        if (healed > 0) this.logger.info('v1.5.0 backfill: customer property values harvested from raw_json', { operation: 'backfill', values: healed });
      }
    } catch (e) {
      this.logger.warn('v1.5.0 backfill failed (non-fatal)', { operation: 'backfill', error: String(e) });
    }
  }

  /** Fire automation triggers + auto-analysis when a conversation changes. */
  private async onConversationChanged(conversationLocalId: number, source: 'sync' | 'manual'): Promise<void> {
    void source;
    try {
      const lastThread = this.ctx.db
        .prepare("SELECT type FROM threads WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY remote_created_at DESC, id DESC LIMIT 1")
        .get(conversationLocalId) as { type: string } | undefined;
      if (lastThread?.type === 'customer') {
        // New/changed ticket with a customer message -> automation + analysis
        await this.ctx.automation.fireTrigger('new_conversation', conversationLocalId).catch(() => undefined);
        await this.ctx.automation.fireTrigger('customer_reply', conversationLocalId).catch(() => undefined);
        if (this.ctx.settingsRepo.get('automatic_analysis_enabled', true) && this.ctx.settingsRepo.get('ai_enabled', true)) {
          this.ctx.jobsRepo.enqueue('ai', 'analyze_ticket', { conversationId: conversationLocalId }, PRIORITY.ANALYTICS, 2);
        }
        // Interaction intelligence: refresh deterministic signals on customer activity (spec #59)
        try {
          this.ctx.aiPipeline.interactionEngine().recordCurrentInteraction(conversationLocalId);
        } catch {
          /* never break sync */
        }
      }
    } catch {
      /* automation failures never break sync */
    }
  }

  /**
   * v1.4.0: embed docs-mirror chunks. Vectors are ALWAYS stored locally
   * (docs_chunks.embedding) so semantic search works without Qdrant; when
   * Qdrant is connected the same vectors are upserted for ANN retrieval.
   * Without an embedding model configured this is a documented no-op.
   */
  private async embedPendingDocs(): Promise<void> {
    const chunks = this.ctx.docsRepo.listDocChunksNeedingEmbedding(60);
    if (chunks.length === 0) return;
    const settings = this.ctx.settingsRepo.getLmStudio();
    if (!settings.embedding_model) return; // no embedding model configured - FTS remains the search path
    const qdrantHealth = await this.ctx.qdrant.health();
    try {
      const vectors = await this.ctx.aiProvider.embed(chunks.map((c) => c.content.slice(0, 4000)));
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const v = vectors[i];
        if (!v || v.length === 0) {
          this.ctx.docsRepo.setDocChunkEmbeddingState(c.id, 'failed', null);
          continue;
        }
        this.ctx.docsRepo.updateDocChunkEmbedding(c.id, settings.embedding_model, new Float32Array(v), 'indexed');
      }
      if (qdrantHealth.connected) {
        const points = chunks
          .map((c, i) => ({ c, v: vectors[i] }))
          .filter((x) => x.v && x.v.length > 0)
          .map((x) => ({
            id: x.c.id,
            vector: x.v!,
            payload: {
              entity_type: 'docs_chunk' as const,
              entity_id: x.c.article_id,
              chunk_id: x.c.id,
              title: x.c.title,
              text: x.c.content.slice(0, 2000),
              visibility: x.c.visibility,
              embedding_model: settings.embedding_model ?? 'unknown',
              index_version: 1
            }
          }));
        if (points.length > 0) {
          await this.ctx.qdrant.ensureCollection(points[0]!.vector.length);
          await this.ctx.qdrant.upsert(points as Parameters<typeof this.ctx.qdrant.upsert>[0]);
        }
      }
      this.logger.info('Docs chunk embedding pass completed', { operation: 'embed_docs', chunks: chunks.length, qdrant: qdrantHealth.connected });
    } catch (e) {
      for (const c of chunks) this.ctx.docsRepo.setDocChunkEmbeddingState(c.id, 'failed', null);
      this.logger.warn('Docs embedding pass failed', { operation: 'embed_docs', error: String(e) });
    }
  }

  /**
   * v1.5.0: embed ticket/thread chunks. Same design as embedPendingDocs:
   * vectors ALWAYS stored locally (conversation_chunks.embedding) so semantic
   * search works without Qdrant; Qdrant upsert adds ANN speed when connected.
   * Without an embedding model this is a documented no-op (FTS remains).
   */
  private async embedPendingConversationChunks(): Promise<void> {
    const chunks = this.ctx.conversationRepo.listConversationChunksNeedingEmbedding(60);
    if (chunks.length === 0) return;
    const settings = this.ctx.settingsRepo.getLmStudio();
    if (!settings.embedding_model) return;
    const qdrantHealth = await this.ctx.qdrant.health();
    try {
      const vectors = await this.ctx.aiProvider.embed(chunks.map((c) => c.content.slice(0, 4000)));
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const v = vectors[i];
        if (!v || v.length === 0) {
          this.ctx.conversationRepo.setConversationChunkEmbeddingState(c.id, 'failed', null);
          continue;
        }
        this.ctx.conversationRepo.updateConversationChunkEmbedding(c.id, settings.embedding_model, new Float32Array(v), 'indexed');
      }
      if (qdrantHealth.connected) {
        const points = chunks
          .map((c, i) => ({ c, v: vectors[i] }))
          .filter((x) => x.v && x.v.length > 0)
          .map((x) => {
            const conv = this.ctx.db
              .prepare('SELECT c.id, c.number, c.subject, c.customer_local_id FROM conversations c WHERE c.id = ?')
              .get(x.c.conversation_id) as { id: number; number: number; subject: string | null; customer_local_id: number | null } | undefined;
            return {
              id: x.c.id,
              vector: x.v!,
              payload: {
                entity_type: 'conversation_chunk' as const,
                entity_id: x.c.conversation_id,
                chunk_id: x.c.id,
                title: conv?.subject?.slice(0, 300) ?? `#${conv?.number ?? x.c.conversation_id}`,
                number: conv?.number ?? null,
                text: x.c.content.slice(0, 2000),
                visibility: 'internal_only' as const,
                embedding_model: settings.embedding_model ?? 'unknown',
                index_version: 1
              }
            };
          });
        if (points.length > 0) {
          await this.ctx.qdrant.ensureCollection(points[0]!.vector.length);
          await this.ctx.qdrant.upsert(points as Parameters<typeof this.ctx.qdrant.upsert>[0]);
        }
      }
      this.logger.info('Conversation chunk embedding pass completed', { operation: 'embed_conversations', chunks: chunks.length, qdrant: qdrantHealth.connected });
    } catch (e) {
      for (const c of chunks) this.ctx.conversationRepo.setConversationChunkEmbeddingState(c.id, 'failed', null);
      this.logger.warn('Conversation embedding pass failed', { operation: 'embed_conversations', error: String(e) });
    }
  }

  private async embedPendingKnowledge(): Promise<void> {
    const chunks = this.ctx.knowledgeRepo.listChunksNeedingEmbedding(60);
    if (chunks.length === 0) return;
    const qdrantHealth = await this.ctx.qdrant.health();
    const settings = this.ctx.settingsRepo.getLmStudio();
    if (!settings.embedding_model) return; // no embedding model configured - FTS still works
    try {
      const vectors = await this.ctx.aiProvider.embed(chunks.map((c) => c.content.slice(0, 4000)));
      if (qdrantHealth.connected) {
        const points = chunks.map((c, i) => ({
          id: c.id,
          vector: vectors[i] ?? [],
          payload: {
            entity_type: 'knowledge_chunk',
            entity_id: c.document_id,
            chunk_id: c.id,
            title: c.title,
            text: c.content.slice(0, 2000),
            visibility: c.visibility,
            embedding_model: settings.embedding_model ?? 'unknown',
            index_version: 1
          }
        }));
        if (points.length > 0 && (vectors[0]?.length ?? 0) > 0) {
          await this.ctx.qdrant.ensureCollection(vectors[0]!.length);
          const ok = await this.ctx.qdrant.upsert(points as Parameters<typeof this.ctx.qdrant.upsert>[0]);
          for (const c of chunks) this.ctx.knowledgeRepo.setChunkEmbeddingState(c.id, ok ? 'indexed' : 'failed', settings.embedding_model);
          return;
        }
      }
      // Qdrant unavailable: store embeddings locally (keyword search remains primary)
      for (const c of chunks) {
        const v = vectors[chunks.indexOf(c)];
        if (v) this.ctx.knowledgeRepo.updateChunkEmbedding(c.id, settings.embedding_model ?? null, new Float32Array(v), 'indexed');
        else this.ctx.knowledgeRepo.setChunkEmbeddingState(c.id, 'failed', null);
      }
    } catch (e) {
      for (const c of chunks) this.ctx.knowledgeRepo.setChunkEmbeddingState(c.id, 'failed', null);
      this.logger.warn('Embedding pass failed', { operation: 'embed', error: String(e) });
    }
  }

  aiHealth(): { connected: boolean; checkedAt: string; error: string | null } {
    // Cached LM Studio health (avoid probing on every request)
    if (this.lastAiHealthCheck && Date.now() - new Date(this.lastAiHealthCheck.at).getTime() < 30_000) {
      return { connected: this.lastAiHealthCheck.connected, checkedAt: this.lastAiHealthCheck.at, error: null };
    }
    void this.ctx.lmStudio
      .listModels()
      .then(() => {
        this.lastAiHealthCheck = { at: new Date().toISOString(), connected: true };
      })
      .catch(() => {
        this.lastAiHealthCheck = { at: new Date().toISOString(), connected: false };
      });
    const now = new Date().toISOString();
    return { connected: this.lastAiHealthCheck?.connected ?? false, checkedAt: now, error: this.ctx.aiProvider.lastError() };
  }

  /** Manually enqueue common maintenance jobs (Sync Health screen buttons). */
  enqueueRebuildSearchIndex(): void {
    this.ctx.jobsRepo.enqueue('maintenance', 'rebuild_search_index', {}, PRIORITY.INDEXING, 1);
  }
}
