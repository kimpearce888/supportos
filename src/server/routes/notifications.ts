import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { NOTIFICATION_TYPES, NotificationPrefsUpdateSchema, MarkReadSchema, type NotificationType } from '../../shared/collaboration.js';
import { clampListParam } from './helpers.js';

/**
 * Notification Center routes (v1.8.0, plan Phase 12) + the "mentions for me"
 * queue (plan Phase 13).
 *
 * "Me" resolution matches the rest of the app (my-tickets view): the
 * connected Help Scout user (me_remote_id), falling back to the first
 * synced user. Broadcast notifications (target NULL) are visible to me.
 */
export async function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/notifications', async (request) => {
    const q = request.query as Record<string, string>;
    const me = ctx.notificationSweep.meUserLocalId();
    const type = q.type && (NOTIFICATION_TYPES as readonly string[]).includes(q.type) ? (q.type as NotificationType) : null;
    const result = ctx.notificationRepo.list({
      meUserLocalId: me,
      unreadOnly: q.unreadOnly === 'true' || q.unreadOnly === '1',
      type,
      limit: clampListParam(q.limit, 50, 1, 200),
      offset: clampListParam(q.offset, 0, 0, 100000)
    });
    return result;
  });

  app.get('/api/notifications/unread-count', async () => {
    const me = ctx.notificationSweep.meUserLocalId();
    return { unread: ctx.notificationRepo.unreadCount(me) };
  });

  app.post('/api/notifications/:id/read', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'id must be a positive integer.' });
      return;
    }
    const parsed = MarkReadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Body must be { read: boolean }.' });
      return;
    }
    const me = ctx.notificationSweep.meUserLocalId();
    const ok = ctx.notificationRepo.markRead(id, me, parsed.data.read);
    if (!ok) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Notification not found (or not visible to you).' });
      return;
    }
    return { unread: ctx.notificationRepo.unreadCount(me) };
  });

  app.post('/api/notifications/read-all', async () => {
    const me = ctx.notificationSweep.meUserLocalId();
    const marked = ctx.notificationRepo.markAllRead(me);
    return { marked, unread: ctx.notificationRepo.unreadCount(me) };
  });

  app.get('/api/notifications/prefs', async () => ({ prefs: ctx.notificationRepo.listPrefs() }));

  app.put('/api/notifications/prefs/:type', async (request, reply) => {
    const type = String((request.params as { type: string }).type);
    if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `type must be one of: ${NOTIFICATION_TYPES.join(', ')}.` });
      return;
    }
    const parsed = NotificationPrefsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Body must be { enabled: boolean }.' });
      return;
    }
    ctx.notificationRepo.setPref(type as NotificationType, parsed.data.enabled);
    return { prefs: ctx.notificationRepo.listPrefs() };
  });

  /**
   * "Mentions for me" queue (plan Phase 13): two honest sources merged -
   * mention notifications (internal notes, from the sweep) and side-thread
   * mention rows (created at message time). Both link back to the
   * conversation.
   */
  app.get('/api/notifications/mentions', async () => {
    const me = ctx.notificationSweep.meUserLocalId();
    if (me == null) return { me: null, notifications: [], side_thread_mentions: [] };
    const notifications = ctx.notificationRepo.mentionsForMe(me);
    const sideThreadMentions = ctx.sideThreadRepo.mentionsForUser(me);
    return { me, notifications, side_thread_mentions: sideThreadMentions.map((m) => ({
      message_id: m.message.id,
      thread_id: m.thread_id,
      thread_title: m.thread_title,
      conversation_id: m.conversation_id,
      conversation_number: m.conversation_number,
      author: [m.message.author_first_name, m.message.author_last_name].filter(Boolean).join(' ') || null,
      body: m.message.body,
      created_at: m.message.created_at
    })) };
  });

  /** Manual sweep trigger (tests, demo, and "check now" in the UI). */
  app.post('/api/notifications/sweep', async () => {
    const result = ctx.notificationSweep.sweep();
    return { created: result.created };
  });
}
