import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { replyRequestSchema, noteRequestSchema, statusRequestSchema, assignRequestSchema, tagsRequestSchema, fieldsRequestSchema, snoozeRequestSchema, scheduleRequestSchema, schedulePublishRequestSchema, bulkRequestSchema, subjectRequestSchema, moveToInboxRequestSchema } from '../../shared/schemas.js';
import { sanitizeThreadHtml } from '../security/sanitize.js';
import { inboxFilterQuerySchema, setPriorityRequestSchema, setStateRequestSchema, ACTIVITY_FIELD_COLUMN } from '../../shared/activity.js';
import { isConversationOpsTile, tileFragment } from '../operations/tileFragments.js';
import { resolveDateRange, resolveTimezone, formatAgeMinutes } from '../services/dateRange.js';
import { responseStateOf, responseAgesOf } from '../inbox/responseState.js';
import { ViewEngine, ViewCompileError } from '../inbox/viewEngine.js';
import { ViewDefinition } from '../../shared/activity.js';

function clampListParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value != null && value !== '' ? Number(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = ctx.conversationRepo;
  const ops = ctx.operations;

  // List conversations for inbox views
  app.get('/api/conversations', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const me = ctx.db.prepare('SELECT id FROM users WHERE remote_id = (SELECT json_extract(value, \'$\') FROM application_settings WHERE key=\'me_remote_id\')').get() as { id: number } | undefined;
    const view = q.view ?? 'active';
    let assigneeLocalId: number | null = null;
    if (view === 'my-tickets') {
      assigneeLocalId = me?.id ?? (ctx.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? null;
    }
    const page = clampListParam(q.page, 1, 1, 100000);
    // v1.6.0 audit fix: the route used to accept pageSize up to 200 while the
    // repo silently capped at 100 - paging at 150/200 skipped rows without any
    // signal. Both layers now agree on 100.
    const pageSize = clampListParam(q.pageSize, 50, 1, 100);
    const mailboxId = q.mailboxId != null && q.mailboxId !== '' ? Number(q.mailboxId) : null;
    // Channel filter (v1.3.0): 'email' or 'chat' (Beacon sessions); other values -> 422.
    let channel: 'email' | 'chat' | null = null;
    if (q.channel != null && q.channel !== '') {
      if (q.channel !== 'email' && q.channel !== 'chat') {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: "channel must be 'email' or 'chat'." });
        return;
      }
      channel = q.channel;
    }

    // ---- v1.7.0 activity/date/state filters (Zod-validated) ----
    const parsed = inboxFilterQuerySchema.safeParse(q);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: parsed.error.issues[0]?.message ?? 'Invalid filter parameters.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const f = parsed.data;
    const notes: string[] = [];
    let activityColumn: string | null = null;
    let activityFrom: string | null = null;
    let activityTo: string | null = null;
    if (f.activityField && f.dateMode) {
      const tz = resolveTimezone(f.timezone ?? null, ctx.settingsRepo.get('display_timezone', 'system'));
      const range = resolveDateRange({
        mode: f.dateMode,
        timezone: tz,
        from: f.from ?? null,
        to: f.to ?? null,
        fromTime: f.fromTime ?? null,
        toTime: f.toTime ?? null
      });
      if (!range) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `dateMode '${f.dateMode}' requires valid from/to dates (YYYY-MM-DD).` });
        return;
      }
      activityColumn = ACTIVITY_FIELD_COLUMN[f.activityField];
      activityFrom = range.from;
      activityTo = range.to;
      notes.push(`Date filter '${f.activityField}' = ${range.label} (${range.kind} boundaries, ${tz}).`);
    }

    // Saved view (dynamic: conditions compiled at open time)
    let extraWhere: string | null = null;
    let extraParams: unknown[] = [];
    // v1.8.0 Operations Center drill-down (?ops=<tileKey>): the SAME whitelisted
    // fragment the tile count uses, so a tile can never disagree with its list.
    if (f.ops != null && f.ops !== '') {
      if (!isConversationOpsTile(f.ops)) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `ops must be one of: unassigned, needs_first_response, customer_waiting, waiting_over_threshold, urgent, high_effort, repeated_issue, known_issue, ai_escalation.` });
        return;
      }
      const threshold = ctx.operationsCenter.waitingThresholdMinutes();
      const frag = tileFragment(f.ops, threshold);
      extraWhere = frag.whereSql;
      extraParams = frag.params;
      notes.push(`Operations Center tile '${f.ops}' applied.`);
    }
    if (f.savedViewId != null) {
      const saved = ctx.inboxViewRepo.getView(Number(f.savedViewId));
      if (!saved) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Saved view not found.' });
        return;
      }
      const tz = resolveTimezone(f.timezone ?? null, ctx.settingsRepo.get('display_timezone', 'system'));
      try {
        const engine = new ViewEngine(ctx.db, { timezone: tz, resolveSlaConversationIds: (states) => ctx.sla.slaAlerts().alerts.filter((a) => states.includes(a.state as 'at_risk' | 'breached')).map((a) => a.conversation_id) });
        const compiled = engine.compile(saved.definition as ViewDefinition);
        extraWhere = compiled.whereSql === '1=1' ? null : compiled.whereSql;
        extraParams = compiled.params;
        notes.push(`Saved view '${saved.name}' (v${saved.version}) applied.`, ...compiled.notes);
      } catch (e) {
        if (e instanceof ViewCompileError) {
          reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `Saved view '${saved.name}' could not be evaluated: ${e.message}` });
          return;
        }
        throw e;
      }
    }

    // v1.9.0 (M3): live AI-attribute filter (plan Phase 16 "filterable").
    // Compiled by the SAME viewEngine path as saved views - one implementation,
    // closed key catalog, bound parameters. Composable with ops/saved views.
    if (f.aiAttribute != null) {
      if (f.aiAttrValue == null || f.aiAttrValue === '') {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: "aiAttribute requires aiAttrValue (use 'unknown' to find tickets without a value)." });
        return;
      }
      const engine = new ViewEngine(ctx.db, { timezone: 'UTC', resolveSlaConversationIds: () => [] });
      try {
        const compiled = engine.compile({
          combinator: 'all',
          conditions: [{ kind: 'ai_attribute', attribute: f.aiAttribute, op: f.aiAttrOp ?? 'equals', value: f.aiAttrValue }]
        });
        const fragSql = compiled.whereSql === '1=1' ? null : compiled.whereSql;
        if (fragSql != null) {
          extraWhere = extraWhere != null ? `(${extraWhere}) AND (${fragSql})` : fragSql;
          extraParams = [...extraParams, ...compiled.params];
        }
        notes.push(`AI attribute filter: ${f.aiAttribute} ${f.aiAttrOp ?? 'equals'} "${f.aiAttrValue}" (local layer; missing values read as unknown).`);
      } catch (e) {
        if (e instanceof ViewCompileError) {
          reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `AI attribute filter rejected: ${e.message}` });
          return;
        }
        throw e;
      }
    }

    const result = repo.listConversations({
      view,
      mailboxId: Number.isFinite(mailboxId) ? mailboxId : null,
      channel,
      page,
      pageSize,
      assigneeLocalId,
      tag: q.tag ?? null,
      activityColumn,
      activityFrom,
      activityTo,
      responseState: f.responseState ?? null,
      priority: f.priority ?? null,
      ticketStateId: f.ticketStateId != null ? Number(f.ticketStateId) : null,
      extraWhere,
      extraParams,
      sort: f.sort ?? undefined
    });
    return { conversations: result.conversations, total: result.total, page, page_size: pageSize, view, notes };
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
    // v1.7.0: activity intelligence on the detail payload (the full event
    // timeline is served by /api/conversations/:id/events)
    const ticketState = ctx.ticketStateRepo.getConversationState(id);
    const stateHistory = ctx.ticketStateRepo.listTransitions(id, 50);
    const stateLifecycle = ctx.ticketStateRepo.stateLifecycle(id);
    const responseState = responseStateOf({
      status: conv.status,
      snoozed_until: conv.snoozed_until ?? null,
      first_customer_message_at: conv.first_customer_message_at ?? null,
      first_response_at: conv.first_response_at ?? null,
      last_customer_reply_at: conv.last_customer_reply_at ?? null,
      last_human_agent_response_at: conv.last_human_agent_response_at ?? null,
      activity_history_complete: conv.activity_history_complete ?? 0
    });
    const ages = responseAgesOf({
      remote_created_at: conv.remote_created_at,
      first_response_at: conv.first_response_at ?? null,
      last_customer_reply_at: conv.last_customer_reply_at ?? null,
      last_human_agent_response_at: conv.last_human_agent_response_at ?? null,
      customer_waiting_since: conv.customer_waiting_since ?? null,
      closed_at: conv.closed_at
    });
    const agesHuman: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(ages)) agesHuman[k] = formatAgeMinutes(v);
    const eventCounts = ctx.activityRepo.eventCounts(id);
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
      teams,
      activity: {
        response_state: responseState,
        ages_minutes: ages,
        ages_human: agesHuman,
        event_counts: eventCounts,
        history_complete: (conv.activity_history_complete ?? 0) === 1,
        ticket_state: ticketState,
        state_history: stateHistory,
        state_lifecycle: stateLifecycle
      },
      ticket_states: ctx.ticketStateRepo.listStates()
    };
  });

  // v1.7.0: full event timeline for a conversation (paged, filterable by type)
  app.get('/api/conversations/:id/events', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const conv = repo.getConversationByLocalId(id);
    if (!conv) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found locally.' });
      return;
    }
    const q = request.query as Record<string, string>;
    const limit = clampListParam(q.limit, 200, 1, 1000);
    const events = ctx.activityRepo.listEvents(id, limit);
    return { conversation_id: id, events, counts: ctx.activityRepo.eventCounts(id) };
  });

  // v1.7.0: set local SupportOS priority (optional HS custom-field mapping)
  app.post('/api/conversations/:id/priority', async (request, reply) => {
    const body = setPriorityRequestSchema.parse(request.body);
    const result = await ops.setPriority(Number((request.params as { id: string }).id), body.priority);
    if (!result.ok) reply.code(422);
    return result;
  });

  // v1.7.0: set SupportOS custom ticket state (records transition history)
  app.post('/api/conversations/:id/state', async (request, reply) => {
    const body = setStateRequestSchema.parse(request.body);
    const id = Number((request.params as { id: string }).id);
    const conv = repo.getConversationByLocalId(id);
    if (!conv) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found locally.' });
      return;
    }
    const result = ctx.ticketStateRepo.setState({ conversationLocalId: id, newStateId: body.stateId, reason: body.reason ?? null, actorType: 'user' });
    if (!result.ok) reply.code(422);
    else ctx.jobsRepo.audit({ actor: 'user', action: 'ticket_state_changed', conversation_id: id, before_state: { state_id: result.previousStateId }, after_state: { state_id: body.stateId, reason: body.reason ?? null } });
    return result;
  });

  // v1.7.0: ticket state definitions (CRUD) + lifecycle metrics
  app.get('/api/ticket-states', async () => ({ states: ctx.ticketStateRepo.listStates(), bottlenecks: ctx.ticketStateRepo.stateBottlenecks() }));
  app.post('/api/ticket-states', async (request, reply) => {
    const { createStateRequestSchema } = await import('../../shared/activity.js');
    const body = createStateRequestSchema.parse(request.body);
    try {
      const state = ctx.ticketStateRepo.createState(body);
      return { ok: true, message: `State '${state.name}' created.`, state };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
  app.patch('/api/ticket-states/:id', async (request, reply) => {
    const { updateStateRequestSchema } = await import('../../shared/activity.js');
    const body = updateStateRequestSchema.parse(request.body);
    const id = Number((request.params as { id: string }).id);
    try {
      const state = ctx.ticketStateRepo.updateState(id, body);
      if (!state) {
        reply.code(404);
        return { ok: false, message: 'State not found.' };
      }
      return { ok: true, message: 'State updated.', state };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
  app.delete('/api/ticket-states/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const result = ctx.ticketStateRepo.deleteState(id);
    if (!result.ok) reply.code(422);
    return result;
  });

  // v1.7.0: rebuild the activity engine from the thread mirror (admin; idempotent)
  app.post('/api/conversations/activity/rebuild', async () => {
    const result = ctx.activityRepo.rebuildAll();
    ctx.jobsRepo.audit({ actor: 'user', action: 'activity_rebuild', after_state: result });
    return { ok: true, message: `Rebuilt activity history for ${result.conversations} conversation(s); ${result.events_inserted} new event(s) derived.`, data: result };
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
