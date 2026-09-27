import { APP_VERSION } from '../../shared/constants.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { tableStats } from '../database/connection.js';
import { migrationsApplied } from '../database/migrator.js';
import { CAPABILITY_MATRIX } from './capabilities.js';
import { serverEventBus } from '../services/eventBus.js';
import { demoWebhookSchema } from '../../shared/schemas.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------------- Health (spec #98) ----------------
  app.get('/health', async (_request, reply) => {
    const dbOk = (() => {
      try {
        ctx.db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    })();
    const healthy = dbOk;
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'error', database: dbOk, version: APP_VERSION, time: new Date().toISOString() };
  });

  app.get('/health/detailed', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const dbOk = (() => {
      try {
        ctx.db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    })();

    // Help Scout connectivity (cached ping to avoid rate-limit burns)
    let helpscout = { connected: false, error: 'Not checked' };
    if (ctx.provider.kind === 'fake') {
      helpscout = { connected: true, error: null as unknown as string };
    } else {
      const cached = ctx.db.prepare("SELECT value FROM application_settings WHERE key='hs_last_ping'").get() as { value: string } | undefined;
      if (cached && Date.now() - JSON.parse(cached.value).at < 60_000) {
        helpscout = JSON.parse(cached.value);
      } else {
        try {
          await ctx.provider.ping();
          helpscout = { connected: true, error: null as unknown as string };
        } catch (e) {
          helpscout = { connected: false, error: e instanceof Error ? e.message : String(e) };
        }
        ctx.db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('hs_last_ping', ?, datetime('now'))").run(JSON.stringify({ ...helpscout, at: Date.now() }));
      }
    }

    const lmstudio = await ctx.lmStudio
      .listModels()
      .then((m) => ({ connected: true, models: m.data.map((x) => x.id) }))
      .catch((e: unknown) => ({ connected: false, models: [] as string[], error: e instanceof Error ? e.message : String(e) }));

    const qdrant = await ctx.qdrant.health();

    const result = {
      status: dbOk ? (helpscout.connected || ctx.provider.kind === 'fake' ? 'ok' : 'degraded') : 'error',
      version: APP_VERSION,
      time: new Date().toISOString(),
      database: { ok: dbOk, path: ctx.dbStats().path, size_bytes: ctx.dbStats().size_bytes, migrations_applied: migrationsApplied(ctx.db), wal: true },
      helpscout: { connected: helpscout.connected, demo_mode: ctx.provider.kind === 'fake', error: helpscout.error ?? null, oauth: ctx.realProvider ? ctx.realProvider.auth.status(false) : { configured: false, authenticated: true, demoMode: true, expiresAt: null } },
      lmstudio: { connected: lmstudio.connected, base_url: ctx.settingsRepo.getLmStudio().base_url, models: (lmstudio as { models?: string[] }).models ?? [], embedding_model: ctx.settingsRepo.getLmStudio().embedding_model, last_inference: ctx.lmStudio.getLastInference(), error: (lmstudio as { error?: string }).error ?? null },
      qdrant: { connected: qdrant.connected, url: qdrant.url, collections: qdrant.collections, indexed: ctx.knowledgeRepo.countIndexed(), error: qdrant.error },
      sync: { state: ctx.syncRepo.getState(), last_success: ctx.syncRepo.lastSuccessfulSync(), queued_jobs: ctx.jobsRepo.queueStats().queued, failed_jobs: ctx.jobsRepo.queueStats().failed },
      workers: { running: ctx.workers.isRunning(), queue_depth: ctx.jobsRepo.queueStats().queued }
    };
    if (q.format === 'ui') return result;
    reply.code(result.status === 'ok' ? 200 : result.status === 'degraded' ? 200 : 503);
    return result;
  });

  // ---------------- Database stats ----------------
  app.get('/api/system/db', async () => ctx.dbStats());

  // ---------------- Capability matrix (spec #117, #118) ----------------
  app.get('/api/system/capabilities', async () => {
    const implemented = CAPABILITY_MATRIX.filter((c) => c.implemented).length;
    return { matrix: CAPABILITY_MATRIX, summary: { implemented, total: CAPABILITY_MATRIX.length, tested: CAPABILITY_MATRIX.filter((c) => c.tested).length } };
  });

  // ---------------- First-run / onboarding state ----------------
  app.get('/api/onboarding', async () => ({
    step: ctx.settingsRepo.get('onboarding_step', 'welcome'),
    completed: ctx.settingsRepo.get('first_run_completed', false),
    demo_mode: ctx.provider.kind === 'fake',
    hs_configured: !ctx.realProvider || ctx.realProvider.auth.isConfigured(),
    hs_authenticated: ctx.realProvider ? ctx.realProvider.auth.status(false).authenticated : true,
    sync_state: ctx.syncRepo.getState(),
    conversations: (ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n
  }));

  app.post('/api/onboarding/step', async (request) => {
    const body = request.body as { step: string };
    ctx.settingsRepo.set('onboarding_step', body.step);
    return { ok: true };
  });

  app.post('/api/onboarding/complete', async () => {
    ctx.settingsRepo.set('first_run_completed', true);
    return { ok: true, message: 'Onboarding complete.' };
  });

  // ---------------- Demo mode helpers (explicit, never mixed with production) ----------------
  app.post('/api/demo/enable', async () => {
    if (ctx.provider.kind !== 'fake') {
      ctx.switchToDemoMode();
      ctx.settingsRepo.set('demo_data_loaded', true);
    }
    return { ok: true, message: 'Demo mode active with a simulated Help Scout account. Run the initial sync from Sync Health to populate the demo database.' };
  });

  app.post('/api/demo/simulate-incoming', async (request) => {
    if (ctx.provider.kind !== 'fake') return { ok: false, message: 'Not in demo mode.' };
    const body = (request.body ?? {}) as { subject?: string; body?: string; customerRemoteId?: number; mailboxId?: number };
    const subject = body.subject ?? 'New question about exports';
    const text = body.body ?? 'Hello, can scheduled exports include the raw JSON fields in addition to CSV?';
    const customerRemoteId = body.customerRemoteId ?? 3003;
    const mailboxId = body.mailboxId ?? 201;
    const conv = ctx.fakeProvider!.createConversationOnRemote({ subject, preview: text.slice(0, 120), mailboxId, customerRemoteId, body: text, tags: [] });
    ctx.jobsRepo.enqueue('sync', 'sync_conversation', { remoteId: conv.remoteId }, 2, 2);
    return { ok: true, message: `Simulated incoming conversation #${conv.number}. It will appear after the next sync tick (a few seconds).` };
  });

  // Simulate a CSAT rating arriving RIGHT NOW: upserted locally immediately and
  // broadcast over SSE (/api/events) so connected dashboards update in real time.
  app.post('/api/demo/simulate-rating', async (request, reply) => {
    if (ctx.provider.kind !== 'fake') return { ok: false, message: 'Not in demo mode.' };
    const body = (request.body ?? {}) as { conversationRemoteId?: number; rating?: 'great' | 'okay' | 'not-good'; comments?: string };
    if (!body.conversationRemoteId || !Number.isInteger(Number(body.conversationRemoteId))) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'conversationRemoteId (remote Help Scout id) is required.' });
      return;
    }
    if (body.rating && !['great', 'okay', 'not-good'].includes(body.rating)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: "rating must be 'great', 'okay' or 'not-good'." });
      return;
    }
    const hs = ctx.fakeProvider!.submitRating({
      conversationRemoteId: Number(body.conversationRemoteId),
      rating: body.rating ?? 'great',
      comments: body.comments
    });
    if (!hs) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found in the simulated account.' });
      return;
    }
    const convRow = ctx.conversationRepo.getConversationByRemoteId(hs.conversationId ?? 0);
    const customerLocal = hs.customerId ? ctx.referenceRepo.getLocalId('customers', hs.customerId) : null;
    ctx.peopleRepo.upsertRating({
      remote_id: hs.remoteId,
      conversation_local_id: convRow?.id ?? null,
      rating: hs.rating,
      comments: hs.comments,
      customer_local_id: customerLocal,
      user_local_id: hs.userId ? ctx.referenceRepo.getLocalId('users', hs.userId) : null,
      createdAt: hs.createdAt,
      raw: hs
    });
    serverEventBus.emit('rating-received', {
      rating: hs.rating,
      conversationId: convRow?.id ?? null,
      conversationNumber: convRow?.number ?? null,
      customerId: customerLocal,
      customerName: hs.customerName ?? null,
      comments: hs.comments,
      at: new Date().toISOString()
    });
    serverEventBus.emit('ratings-refreshed', { processed: 1, fresh: 1, at: new Date().toISOString() });
    return { ok: true, message: `Simulated a ${hs.rating ?? '(no)'} rating on conversation #${convRow?.number ?? hs.conversationId}. Connected dashboards update instantly via /api/events.` };
  });

  // v1.4.0: simulate an incoming WEBHOOK PUSH through the REAL pipeline -
  // HMAC-signed self-POST to /api/webhooks/helpscout -> persist -> dedup ->
  // sync_conversation job -> worker tick -> mirror update -> SSE
  // conversation-updated. This is the same path production events travel.
  app.post('/api/demo/simulate-webhook', async (request, reply) => {
    if (ctx.provider.kind !== 'fake') return { ok: false, message: 'Not in demo mode.' };
    const parsed = demoWebhookSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(422);
      return { ok: false, message: 'Invalid simulation request: event must be one of the supported convo.* types.' };
    }
    const { event, conversationRemoteId, replyText } = parsed.data;

    // 1. Mutate the simulated remote FIRST (the webhook tells us something changed)
    let remoteId = conversationRemoteId ?? 0;
    if (event === 'convo.created') {
      const conv = ctx.fakeProvider!.createConversationOnRemote({
        subject: 'Webhook push: SSO callback rejected',
        preview: 'Our identity provider logs show a rejected assertion after the 2.5 rollout…',
        mailboxId: 201,
        customerRemoteId: 3004,
        body: replyText ?? 'Our identity provider logs show a rejected SAML assertion right after the 2.5 rollout. SSO logins fail for about half our users. Is this a known issue?',
        tags: ['sso']
      });
      remoteId = conv.remoteId;
    } else {
      if (!remoteId) {
        const first = ctx.db.prepare('SELECT remote_id FROM conversations WHERE deleted_at IS NULL AND status = \'active\' ORDER BY id LIMIT 1').get() as { remote_id: number } | undefined;
        if (!first) {
          reply.code(404);
          return { ok: false, message: 'No conversation available to push an event for.' };
        }
        remoteId = first.remote_id;
      }
      if (event === 'convo.customer.reply.created' || event === 'convo.agent.reply.created') {
        ctx.fakeProvider!.customerReplies(remoteId, replyText ?? 'Any update on this? Our team is blocked until SSO works again.');
      }
      // convo.note.created mutates nothing customer-visible; the sync still refreshes the thread.
    }

    // 2. Self-POST through the REAL webhook endpoint with a valid HMAC when a
    //    secret is configured (unsigned is accepted only when no secret is set,
    //    exactly like production). A per-push nonce mirrors Help Scout's
    //    unique payloads so repeated demos are NOT swallowed by dedup.
    const payload = JSON.stringify({ conversationId: remoteId, objectID: remoteId, id: remoteId, nonce: Date.now() });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-HelpScout-Event': event };
    const secret = ctx.config.helpscout.webhookSecret;
    if (secret) headers['X-HelpScout-Signature'] = crypto.createHmac('sha1', secret).update(Buffer.from(payload, 'utf8')).digest('base64');
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.config.port}/api/webhooks/helpscout`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => ({}))) as { received?: boolean; duplicate?: boolean };
      if (!res.ok || !body.received) {
        return { ok: false, message: `Webhook endpoint rejected the simulated event (HTTP ${res.status}).` };
      }
      return {
        ok: true,
        message: `${event} pushed through the real webhook pipeline${body.duplicate ? ' (deduplicated)' : ''}. The sync job runs on the next worker tick (~2s); connected clients get an SSE conversation-updated event.`,
        remoteId
      };
    } catch (e) {
      return { ok: false, message: `Could not reach the local webhook endpoint: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  // ---------------- Attachment file serving (safe: no execution, path constrained) ----------------
  app.get('/api/attachments/:id/file', async (request, reply) => {
    const rawId = (request.params as { id: string }).id;
    const id = Number(rawId);
    if (!Number.isFinite(id) || !Number.isInteger(id)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid attachment id.' });
      return;
    }
    const att = ctx.conversationRepo.getAttachment(id);
    if (!att?.local_path || !fs.existsSync(att.local_path)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Attachment not downloaded yet. Use the download action first.' });
      return;
    }
    const resolved = path.resolve(att.local_path);
    const root = path.resolve(ctx.config.attachmentsPath);
    // Separator-aware containment: blocks sibling dirs that share a prefix (e.g. data-x/ vs data/)
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid attachment path.' });
      return;
    }
    // Only raster/vector images are served inline; every other type (including
    // text/html, which would execute same-origin script against this unauthenticated
    // local API) is forced to download.
    const type = att.mime_type ?? 'application/octet-stream';
    const safeInline = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i;
    reply.header('Content-Type', safeInline.test(type) ? type : 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${(att.filename ?? 'attachment').replace(/["\\\r\n]/g, '_')}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    // Stream directly from disk: reply.sendFile() joins paths onto the SPA root
    // (dist/client) when the static plugin is registered and would 404 here.
    return fs.createReadStream(resolved).on('error', () => {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Attachment file is no longer readable on disk.' });
    });
  });

  // ---------------- Table stats for queue/db panel ----------------
  app.get('/api/system/tables', async () => ({ tables: tableStats(ctx.db) }));
}
