import type { HelpScoutProvider, ConversationQuery, CustomerQuery, Page, HsUser, HsTeam, HsMailbox, HsFolder, HsTag, HsField, HsSavedReply, HsWorkflow, HsWebhookConfig, HsCustomer, HsOrganization, HsPropertyDef, HsConversation, HsThread, HsRating, HsUserStatus, CreateReplyInput, CreateNoteInput, ConversationPatch, HsReportRow } from './provider.js';
import { buildFakeWorld, type FakeWorld } from './fakeData.js';
import { HelpScoutApiError, friendlyError } from './client.js';

/**
 * FakeHelpScoutProvider (spec #80): an in-memory, mutable Help Scout simulator.
 * Used for demo mode (LOCAL_DEMO_MODE=true) and for the entire automated test
 * suite - pagination, rate limits, merges, duplicates and write flows can be
 * exercised without touching a real account.
 */
export class FakeHelpScoutProvider implements HelpScoutProvider {
  readonly kind = 'fake' as const;
  world: FakeWorld;
  callLog: { method: string; path: string; at: string }[] = [];
  /** Test hooks */
  simulateStatusOnNext: number | null = null;
  latencyMs = 0;
  pageSizes = { conversations: 25, customers: 50 };

  constructor(seed?: FakeWorld) {
    this.world = seed ?? buildFakeWorld();
  }

  private log(path: string): void {
    this.callLog.push({ method: 'GET', path, at: new Date().toISOString() });
    if (this.simulateStatusOnNext != null) {
      const status = this.simulateStatusOnNext;
      this.simulateStatusOnNext = null;
      throw new HelpScoutApiError(status, `Simulated ${status}`, friendlyError(status, '', 'GET'), null, status === 429 || status >= 500);
    }
  }

  reset(): void {
    this.world = buildFakeWorld();
    this.callLog = [];
  }

  async getMe(): Promise<HsUser> {
    return this.world.me;
  }
  async listUsers(page = 1): Promise<Page<HsUser>> {
    this.log('/v2/users');
    const items = this.world.users.slice((page - 1) * 50, page * 50);
    return { items, nextCursor: null, page: { size: 50, totalElements: this.world.users.length, totalPages: 1, number: page } };
  }
  async listSystemUsers(): Promise<HsUser[]> {
    this.log('/v3/system-users');
    return this.world.systemUsers;
  }
  async listTeams(): Promise<HsTeam[]> {
    this.log('/v2/teams');
    return this.world.teams;
  }
  async getUserStatus(userId: number): Promise<HsUserStatus | null> {
    this.log(`/v2/users/${userId}/status`);
    return this.world.userStatuses.find((s) => s.userId === userId) ?? null;
  }
  async listMailboxes(): Promise<HsMailbox[]> {
    this.log('/v2/mailboxes');
    return this.world.mailboxes;
  }
  async listFolders(mailboxId: number): Promise<HsFolder[]> {
    this.log(`/v2/mailboxes/${mailboxId}/folders`);
    return this.world.folders.filter((f) => f.mailboxId === mailboxId);
  }
  async listInboxFields(mailboxId: number): Promise<HsField[]> {
    this.log(`/v2/mailboxes/${mailboxId}/fields`);
    return this.world.fields.filter((f) => f.mailboxId === mailboxId);
  }
  async listSavedReplies(mailboxId: number): Promise<HsSavedReply[]> {
    this.log(`/v2/mailboxes/${mailboxId}/saved-replies`);
    return this.world.savedReplies;
  }
  async getRoutingConfiguration(mailboxId: number): Promise<unknown | null> {
    this.log(`/v2/mailboxes/${mailboxId}/routing`);
    return { state: 'enabled', assignmentLimit: 10, assignmentMethod: 'round_robin', userIds: this.world.users.map((u) => u.remoteId), rotation: [] };
  }
  async listTags(): Promise<HsTag[]> {
    this.log('/v2/tags');
    return this.world.tags;
  }
  async listWorkflows(): Promise<HsWorkflow[]> {
    this.log('/v2/workflows');
    return this.world.workflows;
  }
  async listWebhooks(): Promise<HsWebhookConfig[]> {
    this.log('/v2/webhooks');
    return this.world.webhooks;
  }
  async listCustomerPropertyDefinitions(): Promise<HsPropertyDef[]> {
    this.log('/v2/customer-properties');
    return this.world.customerProps;
  }
  async listOrganizationPropertyDefinitions(): Promise<HsPropertyDef[]> {
    this.log('/v2/organization-properties');
    return this.world.orgProps;
  }

  async listCustomers(query: CustomerQuery): Promise<Page<HsCustomer>> {
    this.log('/v3/customers');
    let items = this.world.customers;
    if (query.modifiedSince) {
      const since = new Date(query.modifiedSince).getTime();
      items = items.filter((c) => !c.updatedAt || new Date(c.updatedAt).getTime() >= since);
    }
    const size = this.pageSizes.customers;
    const start = query.cursor ? parseInt(Buffer.from(query.cursor, 'base64url').toString(), 10) : 0;
    const slice = items.slice(start, start + size);
    const nextIndex = start + size;
    const nextCursor = nextIndex < items.length ? Buffer.from(String(nextIndex)).toString('base64url') : null;
    return { items: slice, nextCursor };
  }

  async getCustomer(customerId: number): Promise<HsCustomer | null> {
    this.log(`/v2/customers/${customerId}`);
    return this.world.customers.find((c) => c.remoteId === customerId) ?? null;
  }

  async listOrganizations(): Promise<HsOrganization[]> {
    this.log('/v2/organizations');
    return this.world.organizations;
  }

  async listConversations(query: ConversationQuery): Promise<Page<HsConversation>> {
    this.log('/v3/conversations');
    // Merged conversations no longer appear in listings (they return 301 on direct access)
    let items = this.world.conversations.filter((c) => !((c as HsConversation & { mergedInto?: number }).mergedInto));
    if (query.status && query.status !== 'all') {
      if (query.status === 'open') items = items.filter((c) => c.status === 'active' || c.status === 'pending');
      else items = items.filter((c) => c.status === query.status);
    }
    if (query.mailboxId) items = items.filter((c) => c.mailboxId === query.mailboxId);
    if (query.number) items = items.filter((c) => c.number === query.number);
    if (query.modifiedSince) {
      const since = new Date(query.modifiedSince).getTime();
      items = items.filter((c) => {
        const modified = new Date(c.userUpdatedAt ?? c.createdAt ?? 0).getTime();
        return modified >= since;
      });
    }
    // newest first, by remote id desc (mirrors v3 default ordering)
    items = [...items].sort((a, b) => b.remoteId - a.remoteId);
    const size = this.pageSizes.conversations;
    const start = query.cursor ? parseInt(Buffer.from(query.cursor, 'base64url').toString(), 10) : 0;
    const slice = items.slice(start, start + size);
    const nextIndex = start + size;
    const nextCursor = nextIndex < items.length ? Buffer.from(String(nextIndex)).toString('base64url') : null;
    const embeddedThreads = query.embed === 'threads' ? slice.flatMap((c) => this.world.threads.filter((t) => t.conversationId === c.remoteId)) : undefined;
    return { items: slice, nextCursor, embeddedThreads };
  }

  async getConversation(conversationId: number): Promise<HsConversation | null> {
    this.log(`/v3/conversations/${conversationId}`);
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) return null;
    const mergedInto = (conv as HsConversation & { mergedInto?: number }).mergedInto;
    if (mergedInto) {
      // mirrors documented 301 behavior for merged conversations
      throw new HelpScoutApiError(301, `Conversation merged into ${mergedInto}`, 'This conversation was merged into another conversation in Help Scout. Open the target conversation instead.', null, false);
    }
    return conv;
  }

  async listThreads(conversationId: number): Promise<HsThread[]> {
    this.log(`/v3/conversations/${conversationId}/threads`);
    return this.world.threads.filter((t) => t.conversationId === conversationId).sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
  }

  async getRating(ratingId: number): Promise<HsRating | null> {
    this.log(`/v2/ratings/${ratingId}`);
    return this.world.ratings.find((r) => r.remoteId === ratingId) ?? null;
  }

  async listAllRatings(): Promise<HsRating[]> {
    return this.world.ratings;
  }

  async getCompanyOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    this.log('/v2/reports/company');
    const inRange = this.world.conversations.filter((c) => c.createdAt && c.createdAt >= start && c.createdAt <= end);
    return { key: 'hs_company_overall', name: 'Help Scout Company Overall', source: 'helpscout', data: { totalConversations: inRange.length, startDate: start, endDate: end } };
  }
  async getConversationsOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    this.log('/v2/reports/conversations');
    const inRange = this.world.conversations.filter((c) => c.createdAt && c.createdAt >= start && c.createdAt <= end);
    return { key: 'hs_conversations_overall', name: 'Help Scout Conversations Overall', source: 'helpscout', data: { totalConversations: inRange.length, byStatus: { active: inRange.filter((c) => c.status === 'active').length, closed: inRange.filter((c) => c.status === 'closed').length, pending: inRange.filter((c) => c.status === 'pending').length } } };
  }
  async getHappinessRatingsReport(start: string, end: string): Promise<HsReportRow | null> {
    this.log('/v2/reports/happiness');
    const inRange = this.world.ratings.filter((r) => r.createdAt && r.createdAt >= start && r.createdAt <= end);
    return {
      key: 'hs_happiness_ratings',
      name: 'Help Scout Happiness Ratings',
      source: 'helpscout',
      data: { great: inRange.filter((r) => r.rating === 'great').length, okay: inRange.filter((r) => r.rating === 'okay').length, notGood: inRange.filter((r) => r.rating === 'not-good').length }
    };
  }
  async getProductivityOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    this.log('/v2/reports/productivity');
    const replies = this.world.threads.filter((t) => t.type === 'reply' && t.createdAt && t.createdAt >= start && t.createdAt <= end);
    return { key: 'hs_productivity_overall', name: 'Help Scout Productivity Overall', source: 'helpscout', data: { repliesSent: replies.length } };
  }

  // ---------------- Writes ----------------

  async createReplyThread(input: CreateReplyInput): Promise<{ threadId: number; conversationId: number }> {
    const conv = this.world.conversations.find((c) => c.remoteId === input.conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'POST'), null, false);
    const nextId = Math.max(...this.world.threads.map((t) => t.remoteId)) + 1;
    const t: HsThread = {
      remoteId: nextId,
      conversationId: input.conversationId,
      type: 'reply',
      state: input.draft ? 'draft' : 'published',
      status: null,
      actionType: null,
      actionText: null,
      body: input.text,
      sourceType: 'email',
      sourceVia: 'user',
      customer: { id: conv.primaryCustomerId, first: conv.primaryCustomerName?.split(' ')[0] ?? null, last: conv.primaryCustomerName?.split(' ')[1] ?? null, email: conv.primaryCustomerEmail ?? null },
      createdBy: { id: this.world.me.remoteId, type: 'user', first: this.world.me.firstName, last: this.world.me.lastName, email: this.world.me.email },
      assignedTo: null,
      savedReplyId: null,
      to: [conv.primaryCustomerEmail ?? ''],
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      createdAt: new Date().toISOString(),
      attachments: (input.attachments ?? []).map((a, i) => ({ id: 9100 + i, filename: a.fileName, mimeType: a.mimeType, size: Math.floor((a.dataBase64.length * 3) / 4) }))
    };
    this.world.threads.push(t);
    conv.threadCount = this.world.threads.filter((x) => x.conversationId === conv.remoteId).length;
    conv.userUpdatedAt = new Date().toISOString();
    if (!input.draft) {
      if (input.statusAfter && ['active', 'closed', 'pending', 'spam'].includes(input.statusAfter)) conv.status = input.statusAfter as HsConversation['status'];
      else conv.status = 'active';
      if (input.assignTo != null) {
        conv.assigneeId = input.assignTo;
        conv.assigneeType = this.world.users.some((u) => u.remoteId === input.assignTo) ? 'user' : 'team';
      }
    }
    return { threadId: nextId, conversationId: input.conversationId };
  }

  async createNoteThread(input: CreateNoteInput): Promise<{ threadId: number; conversationId: number }> {
    const conv = this.world.conversations.find((c) => c.remoteId === input.conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'POST'), null, false);
    const nextId = Math.max(...this.world.threads.map((t) => t.remoteId)) + 1;
    this.world.threads.push({
      remoteId: nextId,
      conversationId: input.conversationId,
      type: 'note',
      state: 'published',
      status: null,
      actionType: null,
      actionText: null,
      body: input.text,
      sourceType: 'note',
      sourceVia: 'user',
      customer: null,
      createdBy: { id: this.world.me.remoteId, type: 'user', first: this.world.me.firstName, last: this.world.me.lastName, email: this.world.me.email },
      assignedTo: null,
      savedReplyId: null,
      to: [],
      cc: [],
      bcc: [],
      createdAt: new Date().toISOString(),
      attachments: []
    });
    conv.threadCount = this.world.threads.filter((x) => x.conversationId === input.conversationId).length;
    conv.userUpdatedAt = new Date().toISOString();
    return { threadId: nextId, conversationId: input.conversationId };
  }

  async updateConversation(conversationId: number, patch: ConversationPatch): Promise<boolean> {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'PATCH'), null, false);
    if (patch.subject !== undefined) conv.subject = patch.subject;
    if (patch.status !== undefined) conv.status = patch.status;
    if (patch.mailboxId !== undefined) conv.mailboxId = patch.mailboxId;
    if (patch.primaryCustomerId !== undefined) {
      const cust = this.world.customers.find((c) => c.remoteId === patch.primaryCustomerId);
      conv.primaryCustomerId = patch.primaryCustomerId;
      conv.primaryCustomerName = cust ? `${cust.firstName} ${cust.lastName}` : null;
      conv.primaryCustomerEmail = cust?.emails[0]?.value ?? null;
    }
    if (patch.publishDraft !== undefined) {
      const draft = [...this.world.threads].reverse().find((t) => t.conversationId === conversationId && t.state === 'draft');
      if (draft) draft.state = 'published';
    }
    if (patch.assignTo !== undefined) {
      conv.assigneeId = patch.assignTo;
      conv.assigneeType = patch.assignTo == null ? null : this.world.users.some((u) => u.remoteId === patch.assignTo) ? 'user' : 'team';
    }
    conv.userUpdatedAt = new Date().toISOString();
    return true;
  }

  async updateTags(conversationId: number, tags: string[]): Promise<boolean> {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'PUT'), null, false);
    conv.tags = tags.map((name) => ({ remoteId: this.world.tags.find((t) => t.name === name)?.remoteId ?? null, name, color: null }));
    conv.userUpdatedAt = new Date().toISOString();
    return true;
  }

  async updateCustomFields(conversationId: number, fields: { id: number; value: string | null }[]): Promise<boolean> {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'PUT'), null, false);
    // replacement semantics, but system fields are preserved when omitted (documented behavior)
    const preservedSystem = conv.customFields.filter((f) => f.systemType && !fields.some((nf) => nf.id === f.fieldId));
    conv.customFields = [
      ...preservedSystem,
      ...fields.map((f) => {
        const def = this.world.fields.find((x) => x.remoteId === f.id);
        const opt = def?.options.find((o) => o.id === Number(f.value));
        return { fieldId: f.id, value: f.value ?? '', text: opt?.label ?? f.value ?? '', systemType: def?.systemType ?? null };
      })
    ];
    conv.userUpdatedAt = new Date().toISOString();
    return true;
  }

  async snoozeConversation(conversationId: number, snoozedUntil: string, unsnoozeOnCustomerReply: boolean): Promise<boolean> {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'PUT'), null, false);
    conv.snoozedUntil = snoozedUntil;
    void unsnoozeOnCustomerReply;
    return true;
  }
  async unsnoozeConversation(conversationId: number): Promise<boolean> {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!conv) throw new HelpScoutApiError(404, 'Conversation not found', friendlyError(404, '', 'DELETE'), null, false);
    conv.snoozedUntil = null;
    return true;
  }
  async scheduleThread(conversationId: number, threadId: number, scheduledFor: string): Promise<boolean> {
    const t = this.world.threads.find((x) => x.remoteId === threadId);
    if (!t) throw new HelpScoutApiError(404, 'Thread not found', friendlyError(404, '', 'PUT'), null, false);
    (t as HsThread & { scheduledFor?: string }).scheduledFor = scheduledFor;
    t.state = 'scheduled';
    void conversationId;
    return true;
  }
  async publishScheduledThread(conversationId: number, threadId: number): Promise<boolean> {
    const t = this.world.threads.find((x) => x.remoteId === threadId);
    if (!t) throw new HelpScoutApiError(404, 'Thread not found', friendlyError(404, '', 'PATCH'), null, false);
    t.state = 'published';
    void conversationId;
    return true;
  }
  async deleteThreadSchedule(conversationId: number, threadId: number): Promise<boolean> {
    const t = this.world.threads.find((x) => x.remoteId === threadId);
    if (!t) throw new HelpScoutApiError(404, 'Thread not found', friendlyError(404, '', 'DELETE'), null, false);
    t.state = 'draft';
    delete (t as HsThread & { scheduledFor?: string }).scheduledFor;
    void conversationId;
    return true;
  }
  async runWorkflow(workflowId: number, conversationId: number): Promise<boolean> {
    const wf = this.world.workflows.find((w) => w.remoteId === workflowId);
    const conv = this.world.conversations.find((c) => c.remoteId === conversationId);
    if (!wf || !conv) throw new HelpScoutApiError(404, 'Not found', friendlyError(404, '', 'POST'), null, false);
    if (wf.name.includes('Tier 1')) {
      conv.assigneeId = 1001;
      conv.assigneeType = 'user';
    }
    return true;
  }
  async getAttachmentData(conversationId: number, threadId: number, attachmentId: number): Promise<{ data: Buffer; mimeType: string | null; filename: string | null } | null> {
    const t = this.world.threads.find((x) => x.conversationId === conversationId && x.attachments.some((a) => a.id === attachmentId));
    const att = t?.attachments.find((a) => a.id === attachmentId);
    if (!att) return null;
    const content = `Simulated attachment content for ${att.filename} (thread ${threadId})\nGenerated by FakeHelpScoutProvider.\n`;
    return { data: Buffer.from(content, 'utf8'), mimeType: att.mimeType, filename: att.filename };
  }
  async ping(): Promise<boolean> {
    return true;
  }

  // ---------------- Test/demo helpers ----------------

  /** Simulate a new customer reply arriving (used by demo + webhook tests). */
  customerReplies(conversationRemoteId: number, text: string): void {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationRemoteId);
    if (!conv) return;
    const nextId = Math.max(...this.world.threads.map((t) => t.remoteId)) + 1;
    this.world.threads.push({
      remoteId: nextId,
      conversationId: conversationRemoteId,
      type: 'customer',
      state: 'published',
      status: null,
      actionType: null,
      actionText: null,
      body: text,
      sourceType: 'email',
      sourceVia: 'customer',
      customer: { id: conv.primaryCustomerId, first: conv.primaryCustomerName?.split(' ')[0] ?? null, last: conv.primaryCustomerName?.split(' ')[1] ?? null, email: conv.primaryCustomerEmail ?? null },
      createdBy: { id: conv.primaryCustomerId, type: 'customer', first: conv.primaryCustomerName?.split(' ')[0] ?? null, last: conv.primaryCustomerName?.split(' ')[1] ?? null, email: conv.primaryCustomerEmail ?? null },
      assignedTo: null,
      savedReplyId: null,
      to: ['support@zylker.io'],
      cc: [],
      bcc: [],
      createdAt: new Date().toISOString(),
      attachments: []
    });
    conv.threadCount = this.world.threads.filter((x) => x.conversationId === conversationRemoteId).length;
    conv.userUpdatedAt = new Date().toISOString();
    if (conv.status === 'pending' || conv.status === 'closed') conv.status = 'active';
  }

  /** Simulate a brand new conversation arriving (demo + webhook tests). */
  createConversationOnRemote(opts: { subject: string; preview: string; mailboxId: number; customerRemoteId: number; body: string; tags?: string[] }): HsConversation {
    const cust = this.world.customers.find((c) => c.remoteId === opts.customerRemoteId)!;
    const nextConvId = Math.max(...this.world.conversations.map((c) => c.remoteId)) + 1;
    const nextNumber = Math.max(...this.world.conversations.map((c) => c.number)) + 1;
    const conv: HsConversation = {
      remoteId: nextConvId,
      number: nextNumber,
      type: 'email',
      folderId: null,
      status: 'active',
      state: 'published',
      subject: opts.subject,
      preview: opts.preview,
      mailboxId: opts.mailboxId,
      assigneeId: null,
      assigneeType: null,
      assignedTeamId: null,
      closedAt: null,
      createdAt: new Date().toISOString(),
      userUpdatedAt: new Date().toISOString(),
      tags: (opts.tags ?? []).map((name) => ({ remoteId: this.world.tags.find((t) => t.name === name)?.remoteId ?? null, name, color: null })),
      primaryCustomerId: opts.customerRemoteId,
      primaryCustomerName: `${cust.firstName} ${cust.lastName}`,
      primaryCustomerEmail: cust.emails[0]?.value ?? null,
      cc: [],
      bcc: [],
      snoozedUntil: null,
      customFields: [],
      threadCount: 0
    };
    this.world.conversations.push(conv);
    this.world.threads.push({
      remoteId: Math.max(...this.world.threads.map((t) => t.remoteId)) + 1,
      conversationId: conv.remoteId,
      type: 'customer',
      state: 'published',
      status: null,
      actionType: null,
      actionText: null,
      body: opts.body,
      sourceType: 'email',
      sourceVia: 'customer',
      customer: { id: cust.remoteId, first: cust.firstName, last: cust.lastName, email: cust.emails[0]?.value ?? null },
      createdBy: { id: cust.remoteId, type: 'customer', first: cust.firstName, last: cust.lastName, email: cust.emails[0]?.value ?? null },
      assignedTo: null,
      savedReplyId: null,
      to: ['support@zylker.io'],
      cc: [],
      bcc: [],
      createdAt: new Date().toISOString(),
      attachments: []
    });
    conv.threadCount = 1;
    return conv;
  }

  /** Simulate tags changing on the remote (for stale-state / reconciliation tests). */
  setRemoteTags(conversationRemoteId: number, names: string[]): void {
    const conv = this.world.conversations.find((c) => c.remoteId === conversationRemoteId);
    if (conv) conv.tags = names.map((name) => ({ remoteId: this.world.tags.find((t) => t.name === name)?.remoteId ?? null, name, color: null }));
  }

  /** Simulate remote deletion. */
  deleteConversationRemote(conversationRemoteId: number): void {
    this.world.conversations = this.world.conversations.filter((c) => c.remoteId !== conversationRemoteId);
  }
}
