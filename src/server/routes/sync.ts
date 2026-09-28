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
    // v1.6.0 audit fix: fire-and-forget syncs used to swallow failures silently
    // after telling the user "started". Failures are logged (and visible in the
    // server log / Sync Health error state) instead of vanishing.
    void ctx.coordinator.initialSync().catch((e: unknown) => {
      ctx.jobsRepo.logError('sync', `initial sync failed: ${e instanceof Error ? e.message : String(e)}`);
    });
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
    void ctx.coordinator.incrementalSync().catch((e: unknown) => {
      ctx.jobsRepo.logError('sync', `incremental sync failed: ${e instanceof Error ? e.message : String(e)}`);
    });
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
    void ctx.coordinator.reconcile().catch((e: unknown) => {
      ctx.jobsRepo.logError('sync', `reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    });
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

  app.post('/api/queue/:id/retry', async (request, reply) => {
    // v1.6.0 audit fix: NaN/nonexistent ids used to return ok:true silently.
    const raw = Number((request.params as { id: string }).id);
    if (!Number.isInteger(raw) || raw <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'A positive numeric job id is required.' });
      return;
    }
    const job = ctx.jobsRepo.getJob(raw);
    if (!job) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Job not found.' });
      return;
    }
    // Retrying a parked awaiting-approval job is the APPROVE gesture: the
    // payload gains approved=true so the worker executes the parked action.
    const patch = job.status === 'awaiting_approval' ? { approved: true } : null;
    const ok = ctx.jobsRepo.retryJob(raw, patch);
    if (!ok) {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: 'Job is not in a retryable state.' });
      return;
    }
    return { ok: true, message: job.status === 'awaiting_approval' ? 'Approved - the action runs on the next worker tick.' : 'Job requeued.' };
  });

  app.post('/api/queue/:id/cancel', async (request, reply) => {
    const raw = Number((request.params as { id: string }).id);
    if (!Number.isInteger(raw) || raw <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'A positive numeric job id is required.' });
      return;
    }
    const ok = ctx.jobsRepo.cancelJob(raw);
    if (!ok) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Job not found (or already finished).' });
      return;
    }
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

  // ---------------- Encrypted multi-device sync (v1.5.0) ----------------

  app.get('/api/sync/encrypted', async () => ({
    bundles: ctx.encryptedSync.listBundles(),
    log: ctx.encryptedSync.syncLog(),
    bundle_dir: ctx.encryptedSync.bundleDir(),
    design: 'File-based end-to-end encrypted bundles. No relay server: SupportOS never sees your data in transit - move the .sosync file yourself (cloud drive, USB, company share). Only the passphrase holder can decrypt it.'
  }));

  app.post('/api/sync/encrypted/export', async (request) => {
    const body = request.body as { passphrase?: string };
    const result = ctx.encryptedSync.exportBundle(String(body?.passphrase ?? ''));
    if (result.ok) ctx.jobsRepo.audit({ actor: 'user', action: 'encrypted_sync_export', after_state: { path: result.path, size: result.size_bytes } });
    return result;
  });

  app.post('/api/sync/encrypted/verify', async (request) => {
    const body = request.body as { path?: string; passphrase?: string };
    if (!body?.path) return { ok: false, message: 'A bundle path is required.' };
    return ctx.encryptedSync.verifyBundle(String(body.path), String(body.passphrase ?? ''));
  });

  app.post('/api/sync/encrypted/import', async (request) => {
    const body = request.body as { path?: string; passphrase?: string };
    if (!body?.path) return { ok: false, message: 'A bundle path is required.' };
    const result = ctx.encryptedSync.importBundle(String(body.path), String(body.passphrase ?? ''));
    if (result.ok) ctx.jobsRepo.audit({ actor: 'user', action: 'encrypted_sync_import', after_state: { path: body.path } });
    return result;
  });

  // Raw upload of a .sosync bundle (octet-stream body). Saved into the local
  // bundles dir; decrypt+import happens in a second, explicit step so the
  // passphrase never appears in a URL. Per-route body limit: bundles are whole
  // encrypted databases and can be far larger than the JSON API limit.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post(
    '/api/sync/encrypted/upload',
    { bodyLimit: 512 * 1024 * 1024 },
    async (request, reply) => {
      const body = request.body as Buffer | undefined;
      if (!body || !Buffer.isBuffer(body) || body.length < 32) {
        reply.code(422);
        return { ok: false, message: 'Upload a .sosync bundle as the raw request body (application/octet-stream).' };
      }
      const magic = Buffer.from('SOSYNC', 'utf8');
      if (!body.subarray(0, magic.length).equals(magic)) {
        reply.code(422);
        return { ok: false, message: 'This is not a SupportOS encrypted sync bundle (.sosync files start with SOSYNC).' };
      }
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = ctx.encryptedSync.bundleDir();
      fs.mkdirSync(dir, { recursive: true });
      const name = `uploaded-${Date.now()}.sosync`;
      const target = path.join(dir, name);
      fs.writeFileSync(target, body);
      return { ok: true, path: target, message: 'Bundle uploaded. Now import it with your passphrase.' };
    }
  );

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

  // v2.2.1 audit fix (completing existing functionality): the Settings page's
  // "Authorize via browser (OAuth code flow)" button and the stored oauth_state
  // existed, but NOTHING consumed the callback - Help Scout redirected to
  // /oauth/callback?code=..., the SPA fallback served the app, and the
  // authorization code was silently discarded (the flow could never connect).
  // This handler completes the advertised flow server-side (works in dev via
  // the Vite /oauth proxy AND in packaged builds) and finally VERIFIES the
  // single-use state parameter, closing the OAuth CSRF hole the dead path left.
  app.get('/oauth/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    const fail = (message: string): void => {
      reply.type('text/html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>SupportOS - connection not completed</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1f2933}h1{font-size:1.2rem}p{line-height:1.5;color:#52606d}</style></head>` +
          `<body><h1>Help Scout connection not completed</h1><p>${message}</p>` +
          `<p>Return to SupportOS Settings and try again, or use "Connect with Client Credentials".</p></body></html>`
      );
    };
    if (!ctx.realProvider) {
      fail('Demo mode is active - OAuth is not needed.');
      return;
    }
    if (q.error) {
      fail(`Help Scout returned an error: ${escapeHtml(String(q.error))}${q.error_description ? ` - ${escapeHtml(String(q.error_description))}` : ''}`);
      return;
    }
    if (!q.code || !q.state) {
      fail('The callback is missing its authorization code or state parameter.');
      return;
    }
    const stateRow = ctx.db.prepare("SELECT value FROM application_settings WHERE key = 'oauth_state'").get() as { value: string } | undefined;
    let stored: string | null = null;
    try {
      stored = stateRow ? (JSON.parse(stateRow.value) as string) : null;
    } catch {
      stored = null;
    }
    // Single-use: clear the stored state immediately after reading it.
    ctx.db.prepare("DELETE FROM application_settings WHERE key = 'oauth_state'").run();
    if (!stored || stored !== q.state) {
      fail('The state parameter did not match the authorization request (it may have expired or been reused). For safety the code was not exchanged.');
      return;
    }
    try {
      const tokens = await ctx.realProvider.auth.exchangeCode(q.code);
      ctx.realProvider.auth.saveTokens(tokens);
      const me = await ctx.realProvider.getMe();
      ctx.db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('me_remote_id', ?, datetime('now'))").run(JSON.stringify(me.remoteId));
      ctx.jobsRepo.audit({ actor: 'user', action: 'helpscout_connected', remote_operation: 'GET /oauth/callback (code exchange)' });
      reply.type('text/html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>SupportOS - connected</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1f2933}h1{font-size:1.2rem}p{line-height:1.5;color:#52606d}</style></head>` +
          `<body><h1>Connected to Help Scout</h1><p>Connected as ${escapeHtml(`${me.firstName} ${me.lastName}`.trim())}${me.email ? ` (${escapeHtml(me.email)})` : ''}.</p>` +
          `<p>You can close this tab and return to SupportOS. Reload the Settings page to see the connection status.</p></body></html>`
      );
    } catch (e) {
      fail(`Exchanging the authorization code failed: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
