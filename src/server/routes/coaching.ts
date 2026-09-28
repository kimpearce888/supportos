import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { COACHING_CHECK_KINDS, COACHING_MAX_DRAFT_CHARS, COACHING_MAX_DRAFT_BYTES } from '../../shared/coaching.js';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * M6 coaching routes (v2.2.0, plan Phase 35): OPTIONAL, ADVISORY ONLY.
 * Nothing here is called by the send path - the agent explicitly asks for
 * a review. Hostile input is 422'd; AI-unavailable is an honest 503 that
 * still reports the deterministic layer was computed and stored.
 */
export async function registerCoachingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const aiEnabled = (): boolean => ctx.settingsRepo.get('ai_enabled', true) === true;

  app.get('/api/coaching/meta', async () => ({
    checks: COACHING_CHECK_KINDS,
    advisory_only: true,
    note: 'Coaching reviews drafts on request and never blocks, delays or modifies the send. Deterministic checks always run; the AI layer needs LM Studio.'
  }));

  app.get('/api/coaching/:conversationId', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const review = ctx.coaching.get(id);
    if (!review) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'No coaching review stored for this conversation yet.' });
      return;
    }
    return review;
  });

  app.post('/api/coaching/:conversationId/review', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const body = z
      .object({
        draft: z.string().min(1).max(COACHING_MAX_DRAFT_CHARS),
        includeAi: z.boolean().optional()
      })
      .parse(request.body ?? {});
    if (Buffer.byteLength(body.draft, 'utf8') > COACHING_MAX_DRAFT_BYTES) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `Draft exceeds ${COACHING_MAX_DRAFT_BYTES} bytes.` });
      return;
    }
    if (body.includeAi === true && !aiEnabled()) {
      reply.code(503).send({
        statusCode: 503,
        error: 'ServiceUnavailable',
        message: 'AI is disabled in Settings. The deterministic coaching checks work without it; enable LM Studio for the optional AI layer.'
      });
      return;
    }
    try {
      const result = await ctx.coaching.reviewDraft(id, body.draft, { includeAi: body.includeAi === true });
      if (!result.ok) {
        const code = result.code === 'not_found' ? 404 : 422;
        reply.code(code).send({
          statusCode: code,
          error: code === 404 ? 'NotFound' : 'ValidationError',
          message: result.code === 'not_found' ? 'Conversation not found.' : 'Draft is empty.'
        });
        return;
      }
      if (result.review.ai.error != null) {
        // Deterministic layer WAS computed and stored; the AI layer honestly
        // did not run. Signal the AI failure clearly but return the review.
        reply.header('x-ai-layer', 'unavailable');
      }
      return result.review;
    } catch (e) {
      if (e instanceof LmStudioError) {
        reply.code(503).send({
          statusCode: 503,
          error: 'ServiceUnavailable',
          message: `${e.message} The deterministic coaching checks were computed and stored.`
        });
        return;
      }
      throw e;
    }
  });
}
