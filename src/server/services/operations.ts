import type { DB } from '../database/connection.js';
import type { HelpScoutProvider } from '../integrations/helpscout/provider.js';
import { HelpScoutApiError } from '../integrations/helpscout/client.js';
import { ConversationRepository } from '../database/repositories/conversationRepo.js';
import { ReferenceRepository } from '../database/repositories/referenceRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import crypto from 'node:crypto';

export interface OperationResult<T = unknown> {
  ok: boolean;
  message: string;
  detail?: string;
  data?: T;
}

/**
 * ConversationOperations (spec #17, #19, #66, #141, #142):
 * every remote mutation follows write protection:
 *   validate -> verify auth -> obtain CURRENT remote state -> compute desired
 *   -> perform -> confirm -> persist local state -> audit.
 * Tag/field updates are fresh-read-merge-write (never stale-state overwrite).
 * Replies are durable, idempotency-keyed, and never blindly retried.
 */
export class ConversationOperations {
  private conv: ConversationRepository;
  private ref: ReferenceRepository;
  private jobs: JobRepository;
  private settings: SettingsRepository;
  private ai: AiRepository;

  constructor(
    private db: DB,
    private provider: HelpScoutProvider
  ) {
    this.conv = new ConversationRepository(db);
    this.ref = new ReferenceRepository(db);
    this.jobs = new JobRepository(db);
    this.settings = new SettingsRepository(db);
    this.ai = new AiRepository(db);
  }

  private requireAuth(): { ok: false; message: string } | null {
    if (this.provider.kind === 'fake') return null; // demo mode always "authenticated"
    const tokens = this.settings.getOAuthTokens();
    if (!tokens.access_token || tokens.revoked) {
      return { ok: false, message: 'Help Scout is not connected. Remote actions are disabled - connect Help Scout in Settings first.' };
    }
    return null;
  }

  // ============================================================ Reply / note

  async sendReply(input: { conversationId: number; text: string; draft: boolean; cc: string[]; bcc: string[]; statusAfter?: string | null; assignTo?: number | null; aiDraftId?: number | null; originalAiText?: string | null }): Promise<OperationResult<{ threadRemoteId: number }>> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(input.conversationId);
    if (!conv || !conv.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    if (conv.merged_into_conversation_id) return { ok: false, message: 'This conversation was merged into another conversation. Open the target conversation to reply.' };

    const idempotencyKey = `reply:${conv.remote_id}:${crypto.createHash('sha256').update(input.text).digest('hex').slice(0, 24)}`;
    const existing = this.db.prepare('SELECT id, status FROM outbound_jobs WHERE idempotency_key = ?').get(idempotencyKey) as { id: number; status: string } | undefined;
    if (existing && existing.status !== 'failed') {
      return { ok: false, message: 'This exact reply was already sent (duplicate-send protection). Check the conversation history before sending again.' };
    }

    const jobId = this.jobs.createOutboundJob('create_reply', { conversationId: input.conversationId, text: input.text, draft: input.draft, cc: input.cc, bcc: input.bcc, statusAfter: input.statusAfter, assignTo: input.assignTo }, { conversationId: input.conversationId, idempotencyKey });
    const before = { status: conv.status };
    const started = Date.now();
    try {
      this.jobs.setOutboundStatus(jobId, 'sending');
      const res = await this.provider.createReplyThread({
        conversationId: conv.remote_id,
        text: input.text,
        draft: input.draft,
        cc: input.cc,
        bcc: input.bcc,
        statusAfter: (input.statusAfter as never) ?? null,
        assignTo: input.assignTo ?? null
      });
      this.jobs.recordOutboundAttempt(jobId, 1, `POST reply (draft=${input.draft})`, 201, null, Date.now() - started);
      this.jobs.setOutboundStatus(jobId, 'confirmed', null, res);
      // Persist locally after confirmed remote write
      await this.refreshOne(conv.remote_id);
      if (input.aiDraftId) {
        this.ai.setDraftState(input.aiDraftId, 'sent');
        this.ai.recordFeedback(input.aiDraftId, input.originalAiText ?? '', input.text, true);
      }
      this.jobs.audit({
        actor: 'user',
        action: input.draft ? 'reply_draft_created' : 'reply_sent',
        conversation_id: input.conversationId,
        before_state: before,
        after_state: { threadRemoteId: res.threadId },
        remote_operation: `POST /v2/conversations/${conv.remote_id}/reply`,
        remote_result: res,
        ai_involvement: !!input.aiDraftId,
        job_id: jobId
      });
      return { ok: true, message: input.draft ? 'Draft saved to Help Scout.' : 'Reply sent successfully.', data: { threadRemoteId: res.threadId } };
    } catch (e) {
      const hsErr = e instanceof HelpScoutApiError ? e : null;
      const msg = hsErr ? hsErr.friendly : e instanceof Error ? e.message : String(e);
      // Replies are NEVER auto-retried: a timeout may still have delivered the message remotely.
      this.jobs.recordOutboundAttempt(jobId, 1, 'POST reply', hsErr?.statusCode ?? null, String(e).slice(0, 500), Date.now() - started);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      this.jobs.audit({ actor: 'user', action: 'reply_failed', conversation_id: input.conversationId, before_state: before, remote_operation: `POST /v2/conversations/${conv.remote_id}/reply`, remote_result: { error: msg }, job_id: jobId });
      const caution = input.draft ? '' : ' The reply may or may not have been delivered - verify in Help Scout before sending again; SupportOS will not automatically resend.';
      return { ok: false, message: msg + caution, detail: hsErr ? `HTTP ${hsErr.statusCode}${hsErr.correlationId ? ` (correlation: ${hsErr.correlationId})` : ''}` : undefined };
    }
  }

  async addNote(input: { conversationId: number; text: string; aiGenerated?: boolean }): Promise<OperationResult<{ threadRemoteId: number }>> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(input.conversationId);
    if (!conv || !conv.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    if (this.settings.getAllSettings().ai_evaluation_mode) {
      return { ok: false, message: 'AI evaluation mode is ON: no notes, replies or status changes are sent to Help Scout.' };
    }
    const jobId = this.jobs.createOutboundJob('create_note', input, { conversationId: input.conversationId });
    const started = Date.now();
    try {
      this.jobs.setOutboundStatus(jobId, 'sending');
      const res = await this.provider.createNoteThread({ conversationId: conv.remote_id, text: input.text });
      this.jobs.recordOutboundAttempt(jobId, 1, 'POST note', 201, null, Date.now() - started);
      this.jobs.setOutboundStatus(jobId, 'confirmed', null, res);
      await this.refreshOne(conv.remote_id);
      this.jobs.audit({
        actor: input.aiGenerated ? 'ai' : 'user',
        action: 'note_added',
        conversation_id: input.conversationId,
        remote_operation: `POST /v2/conversations/${conv.remote_id}/notes`,
        remote_result: res,
        ai_involvement: !!input.aiGenerated,
        job_id: jobId
      });
      return { ok: true, message: 'Internal note added.', data: { threadRemoteId: res.threadId } };
    } catch (e) {
      const hsErr = e instanceof HelpScoutApiError ? e : null;
      const msg = hsErr ? hsErr.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.recordOutboundAttempt(jobId, 1, 'POST note', hsErr?.statusCode ?? null, String(e).slice(0, 500), Date.now() - started);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: msg, detail: hsErr ? `HTTP ${hsErr.statusCode}` : undefined };
    }
  }

  // ============================================================ Status / assign / subject / move

  async changeStatus(conversationId: number, status: 'active' | 'closed' | 'pending' | 'spam'): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    if (this.settings.getAllSettings().ai_evaluation_mode) return { ok: false, message: 'AI evaluation mode is ON: status changes are disabled.' };
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const before = conv.status;
    const jobId = this.jobs.createOutboundJob('update_status', { conversationId, status }, { conversationId });
    try {
      await this.provider.updateConversation(conv.remote_id, { status });
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.conv.updateLocalStatus(conversationId, status);
      if (status === 'closed' && !conv.closed_at) {
        this.db.prepare("UPDATE conversations SET closed_at = datetime('now') WHERE id = ?").run(conversationId);
      }
      this.jobs.audit({ actor: 'user', action: 'status_changed', conversation_id: conversationId, before_state: { status: before }, after_state: { status }, remote_operation: `PATCH /v2/conversations/${conv.remote_id}`, job_id: jobId });
      return { ok: true, message: `Status changed to ${status}.` };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Status was NOT changed. ${msg}`, detail: e instanceof HelpScoutApiError ? `HTTP ${e.statusCode}` : undefined };
    }
  }

  async assign(conversationId: number, userId: number | null): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('assign', { conversationId, userId }, { conversationId });
    try {
      await this.provider.updateConversation(conv.remote_id, { assignTo: userId });
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      const localUser = userId ? (this.db.prepare('SELECT id FROM users WHERE remote_id = ?').get(userId) as { id: number } | undefined) : undefined;
      const localTeam = userId && !localUser ? (this.db.prepare('SELECT id FROM teams WHERE remote_id = ?').get(userId) as { id: number } | undefined) : undefined;
      this.conv.updateLocalAssignee(conversationId, localUser?.id ?? localTeam?.id ?? null);
      this.jobs.audit({ actor: 'user', action: 'assignment_changed', conversation_id: conversationId, before_state: { assignee: conv.assignee_local_id }, after_state: { assignee: userId }, remote_operation: `PATCH /v2/conversations/${conv.remote_id} /assignTo`, job_id: jobId });
      return { ok: true, message: userId ? 'Conversation assigned.' : 'Conversation unassigned.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Assignment was NOT changed. ${msg}` };
    }
  }

  async changeSubject(conversationId: number, subject: string): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('update_subject', { conversationId, subject }, { conversationId });
    try {
      await this.provider.updateConversation(conv.remote_id, { subject });
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.conv.updateLocalSubject(conversationId, subject);
      this.jobs.audit({ actor: 'user', action: 'subject_changed', conversation_id: conversationId, before_state: { subject: conv.subject }, after_state: { subject }, remote_operation: `PATCH /v2/conversations/${conv.remote_id} /subject`, job_id: jobId });
      return { ok: true, message: 'Subject updated.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Subject was NOT changed. ${msg}` };
    }
  }

  async moveToInbox(conversationId: number, mailboxRemoteId: number): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('move', { conversationId, mailboxRemoteId }, { conversationId });
    try {
      await this.provider.updateConversation(conv.remote_id, { mailboxId: mailboxRemoteId });
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      const mailbox = this.ref.getMailboxByRemoteId(mailboxRemoteId);
      if (mailbox) this.conv.updateLocalMailbox(conversationId, mailbox.id);
      this.jobs.audit({ actor: 'user', action: 'moved_inbox', conversation_id: conversationId, before_state: { mailbox: conv.mailbox_local_id }, after_state: { mailbox: mailboxRemoteId }, remote_operation: `PATCH /v2/conversations/${conv.remote_id} /mailboxId`, job_id: jobId });
      return { ok: true, message: `Moved to ${mailbox?.name ?? 'the new inbox'}.` };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Conversation was NOT moved. ${msg}` };
    }
  }

  // ============================================================ Tags (fresh-read-merge-write, spec #18)

  async updateTags(conversationId: number, change: { add?: string[]; remove?: string[]; set?: string[] }): Promise<OperationResult<{ tags: string[] }>> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('update_tags', { conversationId, ...change }, { conversationId });
    try {
      // 1. read LATEST remote state
      const remote = await this.provider.getConversation(conv.remote_id);
      if (!remote) {
        this.jobs.setOutboundStatus(jobId, 'failed', 'Conversation no longer exists remotely');
        return { ok: false, message: 'Help Scout reports this conversation no longer exists. Refresh and check for a merge.' };
      }
      // 2. calculate desired state from remote truth (remote A,B + add C => A,B,C)
      let desired: string[];
      if (change.set) desired = [...new Set(change.set)].map((t) => t.trim()).filter(Boolean);
      else {
        const current = remote.tags.map((t) => t.name);
        desired = [...new Set([...current.filter((t) => !(change.remove ?? []).map((r) => r.toLowerCase()).includes(t.toLowerCase())), ...(change.add ?? []).map((t) => t.trim()).filter(Boolean)])];
      }
      // 3. send complete state
      await this.provider.updateTags(conv.remote_id, desired);
      // 4. confirm + persist
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.conv.updateLocalTags(conversationId, desired);
      this.jobs.audit({ actor: 'user', action: 'tags_changed', conversation_id: conversationId, before_state: { tags: remote.tags.map((t) => t.name) }, after_state: { tags: desired }, remote_operation: `PUT /v2/conversations/${conv.remote_id}/tags`, job_id: jobId });
      return { ok: true, message: 'Tags updated.', data: { tags: desired } };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Tags were NOT changed. ${msg}` };
    }
  }

  // ============================================================ Custom fields (fresh-read-merge-write, spec #17)

  async updateCustomFields(conversationId: number, fields: { id: number; value: string | null }[]): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('update_fields', { conversationId, fields }, { conversationId });
    try {
      const remote = await this.provider.getConversation(conv.remote_id);
      if (!remote) {
        this.jobs.setOutboundStatus(jobId, 'failed', 'Conversation no longer exists remotely');
        return { ok: false, message: 'Help Scout reports this conversation no longer exists. Refresh and check for a merge.' };
      }
      // System fields (Topics/Sentiment) are PRESERVED when omitted (documented behavior).
      // User-created fields: full replacement semantics - send current user fields merged with changes.
      const systemFields = remote.customFields.filter((f) => f.systemType);
      const currentUserFields = remote.customFields.filter((f) => !f.systemType);
      const changedIds = new Set(fields.map((f) => f.id));
      const merged = [
        ...systemFields.map((f) => ({ id: f.fieldId, value: f.value ?? '' })),
        ...currentUserFields.filter((f) => !changedIds.has(f.fieldId)).map((f) => ({ id: f.fieldId, value: f.value ?? '' })),
        ...fields.map((f) => ({ id: f.id, value: f.value ?? '' }))
      ];
      await this.provider.updateCustomFields(conv.remote_id, merged);
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      await this.refreshOne(conv.remote_id);
      this.jobs.audit({ actor: 'user', action: 'fields_changed', conversation_id: conversationId, before_state: { fields: remote.customFields }, after_state: { fields: merged }, remote_operation: `PUT /v2/conversations/${conv.remote_id}/fields`, job_id: jobId });
      return { ok: true, message: 'Custom fields updated.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Fields were NOT changed. ${msg}` };
    }
  }

  // ============================================================ Snooze / schedule

  async snooze(conversationId: number, snoozedUntil: string, unsnoozeOnCustomerReply = true): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    const jobId = this.jobs.createOutboundJob('snooze', { conversationId, snoozedUntil }, { conversationId });
    try {
      await this.provider.snoozeConversation(conv.remote_id, snoozedUntil, unsnoozeOnCustomerReply);
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.conv.updateLocalSnooze(conversationId, snoozedUntil);
      this.jobs.audit({ actor: 'user', action: 'snoozed', conversation_id: conversationId, after_state: { snoozedUntil }, remote_operation: `PUT /v2/conversations/${conv.remote_id}/snooze`, job_id: jobId });
      return { ok: true, message: `Snoozed until ${snoozedUntil}.` };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Snooze was NOT applied. ${msg}` };
    }
  }

  async unsnooze(conversationId: number): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    try {
      await this.provider.unsnoozeConversation(conv.remote_id);
      this.conv.updateLocalSnooze(conversationId, null);
      this.jobs.audit({ actor: 'user', action: 'unsnoozed', conversation_id: conversationId, remote_operation: `DELETE /v2/conversations/${conv.remote_id}/snooze` });
      return { ok: true, message: 'Snooze removed.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Snooze was NOT removed. ${msg}` };
    }
  }

  async scheduleReply(conversationId: number, threadId: number, scheduledFor: string, unscheduleOnCustomerReply = true): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    const thread = this.db.prepare('SELECT remote_id FROM threads WHERE id = ?').get(threadId) as { remote_id: number } | undefined;
    if (!conv?.remote_id || !thread?.remote_id) return { ok: false, message: 'Conversation or draft thread not found locally.' };
    const jobId = this.jobs.createOutboundJob('schedule', { conversationId, threadId, scheduledFor }, { conversationId, threadId });
    try {
      await this.provider.scheduleThread(conv.remote_id, thread.remote_id, scheduledFor, unscheduleOnCustomerReply);
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.db.prepare('UPDATE threads SET scheduled_for = ?, state = ? WHERE id = ?').run(scheduledFor, 'scheduled', threadId);
      this.jobs.audit({ actor: 'user', action: 'reply_scheduled', conversation_id: conversationId, after_state: { scheduledFor }, remote_operation: `PUT /v2/conversations/${conv.remote_id}/threads/${thread.remote_id}/schedule`, job_id: jobId });
      return { ok: true, message: `Reply scheduled for ${scheduledFor}.` };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Schedule was NOT applied. ${msg}` };
    }
  }

  async publishSchedule(conversationId: number, threadId: number): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    const thread = this.db.prepare('SELECT remote_id FROM threads WHERE id = ?').get(threadId) as { remote_id: number } | undefined;
    if (!conv?.remote_id || !thread?.remote_id) return { ok: false, message: 'Conversation or thread not found locally.' };
    const jobId = this.jobs.createOutboundJob('schedule_publish', { conversationId, threadId }, { conversationId, threadId });
    try {
      await this.provider.publishScheduledThread(conv.remote_id, thread.remote_id);
      this.jobs.setOutboundStatus(jobId, 'confirmed');
      this.db.prepare("UPDATE threads SET state = 'published', scheduled_for = NULL WHERE id = ?").run(threadId);
      this.jobs.audit({ actor: 'user', action: 'scheduled_reply_published', conversation_id: conversationId, remote_operation: `PATCH .../schedule (publish)`, job_id: jobId });
      return { ok: true, message: 'Scheduled reply published (sent now).' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.jobs.setOutboundStatus(jobId, 'failed', msg);
      return { ok: false, message: `Publish failed. ${msg}` };
    }
  }

  async deleteSchedule(conversationId: number, threadId: number): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    const thread = this.db.prepare('SELECT remote_id FROM threads WHERE id = ?').get(threadId) as { remote_id: number } | undefined;
    if (!conv?.remote_id || !thread?.remote_id) return { ok: false, message: 'Conversation or thread not found locally.' };
    try {
      await this.provider.deleteThreadSchedule(conv.remote_id, thread.remote_id);
      this.db.prepare("UPDATE threads SET state = 'draft', scheduled_for = NULL WHERE id = ?").run(threadId);
      this.jobs.audit({ actor: 'user', action: 'schedule_deleted', conversation_id: conversationId, remote_operation: `DELETE .../schedule` });
      return { ok: true, message: 'Schedule deleted; draft kept.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Delete failed. ${msg}` };
    }
  }

  // ============================================================ Bulk actions (queue-based, spec #95)

  async bulkAction(conversationIds: number[], action: string, params: Record<string, string>): Promise<OperationResult<{ queued: number }>> {
    const auth = this.requireAuth();
    if (auth) return auth;
    let queued = 0;
    for (const id of conversationIds) {
      this.jobs.enqueue('api', 'bulk_' + action, { conversationId: id, ...params }, 1, 2);
      queued++;
    }
    this.jobs.audit({ actor: 'user', action: `bulk_${action}`, before_state: { count: conversationIds.length }, after_state: { queued } });
    return { ok: true, message: `${queued} operations queued.`, data: { queued } };
  }

  // ============================================================ Workflow run (Help Scout workflow, distinct from local automation)

  async runHelpScoutWorkflow(workflowId: number, conversationId: number): Promise<OperationResult> {
    const auth = this.requireAuth();
    if (auth) return auth;
    const conv = this.conv.getConversationByLocalId(conversationId);
    if (!conv?.remote_id) return { ok: false, message: 'Conversation not found locally.' };
    try {
      await this.provider.runWorkflow(workflowId, conv.remote_id);
      this.jobs.audit({ actor: 'user', action: 'helpscout_workflow_run', conversation_id: conversationId, remote_operation: `POST /v2/workflows/${workflowId}/run` });
      return { ok: true, message: 'Help Scout workflow executed.' };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Workflow failed. ${msg}` };
    }
  }

  // ============================================================ Attachment download

  async downloadAttachment(attachmentId: number, attachmentsDir: string): Promise<OperationResult<{ path: string }>> {
    const att = this.conv.getAttachment(attachmentId);
    if (!att?.remote_id) return { ok: false, message: 'Attachment not found.' };
    const thread = this.db.prepare('SELECT conversation_id FROM threads WHERE id = ?').get(att.thread_id) as { conversation_id: number } | undefined;
    const conv = thread ? this.conv.getConversationByLocalId(thread.conversation_id) : undefined;
    if (!conv?.remote_id) return { ok: false, message: 'Parent conversation not found.' };
    try {
      const data = await this.provider.getAttachmentData(conv.remote_id, att.thread_id, att.remote_id);
      if (!data) {
        this.conv.updateAttachmentState(attachmentId, 'failed', null, null);
        return { ok: false, message: 'Attachment is no longer available in Help Scout (it may have expired or been removed).' };
      }
      const safeName = (att.filename ?? 'attachment').replace(/[/\\:*?"<>|]/g, '_');
      const target = `${attachmentsDir}/${att.conversation_id}-${attachmentId}-${safeName}`;
      const fs = await import('node:fs');
      fs.writeFileSync(target, data.data);
      const hash = crypto.createHash('sha256').update(data.data).digest('hex');
      this.conv.updateAttachmentState(attachmentId, 'downloaded', target, hash);
      return { ok: true, message: 'Attachment downloaded.', data: { path: target } };
    } catch (e) {
      const msg = e instanceof HelpScoutApiError ? e.friendly : e instanceof Error ? e.message : String(e);
      this.conv.updateAttachmentState(attachmentId, 'failed', null, null);
      return { ok: false, message: `Attachment download failed. ${msg}` };
    }
  }

  /** Refresh one conversation from remote (used after writes + manual refresh button). */
  async refreshOne(remoteId: number): Promise<void> {
    const { SyncCoordinator } = await import('../sync/coordinator.js');
    const coordinator = new SyncCoordinator(this.db, this.provider);
    await coordinator.syncSingleConversation(remoteId);
  }
}
