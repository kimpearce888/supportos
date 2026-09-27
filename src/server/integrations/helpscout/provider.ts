/**
 * HelpScoutProvider: the integration boundary the whole application depends on.
 * The UI/sync layer never sees endpoint URLs or API versions (spec #4, #119).
 * Two implementations: real HTTP provider and FakeHelpScoutProvider (demo/tests).
 */
import type { PRIORITY } from '../../../shared/constants.js';

// ------- Normalized DTOs (version-neutral) -------

export interface HsUser {
  remoteId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  type: 'user' | 'system_user';
  timezone: string | null;
  photoUrl: string | null;
  initials: string | null;
  mention: string | null;
  jobTitle: string | null;
  phone: string | null;
  alternateEmails: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HsTeam {
  remoteId: number;
  name: string;
  memberUserIds: number[];
}

export interface HsMailbox {
  remoteId: number;
  name: string;
  slug: string | null;
  email: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HsFolder {
  remoteId: number;
  mailboxId: number;
  name: string;
  type: string | null;
  userId: number | null;
  totalCount: number | null;
  activeCount: number | null;
}

export interface HsTag {
  remoteId: number;
  name: string;
  slug: string | null;
  color: string | null;
  ticketCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HsField {
  remoteId: number;
  mailboxId: number;
  name: string;
  type: string | null;
  systemType: string | null;
  required: boolean;
  order: number | null;
  options: { id: number; order: number | null; label: string | null }[];
}

export interface HsSavedReply {
  remoteId: number;
  name: string;
  preview: string | null;
  text: string | null;
}

export interface HsWorkflow {
  remoteId: number;
  mailboxId: number | null;
  name: string;
  type: 'manual' | 'automatic';
  status: string | null;
  order: number | null;
}

export interface HsWebhookConfig {
  remoteId: number;
  url: string;
  events: string[];
  status: string | null;
}

export interface HsCustomer {
  remoteId: number;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  jobTitle: string | null;
  emails: { value: string | null; type: string | null }[];
  phones: { value: string | null; type: string | null }[];
  websites: { value: string | null }[];
  socialProfiles: { value: string | null; type: string | null }[];
  address: Record<string, string | null> | null;
  organization: { id: number; name: string | null } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HsOrganization {
  remoteId: number;
  name: string;
  domains: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HsPropertyDef {
  remoteId: number;
  name: string;
  slug: string | null;
  type: string | null;
  order: number | null;
}

export interface HsConversation {
  remoteId: number;
  number: number;
  type: string | null;
  folderId: number | null;
  status: 'active' | 'pending' | 'closed' | 'spam';
  state: string | null;
  subject: string | null;
  preview: string | null;
  mailboxId: number;
  assigneeId: number | null;
  assigneeType: 'user' | 'team' | null;
  assignedTeamId: number | null;
  closedAt: string | null;
  createdAt: string | null;
  userUpdatedAt: string | null;
  tags: { remoteId: number | null; name: string; color: string | null }[];
  primaryCustomerId: number | null;
  primaryCustomerName: string | null;
  primaryCustomerEmail: string | null;
  cc: string[];
  bcc: string[];
  snoozedUntil: string | null;
  customFields: { fieldId: number; value: string | null; text?: string | null; systemType?: string | null }[];
  threadCount: number;
}

export interface HsThread {
  remoteId: number;
  conversationId: number;
  type: string | null;
  state: string | null;
  status: string | null;
  actionType: string | null;
  actionText: string | null;
  body: string | null;
  sourceType: string | null;
  sourceVia: string | null;
  customer: { id: number | null; first: string | null; last: string | null; email: string | null } | null;
  createdBy: { id: number | null; type: string | null; first: string | null; last: string | null; email: string | null } | null;
  assignedTo: { id: number | null; type: string | null } | null;
  savedReplyId: number | null;
  to: string[];
  cc: string[];
  bcc: string[];
  createdAt: string | null;
  attachments: { id: number; filename: string | null; mimeType: string | null; size: number | null }[];
}

export interface HsRating {
  remoteId: number;
  conversationId: number | null;
  threadId: number | null;
  rating: 'great' | 'okay' | 'not-good' | null;
  comments: string | null;
  customerId: number | null;
  customerName: string | null;
  userId: number | null;
  createdAt: string | null;
}

export interface HsUserStatus {
  userId: number;
  emailStatus: string | null;
  emailUpdatedAt: string | null;
  chatStatus: string | null;
  mailboxStatuses: Record<string, string>;
}

// ------- Read query types -------

export interface ConversationQuery {
  status?: 'active' | 'all' | 'closed' | 'open' | 'pending' | 'spam';
  mailboxId?: number;
  contactId?: number;
  modifiedSince?: string;
  number?: number;
  cursor?: string | null;
  pageSize?: number;
  /** v3 supports embed=threads to inline thread data (chat threads may truncate). */
  embed?: 'threads';
}

export interface CustomerQuery {
  modifiedSince?: string;
  cursor?: string | null;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  page?: { size?: number; totalElements?: number; totalPages?: number; number?: number };
  /** When the request used embed=threads, the inlined threads for the returned conversations. */
  embeddedThreads?: HsThread[];
}

// ------- Write payloads -------

export interface CreateReplyInput {
  conversationId: number;
  text: string;
  draft: boolean;
  customerIds?: number[];
  cc?: string[];
  bcc?: string[];
  statusAfter?: 'active' | 'closed' | 'pending' | 'spam' | 'open' | 'inbox_predefined' | null;
  assignTo?: number | null;
  attachments?: { fileName: string; mimeType: string; dataBase64: string }[];
}

export interface CreateNoteInput {
  conversationId: number;
  text: string;
}

export interface ConversationPatch {
  subject?: string;
  status?: 'active' | 'closed' | 'pending' | 'spam';
  assignTo?: number | null; // null = un-assign
  mailboxId?: number;
  primaryCustomerId?: number;
  publishDraft?: boolean;
}

export interface HsReportRow {
  key: string;
  name: string;
  source: 'helpscout';
  data: unknown;
}

// ------- Provider interface -------

export interface HelpScoutProvider {
  readonly kind: 'real' | 'fake';

  // Account + people
  getMe(): Promise<HsUser>;
  listUsers(page?: number): Promise<Page<HsUser>>;
  listSystemUsers(): Promise<HsUser[]>;
  listTeams(): Promise<HsTeam[]>;
  getUserStatus(userId: number): Promise<HsUserStatus | null>;

  // Structure
  listMailboxes(): Promise<HsMailbox[]>;
  listFolders(mailboxId: number): Promise<HsFolder[]>;
  listInboxFields(mailboxId: number): Promise<HsField[]>;
  listSavedReplies(mailboxId: number): Promise<HsSavedReply[]>;
  getRoutingConfiguration(mailboxId: number): Promise<unknown | null>;
  listTags(): Promise<HsTag[]>;
  listWorkflows(mailboxId?: number): Promise<HsWorkflow[]>;
  listWebhooks(): Promise<HsWebhookConfig[]>;

  // Properties
  listCustomerPropertyDefinitions(): Promise<HsPropertyDef[]>;
  listOrganizationPropertyDefinitions(): Promise<HsPropertyDef[]>;

  // Customers + organizations
  listCustomers(query: CustomerQuery): Promise<Page<HsCustomer>>;
  getCustomer(customerId: number): Promise<HsCustomer | null>;
  listOrganizations(): Promise<HsOrganization[]>;

  // Conversations + threads
  listConversations(query: ConversationQuery): Promise<Page<HsConversation>>;
  getConversation(conversationId: number): Promise<HsConversation | null>;
  listThreads(conversationId: number): Promise<HsThread[]>;

  // Ratings
  getRating(ratingId: number): Promise<HsRating | null>;
  /**
   * Ratings list: the public API does not document a polling list-ratings endpoint;
   * ratings normally arrive via the satisfaction.ratings webhook. The fake provider
   * returns its seeded ratings; the real provider returns [] (honest capability).
   */
  listAllRatings(): Promise<HsRating[]>;

  // Reports (native Help Scout reporting import)
  getCompanyOverallReport(start: string, end: string): Promise<HsReportRow | null>;
  getConversationsOverallReport(start: string, end: string): Promise<HsReportRow | null>;
  getHappinessRatingsReport(start: string, end: string): Promise<HsReportRow | null>;
  getProductivityOverallReport(start: string, end: string): Promise<HsReportRow | null>;

  // Writes (v2 documented operations)
  createReplyThread(input: CreateReplyInput): Promise<{ threadId: number; conversationId: number }>;
  createNoteThread(input: CreateNoteInput): Promise<{ threadId: number; conversationId: number }>;
  updateConversation(conversationId: number, patch: ConversationPatch): Promise<boolean>;
  updateTags(conversationId: number, tags: string[]): Promise<boolean>;
  updateCustomFields(conversationId: number, fields: { id: number; value: string | null }[]): Promise<boolean>;
  snoozeConversation(conversationId: number, snoozedUntil: string, unsnoozeOnCustomerReply: boolean): Promise<boolean>;
  unsnoozeConversation(conversationId: number): Promise<boolean>;
  scheduleThread(conversationId: number, threadId: number, scheduledFor: string, unscheduleOnCustomerReply: boolean): Promise<boolean>;
  publishScheduledThread(conversationId: number, threadId: number): Promise<boolean>;
  deleteThreadSchedule(conversationId: number, threadId: number): Promise<boolean>;
  runWorkflow(workflowId: number, conversationId: number): Promise<boolean>;
  getAttachmentData(conversationId: number, threadId: number, attachmentId: number): Promise<{ data: Buffer; mimeType: string | null; filename: string | null } | null>;

  // Health / queue introspection
  ping(): Promise<boolean>;
}

export type ProviderPriority = (typeof PRIORITY)[keyof typeof PRIORITY];
