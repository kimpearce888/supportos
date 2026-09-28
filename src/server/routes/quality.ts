import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { clampDaysParam } from './helpers.js';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * M5 quality routes (v2.1.0, plan phases 26, 27, 29): knowledge gap
 * candidates, post-resolution QA, conversation friction. All bodies are
 * zod-validated (422 on hostile input); AI-dependent endpoints report
 * honest 503s when AI is disabled; every response carries its own honesty
 * notes - the data explains itself.
 */
export async function registerQualityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const aiEnabled = (): boolean => ctx.settingsRepo.get('ai_enabled', true) === true;

  // ---------------- Phase 26: knowledge gap engine ----------------

  app.get('/api/knowledge/gaps', async () => {
    // v2.2.1 audit fix: GET no longer triggers a synchronous rebuild
    // (?rebuild=1 made heavy SQLite work fireable cross-site via <img> tags
    // since GETs are unmetered). Rebuilds go through the POST sibling, which
    // the UI already uses.
    return ctx.knowledgeGaps.report();
  });

  app.post('/api/knowledge/gaps/rebuild', async (request) => {
    const body = z.object({ days: z.number().int().min(1).max(3650).optional() }).parse(request.body ?? {});
    return ctx.knowledgeGaps.rebuild(body.days ?? 90);
  });

  app.get('/api/knowledge/gaps/candidates/:id/draft', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Candidate id must be a positive integer.' });
      return;
    }
    const draft = ctx.knowledgeGaps.draft(id);
    if (!draft) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Knowledge candidate not found.' });
      return;
    }
    return draft;
  });

  app.post('/api/knowledge/gaps/candidates/:id/decide', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Candidate id must be a positive integer.' });
      return;
    }
    const body = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(500).nullable().optional()
      })
      .parse(request.body ?? {});
    const candidate = ctx.knowledgeGaps.decide(id, body.decision, body.note ?? null, null);
    if (!candidate) {
      reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Candidate not found or already decided. Rebuild does not reset human decisions.'
      });
      return;
    }
    return { ok: true, candidate };
  });

  // ---------------- Phase 27: post-resolution QA ----------------

  app.get('/api/qa/overview', async () => ctx.qa.overview());

  app.post('/api/qa/rebuild', async () => ctx.qa.rebuild());

  app.get('/api/qa/:conversationId', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const exists = ctx.db.prepare('SELECT 1 AS x FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!exists) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    const qa = ctx.qa.get(id);
    const friction = ctx.friction.analyzeConversation(id);
    return { qa, friction };
  });

  app.post('/api/qa/:conversationId/analyze', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const exists = ctx.db.prepare('SELECT 1 AS x FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!exists) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    const body = z.object({ includeAi: z.boolean().optional() }).parse(request.body ?? {});
    if (body.includeAi === true && !aiEnabled()) {
      reply.code(503).send({
        statusCode: 503,
        error: 'ServiceUnavailable',
        message: 'AI is disabled in Settings. The deterministic QA layer works without it; enable LM Studio for the optional AI layer.'
      });
      return;
    }
    if (body.includeAi === true) {
      try {
        const result = await ctx.qa.computeAiLayer(id);
        if (result.error != null) {
          // The deterministic layer WAS computed and stored; the AI layer
          // honestly did not run. Signal the AI failure clearly.
          reply.code(503).send({
            statusCode: 503,
            error: 'ServiceUnavailable',
            message: `${result.error} The deterministic QA layer was computed and stored.`
          });
          return;
        }
        return { ok: true, qa: result.qa, ai: result.ai, error: null };
      } catch (e) {
        const err = e instanceof LmStudioError ? e : null;
        reply.code(503).send({
          statusCode: 503,
          error: 'ServiceUnavailable',
          message: err?.message ?? (e instanceof Error ? e.message : 'The local model request failed.')
        });
        return;
      }
    }
    const deterministic = ctx.qa.computeDeterministic(id);
    if (!deterministic) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { ok: true, qa: ctx.qa.get(id), ai: null, error: null };
  });

  // ---------------- Phase 29: conversation friction ----------------

  app.get('/api/friction/overview', async (request) => {
    const q = request.query as Record<string, string>;
    const days = clampDaysParam(q.days, 30, 1, 3650);
    // v2.2.1 audit fix: same as /api/knowledge/gaps - rebuild via POST only.
    return ctx.friction.overview(days);
  });

  app.post('/api/friction/rebuild', async () => ctx.friction.rebuild());

  app.get('/api/friction/:conversationId', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const exists = ctx.db.prepare('SELECT 1 AS x FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!exists) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { findings: ctx.friction.analyzeConversation(id) };
  });
}
