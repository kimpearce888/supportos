import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';
import { SUPPORTED_LANGUAGES } from '../../shared/translation.js';

/**
 * M5 translation routes (v2.1.0, plan Phase 30). Detection is deterministic
 * and always available; translation requires the local model and reports an
 * honest 503 when AI is disabled or LM Studio is down - no cloud fallback
 * ever exists. Nothing here sends anything: translated drafts return for
 * side-by-side review, and sending still goes through the human write path.
 */
export async function registerTranslationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const aiEnabled = (): boolean => ctx.settingsRepo.get('ai_enabled', true) === true;

  app.get('/api/translation/meta', async () => ({
    languages: SUPPORTED_LANGUAGES,
    agent_language: ctx.translation.agentLanguage(),
    note: 'Detection is deterministic (script ranges + function words). Translation runs on the locally configured model only; nothing is ever sent automatically.'
  }));

  app.post('/api/translation/detect', async (request, reply) => {
    const body = z
      .object({
        texts: z.array(z.string().max(8000)).min(1).max(50)
      })
      .parse(request.body ?? {});
    if (body.texts.length === 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'texts must not be empty.' });
      return;
    }
    return { detections: ctx.translation.detect(body.texts) };
  });

  app.get('/api/translation/conversation/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const summary = ctx.translation.conversationLanguages(id);
    if (!summary) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return summary;
  });

  app.post('/api/translation/translate', async (request, reply) => {
    const body = z
      .object({
        text: z.string().min(1).max(8000),
        from: z.string().max(8).nullable().optional(),
        to: z.string().min(2).max(8),
        purpose: z.enum(['customer_inbound', 'agent_draft', 'general']).optional()
      })
      .parse(request.body ?? {});
    if (!SUPPORTED_LANGUAGES.some((l) => l.code === body.to)) {
      reply.code(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: `Unsupported target language. Supported: ${SUPPORTED_LANGUAGES.map((l) => l.code).join(', ')}.`
      });
      return;
    }
    if (!aiEnabled()) {
      reply.code(503).send({
        statusCode: 503,
        error: 'ServiceUnavailable',
        message: 'AI is disabled in Settings. Translation uses the local LM Studio model only - there is no cloud fallback, so translation is unavailable.'
      });
      return;
    }
    try {
      const result = await ctx.translation.translate({ text: body.text, from: body.from ?? null, to: body.to, purpose: body.purpose ?? 'general' });
      return { ok: true, ...result };
    } catch (e) {
      if (e instanceof LmStudioError) {
        reply.code(503).send({ statusCode: 503, error: 'ServiceUnavailable', message: e.message });
        return;
      }
      const message = e instanceof Error ? e.message : 'Translation failed.';
      // Known client-shaped errors are 422; anything else is honest 502.
      if (message.includes('Unsupported target') || message.includes('nothing to translate') || message.includes('could not be detected') || message.includes('Source and target')) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message });
        return;
      }
      reply.code(502).send({ statusCode: 502, error: 'BadGateway', message });
    }
  });
}
