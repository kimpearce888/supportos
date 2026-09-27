import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { lmStudioSettingsSchema, settingsPatchSchema, businessHoursSchema } from '../../shared/schemas.js';
import { isValidTimezone } from '../analytics/businessHours.js';

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value != null && value !== '' ? Number(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/settings', async () => ctx.settingsRepo.getAllSettings());

  app.patch('/api/settings', async (request, reply) => {
    const parsed = settingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(422);
      return { ok: false, message: 'Invalid settings patch: unknown or badly typed keys were rejected.' };
    }
    const patch = parsed.data;
    const updated = ctx.settingsRepo.updateSettings(patch);
    if ('ai_enabled' in patch) ctx.setAiEnabled(patch.ai_enabled === true);
    if ('qdrant_url' in patch || 'qdrant_enabled' in patch) {
      ctx.qdrant.reconfigure({ url: patch.qdrant_url, enabled: patch.qdrant_enabled });
    }
    if ('sync_interval_minutes' in patch) {
      ctx.workers.stop();
      ctx.workers.start();
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'settings_updated', after_state: { keys: Object.keys(patch) } });
    return { ok: true, message: 'Settings saved.', settings: updated };
  });

  // LM Studio settings + connection test + model discovery
  app.get('/api/settings/lmstudio', async () => ctx.settingsRepo.getLmStudio());

  app.patch('/api/settings/lmstudio', async (request) => {
    const parsed = lmStudioSettingsSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid LM Studio settings.' };
    }
    ctx.settingsRepo.updateLmStudio(parsed.data);
    ctx.lmStudio.refreshFromSettings();
    ctx.aiPipeline = ctx.aiPipeline; // settings are read per-request
    return { ok: true, message: 'LM Studio settings saved.' };
  });

  app.post('/api/settings/lmstudio/test', async () => {
    ctx.lmStudio.refreshFromSettings();
    try {
      const models = await ctx.lmStudio.listModels();
      return { ok: true, connected: true, models: models.data.map((m) => m.id), message: `LM Studio reachable - ${models.data.length} model(s) available.` };
    } catch (e) {
      return { ok: false, connected: false, models: [], message: e instanceof Error ? e.message : String(e) };
    }
  });

  // Qdrant settings + test
  app.get('/api/settings/qdrant', async () => ctx.settingsRepo.getQdrant());

  // ---------------- Business hours per mailbox (v1.4.0 SLA) ----------------

  app.get('/api/settings/business-hours', async () => {
    const rows = ctx.docsRepo.listBusinessHours();
    const mailboxes = ctx.referenceRepo.getMailboxes();
    return {
      mailboxes: mailboxes.map((m) => {
        const row = rows.find((r) => r.mailbox_local_id === m.id);
        return {
          mailbox_id: m.id,
          name: m.name,
          configured: row != null,
          timezone: row?.timezone ?? null,
          days: row ? (JSON.parse(row.days) as number[]) : null,
          start_minute: row?.start_minute ?? null,
          end_minute: row?.end_minute ?? null,
          first_response_target_min: row?.first_response_target_min ?? null,
          resolution_target_min: row?.resolution_target_min ?? null
        };
      })
    };
  });

  app.put('/api/settings/business-hours/:mailboxId', async (request, reply) => {
    const mailboxId = Number((request.params as { mailboxId: string }).mailboxId);
    if (!Number.isInteger(mailboxId) || mailboxId <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'mailboxId must be a positive integer.' });
      return;
    }
    const mailbox = ctx.referenceRepo.getMailboxes().find((m) => m.id === mailboxId);
    if (!mailbox) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Mailbox not found in the local mirror.' });
      return;
    }
    const parsed = businessHoursSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { ok: false, message: 'Invalid business hours: check timezone, days (0-6), and that the end time is after the start time.' };
    }
    if (!isValidTimezone(parsed.data.timezone)) {
      reply.code(422);
      return { ok: false, message: 'Unknown IANA timezone (e.g. America/New_York, Europe/Berlin, Asia/Kolkata).' };
    }
    ctx.docsRepo.setBusinessHours(mailboxId, {
      timezone: parsed.data.timezone,
      days: parsed.data.days,
      startMinute: parsed.data.start_minute,
      endMinute: parsed.data.end_minute,
      firstResponseTargetMin: parsed.data.first_response_target_min,
      resolutionTargetMin: parsed.data.resolution_target_min
    });
    ctx.jobsRepo.audit({ actor: 'user', action: 'business_hours_updated', after_state: { mailboxId, ...parsed.data } });
    return { ok: true, message: `Business hours saved for ${mailbox.name}. SLA reports now measure this mailbox in business minutes.` };
  });

  app.delete('/api/settings/business-hours/:mailboxId', async (request, reply) => {
    const mailboxId = Number((request.params as { mailboxId: string }).mailboxId);
    if (!Number.isInteger(mailboxId) || mailboxId <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'mailboxId must be a positive integer.' });
      return;
    }
    ctx.docsRepo.clearBusinessHours(mailboxId);
    return { ok: true, message: 'Business hours cleared - this mailbox falls back to wall-clock minutes in SLA reports.' };
  });

  app.patch('/api/settings/qdrant', async (request, reply) => {
    const body = (request.body ?? {}) as { url?: string; enabled?: boolean };
    if (body.url != null && !/^https?:\/\/\S+$/.test(body.url)) {
      reply.code(422);
      return { ok: false, message: 'Invalid Qdrant URL.' };
    }
    if (body.enabled != null && typeof body.enabled !== 'boolean') {
      reply.code(422);
      return { ok: false, message: 'Invalid Qdrant enabled flag.' };
    }
    ctx.settingsRepo.updateQdrant(body);
    ctx.qdrant.reconfigure(body);
    return { ok: true, message: 'Qdrant settings saved.' };
  });

  app.post('/api/settings/qdrant/test', async () => {
    const health = await ctx.qdrant.health();
    return {
      ok: health.connected,
      ...health,
      message: health.connected ? `Qdrant reachable at ${health.url} (${health.collections.length} collections).` : `Qdrant is not reachable at ${health.url}. Keyword search (FTS) remains fully functional without it.`
    };
  });

  // Appearance: available themes are handled client-side; expose display timezone list marker
  app.get('/api/settings/appearance', async () => {
    const tz = ctx.settingsRepo.get('display_timezone', 'system');
    return { display_timezone: tz, themes: ['light', 'dark'], default: 'light' };
  });

  // Backup endpoints
  app.get('/api/backups', async () => ({ backups: ctx.backup.listBackups(), exports: [] as string[] }));

  app.post('/api/backups/create', async () => {
    const result = ctx.backup.backup();
    ctx.jobsRepo.audit({ actor: 'user', action: 'backup_created', after_state: { path: result.path } });
    return result;
  });

  app.post('/api/backups/export-json', async () => ctx.backup.exportJson());
  app.post('/api/backups/export-csv', async () => ctx.backup.exportConversationsCsv());

  // Audit log
  app.get('/api/audit', async (request) => {
    const q = request.query as Record<string, string>;
    const convId = q.conversationId != null && q.conversationId !== '' ? Number(q.conversationId) : undefined;
    return { entries: ctx.jobsRepo.listAudit(Number.isFinite(convId) ? convId : undefined, clampInt(q.limit, 200, 1, 1000)) };
  });

  // Recent application errors
  app.get('/api/errors', async () => ({ errors: ctx.jobsRepo.listRecentErrors(50) }));
}
