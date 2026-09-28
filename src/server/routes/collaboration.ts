import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { SideThreadCreateSchema, SideThreadMessageSchema, SideThreadParticipantAddSchema } from '../../shared/collaboration.js';

/**
 * Side collaboration thread routes (v1.8.0, plan Phase 14) + the mention
 * directory for @autocomplete (plan Phase 13).
 *
 * Everything here is INTERNAL-ONLY local data: no route touches the Help
 * Scout provider, so nothing can ever become customer-visible. The acting
 * user is the connected Help Scout user (me_remote_id, first-user fallback)
 * - the same identity resolution as every other write path.
 *
 * Referential integrity is validated BEFORE any insert: Zod checks shape
 * (positive ints), these helpers check EXISTENCE, so an unknown user/team id
 * is a 422 - never an FK-constraint 500.
 */
function existingUserIds(ctx: AppContext, ids: number[]): number[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ctx.db.prepare(`SELECT id FROM users WHERE deleted_at IS NULL AND id IN (${placeholders})`).all(...ids) as { id: number }[];
  return rows.map((r) => Number(r.id));
}

function teamExists(ctx: AppContext, teamLocalId: number): boolean {
  return ctx.db.prepare('SELECT 1 AS x FROM teams WHERE deleted_at IS NULL AND id = ?').get(teamLocalId) != null;
}
export async function registerCollaborationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------------- side threads ----------------

  app.get('/api/conversations/:id/side-threads', async (request, reply) => {
    const conversationId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const exists = ctx.db.prepare('SELECT 1 AS x FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId);
    if (!exists) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { side_threads: ctx.sideThreads.listThreads(conversationId) };
  });

  app.post('/api/conversations/:id/side-threads', async (request, reply) => {
    const conversationId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const parsed = SideThreadCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: parsed.error.issues[0]?.message ?? 'Invalid side thread.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    // Existence checks: unknown participants/teams are 422, never FK 500s.
    const known = new Set(existingUserIds(ctx, parsed.data.participant_user_ids));
    if (known.size !== parsed.data.participant_user_ids.length) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'participant_user_ids contains unknown users.' });
      return;
    }
    if (parsed.data.team_local_id != null && !teamExists(ctx, parsed.data.team_local_id)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'team_local_id does not exist.' });
      return;
    }
    const actor = ctx.sideThreads.meUserLocalId();
    const created = ctx.sideThreads.createThread(conversationId, parsed.data, actor);
    if (!created) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { side_thread: created };
  });

  app.get('/api/side-threads/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const thread = ctx.sideThreads.getThread(id);
    if (!thread) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Side thread not found.' });
      return;
    }
    return { side_thread: thread };
  });

  app.post('/api/side-threads/:id/messages', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const parsed = SideThreadMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'body must be 1-8000 characters.' });
      return;
    }
    const actor = ctx.sideThreads.meUserLocalId();
    try {
      const { thread } = ctx.sideThreads.addMessage(id, parsed.data.body, actor);
      if (!thread) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Side thread not found.' });
        return;
      }
      return { side_thread: thread };
    } catch (e) {
      // Resolved threads reject new messages with 409, not 500.
      if (e instanceof Error && e.message.includes('resolved')) {
        reply.code(409).send({ statusCode: 409, error: 'Conflict', message: e.message });
        return;
      }
      throw e;
    }
  });

  app.post('/api/side-threads/:id/participants', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const parsed = SideThreadParticipantAddSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'user_local_ids must be a non-empty array (max 20).' });
      return;
    }
    const known = new Set(existingUserIds(ctx, parsed.data.user_local_ids));
    if (known.size !== new Set(parsed.data.user_local_ids).size) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'user_local_ids contains unknown users.' });
      return;
    }
    const thread = ctx.sideThreads.getThread(id);
    if (!thread) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Side thread not found.' });
      return;
    }
    const actor = ctx.sideThreads.meUserLocalId();
    const added = ctx.sideThreads.addParticipants(id, parsed.data.user_local_ids, actor);
    return { side_thread: ctx.sideThreads.getThread(id), added };
  });

  app.post('/api/side-threads/:id/resolve', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const actor = ctx.sideThreads.meUserLocalId();
    if (!ctx.sideThreads.setStatus(id, 'resolved', actor)) {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: 'Side thread not found or already resolved.' });
      return;
    }
    return { side_thread: ctx.sideThreads.getThread(id) };
  });

  app.post('/api/side-threads/:id/reopen', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const actor = ctx.sideThreads.meUserLocalId();
    if (!ctx.sideThreads.setStatus(id, 'open', actor)) {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: 'Side thread not found or already open.' });
      return;
    }
    return { side_thread: ctx.sideThreads.getThread(id) };
  });

  // ---------------- mention directory (@autocomplete) ----------------

  /** All mentionable identities for the note/side-thread composers. */
  app.get('/api/mention-directory', async () => {
    const users = (
      ctx.db.prepare('SELECT id, first_name, last_name, mention, email FROM users WHERE deleted_at IS NULL ORDER BY first_name, id').all() as {
        id: number; first_name: string | null; last_name: string | null; mention: string | null; email: string | null;
      }[]
    ).map((u) => ({
      user_local_id: u.id,
      display_name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || `user #${u.id}`,
      mention: u.mention
    }));
    const teams = (
      ctx.db.prepare('SELECT id, name FROM teams WHERE deleted_at IS NULL ORDER BY name').all() as { id: number; name: string }[]
    ).map((t) => ({ team_local_id: t.id, name: t.name }));
    return { users, teams };
  });
}
