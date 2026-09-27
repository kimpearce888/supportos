import type { AppContext } from './context.js';
import type { SyncCoordinator } from '../sync/coordinator.js';
import type { AiPipeline } from '../ai/pipeline.js';
import { ConversationOperations } from './operations.js';
import { PRIORITY } from '../../shared/constants.js';
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
  private running = false;
  private processing = false;
  private stopped = false;
  private lastAiHealthCheck: { at: string; connected: boolean } | null = null;

  constructor(private ctx: AppContext) {
    this.logger = createLogger(ctx.config.logLevel).child({ service: 'workers' });
    this.coordinator = ctx.coordinator;
    this.pipeline = ctx.aiPipeline;
    this.operations = ctx.operations;
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
    // Main job loop every 2s
    this.loopTimer = setInterval(() => void this.tick(), 2000);
    this.timers.push(this.loopTimer);
    // Periodic incremental sync
    const syncMinutes = this.ctx.settingsRepo.get('sync_interval_minutes', 5);
    const syncTimer = setInterval(() => void this.autoSync(), Math.max(1, syncMinutes) * 60_000);
    this.timers.push(syncTimer);
    // Maintenance: backup + cluster trends + cleanup every 6h
    const maintenanceTimer = setInterval(() => void this.maintenance(), 6 * 3600_000);
    this.timers.push(maintenanceTimer);
    this.logger.info('Background workers started', { operation: 'start', sync_interval_minutes: syncMinutes });
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

  private async maintenance(): Promise<void> {
    try {
      this.ctx.issueRepo.computeTrends();
      const backupHours = this.ctx.settingsRepo.get<number | null>('backup_interval_hours', 24);
      if (backupHours && backupHours > 0) {
        const result = this.ctx.backup.backup();
        if (result.ok) this.logger.info('Automatic backup created', { operation: 'backup' });
      }
    } catch (e) {
      this.logger.warn('Maintenance failed', { operation: 'maintenance', error: String(e) });
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
            if (local) await this.onConversationChanged(local.id, 'sync');
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
        // ---------- reports queue ----------
        case 'refresh_report': {
          await this.ctx.analytics.dashboard(String(payload.from ?? new Date(Date.now() - 30 * 86400000).toISOString()), String(payload.to ?? new Date().toISOString()));
          break;
        }
        // ---------- maintenance queue ----------
        case 'rebuild_search_index': {
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
    if (this.ctx.settingsRepo.get('ai_enabled', true) && this.ctx.settingsRepo.get('automatic_analysis_enabled', true)) {
      const newConversations = this.ctx.db
        .prepare("SELECT id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM ai_runs a WHERE a.conversation_id = c.id AND a.type='ticket_analysis' AND a.status='completed') AND c.deleted_at IS NULL ORDER BY id LIMIT 50")
        .all() as { id: number }[];
      for (const c of newConversations) {
        this.ctx.jobsRepo.enqueue('ai', 'analyze_ticket', { conversationId: c.id }, PRIORITY.ANALYTICS, 2);
      }
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
      }
    } catch {
      /* automation failures never break sync */
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
