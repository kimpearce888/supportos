import { APP_VERSION } from '../../shared/constants.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { tableStats } from '../database/connection.js';
import { migrationsApplied } from '../database/migrator.js';
import { CAPABILITY_MATRIX } from './capabilities.js';
import fs from 'node:fs';
import path from 'node:path';

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

  // ---------------- Attachment file serving (safe: no execution, path constrained) ----------------
  app.get('/api/attachments/:id/file', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const att = ctx.conversationRepo.getAttachment(id);
    if (!att?.local_path || !fs.existsSync(att.local_path)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Attachment not downloaded yet. Use the download action first.' });
      return;
    }
    const resolved = path.resolve(att.local_path);
    if (!resolved.startsWith(path.resolve(ctx.config.attachmentsPath))) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid attachment path.' });
      return;
    }
    // Only serve safe content types inline; everything else downloads as an attachment
    const inlineTypes = /^(text\/|image\/)/;
    const type = att.mime_type ?? 'application/octet-stream';
    reply.header('Content-Type', type);
    if (!inlineTypes.test(type)) reply.header('Content-Disposition', 'attachment');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.sendFile ? reply.sendFile(resolved) : fs.createReadStream(resolved);
  });

  // ---------------- Table stats for queue/db panel ----------------
  app.get('/api/system/tables', async () => ({ tables: tableStats(ctx.db) }));
}
