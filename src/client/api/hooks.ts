import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { ConversationSummary, ConversationListResponse, DashboardStats, DocsCollectionInfo, DocsArticleSummary, DocsArticleDetail, DocsStats, DocsSearchResponse, SlaReportInfo } from '../../shared/types.js';
import type { SavedInboxView, TicketStateDef, StateTransition, ConversationEvent, ResponseState } from '../../shared/activity.js';

// ---------------- v1.7.0 inbox filters ----------------

export interface InboxFilters {
  activityField?: string | null;
  dateMode?: string | null;
  from?: string | null;
  to?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  responseState?: string | null;
  priority?: string | null;
  ticketStateId?: string | null;
  sort?: string | null;
  savedViewId?: string | null;
}

export function useConversations(view: string, page: number, tag?: string | null, channel?: string | null, filters?: InboxFilters) {
  const f = filters ?? {};
  const params = new URLSearchParams();
  params.set('view', view);
  params.set('page', String(page));
  if (tag) params.set('tag', tag);
  if (channel) params.set('channel', channel);
  for (const key of ['activityField', 'dateMode', 'from', 'to', 'fromTime', 'toTime', 'responseState', 'priority', 'ticketStateId', 'sort', 'savedViewId'] as const) {
    const v = f[key];
    if (v) params.set(key, v);
  }
  const qs = params.toString();
  return useQuery({
    queryKey: ['conversations', view, page, tag ?? null, channel ?? null, f.activityField ?? null, f.dateMode ?? null, f.from ?? null, f.to ?? null, f.fromTime ?? null, f.toTime ?? null, f.responseState ?? null, f.priority ?? null, f.ticketStateId ?? null, f.sort ?? null, f.savedViewId ?? null],
    queryFn: () => api.get<ConversationListResponse & { notes?: string[] }>(`/api/conversations?${qs}`)
  });
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  threads: {
    id: number;
    type: string;
    state: string;
    body_text: string;
    body_html: string | null;
    from_name: string | null;
    from_email: string | null;
    from_type: string | null;
    created_by_name: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    remote_created_at: string | null;
    scheduled_for: string | null;
    attachments: { id: number; filename: string; mime_type: string | null; size: number | null; state: string }[];
  }[];
  custom_fields: { field_id: number; name: string; type: string; system_type: string | null; value: string | null; text_value: string | null; field_remote_id: number; options: { id: number; label: string }[] }[];
  inbox_fields: { id: number; remote_id: number; name: string; type: string; system_type: string | null; options: { id: number; remote_id: number; label: string; order: number }[] }[];
  customer: { id: number; first_name: string | null; last_name: string | null; emails: string[]; phones: string[]; organization_name: string | null; open_conversation_count: number; conversation_count: number; average_rating: number | null; job_title: string | null } | null;
  customer_history: { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; thread_count: number }[];
  customer_memories: { id: number; key: string; value: string; source: string; confidence: string; last_seen_at: string | null }[];
  ai_drafts: { id: number; content: string; mode: string; state: string; created_at: string; verification: { verified: boolean; unsupported_claims: string[]; missing_questions: string[]; internal_leakage: string[]; conflicts: string[]; warnings: string[] } | null; sources: { source_type: string; source_id: number; title: string; visibility: string }[]; model: string | null }[];
  ai_analysis: { run: { id: number; model: string | null; created_at: string; latency_ms: number | null }; analysis: { intent: string | null; primary_question: string | null; secondary_questions: string[]; customer_goal: string | null; product: string | null; feature: string | null; problem_type: string | null; urgency: string | null; sentiment: string | null; known_issue_candidate: string | null; issue_cluster_candidate: string | null; missing_information: string[]; summary: string | null; confidence: string }; sources: { source_type: string; source_id: number; title: string; visibility: string }[] } | null;
  audit: { id: number; timestamp: string; actor: string; action: string; ai_involvement: number }[];
  workflows: { id: number; remote_id: number; name: string; type: string; status: string | null }[];
  users: { id: number; remote_id: number; first_name: string; last_name: string; email: string | null }[];
  teams: { id: number; remote_id: number; name: string }[];
  // v1.7.0 activity intelligence
  activity: {
    response_state: ResponseState;
    ages_minutes: Record<string, number | null>;
    ages_human: Record<string, string | null>;
    event_counts: Record<string, number>;
    history_complete: boolean;
    ticket_state: TicketStateDef | null;
    state_history: StateTransition[];
    state_lifecycle: {
      current_state: TicketStateDef | null;
      time_in_current_state_min: number | null;
      transitions: number;
      per_state: { state_id: number; state_name: string; entries: number; total_minutes: number | null; avg_minutes: number | null; last_entered: string | null }[];
    };
  };
  ticket_states: TicketStateDef[];
}

export function useConversationDetail(id: number | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`),
    enabled: id != null && id > 0
  });
  return {
    ...query,
    invalidate: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', id] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    }
  };
}

export function useDashboard(days: number, mailboxIds?: number[] | null, channel?: string | null) {
  return useQuery({
    queryKey: ['dashboard', days, (mailboxIds ?? []).join(',') || null, channel ?? null],
    queryFn: () =>
      api.get<DashboardStats>(
        `/api/analytics/dashboard?days=${days}${mailboxIds && mailboxIds.length > 0 ? `&mailboxIds=${mailboxIds.join(',')}` : ''}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`
      )
  });
}

export function useReference() {
  return {
    mailboxes: useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: number; remote_id: number; name: string; email: string | null }[]>('/api/mailboxes') }),
    tags: useQuery({ queryKey: ['tags-all'], queryFn: () => api.get<{ id: number; name: string; ticket_count: number }[]>('/api/tags') }),
    savedReplies: useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ saved_replies: { id: number; name: string; preview: string; text: string | null }[] }>('/api/saved-replies') })
  };
}

// ---------------- Docs mirror (v1.3.0) ----------------

export function useDocsStats() {
  return useQuery({ queryKey: ['docs', 'stats'], queryFn: () => api.get<DocsStats>('/api/docs/stats') });
}

export function useDocsCollections() {
  return useQuery({
    queryKey: ['docs', 'collections'],
    queryFn: () => api.get<{ collections: DocsCollectionInfo[]; docs_sync_available: boolean }>('/api/docs/collections')
  });
}

export function useDocsArticles(collectionId: number | null, q: string, status?: string | null) {
  return useQuery({
    queryKey: ['docs', 'articles', collectionId, q, status ?? null],
    queryFn: () =>
      api.get<{ articles: DocsArticleSummary[]; total: number; page: number; page_size: number }>(
        `/api/docs/articles?page=1&pageSize=50${collectionId ? `&collectionId=${collectionId}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`
      )
  });
}

export function useDocsArticle(id: number | null) {
  return useQuery({
    queryKey: ['docs', 'article', id],
    queryFn: () => api.get<{ article: DocsArticleDetail }>(`/api/docs/articles/${id}`),
    enabled: id != null && id > 0
  });
}

/** v1.4.0: hybrid docs search (FTS5 + semantic when embeddings exist). */
export function useDocsSearch(q: string, semantic: boolean) {
  return useQuery({
    queryKey: ['docs', 'search', q, semantic],
    queryFn: () =>
      api.get<DocsSearchResponse>(
        `/api/docs/search?q=${encodeURIComponent(q)}&semantic=${semantic ? '1' : '0'}&limit=25`
      ),
    enabled: q.trim().length > 0
  });
}

/** v1.4.0: SLA report (per mailbox, business minutes). */
export function useSlaReport(days: number) {
  return useQuery({
    queryKey: ['sla-report', days],
    queryFn: () => api.get<SlaReportInfo>(`/api/reports/sla?days=${days}`)
  });
}

export interface BusinessHoursRow {
  mailbox_id: number;
  name: string;
  configured: boolean;
  timezone: string | null;
  days: number[] | null;
  start_minute: number | null;
  end_minute: number | null;
  first_response_target_min: number | null;
  resolution_target_min: number | null;
}

export function useBusinessHours() {
  return useQuery({ queryKey: ['business-hours'], queryFn: () => api.get<{ mailboxes: BusinessHoursRow[] }>('/api/settings/business-hours') });
}

// ---------------- Client Interaction Intelligence ----------------

export function useInteractionCard(conversationId: number | null) {
  return useQuery({
    queryKey: ['interaction', conversationId],
    queryFn: () => api.get<{ card: import('../../shared/types.js').InteractionCard; labels: { featureTitle: string; note: string } }>(`/api/interaction/${conversationId}`),
    enabled: conversationId != null && conversationId > 0
  });
}

export function useInteractionProfile(customerId: number | null) {
  return useQuery({
    queryKey: ['interaction-profile', customerId],
    queryFn: () => api.get<{ profile: import('../../shared/types.js').ClientInteractionProfile }>(`/api/interaction/profile/${customerId}`),
    enabled: customerId != null && customerId > 0
  });
}

export function useInteractionEvidence(conversationId: number | null) {
  return useQuery({
    queryKey: ['interaction-evidence', conversationId],
    queryFn: () => api.get<{ observations: { dimension: string; value: string; confidence: string; evidence_excerpt: string | null; conversation_local_id: number | null; thread_local_id: number | null; observed_at: string; provenance: string }[] }>(`/api/interaction/${conversationId}/evidence`),
    enabled: conversationId != null && conversationId > 0
  });
}

// ---------------- v1.7.0 activity engine ----------------

export function useInboxViews() {
  return useQuery({ queryKey: ['inbox-views'], queryFn: () => api.get<{ views: SavedInboxView[] }>('/api/inbox-views') });
}

export function useTicketStates() {
  return useQuery({
    queryKey: ['ticket-states'],
    queryFn: () => api.get<{ states: TicketStateDef[]; bottlenecks: { state_id: number; state_name: string; conversations: number; avg_minutes: number | null; max_minutes: number | null }[] }>('/api/ticket-states')
  });
}

export function useConversationEvents(id: number | null) {
  return useQuery({
    queryKey: ['conversation-events', id],
    queryFn: () => api.get<{ conversation_id: number; events: ConversationEvent[]; counts: Record<string, number> }>(`/api/conversations/${id}/events?limit=500`),
    enabled: id != null && id > 0
  });
}

// ---------------- v1.8.0 collaboration (M2) ----------------

export interface NotificationRow {
  id: number;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  target_user_local_id: number | null;
  actor_user_local_id: number | null;
  conversation_id: number | null;
  conversation_number: number | null;
  customer_local_id: number | null;
  issue_id: number | null;
  campaign_id: number | null;
  job_id: number | null;
  side_thread_id: number | null;
  created_at: string;
  read_at: string | null;
}

export function useNotifications(opts: { unreadOnly?: boolean; type?: string | null; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.unreadOnly) params.set('unreadOnly', 'true');
  if (opts.type) params.set('type', opts.type);
  params.set('limit', String(opts.limit ?? 100));
  return useQuery({
    queryKey: ['notifications', opts.unreadOnly ?? false, opts.type ?? null, opts.limit ?? 100],
    queryFn: () => api.get<{ notifications: NotificationRow[]; total: number; unread: number }>(`/api/notifications?${params.toString()}`),
    refetchInterval: 60_000
  });
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ['notification-unread'],
    queryFn: () => api.get<{ unread: number }>('/api/notifications/unread-count'),
    refetchInterval: 30_000
  });
}

export function useNotificationPrefs() {
  return useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => api.get<{ prefs: { type: string; enabled: boolean; default_enabled: boolean }[] }>('/api/notifications/prefs')
  });
}

export function useMentionQueue() {
  return useQuery({
    queryKey: ['mention-queue'],
    queryFn: () => api.get<{
      me: number | null;
      notifications: NotificationRow[];
      side_thread_mentions: { message_id: number; thread_id: number; thread_title: string; conversation_id: number; conversation_number: number | null; author: string | null; body: string; created_at: string }[];
    }>('/api/notifications/mentions')
  });
}

export function useOperationsCenter(mailboxIds: number[] | null) {
  const mailboxes = mailboxIds && mailboxIds.length > 0 ? mailboxIds.join(',') : 'all';
  return useQuery({
    queryKey: ['operations-center', mailboxes],
    queryFn: () => api.get<import('../../shared/collaboration.js').OperationsSnapshot>(`/api/operations/center?mailboxes=${encodeURIComponent(mailboxes)}`),
    refetchInterval: 30_000
  });
}

export function useWorkload() {
  return useQuery({
    queryKey: ['operations-workload'],
    queryFn: () => api.get<import('../../shared/collaboration.js').WorkloadSnapshotResponse>('/api/operations/workload'),
    refetchInterval: 60_000
  });
}

export function useSuggestedAssignees(limit = 10) {
  return useQuery({
    queryKey: ['suggested-assignees', limit],
    queryFn: () => api.get<{ suggestions: import('../../shared/collaboration.js').SuggestedAssigneeResponse[] }>(`/api/operations/suggested-assignees?limit=${limit}`),
    refetchInterval: 60_000
  });
}

export function useMentionDirectory() {
  return useQuery({
    queryKey: ['mention-directory'],
    queryFn: () => api.get<{ users: { user_local_id: number; display_name: string; mention: string | null }[]; teams: { team_local_id: number; name: string }[] }>('/api/mention-directory')
  });
}

export function useSideThreads(conversationId: number | null) {
  return useQuery({
    queryKey: ['side-threads', conversationId],
    queryFn: () => api.get<{ side_threads: import('../../shared/collaboration.js').SideThread[] }>(`/api/conversations/${conversationId}/side-threads`),
    enabled: conversationId != null && conversationId > 0
  });
}

export function useSideThread(threadId: number | null) {
  return useQuery({
    queryKey: ['side-thread', threadId],
    queryFn: () => api.get<{ side_thread: import('../../shared/collaboration.js').SideThreadDetail }>(`/api/side-threads/${threadId}`),
    enabled: threadId != null && threadId > 0
  });
}
