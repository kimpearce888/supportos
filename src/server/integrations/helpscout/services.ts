import { z } from 'zod';
import { HelpScoutHttpClient, HelpScoutApiError } from './client.js';
import { PRIORITY } from '../../../shared/constants.js';
import {
  hsConversationListV3Schema,
  hsThreadListV3Schema,
  hsCustomerListV3Schema,
  hsMailboxListSchema
} from '../../../shared/schemas.js';
import type {
  ConversationQuery,
  CustomerQuery,
  HsConversation,
  HsCustomer,
  HsField,
  HsFolder,
  HsMailbox,
  HsPropertyDef,
    HsSavedReply,
  HsTag,
  HsTeam,
  HsThread,
  HsUser,
    HsWorkflow,
  HsWebhookConfig,
  Page,
      HsReportRow
} from './provider.js';

// Raw wire shapes
interface HalPage<T> {
  _embedded: Record<string, T[]>;
  _links?: { next?: { href?: string }; last?: { href?: string } };
  page?: { size?: number; totalElements?: number; totalPages?: number; number?: number };
}

interface RawConversationV3 {
  id: number;
  number?: number;
  threads?: number;
  type?: string | null;
  folderId?: number | null;
  status?: string | null;
  state?: string | null;
  subject?: string | null;
  preview?: string | null;
  mailboxId?: number;
  assignee?: { id?: number; type?: string } | null;
  assignedTeam?: { id: number } | null;
  closedAt?: string | null;
  createdAt?: string | null;
  userUpdatedAt?: string | null;
  tags?: { id?: number; tag: string; color?: string | null }[];
  primaryCustomer?: { id?: number; first?: string | null; last?: string | null; email?: string | null } | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  snooze?: { snoozedUntil?: string | null } | null;
  customFields?: { id: number; value?: string | number | null; text?: string | null; systemType?: string | null }[] | null;
}

interface RawThreadV3 {
  id: number;
  type?: string | null;
  status?: string | null;
  state?: string | null;
  action?: { type?: string | null; text?: string | null } | null;
  body?: string | null;
  source?: { type?: string | null; via?: string | null } | null;
  customer?: { id?: number; first?: string | null; last?: string | null; email?: string | null } | null;
  createdBy?: { id?: number; type?: string; first?: string | null; last?: string | null; email?: string | null } | null;
  assignedTo?: { id?: number; type?: string } | null;
  savedReplyId?: number | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  createdAt?: string | null;
  attachments?: { id: number; filename?: string | null; mimeType?: string | null; size?: number | null }[] | null;
}

interface RawCustomerV3 {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  jobTitle?: string | null;
  emails?: { value?: string | null; type?: string | null }[] | null;
  phones?: { value?: string | null; type?: string | null }[] | null;
  websites?: { value?: string | null }[] | null;
  socialProfiles?: { value?: string | null; type?: string | null }[] | null;
  address?: Record<string, string | null> | null;
  organization?: { id: number; name?: string | null } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function validateOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HelpScoutApiError(0, `Unexpected ${label} response schema: ${JSON.stringify(r.error.issues).slice(0, 300)}`, `Help Scout returned an unexpected ${label} format. The raw payload was preserved and the sync was marked with an error rather than corrupting local data.`, null, false);
  }
  return r.data;
}

function cursorFromLink(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null;
  try {
    const u = new URL(href, 'https://api.helpscout.net');
    return u.searchParams.get('cursor');
  } catch {
    return null;
  }
}

function mapStatus(s: string | null | undefined): 'active' | 'pending' | 'closed' | 'spam' {
  if (s === 'pending' || s === 'closed' || s === 'spam') return s;
  return 'active';
}

// =====================================================================
// Service classes (spec #4) - the application depends on these, not URLs
// =====================================================================

export class HelpScoutUserService {
  constructor(private http: HelpScoutHttpClient) {}
  async getMe(): Promise<HsUser> {
    const raw = await this.http.request<Record<string, unknown>>('/v2/users/me', { priority: PRIORITY.INTERACTIVE });
    return this.mapUser(raw, 'user');
  }
  async list(page = 1): Promise<Page<HsUser>> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/users?page=${page}`);
    return { items: (raw._embedded?.users ?? []).map((u) => this.mapUser(u, 'user')), nextCursor: null, page: raw.page };
  }
  async listSystemUsers(): Promise<HsUser[]> {
    const out: HsUser[] = [];
    let page = 1;
    for (;;) {
      const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v3/system-users?page=${page}`);
      const users = raw._embedded?.['system_users'] ?? [];
      out.push(...users.map((u) => this.mapUser(u, 'system_user')));
      const totalPages = raw.page?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return out;
  }
  mapUser(u: Record<string, unknown>, type: 'user' | 'system_user'): HsUser {
    return {
      remoteId: (u.id as number) ?? 0,
      firstName: (u.firstName as string | null) ?? null,
      lastName: (u.lastName as string | null) ?? null,
      email: (u.email as string | null) ?? null,
      role: (u.role as string | null) ?? null,
      type,
      timezone: (u.timezone as string | null) ?? null,
      photoUrl: (u.photoUrl as string | null) ?? null,
      initials: (u.initials as string | null) ?? null,
      mention: (u.mention as string | null) ?? null,
      jobTitle: (u.jobTitle as string | null) ?? null,
      phone: (u.phone as string | null) ?? null,
      alternateEmails: (u.alternateEmails as string[] | null) ?? [],
      createdAt: (u.createdAt as string | null) ?? null,
      updatedAt: (u.updatedAt as string | null) ?? null
    };
  }
}

export class HelpScoutTeamService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(): Promise<HsTeam[]> {
    let page = 1;
    const teams: HsTeam[] = [];
    for (;;) {
      const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/teams?page=${page}`);
      const rows = raw._embedded?.teams ?? [];
      for (const t of rows) {
        const members = await this.http
          .request<HalPage<Record<string, unknown>>>(`/v2/teams/${t.id}/members`)
          .then((m) => (m._embedded?.teamMembers ?? []).map((u) => (u.id as number) ?? 0))
          .catch(() => [] as number[]);
        teams.push({ remoteId: t.id as number, name: (t.name as string) ?? '', memberUserIds: members });
      }
      const totalPages = raw.page?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return teams;
  }
}

export class HelpScoutInboxService {
  constructor(private http: HelpScoutHttpClient) {}
  async listMailboxes(): Promise<HsMailbox[]> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>('/v2/mailboxes');
    validateOrThrow(hsMailboxListSchema, raw, 'mailboxes list');
    return (raw._embedded?.mailboxes ?? []).map((m) => ({
      remoteId: m.id as number,
      name: (m.name as string) ?? '',
      slug: (m.slug as string | null) ?? null,
      email: (m.email as string | null) ?? null,
      createdAt: (m.createdAt as string | null) ?? null,
      updatedAt: (m.updatedAt as string | null) ?? null
    }));
  }
  async listFolders(mailboxId: number): Promise<HsFolder[]> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/mailboxes/${mailboxId}/folders`);
    return (raw._embedded?.folders ?? []).map((f) => ({
      remoteId: f.id as number,
      mailboxId,
      name: (f.name as string) ?? '',
      type: (f.type as string | null) ?? null,
      userId: (f.userId as number | null) ?? null,
      totalCount: (f.totalCount as number | null) ?? null,
      activeCount: (f.activeCount as number | null) ?? null
    }));
  }
}

export class HelpScoutFieldService {
  constructor(private http: HelpScoutHttpClient) {}
  async listInboxFields(mailboxId: number): Promise<HsField[]> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/mailboxes/${mailboxId}/fields`);
    return (raw._embedded?.fields ?? []).map((f) => ({
      remoteId: f.id as number,
      mailboxId,
      name: (f.name as string) ?? '',
      type: (f.type as string | null) ?? null,
      systemType: (f.systemType as string | null) ?? null,
      required: !!f.required,
      order: (f.order as number | null) ?? null,
      options: ((f.options as { id: number; order?: number; label?: string }[] | null) ?? []).map((o) => ({ id: o.id, order: o.order ?? null, label: o.label ?? null }))
    }));
  }
  async listPropertyDefinitions(context: 'customer' | 'organization'): Promise<HsPropertyDef[]> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/${context}-properties`);
    const key = context === 'customer' ? 'customer-properties' : 'organization-properties';
    return (raw._embedded?.[key] ?? []).map((p) => ({
      remoteId: -Math.abs(parseInt(String(p.slug ?? p.name ?? '0').replace(/\D/g, '') || '0', 10) || hashString(String(p.slug ?? p.name))),
      name: (p.name as string) ?? '',
      slug: (p.slug as string | null) ?? null,
      type: (p.type as string | null) ?? null,
      order: 0
    }));
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class HelpScoutTagService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(): Promise<HsTag[]> {
    let page = 1;
    const tags: HsTag[] = [];
    for (;;) {
      const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/tags?page=${page}`);
      tags.push(
        ...(raw._embedded?.tags ?? []).map((t) => ({
          remoteId: t.id as number,
          name: (t.name as string) ?? '',
          slug: (t.slug as string | null) ?? null,
          color: (t.color as string | null) ?? null,
          ticketCount: (t.ticketCount as number | null) ?? null,
          createdAt: (t.createdAt as string | null) ?? null,
          updatedAt: (t.updatedAt as string | null) ?? null
        }))
      );
      const totalPages = raw.page?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return tags;
  }
}

export class HelpScoutSavedReplyService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(mailboxId: number): Promise<HsSavedReply[]> {
    const raw = await this.http.request<Record<string, unknown>[]>(`/v2/mailboxes/${mailboxId}/saved-replies`);
    return (Array.isArray(raw) ? raw : []).map((r) => ({
      remoteId: r.id as number,
      name: (r.name as string) ?? '',
      preview: (r.preview as string | null) ?? null,
      text: (r.text as string | null) ?? null
    }));
  }
}

export class HelpScoutWorkflowService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(): Promise<HsWorkflow[]> {
    let page = 1;
    const out: HsWorkflow[] = [];
    for (;;) {
      const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/workflows?page=${page}`);
      out.push(
        ...(raw._embedded?.workflows ?? []).map((w) => ({
          remoteId: w.id as number,
          mailboxId: (w.mailboxId as number | null) ?? null,
          name: (w.name as string) ?? '',
          type: ((w.type as string) === 'automatic' ? 'automatic' : 'manual') as 'manual' | 'automatic',
          status: (w.status as string | null) ?? null,
          order: (w.order as number | null) ?? null
        }))
      );
      const totalPages = raw.page?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return out;
  }
  async run(workflowId: number, conversationId: number): Promise<boolean> {
    await this.http.request(`/v2/workflows/${workflowId}/run`, { method: 'POST', body: { conversationIds: [conversationId] }, priority: PRIORITY.INTERACTIVE });
    return true;
  }
}

export class HelpScoutWebhookService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(): Promise<HsWebhookConfig[]> {
    const raw = await this.http.request<HalPage<Record<string, unknown>>>('/v2/webhooks');
    return (raw._embedded?.webhooks ?? []).map((w) => ({
      remoteId: w.id as number,
      url: (w.url as string) ?? '',
      events: (w.events as string[] | null) ?? [],
      status: (w.status as string | null) ?? null
    }));
  }
  async create(url: string, events: string[], secret: string, label: string): Promise<number> {
    const res = await this.http.request<{ id: number }>('/v2/webhooks', {
      method: 'POST',
      body: { url, events, secret, payloadVersion: 'V2', label },
      priority: PRIORITY.INTERACTIVE
    });
    return res.id;
  }
  async delete(id: number): Promise<void> {
    await this.http.request(`/v2/webhooks/${id}`, { method: 'DELETE', priority: PRIORITY.INTERACTIVE });
  }
}

export class HelpScoutCustomerService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(query: CustomerQuery): Promise<Page<HsCustomer>> {
    const params = new URLSearchParams();
    if (query.modifiedSince) params.set('modifiedSince', query.modifiedSince);
    if (query.cursor) params.set('cursor', query.cursor);
    const raw = await this.http.request<unknown>(`/v3/customers${params.size ? '?' + params.toString() : ''}`);
    const parsed = validateOrThrow(hsCustomerListV3Schema, raw, 'customers list v3');
    const items = (parsed._embedded?.customers ?? []).map((c) => this.mapCustomer(c));
    const next = cursorFromLink((parsed._links?.next as { href?: unknown } | undefined)?.href);
    return { items, nextCursor: next };
  }
  async get(customerId: number): Promise<HsCustomer | null> {
    const raw = await this.http.request<RawCustomerV3>(`/v2/customers/${customerId}`).catch((e: HelpScoutApiError) => {
      if (e.statusCode === 404) return null;
      throw e;
    });
    if (!raw) return null;
    return this.mapCustomer(raw);
  }
  mapCustomer(c: { id: number; firstName?: string | null; lastName?: string | null; photoUrl?: string | null; jobTitle?: string | null; emails?: { value?: string | null; type?: string | null }[] | null; phones?: { value?: string | null; type?: string | null }[] | null; websites?: { value?: string | null }[] | null; socialProfiles?: { value?: string | null; type?: string | null }[] | null; address?: Record<string, unknown> | null; organization?: { id: number; name?: string | null } | null; createdAt?: string | null; updatedAt?: string | null }): HsCustomer {
    return {
      remoteId: c.id,
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      photoUrl: c.photoUrl ?? null,
      jobTitle: c.jobTitle ?? null,
      emails: (c.emails ?? []).map((e) => ({ value: e.value ?? null, type: e.type ?? null })),
      phones: (c.phones ?? []).map((p) => ({ value: p.value ?? null, type: p.type ?? null })),
      websites: (c.websites ?? []).map((w) => ({ value: w.value ?? null })),
      socialProfiles: (c.socialProfiles ?? []).map((s) => ({ value: s.value ?? null, type: s.type ?? null })),
      address: (c.address as Record<string, string | null> | null) ?? null,
      organization: c.organization ? { id: c.organization.id, name: c.organization.name ?? null } : null,
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt ?? null
    };
  }
}

export class HelpScoutOrganizationService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(): Promise<{ remoteId: number; name: string; domains: string[]; createdAt: string | null; updatedAt: string | null }[]> {
    let page = 1;
    const out: { remoteId: number; name: string; domains: string[]; createdAt: string | null; updatedAt: string | null }[] = [];
    for (;;) {
      const raw = await this.http.request<HalPage<Record<string, unknown>>>(`/v2/organizations?page=${page}`);
      out.push(
        ...(raw._embedded?.organizations ?? []).map((o) => ({
          remoteId: o.id as number,
          name: (o.name as string) ?? '',
          domains: (o.domains as string[] | null) ?? [],
          createdAt: (o.createdAt as string | null) ?? null,
          updatedAt: (o.updatedAt as string | null) ?? null
        }))
      );
      const totalPages = raw.page?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return out;
  }
}

export class HelpScoutConversationService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(query: ConversationQuery): Promise<Page<HsConversation>> {
    const params = new URLSearchParams();
    params.set('status', query.status ?? 'all');
    if (query.mailboxId) params.set('inboxId', String(query.mailboxId));
    if (query.contactId) params.set('contactId', String(query.contactId));
    if (query.number) params.set('number', String(query.number));
    if (query.modifiedSince) params.set('modifiedSince', query.modifiedSince);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.embed) params.set('embed', query.embed);
    const raw = await this.http.request<unknown>(`/v3/conversations?${params.toString()}`, { priority: PRIORITY.SYNC });
    const parsed = validateOrThrow(hsConversationListV3Schema, raw, 'conversations list v3');
    const items = (parsed._embedded?.conversations ?? []).map((c) => this.mapConversation(c));
    const next = cursorFromLink(parsed._links?.next?.href);
    let embeddedThreads: HsThread[] | undefined;
    if (query.embed === 'threads') {
      const threadMapper = new HelpScoutThreadService(this.http);
      embeddedThreads = [];
      for (const c of parsed._embedded?.conversations ?? []) {
        const convThreads = ((c as { _embedded?: { threads?: unknown[] } })._embedded?.threads ?? []) as RawThreadV3[];
        for (const t of convThreads) {
          embeddedThreads.push(threadMapper.mapThread(t, c.id));
        }
      }
    }
    return { items, nextCursor: next, embeddedThreads };
  }
  async get(conversationId: number): Promise<HsConversation | null> {
    const raw = await this.http
      .request<RawConversationV3>(`/v3/conversations/${conversationId}`, { priority: PRIORITY.INTERACTIVE })
      .catch((e: HelpScoutApiError) => {
        if (e.statusCode === 404) return null;
        throw e;
      });
    if (!raw) return null;
    return this.mapConversation(raw);
  }
  mapConversation(c: RawConversationV3): HsConversation {
    return {
      remoteId: c.id,
      number: c.number ?? c.id,
      type: c.type ?? null,
      folderId: c.folderId ?? null,
      status: mapStatus(c.status),
      state: c.state ?? null,
      subject: c.subject ?? null,
      preview: c.preview ?? null,
      mailboxId: c.mailboxId ?? 0,
      assigneeId: c.assignee?.id ?? null,
      assigneeType: (c.assignee?.type as 'user' | 'team' | null) ?? null,
      assignedTeamId: c.assignedTeam?.id ?? (c.assignee?.type === 'team' ? c.assignee?.id ?? null : null),
      closedAt: c.closedAt ?? null,
      createdAt: c.createdAt ?? null,
      userUpdatedAt: c.userUpdatedAt ?? c.createdAt ?? null,
      tags: (c.tags ?? []).map((t) => ({ remoteId: t.id ?? null, name: t.tag, color: t.color ?? null })),
      primaryCustomerId: c.primaryCustomer?.id ?? null,
      primaryCustomerName: [c.primaryCustomer?.first, c.primaryCustomer?.last].filter(Boolean).join(' ') || null,
      primaryCustomerEmail: c.primaryCustomer?.email ?? null,
      cc: c.cc ?? [],
      bcc: c.bcc ?? [],
      snoozedUntil: c.snooze?.snoozedUntil ?? null,
      customFields: (c.customFields ?? []).map((f) => ({ fieldId: f.id, value: f.value != null ? String(f.value) : null, text: f.text ?? null, systemType: f.systemType ?? null })),
      threadCount: c.threads ?? 0
    };
  }
}

export class HelpScoutThreadService {
  constructor(private http: HelpScoutHttpClient) {}
  async list(conversationId: number): Promise<HsThread[]> {
    const raw = await this.http.request<unknown>(`/v3/conversations/${conversationId}/threads`, { priority: PRIORITY.SYNC });
    const parsed = validateOrThrow(hsThreadListV3Schema, raw, 'threads list v3');
    return (parsed._embedded?.threads ?? []).map((t) => this.mapThread(t, conversationId));
  }
  mapThread(t: RawThreadV3, conversationId: number): HsThread {
    return {
      remoteId: t.id,
      conversationId,
      type: t.type ?? null,
      state: t.state ?? null,
      status: t.status ?? null,
      actionType: t.action?.type ?? null,
      actionText: t.action?.text ?? null,
      body: t.body ?? null,
      sourceType: t.source?.type ?? null,
      sourceVia: t.source?.via ?? null,
      customer: t.customer ? { id: t.customer.id ?? null, first: t.customer.first ?? null, last: t.customer.last ?? null, email: t.customer.email ?? null } : null,
      createdBy: t.createdBy ? { id: t.createdBy.id ?? null, type: t.createdBy.type ?? null, first: t.createdBy.first ?? null, last: t.createdBy.last ?? null, email: t.createdBy.email ?? null } : null,
      assignedTo: t.assignedTo ? { id: t.assignedTo.id ?? null, type: t.assignedTo.type ?? null } : null,
      savedReplyId: t.savedReplyId ?? null,
      to: t.to ?? [],
      cc: t.cc ?? [],
      bcc: t.bcc ?? [],
      createdAt: t.createdAt ?? null,
      attachments: (t.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename ?? null, mimeType: a.mimeType ?? null, size: a.size ?? null }))
    };
  }
}

export class HelpScoutReportService {
  constructor(private http: HelpScoutHttpClient) {}
  private async rangeReport(key: string, name: string, path: string, start: string, end: string): Promise<HsReportRow | null> {
    try {
      const params = new URLSearchParams({ start, end });
      const data = await this.http.request<unknown>(`${path}?${params.toString()}`, { priority: PRIORITY.ANALYTICS });
      return { key, name, source: 'helpscout', data };
    } catch {
      return null;
    }
  }
  companyOverall(start: string, end: string) {
    return this.rangeReport('hs_company_overall', 'Help Scout Company Overall', '/v2/reports/company', start, end);
  }
  conversationsOverall(start: string, end: string) {
    return this.rangeReport('hs_conversations_overall', 'Help Scout Conversations Overall', '/v2/reports/conversations', start, end);
  }
  happinessRatings(start: string, end: string) {
    return this.rangeReport('hs_happiness_ratings', 'Help Scout Happiness Ratings', '/v2/reports/happiness', start, end);
  }
  productivityOverall(start: string, end: string) {
    return this.rangeReport('hs_productivity_overall', 'Help Scout Productivity Overall', '/v2/reports/productivity', start, end);
  }
}

export class HelpScoutAttachmentService {
  constructor(private http: HelpScoutHttpClient) {}
  async getData(conversationId: number, threadId: number, attachmentId: number): Promise<{ data: Buffer; mimeType: string | null; filename: string | null } | null> {
    const raw = await this.http
      .request<{ data?: string }>(`/v2/conversations/${conversationId}/attachments/${attachmentId}/data`, { priority: PRIORITY.INDEXING })
      .catch((e: HelpScoutApiError) => {
        if (e.statusCode === 404) return null;
        throw e;
      });
    if (!raw?.data) return null;
    return { data: Buffer.from(raw.data, 'base64'), mimeType: null, filename: null };
  }
}
