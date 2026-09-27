import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { replyRequestSchema, noteRequestSchema, statusRequestSchema, assignRequestSchema, tagsRequestSchema, fieldsRequestSchema, snoozeRequestSchema, scheduleRequestSchema, schedulePublishRequestSchema, bulkRequestSchema, subjectRequestSchema, moveToInboxRequestSchema } from '../../shared/schemas.js';
import { sanitizeThreadHtml } from '../security/sanitize.js';

function clampListParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value != null && value !== '' ? Number(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = ctx.conversationRepo;
  const ops = ctx.operations;

  // List conversations for inbox views
  app.get('/api/conversations', async (request) => {
    const q = request.query as Record<string, string>;
    const me = ctx.db.prepare('SELECT id FROM users WHERE remote_id = (SELECT json_extract(value, \'$\') FROM application_settings WHERE key=\'me_remote_id\')').get() as { id: number } | undefined;
    const view = q.view ?? 'active';
    let assigneeLocalId: number | null = null;
    if (view === 'my-tickets') {
      assigneeLocalId = me?.id ?? (ctx.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? null;
    }
    const page = clampListParam(q.page, 1, 1, 100000);
    const pageSize = clampListParam(q.pageSize, 50, 1, 200);
    const mailboxId = q.mailboxId != null && q.mailboxId !== '' ? Number(q.mailboxId) : null;
    const result = repo.listConversations({
      view,
      mailboxId: Number.isFinite(mailboxId) ? mailboxId : null,
      page,
      pageSize,
      assigneeLocalId,
      tag: q.tag ?? null
    });
    return { conversations: result.conversations, total: result.total, page, page_size: pageSize, view };
  });

  // Conversation detail with threads (sanitized HTML), customer summary, analysis, drafts
  app.get('/api/conversations/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const conv = repo.getConversationByLocalId(id);
    if (!conv) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found locally.' });
      return;
    }
    const summary = repo.toSummary(conv);
    const threads = repo.getThreads(id).map((t) => ({
      ...t,
      body_html: t.body_html ? sanitizeThreadHtml(t.body_html) : null
    }));
    const fields = ctx.db
      .prepare(
        `SELECT cf.field_local_id AS field_id, f.name, f.type, f.system_type, cf.value, cf.text_value, f.remote_id AS field_remote_id,
           (SELECT GROUP_CONCAT(o.id || ':' || o.label) FROM inbox_field_options o WHERE o.field_id = cf.field_local_id) AS options
         FROM conversation_fields cf JOIN inbox_fields f ON f.id = cf.field_local_id WHERE cf.conversation_id = ?`
      )
      .all(id) as { field_id: number; name: string; type: string; system_type: string | null; value: string | null; text_value: string | null; field_remote_id: number; options: string | null }[];
    const inboxFields = ctx.referenceRepo.getInboxFieldsForMailbox(conv.mailbox_local_id ?? 0);
    const customer = conv.customer_local_id ? ctx.peopleRepo.getCustomerByLocalId(conv.customer_local_id) ?? null : null;
    const customerHistory = conv.customer_local_id
      ? (ctx.db
          .prepare(
            `SELECT cv.id, cv.number, cv.subject, cv.status, cv.remote_created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.conversation_id = cv.id) AS thread_count
             FROM conversations cv WHERE cv.customer_local_id = ? AND cv.id != ? AND cv.deleted_at IS NULL ORDER BY cv.remote_created_at DESC LIMIT 10`
          )
          .all(conv.customer_local_id, id) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; thread_count: number }[])
      : [];
    const memories = conv.customer_local_id ? ctx.aiRepo.getMemories(conv.customer_local_id) : [];
    const drafts = ctx.aiRepo.getDraftsForConversation(id);
    const analysis = ctx.aiRepo.getLatestAnalysis(id);
    const audit = ctx.jobsRepo.listAudit(id, 50);
    const workflows = ctx.referenceRepo.getWorkflows().filter((w) => !w.mailbox_id || w.mailbox_id === conv.mailbox_local_id);
    const users = ctx.referenceRepo.getUsers();
    const teams = ctx.referenceRepo.getTeams();
    repo.setUnread(id, false);
    return {
      conversation: summary,
      threads,
      custom_fields: fields.map((f) => ({ ...f, options: (f.options ?? '').split(',').filter(Boolean).map((o) => { const [idStr, ...labelParts] = o.split(':'); return { id: Number(idStr), label: labelParts.join(':') }; }) })),
      inbox_fields: inboxFields,
      customer,
      customer_history: customerHistory,
      customer_memories: memories,
      ai_drafts: drafts,
      ai_analysis: analysis,
      audit,
      workflows,
      users,
      teams
    };
  });

  // Reply (send or draft) with duplicate-send protection
  app.post('/api/conversations/:id/reply', async (request, reply) => {
    const body = replyRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.sendReply(body);
    if (!result.ok) reply.code(result.message.includes('not connected') ? 503 : 422);
    return result;
  });

  // Internal note
  app.post('/api/conversations/:id/note', async (request, reply) => {
    const body = noteRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.addNote(body);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Status change
  app.post('/api/conversations/:id/status', async (request, reply) => {
    const body = statusRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.changeStatus(body.conversationId, body.status);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Assignment
  app.post('/api/conversations/:id/assign', async (request, reply) => {
    const body = assignRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.assign(body.conversationId, body.userId);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Subject
  app.post('/api/conversations/:id/subject', async (request, reply) => {
    const body = subjectRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.changeSubject(body.conversationId, body.subject);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Move to inbox
  app.post('/api/conversations/:id/move', async (request, reply) => {
    const body = moveToInboxRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.moveToInbox(body.conversationId, body.mailboxId);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Tags (merge semantics, never stale overwrite)
  app.post('/api/conversations/:id/tags', async (request, reply) => {
    const body = tagsRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.updateTags(body.conversationId, { add: body.add, remove: body.remove, set: body.set ?? undefined });
    if (!result.ok) reply.code(422);
    return result;
  });

  // Custom fields
  app.post('/api/conversations/:id/fields', async (request, reply) => {
    const body = fieldsRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.updateCustomFields(body.conversationId, body.fields.map((f) => ({ id: f.id, value: f.value ?? null })));
    if (!result.ok) reply.code(422);
    return result;
  });

  // Snooze / unsnooze
  app.post('/api/conversations/:id/snooze', async (request, reply) => {
    const body = snoozeRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.snooze(body.conversationId, body.snoozedUntil, body.unsnoozeOnCustomerReply);
    if (!result.ok) reply.code(422);
    return result;
  });
  app.delete('/api/conversations/:id/snooze', async (request, reply) => {
    const result = await ops.unsnooze(Number((request.params as { id: string }).id));
    if (!result.ok) reply.code(422);
    return result;
  });

  // Scheduled replies
  app.post('/api/conversations/:id/schedule', async (request, reply) => {
    const body = scheduleRequestSchema.parse({ ...(request.body as Record<string, unknown>), conversationId: Number((request.params as { id: string }).id) });
    const result = await ops.scheduleReply(body.conversationId, body.threadId, body.scheduledFor, body.unscheduleOnCustomerReply);
    if (!result.ok) reply.code(422);
    return result;
  });
  app.post('/api/conversations/:id/schedule/publish', async (request, reply) => {
    const body = schedulePublishRequestSchema.parse({ threadId: (request.body as { threadId?: number } | undefined)?.threadId });
    const result = await ops.publishSchedule(Number((request.params as { id: string }).id), body.threadId);
    if (!result.ok) reply.code(422);
    return result;
  });
  app.delete('/api/conversations/:id/schedule', async (request, reply) => {
    const body = schedulePublishRequestSchema.parse({ threadId: (request.body as { threadId?: number } | undefined)?.threadId });
    const result = await ops.deleteSchedule(Number((request.params as { id: string }).id), body.threadId);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Bulk actions (queued, confirmation required client-side)
  app.post('/api/conversations/bulk', async (request) => {
    const body = bulkRequestSchema.parse(request.body);
    return ops.bulkAction(body.conversationIds, body.action, body.params);
  });

  // Refresh single conversation from remote
  app.post('/api/conversations/:id/refresh', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const conv = repo.getConversationByLocalId(id);
    if (!conv?.remote_id) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found locally.' });
      return;
    }
    try {
      await ops.refreshOne(conv.remote_id);
      return { ok: true, message: 'Conversation refreshed from Help Scout.' };
    } catch (e) {
      return { ok: false, message: `Refresh failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  // Attachments
  app.post('/api/attachments/:id/download', async (request, reply) => {
    const result = await ops.downloadAttachment(Number((request.params as { id: string }).id), ctx.config.attachmentsPath);
    if (!result.ok) reply.code(422);
    return result;
  });

  // Run a Help Scout workflow on a conversation (distinct from local automation)
  app.post('/api/conversations/:id/workflow/:workflowId', async (request, reply) => {
    const result = await ops.runHelpScoutWorkflow(Number((request.params as { workflowId: string }).workflowId), Number((request.params as { id: string }).id));
    if (!result.ok) reply.code(422);
    return result;
  });

  // Reference data for the UI
  app.get('/api/mailboxes', async () => ctx.referenceRepo.getMailboxes());
  app.get('/api/tags', async () => ctx.referenceRepo.getTags());
  app.get('/api/users', async () => ({ users: ctx.referenceRepo.getUsers(), system_users: ctx.referenceRepo.getSystemUsers() }));
  app.get('/api/teams', async () => ctx.referenceRepo.getTeams());
  app.get('/api/users/statuses', async () => ctx.referenceRepo.getUserStatuses());
  app.get('/api/workflows', async () => ctx.referenceRepo.getWorkflows());
  app.get('/api/saved-replies', async (request) => {
    const q = request.query as Record<string, string>;
    if (q.q) return { saved_replies: ctx.referenceRepo.searchSavedReplies(q.q) };
    return { saved_replies: ctx.referenceRepo.getSavedReplies() };
  });
  app.get('/api/inbox-fields', async () => ctx.referenceRepo.getInboxFields());
  app.get('/api/webhook-configs', async () => ctx.referenceRepo.getWebhookConfigs());
}
