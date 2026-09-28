import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { clampListParam } from './helpers.js';
import { customObjectTypeCreateSchema, customObjectTypePatchSchema, customObjectCreateSchema, customObjectPatchSchema, CUSTOM_OBJECT_LINK_TARGETS } from '../../shared/workspace.js';

/**
 * Custom object routes (plan Phase 21). Types define typed fields; values
 * are JSON validated by a dynamic Zod schema built from those definitions -
 * user-defined data never becomes SQL. 422 (not 500) on validation
 * failures; 404 on missing entities; closed target-kind vocabulary.
 */
export async function registerCustomObjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = () => ctx.customObjects;

  app.get('/api/custom-objects/types', async () => {
    return { types: repo().listTypes() };
  });

  app.post('/api/custom-objects/types', async (request, reply) => {
    const parsed = customObjectTypeCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    try {
      const created = repo().createType(parsed.data);
      ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_type_created', after_state: { id: created.id, slug: created.slug } });
      return { ok: true, type: repo().getType(created.id) };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/api/custom-objects/types/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const type = repo().getType(id);
    if (!type) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Type not found.' });
      return;
    }
    return { type };
  });

  app.patch('/api/custom-objects/types/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = customObjectTypePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    try {
      repo().patchType(id, parsed.data);
      ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_type_updated', after_state: { id } });
      return { ok: true, type: repo().getType(id) };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.delete('/api/custom-objects/types/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const deleted = repo().deleteType(id);
      if (!deleted) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Type not found.' });
        return;
      }
      ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_type_deleted', before_state: { id } });
      return { ok: true, message: 'Type deleted.' };
    } catch (e) {
      reply.code(409);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/api/custom-objects', async (request) => {
    const q = request.query as Record<string, string>;
    const typeId = Number(q.typeId);
    const result = repo().listObjects({
      typeId: Number.isInteger(typeId) && typeId > 0 ? typeId : undefined,
      query: (q.q ?? '').slice(0, 120),
      limit: clampListParam(q.pageSize, 50, 1, 200),
      offset: (clampListParam(q.page, 1, 1, 100000) - 1) * clampListParam(q.pageSize, 50, 1, 200)
    });
    return { objects: result.objects, total: result.total };
  });

  app.post('/api/custom-objects', async (request, reply) => {
    const parsed = customObjectCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    try {
      const object = repo().createObject(parsed.data);
      ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_created', after_state: { id: object.id, type_id: object.type_id, title: object.title } });
      return { ok: true, object };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/api/custom-objects/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const object = repo().getObject(id);
    if (!object) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Object not found.' });
      return;
    }
    return { object };
  });

  app.patch('/api/custom-objects/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = customObjectPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    try {
      const object = repo().patchObject(id, parsed.data);
      if (!object) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Object not found.' });
        return;
      }
      ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_updated', after_state: { id } });
      return { ok: true, object };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.delete('/api/custom-objects/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const deleted = repo().deleteObject(id);
    if (!deleted) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Object not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'custom_object_deleted', before_state: { id } });
    return { ok: true, message: 'Object deleted.' };
  });

  app.post('/api/custom-objects/:id/links', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = customObjectPatchSchema.pick({ links: true }).safeParse(request.body ?? {});
    if (!parsed.success || !parsed.data.links || parsed.data.links.length !== 1) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Body must be { links: [{ targetKind, targetLocalId, note? }] }.' });
      return;
    }
    if (!repo().getObject(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Object not found.' });
      return;
    }
    try {
      repo().addLink(id, parsed.data.links[0]!.targetKind, parsed.data.links[0]!.targetLocalId, parsed.data.links[0]!.note ?? null);
      return { ok: true, object: repo().getObject(id) };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.delete('/api/custom-objects/:id/links/:targetKind/:targetLocalId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const params = request.params as { targetKind: string; targetLocalId: string };
    if (!CUSTOM_OBJECT_LINK_TARGETS.includes(params.targetKind as never)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Unknown link target kind.' });
      return;
    }
    const removed = repo().removeLink(id, params.targetKind as never, Number(params.targetLocalId));
    return { ok: true, removed };
  });

  /** Reverse lookup: objects linked to a customer/org/conversation/... */
  app.get('/api/custom-objects/for/:targetKind/:targetId', async (request, reply) => {
    const params = request.params as { targetKind: string; targetId: string };
    if (!CUSTOM_OBJECT_LINK_TARGETS.includes(params.targetKind as never)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Unknown link target kind.' });
      return;
    }
    const objects = repo().objectsForTarget(params.targetKind as never, Number(params.targetId), 50);
    return { objects };
  });

  app.get('/api/custom-objects/report', async () => {
    return { report: repo().report() };
  });
}
