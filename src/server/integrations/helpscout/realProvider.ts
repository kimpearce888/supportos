import type { DB } from '../../database/connection.js';
import { HelpScoutHttpClient, HelpScoutApiError } from './client.js';
import { HelpScoutAuthService } from './authService.js';
import {
  HelpScoutUserService,
  HelpScoutTeamService,
  HelpScoutInboxService,
  HelpScoutFieldService,
  HelpScoutTagService,
  HelpScoutSavedReplyService,
  HelpScoutWorkflowService,
  HelpScoutWebhookService,
  HelpScoutCustomerService,
  HelpScoutOrganizationService,
  HelpScoutConversationService,
  HelpScoutThreadService,
  HelpScoutReportService,
  HelpScoutAttachmentService
} from './services.js';
import type {
  HelpScoutProvider,
  ConversationQuery,
  CustomerQuery,
  Page,
  HsUser,
  HsTeam,
  HsMailbox,
  HsFolder,
  HsTag,
  HsField,
  HsSavedReply,
  HsWorkflow,
  HsWebhookConfig,
  HsCustomer,
  HsOrganization,
  HsPropertyDef,
  HsConversation,
  HsThread,
  HsRating,
  HsUserStatus,
  CreateReplyInput,
  CreateNoteInput,
  ConversationPatch,
  HsReportRow
} from './provider.js';
import { PRIORITY } from '../../../shared/constants.js';

/**
 * RealHelpScoutProvider - composes the service layer behind the HelpScoutProvider
 * interface. Read operations use the current v3 conversation endpoints; writes use
 * the documented v2 operations. Version differences stay inside this module (spec #119).
 */
export class RealHelpScoutProvider implements HelpScoutProvider {
  readonly kind = 'real' as const;
  public users: HelpScoutUserService;
  public teams: HelpScoutTeamService;
  public inboxes: HelpScoutInboxService;
  public fields: HelpScoutFieldService;
  public tags: HelpScoutTagService;
  public savedReplies: HelpScoutSavedReplyService;
  public workflows: HelpScoutWorkflowService;
  public webhooks: HelpScoutWebhookService;
  public customers: HelpScoutCustomerService;
  public organizations: HelpScoutOrganizationService;
  public conversations: HelpScoutConversationService;
  public threads: HelpScoutThreadService;
  public reports: HelpScoutReportService;
  public attachments: HelpScoutAttachmentService;
  public auth: HelpScoutAuthService;
  public http: HelpScoutHttpClient;

  constructor(opts: { apiBase: string; db: DB; clientId: string; clientSecret: string; redirectUri: string; concurrency?: number }) {
    this.http = new HelpScoutHttpClient({
      apiBase: opts.apiBase,
      db: opts.db,
      concurrency: opts.concurrency ?? 2,
      getToken: async () => this.auth.getAccessToken(),
      onAuthFailure: async () => {
        /* client retries with fresh token after authService refresh */
      }
    });
    this.auth = new HelpScoutAuthService(this.http, opts.db, {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: opts.redirectUri,
      apiBase: opts.apiBase
    });
    this.users = new HelpScoutUserService(this.http);
    this.teams = new HelpScoutTeamService(this.http);
    this.inboxes = new HelpScoutInboxService(this.http);
    this.fields = new HelpScoutFieldService(this.http);
    this.tags = new HelpScoutTagService(this.http);
    this.savedReplies = new HelpScoutSavedReplyService(this.http);
    this.workflows = new HelpScoutWorkflowService(this.http);
    this.webhooks = new HelpScoutWebhookService(this.http);
    this.customers = new HelpScoutCustomerService(this.http);
    this.organizations = new HelpScoutOrganizationService(this.http);
    this.conversations = new HelpScoutConversationService(this.http);
    this.threads = new HelpScoutThreadService(this.http);
    this.reports = new HelpScoutReportService(this.http);
    this.attachments = new HelpScoutAttachmentService(this.http);
  }

  async getMe(): Promise<HsUser> {
    return this.users.getMe();
  }
  async listUsers(page = 1): Promise<Page<HsUser>> {
    return this.users.list(page);
  }
  async listSystemUsers(): Promise<HsUser[]> {
    return this.users.listSystemUsers();
  }
  async listTeams(): Promise<HsTeam[]> {
    return this.teams.list();
  }
  async getUserStatus(userId: number): Promise<HsUserStatus | null> {
    const raw = await this.http
      .request<Record<string, unknown>>(`/v2/users/${userId}/status`)
      .catch((e: HelpScoutApiError) => (e.statusCode === 404 ? null : Promise.reject(e)));
    if (!raw) return null;
    return {
      userId,
      emailStatus: ((raw.email as Record<string, unknown> | undefined)?.status as string | null) ?? null,
      emailUpdatedAt: ((raw.email as Record<string, unknown> | undefined)?.updatedAt as string | null) ?? null,
      chatStatus: ((raw.chat as Record<string, unknown> | undefined)?.status as string | null) ?? null,
      mailboxStatuses: ((raw.chat as Record<string, unknown> | undefined)?.mailboxStatuses as Record<string, string> | undefined) ?? {}
    };
  }
  async listMailboxes(): Promise<HsMailbox[]> {
    return this.inboxes.listMailboxes();
  }
  async listFolders(mailboxId: number): Promise<HsFolder[]> {
    return this.inboxes.listFolders(mailboxId);
  }
  async listInboxFields(mailboxId: number): Promise<HsField[]> {
    return this.fields.listInboxFields(mailboxId);
  }
  async listSavedReplies(mailboxId: number): Promise<HsSavedReply[]> {
    return this.savedReplies.list(mailboxId);
  }
  async getRoutingConfiguration(mailboxId: number): Promise<unknown | null> {
    return this.http
      .request<unknown>(`/v2/mailboxes/${mailboxId}/routing`, { priority: PRIORITY.SYNC })
      .catch((e: HelpScoutApiError) => (e.statusCode === 404 ? null : Promise.reject(e)));
  }
  async listTags(): Promise<HsTag[]> {
    return this.tags.list();
  }
  async listWorkflows(): Promise<HsWorkflow[]> {
    return this.workflows.list();
  }
  async listWebhooks(): Promise<HsWebhookConfig[]> {
    return this.webhooks.list();
  }
  async listCustomerPropertyDefinitions(): Promise<HsPropertyDef[]> {
    return this.fields.listPropertyDefinitions('customer');
  }
  async listOrganizationPropertyDefinitions(): Promise<HsPropertyDef[]> {
    return this.fields.listPropertyDefinitions('organization');
  }
  async listCustomers(query: CustomerQuery): Promise<Page<HsCustomer>> {
    return this.customers.list(query);
  }
  async getCustomer(customerId: number): Promise<HsCustomer | null> {
    return this.customers.get(customerId);
  }
  async listOrganizations(): Promise<HsOrganization[]> {
    return this.organizations.list();
  }
  async listConversations(query: ConversationQuery): Promise<Page<HsConversation>> {
    return this.conversations.list(query);
  }
  async getConversation(conversationId: number): Promise<HsConversation | null> {
    return this.conversations.get(conversationId);
  }
  async listThreads(conversationId: number): Promise<HsThread[]> {
    return this.threads.list(conversationId);
  }
  async getRating(ratingId: number): Promise<HsRating | null> {
    const raw = await this.http
      .request<Record<string, unknown>>(`/v2/ratings/${ratingId}`, { priority: PRIORITY.ANALYTICS })
      .catch((e: HelpScoutApiError) => (e.statusCode === 404 ? null : Promise.reject(e)));
    if (!raw) return null;
    return {
      remoteId: raw.id as number,
      conversationId: (raw.conversationId as number | null) ?? null,
      threadId: (raw.threadId as number | null) ?? null,
      rating: (raw.rating as HsRating['rating']) ?? null,
      comments: (raw.comments as string | null) ?? null,
      customerId: ((raw.customer as Record<string, unknown> | undefined)?.id as number | null) ?? null,
      customerName: [((raw.customer as Record<string, unknown> | undefined)?.firstName as string | null) ?? null, ((raw.customer as Record<string, unknown> | undefined)?.lastName as string | null) ?? null]
        .filter(Boolean)
        .join(' ') || null,
      userId: ((raw.user as Record<string, unknown> | undefined)?.id as number | null) ?? null,
      createdAt: (raw.createdAt as string | null) ?? null
    };
  }
  async listAllRatings(): Promise<HsRating[]> {
    // No documented polling endpoint for all ratings; they arrive via the satisfaction.ratings webhook.
    return [];
  }
  async getCompanyOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    return this.reports.companyOverall(start, end);
  }
  async getConversationsOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    return this.reports.conversationsOverall(start, end);
  }
  async getHappinessRatingsReport(start: string, end: string): Promise<HsReportRow | null> {
    return this.reports.happinessRatings(start, end);
  }
  async getProductivityOverallReport(start: string, end: string): Promise<HsReportRow | null> {
    return this.reports.productivityOverall(start, end);
  }

  // ---------------- Writes (documented v2 operations) ----------------
  async createReplyThread(input: CreateReplyInput): Promise<{ threadId: number; conversationId: number }> {
    const body: Record<string, unknown> = {
      text: input.text,
      draft: input.draft
    };
    if (input.customerIds?.length) body.customer = { id: input.customerIds[0] };
    if (input.cc?.length) body.cc = input.cc;
    if (input.bcc?.length) body.bcc = input.bcc;
    if (input.statusAfter) body.status = input.statusAfter;
    if (input.assignTo != null) body.assignTo = input.assignTo;
    if (input.attachments?.length) {
      body.attachments = input.attachments.map((a) => ({ fileName: a.fileName, mimeType: a.mimeType, data: a.dataBase64 }));
    }
    const res = await this.http.request<{ id: number }>(`/v2/conversations/${input.conversationId}/reply`, {
      method: 'POST',
      body,
      priority: PRIORITY.USER_SEND
    });
    return { threadId: res.id, conversationId: input.conversationId };
  }
  async createNoteThread(input: CreateNoteInput): Promise<{ threadId: number; conversationId: number }> {
    const res = await this.http.request<{ id: number }>(`/v2/conversations/${input.conversationId}/notes`, {
      method: 'POST',
      body: { text: input.text },
      priority: PRIORITY.INTERACTIVE
    });
    return { threadId: res.id, conversationId: input.conversationId };
  }
  async updateConversation(conversationId: number, patch: ConversationPatch): Promise<boolean> {
    const ops: { op: string; path: string; value?: unknown }[] = [];
    if (patch.subject !== undefined) ops.push({ op: 'replace', path: '/subject', value: patch.subject });
    if (patch.status !== undefined) ops.push({ op: 'replace', path: '/status', value: patch.status });
    if (patch.mailboxId !== undefined) ops.push({ op: 'move', path: '/mailboxId', value: patch.mailboxId });
    if (patch.primaryCustomerId !== undefined) ops.push({ op: 'replace', path: '/primaryCustomer.id', value: patch.primaryCustomerId });
    if (patch.publishDraft !== undefined) ops.push({ op: 'replace', path: '/draft', value: patch.publishDraft });
    if (patch.assignTo !== undefined) {
      if (patch.assignTo === null) ops.push({ op: 'remove', path: '/assignTo' });
      else ops.push({ op: 'replace', path: '/assignTo', value: patch.assignTo });
    }
    for (const op of ops) {
      await this.http.request(`/v2/conversations/${conversationId}`, { method: 'PATCH', body: op, priority: PRIORITY.INTERACTIVE });
    }
    return true;
  }
  async updateTags(conversationId: number, tags: string[]): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/tags`, { method: 'PUT', body: { tags }, priority: PRIORITY.INTERACTIVE });
    return true;
  }
  async updateCustomFields(conversationId: number, fields: { id: number; value: string | null }[]): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/fields`, {
      method: 'PUT',
      body: { fields: fields.map((f) => ({ id: f.id, value: f.value ?? '' })) },
      priority: PRIORITY.INTERACTIVE
    });
    return true;
  }
  async snoozeConversation(conversationId: number, snoozedUntil: string, unsnoozeOnCustomerReply: boolean): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/snooze`, {
      method: 'PUT',
      body: { snoozedUntil, unsnoozeOnCustomerReply },
      priority: PRIORITY.INTERACTIVE
    });
    return true;
  }
  async unsnoozeConversation(conversationId: number): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/snooze`, { method: 'DELETE', priority: PRIORITY.INTERACTIVE });
    return true;
  }
  async scheduleThread(conversationId: number, threadId: number, scheduledFor: string, unscheduleOnCustomerReply: boolean): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/threads/${threadId}/schedule`, {
      method: 'PUT',
      body: { scheduledFor, unscheduleOnCustomerReply, sendAsCreator: false },
      priority: PRIORITY.INTERACTIVE
    });
    return true;
  }
  async publishScheduledThread(conversationId: number, threadId: number): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/threads/${threadId}/schedule`, {
      method: 'PATCH',
      body: { op: 'replace', path: '/state', value: 'published' },
      priority: PRIORITY.USER_SEND
    });
    return true;
  }
  async deleteThreadSchedule(conversationId: number, threadId: number): Promise<boolean> {
    await this.http.request(`/v2/conversations/${conversationId}/threads/${threadId}/schedule`, { method: 'DELETE', priority: PRIORITY.INTERACTIVE });
    return true;
  }
  async runWorkflow(workflowId: number, conversationId: number): Promise<boolean> {
    return this.workflows.run(workflowId, conversationId);
  }
  async getAttachmentData(conversationId: number, threadId: number, attachmentId: number) {
    return this.attachments.getData(conversationId, threadId, attachmentId);
  }
  async ping(): Promise<boolean> {
    await this.users.getMe();
    return true;
  }
}
