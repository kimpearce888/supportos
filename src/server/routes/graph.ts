import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { GRAPH_NODE_KINDS, GRAPH_HUMAN_RELATIONS, type GraphNodeKind } from '../../shared/graph.js';

/**
 * M6 support graph routes (v2.2.0, plan Phase 34). Every parameter is
 * validated against closed unions (422 on hostile input); every derived
 * view is read-only; only support_graph_edges is writable, and only through
 * the explicit human-link endpoints below.
 */
const kindSchema = z.enum(GRAPH_NODE_KINDS);
const relationSchema = z.enum(GRAPH_HUMAN_RELATIONS);

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function registerGraphRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/graph/stats', async () => ctx.graph.stats());

  app.get('/api/graph/meta', async () => ({
    node_kinds: GRAPH_NODE_KINDS,
    human_relations: GRAPH_HUMAN_RELATIONS,
    notes: [
      'Derived edges are computed live from the local mirror; only human-asserted edges are stored.',
      'Connector rows have no derived links by design.'
    ]
  }));

  app.get('/api/graph/search', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const query = String(q.q ?? '');
    if (query.length > 200) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Search query too long (max 200 chars).' });
      return;
    }
    let kinds: GraphNodeKind[] | undefined;
    if (q.kinds != null && q.kinds.trim() !== '') {
      const parsed = z.array(kindSchema).safeParse(q.kinds.split(',').map((k) => k.trim()).filter(Boolean));
      if (!parsed.success) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Unknown node kind in kinds filter.' });
        return;
      }
      kinds = parsed.data;
    }
    return { results: ctx.graph.search(query, kinds) };
  });

  app.get('/api/graph/node/:kind/:id', async (request, reply) => {
    const params = request.params as { kind: string; id: string };
    const kindParsed = kindSchema.safeParse(params.kind);
    if (!kindParsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Unknown node kind.' });
      return;
    }
    const id = parseId(params.id);
    if (id == null) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Node id must be a positive integer.' });
      return;
    }
    const node = ctx.graph.node(kindParsed.data, id);
    if (!node) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Node not found.' });
      return;
    }
    const neighbors = ctx.graph.neighbors(kindParsed.data, id, { limit: 5 });
    return { node, edge_count: neighbors?.total_edges ?? 0 };
  });

  app.get('/api/graph/neighbors/:kind/:id', async (request, reply) => {
    const params = request.params as { kind: string; id: string };
    const q = request.query as Record<string, string>;
    const kindParsed = kindSchema.safeParse(params.kind);
    if (!kindParsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Unknown node kind.' });
      return;
    }
    const id = parseId(params.id);
    if (id == null) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Node id must be a positive integer.' });
      return;
    }
    const directionParsed = z.enum(['out', 'in', 'both']).safeParse(q.direction ?? 'both');
    if (!directionParsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'direction must be out, in or both.' });
      return;
    }
    const limitRaw = Number(q.limit ?? 200);
    if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > 200) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'limit must be between 1 and 200.' });
      return;
    }
    const result = ctx.graph.neighbors(kindParsed.data, id, { direction: directionParsed.data, limit: limitRaw });
    if (!result) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Node not found.' });
      return;
    }
    return result;
  });

  app.get('/api/graph/subgraph/:kind/:id', async (request, reply) => {
    const params = request.params as { kind: string; id: string };
    const q = request.query as Record<string, string>;
    const kindParsed = kindSchema.safeParse(params.kind);
    if (!kindParsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Unknown node kind.' });
      return;
    }
    const id = parseId(params.id);
    if (id == null) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Node id must be a positive integer.' });
      return;
    }
    const depth = Number(q.depth ?? 1);
    if (!Number.isInteger(depth) || depth < 1 || depth > 2) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'depth must be 1 or 2.' });
      return;
    }
    const result = ctx.graph.subgraph(kindParsed.data, id, { depth });
    if (!result) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Node not found.' });
      return;
    }
    return result;
  });

  app.get('/api/graph/edges', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    return ctx.graph.listHumanEdges(limit, offset);
  });

  app.post('/api/graph/edges', async (request, reply) => {
    const body = z
      .object({
        source_kind: kindSchema,
        source_local_id: z.number().int().min(1),
        target_kind: kindSchema,
        target_local_id: z.number().int().min(1),
        relation: relationSchema,
        note: z.string().max(500).nullable().optional()
      })
      .parse(request.body ?? {});
    const result = ctx.graph.linkHumanEdge({
      source_kind: body.source_kind,
      source_local_id: body.source_local_id,
      target_kind: body.target_kind,
      target_local_id: body.target_local_id,
      relation: body.relation,
      note: body.note ?? null,
      user_local_id: null
    });
    if (!result.ok) {
      const message =
        result.code === 'source_not_found' ? 'Source node not found.' :
        result.code === 'target_not_found' ? 'Target node not found.' :
        result.code === 'self_edge' ? 'A node cannot be linked to itself.' :
        'This edge already exists (duplicate).';
      reply.code(result.code === 'duplicate' || result.code === 'self_edge' ? 409 : 404).send({
        statusCode: result.code === 'duplicate' || result.code === 'self_edge' ? 409 : 404,
        error: result.code === 'duplicate' || result.code === 'self_edge' ? 'Conflict' : 'NotFound',
        message
      });
      return;
    }
    return { ok: true, edge: result.edge };
  });

  app.delete('/api/graph/edges/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id == null) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Edge id must be a positive integer.' });
      return;
    }
    if (!ctx.graph.unlinkHumanEdge(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Human edge not found.' });
      return;
    }
    return { ok: true };
  });
}
