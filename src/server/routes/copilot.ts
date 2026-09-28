import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { clampListParam } from './helpers.js';
import { copilotChatSchema } from '../../shared/schemas.js';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * Local Copilot routes (v1.9.0 / M3, plan Phase 15). All handlers validate
 * their bodies with zod (4xx on hostile input, never a 500) and the chat
 * endpoint reports honest 503s when AI is disabled or LM Studio is down -
 * the Copilot never pretends to work.
 */
export async function registerCopilotRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const copilot = () => ctx.copilot;

  app.get('/api/copilot/sessions', async (request) => {
    const q = request.query as Record<string, string>;
    return { sessions: copilot().listSessions(clampListParam(q.limit, 50, 1, 200)) };
  });

  app.get('/api/copilot/sessions/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Session id must be a positive integer.' });
      return;
    }
    const session = copilot().listSessions(200).find((s) => s.id === id);
    if (!session) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Copilot session not found.' });
      return;
    }
    return { session, messages: copilot().listMessages(id) };
  });

  app.post('/api/copilot/chat', async (request, reply) => {
    const body = copilotChatSchema.parse(request.body ?? {});
    if (!copilot().aiEnabled()) {
      reply.code(503).send({ statusCode: 503, error: 'ServiceUnavailable', message: 'AI is disabled in Settings. Enable LM Studio to use the Local Copilot.' });
      return;
    }
    if (body.conversationId != null) {
      const exists = ctx.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(body.conversationId);
      if (!exists) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
        return;
      }
    }
    // v1.9.0 audit fix: an unknown session is a CLIENT error (404), not a
    // service error - pre-validate instead of letting chat() throw a
    // service-shaped 503 for it.
    if (body.sessionId != null && !copilot().listSessions(200).some((s) => s.id === body.sessionId)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Copilot session not found.' });
      return;
    }
    try {
      const result = await copilot().chat({ question: body.question, conversationId: body.conversationId ?? null, sessionId: body.sessionId ?? null });
      return { ok: true, ...result };
    } catch (e) {
      const err = e instanceof LmStudioError ? e : null;
      reply.code(503).send({ statusCode: 503, error: 'ServiceUnavailable', message: err ? err.message : e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete('/api/copilot/sessions/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Session id must be a positive integer.' });
      return;
    }
    const deleted = copilot().deleteSession(id);
    if (!deleted) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Copilot session not found.' });
      return;
    }
    return { ok: true, message: 'Copilot session deleted.' };
  });

  app.get('/api/copilot/starter-questions/:conversationId', async (request, reply) => {
    const id = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Conversation id must be a positive integer.' });
      return;
    }
    const questions = copilot().starterQuestions(id);
    if (questions.length === 0) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { questions };
  });

  // Tools surfaced for transparency/debugging (read-only, definitions only).
  app.get('/api/copilot/tools', async () => {
    return {
      tools: ctx.toolRegistry.definitions().map((t) => ({ name: t.function.name, description: t.function.description })),
      note: 'The Copilot can only call these allowlisted read-only tools. No SQL is ever exposed to the model.'
    };
  });

  void z; // zod is used via copilotChatSchema; kept import-local for future inline schemas
}
