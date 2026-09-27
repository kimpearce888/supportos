import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { createViewRequestSchema, updateViewRequestSchema, viewDefinitionSchema, type ViewDefinition } from '../../shared/activity.js';
import { ViewEngine, ViewCompileError } from '../inbox/viewEngine.js';
import { resolveTimezone } from '../services/dateRange.js';

/**
 * Saved Inbox View routes (v1.7.0): CRUD + dry-run preview.
 *
 * Views are stored as structured condition trees (JSON) and compiled by the
 * ViewEngine at EVALUATION time - a view saved with "today" always means the
 * day it is opened. The dry-run endpoint exists so the builder UI can show
 * exactly what a definition matches BEFORE saving it.
 */
export async function registerViewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = ctx.inboxViewRepo;

  app.get('/api/inbox-views', async () => ({ views: repo.listViews() }));

  app.get('/api/inbox-views/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const view = repo.getView(id);
    if (!view) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Saved view not found.' });
      return;
    }
    return view;
  });

  app.post('/api/inbox-views', async (request, reply) => {
    const body = createViewRequestSchema.parse(request.body);
    // Compile-check at SAVE time: a definition that cannot be evaluated must
    // never be persisted (the user would only find out when opening the view).
    const tz = resolveTimezone(null, ctx.settingsRepo.get('display_timezone', 'system'));
    try {
      new ViewEngine(ctx.db, { timezone: tz }).compile(body.definition);
    } catch (e) {
      if (e instanceof ViewCompileError) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `View definition cannot be evaluated: ${e.message}` });
        return;
      }
      throw e;
    }
    const view = repo.createView({ name: body.name, description: body.description ?? null, definition: body.definition, sort_order: body.sort_order ?? 0, folder: body.folder ?? null });
    ctx.jobsRepo.audit({ actor: 'user', action: 'inbox_view_created', after_state: { view_id: view.id, name: view.name } });
    return { ok: true, message: `View '${view.name}' saved.`, view };
  });

  app.patch('/api/inbox-views/:id', async (request, reply) => {
    const body = updateViewRequestSchema.parse(request.body);
    const id = Number((request.params as { id: string }).id);
    if (body.definition !== undefined) {
      // Same save-time compile check as create.
      const tz = resolveTimezone(null, ctx.settingsRepo.get('display_timezone', 'system'));
      try {
        new ViewEngine(ctx.db, { timezone: tz }).compile(body.definition);
      } catch (e) {
        if (e instanceof ViewCompileError) {
          reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `View definition cannot be evaluated: ${e.message}` });
          return;
        }
        throw e;
      }
    }
    const view = repo.updateView(id, { name: body.name, description: body.description, definition: body.definition, sort_order: body.sort_order, folder: body.folder });
    if (!view) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Saved view not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'inbox_view_updated', after_state: { view_id: id, name: view.name, version: view.version } });
    return { ok: true, message: 'View updated.', view };
  });

  app.delete('/api/inbox-views/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const view = repo.getView(id);
    if (!view) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Saved view not found.' });
      return;
    }
    repo.deleteView(id);
    ctx.jobsRepo.audit({ actor: 'user', action: 'inbox_view_deleted', before_state: { view_id: id, name: view.name } });
    return { ok: true, message: `View '${view.name}' deleted.` };
  });

  // Dry-run: evaluate an UNSAVED definition and return the match count + notes
  // (the builder previews without persisting anything).
  app.post('/api/inbox-views/preview', async (request, reply) => {
    const raw = (request.body as { definition?: unknown; timezone?: unknown } | undefined) ?? {};
    const parsed = viewDefinitionSchema.safeParse(raw.definition);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: parsed.error.issues[0]?.message ?? 'Invalid view definition.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const tz = resolveTimezone(typeof raw.timezone === 'string' ? raw.timezone : null, ctx.settingsRepo.get('display_timezone', 'system'));
    try {
      const engine = new ViewEngine(ctx.db, {
        timezone: tz,
        resolveSlaConversationIds: (states) => ctx.sla.slaAlerts().alerts.filter((a) => states.includes(a.state as 'at_risk' | 'breached')).map((a) => a.conversation_id)
      });
      const compiled = engine.compile(parsed.data as ViewDefinition);
      const count = compiled.whereSql === '1=1'
        ? (ctx.db.prepare("SELECT COUNT(*) AS n FROM conversations c WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL").get() as { n: number }).n
        : (ctx.db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL AND (${compiled.whereSql})`).get(...compiled.params) as { n: number }).n;
      return { matched: count, notes: compiled.notes, timezone: tz };
    } catch (e) {
      if (e instanceof ViewCompileError) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: e.message });
        return;
      }
      throw e;
    }
  });
}
