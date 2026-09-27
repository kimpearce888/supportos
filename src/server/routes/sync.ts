import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import crypto from 'node:crypto';
import { webhookRegisterSchema } from '../../shared/schemas.js';

/** Conversation-push event set SupportOS registers by default (v1.4.0). */
export const DEFAULT_WEBHOOK_EVENTS = [
  'convo.created',
  'convo.updated',
  'convo.assigned',
  'convo.status',
  'convo.customer.reply.created',
  'convo.agent.reply.created',
  'convo.note.created',
  'satisfaction.ratings'
] as const;

export async function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/sync/status', async () => ({
    state: ctx.syncRepo.getState(),
    running: ctx.coordinator.running,
    current_run: ctx.syncRepo.getCurrentRun(),
    checkpoints: ctx.syncRepo.getAllCheckpoints(),
    last_success: ctx.syncRepo.lastSuccessfulSync(),
    recent_runs: ctx.syncRepo.getLatestRuns(10),
    webhook: {
      events: ctx.syncRepo.getWebhookStats(),
      recent: ctx.syncRepo.listWebhookEvents(20),
      configured: ctx.referenceRepo.getWebhookConfigs(),
      secret_configured: !!ctx.config.helpscout.webhookSecret
    },
    rate_limit: ctx.realProvider ? ctx.realProvider.http.limiter.snapshot() : null,
    api_queue: ctx.realProvider ? ctx.realProvider.http.queue.statsSnapshot() : null
  }));

  // Start initial sync (async: returns immediately, progress via status)
  app.post('/api/sync/initial', async (request, reply) => {
    if (ctx.coordinator.running) {
      reply.code(409);
      return { ok: false, message: 'A sync is already running.' };
    }
    const body = (request.body ?? {}) as { wait?: boolean };
    if (body.wait) {
      const results = await ctx.coordinator.initialSync();
      return { ok: true, message: 'Initial sync completed.', results };
    }
    // Attachment auto-download after initial sync is enqueued ONCE, by the
    // worker's onAfterInitialSync hook (a duplicate enqueue here caused every
    // attachment to be downloaded twice).
    void ctx.coordinator.initialSync().catch(() => undefined);
    return { ok: true, message: 'Initial sync started. Watch Sync Health for progress.' };
  });

  app.post('/api/sync/incremental', async (request, reply) => {
    if (ctx.coordinator.running) {
      reply.code(409);
      return { ok: false, message: 'A sync is already running.' };
    }
    const body = (request.body ?? {}) as { wait?: boolean };
    if (body.wait) {
      const results = await ctx.coordinator.incrementalSync();
      return { ok: true, message: 'Incremental sync completed.', results };
    }
    void ctx.coordinator.incrementalSync().catch(() => undefined);
    return { ok: true, message: 'Incremental sync started.' };
  });

  app.post('/api/sync/reconcile', async (request, reply) => {
    if (ctx.coordinator.running) {
      reply.code(409);
      return { ok: false, message: 'A sync is already running.' };
    }
    const body = (request.body ?? {}) as { wait?: boolean };
    if (body.wait) {
      const result = await ctx.coordinator.reconcile();
      return { ok: true, message: 'Reconciliation completed.', result };
    }
    void ctx.coordinator.reconcile().catch(() => undefined);
    return { ok: true, message: 'Reconciliation started.' };
  });

  app.post('/api/sync/cancel', async () => {
    ctx.coordinator.requestCancellation();
    return { ok: true, message: 'Cancellation requested - the current resource will finish, then the sync stops.' };
  });

  // ---------------- Webhook push registration (v1.4.0) ----------------

  app.post('/api/webhooks/register', async (request, reply) => {
    const parsed = webhookRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { ok: false, message: 'Invalid webhook registration: a reachable https URL and at least one supported event are required.' };
    }
    if (ctx.provider.kind !== 'real') {
      return { ok: false, message: 'Webhook registration targets a real Help Scout account - demo mode cannot register webhooks. Use POST /api/demo/simulate-webhook to exercise the pipeline locally.' };
    }
    const secret = ctx.config.helpscout.webhookSecret;
    if (!secret) {
      reply.code(422);
      return { ok: false, message: 'HELPSCOUT_WEBHOOK_SECRET must be set in .env first: Help Scout signs events with it and SupportOS verifies that signature.' };
    }
    try {
      const remoteId = await ctx.provider.createWebhook(parsed.data.url, parsed.data.events, secret, 'SupportOS');
      ctx.jobsRepo.audit({ actor: 'user', action: 'webhook_registered', remote_operation: 'POST /v2/webhooks', after_state: { url: parsed.data.url, events: parsed.data.events } });
      return {
        ok: true,
        message: `Webhook #${remoteId} registered for ${parsed.data.events.length} event type(s). Help Scout will push changes to that URL; a localhost app needs a relay (see docs/API-INTEGRATION.md).`,
        remoteId,
        events: parsed.data.events
      };
    } catch (e) {
      return { ok: false, message: `Help Scout rejected the webhook registration: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  app.delete('/api/webhooks/:remoteId', async (request, reply) => {
    const remoteId = Number((request.params as { remoteId: string }).remoteId);
    if (!Number.isInteger(remoteId) || remoteId <= 0) {
      reply.code(422);
      return { ok: false, message: 'Webhook id must be a positive integer.' };
    }
    if (ctx.provider.kind !== 'real') {
      return { ok: false, message: 'Not available in demo mode.' };
    }
    try {
      const deleted = await ctx.provider.deleteWebhook(remoteId);
      ctx.jobsRepo.audit({ actor: 'user', action: 'webhook_deleted', remote_operation: `DELETE /v2/webhooks/${remoteId}` });
      return { ok: deleted, message: deleted ? `Webhook #${remoteId} deleted.` : `Webhook #${remoteId} not found remotely.` };
    } catch (e) {
      return { ok: false, message: `Help Scout rejected the webhook deletion: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  // Queue management (developer/admin panel)
  app.get('/api/queue', async (request) => {
    const q = request.query as Record<string, string>;
    const rawLimit = q.limit != null && q.limit !== '' ? Number(q.limit) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 100;
    return {
      jobs: ctx.jobsRepo.listJobs({ status: q.status, queue: q.queue, limit }),
      stats: ctx.jobsRepo.queueStats(),
      outbound: ctx.jobsRepo.listOutboundJobs(q.outbound_status, 50)
    };
  });

  app.post('/api/queue/:id/retry', async (request) => {
    ctx.jobsRepo.retryJob(Number((request.params as { id: string }).id));
    return { ok: true, message: 'Job requeued.' };
  });

  app.post('/api/queue/:id/cancel', async (request) => {
    ctx.jobsRepo.cancelJob(Number((request.params as { id: string }).id));
    return { ok: true, message: 'Job cancelled.' };
  });

  app.post('/api/queue/clear-completed', async () => {
    const n = ctx.jobsRepo.clearCompleted();
    return { ok: true, message: `${n} completed jobs older than 24h removed.` };
  });

  // Maintenance triggers
  app.post('/api/sync/rebuild-search-index', async () => {
    ctx.jobsRepo.enqueue('maintenance', 'rebuild_search_index', {}, 4, 1);
    return { ok: true, message: 'Search index rebuild queued.' };
  });

  app.post('/api/sync/rebuild-embeddings', async () => {
    ctx.jobsRepo.enqueue('maintenance', 'rebuild_embeddings', {}, 4, 1);
    return { ok: true, message: 'Embedding rebuild queued (requires LM Studio embedding model).' };
  });

  // OAuth flow: begin + callback + client-credentials connect + disconnect
  app.get('/api/oauth/authorize-url', async (_request, reply) => {
    if (!ctx.realProvider) return { demo_mode: true, message: 'Demo mode is active - OAuth is not needed.' };
    if (!ctx.realProvider.auth.isConfigured()) {
      reply.code(400);
      return { ok: false, message: 'HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET must be set in .env first.' };
    }
    const state = crypto.randomBytes(16).toString('hex');
    ctx.db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('oauth_state', ?, datetime('now'))").run(JSON.stringify(state));
    return { url: ctx.realProvider.auth.buildAuthorizeUrl(state) };
  });

  app.post('/api/oauth/client-credentials', async (_request, reply) => {
    if (!ctx.realProvider) return { demo_mode: true };
    if (!ctx.realProvider.auth.isConfigured()) {
      reply.code(400);
      return { ok: false, message: 'HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET must be set in .env first.' };
    }
    try {
      const tokens = await ctx.realProvider.auth.clientCredentialsLogin();
      ctx.realProvider.auth.saveTokens(tokens);
      const me = await ctx.realProvider.getMe();
      ctx.db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('me_remote_id', ?, datetime('now'))").run(JSON.stringify(me.remoteId));
      ctx.jobsRepo.audit({ actor: 'user', action: 'helpscout_connected', remote_operation: 'POST /v2/oauth2/token' });
      return { ok: true, message: `Connected to Help Scout as ${me.firstName} ${me.lastName}.` };
    } catch (e) {
      reply.code(401);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  app.get('/api/oauth/status', async () => {
    if (!ctx.realProvider) {
      return { configured: false, authenticated: true, demo_mode: true, expires_at: null, me: null };
    }
    const status = ctx.realProvider.auth.status(false);
    let me: { name: string; email: string | null } | null = null;
    if (status.authenticated) {
      try {
        const u = await ctx.realProvider.getMe();
        me = { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email };
        ctx.db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('me_remote_id', ?, datetime('now'))").run(JSON.stringify(u.remoteId));
      } catch {
        me = null;
      }
    }
    return { ...status, me };
  });

  app.post('/api/oauth/disconnect', async () => {
    if (ctx.realProvider) await ctx.realProvider.auth.revoke();
    ctx.jobsRepo.audit({ actor: 'user', action: 'helpscout_disconnected' });
    return { ok: true, message: 'Disconnected. Local data is fully preserved.' };
  });
}
