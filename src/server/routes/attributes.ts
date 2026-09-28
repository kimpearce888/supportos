import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { clampListParam } from './helpers.js';
import { AI_ATTRIBUTE_CATALOG, AI_ATTRIBUTE_KEYS } from '../../shared/constants.js';

const recomputeSchema = z.object({ force: z.boolean().optional() }).default({});

/**
 * General AI Attribute Layer routes (v1.9.0 / M3, plan Phase 16):
 * snapshot per conversation, version history, searchable conversation lists,
 * aggregate distributions (reportable), and manual recompute. The catalog
 * endpoint powers every filter UI (Views / automation / segments).
 */
export async function registerAttributeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const service = () => ctx.attributes;

  app.get('/api/attributes/catalog', async () => ({
    catalog: AI_ATTRIBUTE_CATALOG,
    schema_version: 'attributes_v1',
    note: 'A missing attribute reads as unknown - it is never fabricated. Attributes are local-only and never written to Help Scout.'
  }));

  app.get('/api/attributes/conversation/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const snapshot = service().snapshot(id);
    if (!snapshot) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return snapshot;
  });

  app.get('/api/attributes/conversation/:id/history/:attribute', async (request, reply) => {
    const p = request.params as { id: string; attribute: string };
    const id = Number(p.id);
    const attribute = p.attribute;
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    if (!(AI_ATTRIBUTE_KEYS as readonly string[]).includes(attribute)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `Unknown attribute '${attribute}'. Use /api/attributes/catalog for the closed list.` });
      return;
    }
    const q = request.query as Record<string, string>;
    return { history: service().repo().history(id, attribute as (typeof AI_ATTRIBUTE_KEYS)[number], clampListParam(q.limit, 50, 1, 200)) };
  });

  // Searchable: conversations matching an attribute test (drill-down lists).
  app.get('/api/attributes/conversations', async (request) => {
    const q = request.query as Record<string, string>;
    const attribute = String(q.attribute ?? '');
    if (!(AI_ATTRIBUTE_KEYS as readonly string[]).includes(attribute)) {
      return { attribute, op: null, value: null, conversations: [], note: `Unknown attribute '${attribute}'. Use /api/attributes/catalog.` };
    }
    const def = AI_ATTRIBUTE_CATALOG.find((d) => d.key === attribute)!;
    const opRaw = String(q.op ?? 'equals');
    const allowedOps = def.value_type === 'number' ? ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'unknown'] : ['equals', 'not_equals', 'contains', 'unknown'];
    const op = (allowedOps.includes(opRaw) ? opRaw : 'equals') as 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'unknown';
    const value = String(q.value ?? '').slice(0, 120);
    return {
      attribute,
      op,
      value,
      conversations: service().repo().conversationsMatching(attribute, op, value, clampListParam(q.limit, 25, 1, 200))
    };
  });

  // Reportable: distribution + honest coverage per attribute.
  app.get('/api/attributes/report', async () => ({ distributions: service().repo().distributions() }));

  // Distinct values for filter autocomplete.
  app.get('/api/attributes/values/:attribute', async (request, reply) => {
    const attribute = String((request.params as { attribute: string }).attribute);
    if (!(AI_ATTRIBUTE_KEYS as readonly string[]).includes(attribute)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `Unknown attribute '${attribute}'.` });
      return;
    }
    const q = request.query as Record<string, string>;
    return { attribute, values: service().repo().distinctValues(attribute, clampListParam(q.limit, 50, 1, 200)) };
  });

  // Manual recompute (deterministic always; AI when enabled + reachable).
  app.post('/api/attributes/conversation/:id/recompute', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const body = recomputeSchema.parse(request.body ?? {});
    try {
      const snapshot = await service().compute(id, { force: body.force });
      ctx.jobsRepo.audit({ actor: 'user', action: 'attributes_recomputed', ai_involvement: true, conversation_id: id });
      return { ok: true, snapshot };
    } catch (e) {
      if (e instanceof Error && e.message === 'Conversation not found') {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
        return;
      }
      reply.code(503).send({ statusCode: 503, error: 'ServiceUnavailable', message: e instanceof Error ? e.message : String(e) });
    }
  });

  void z;
}
