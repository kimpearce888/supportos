import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { ConversationSummary, ConversationListResponse, DashboardStats } from '../../shared/types.js';

export function useConversations(view: string, page: number, tag?: string | null) {
  return useQuery({
    queryKey: ['conversations', view, page, tag ?? null],
    queryFn: () =>
      api.get<ConversationListResponse>(
        `/api/conversations?view=${encodeURIComponent(view)}&page=${page}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`
      )
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

export function useDashboard(days: number) {
  return useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => api.get<DashboardStats>(`/api/analytics/dashboard?days=${days}`)
  });
}

export function useReference() {
  return {
    mailboxes: useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: number; remote_id: number; name: string; email: string | null }[]>('/api/mailboxes') }),
    tags: useQuery({ queryKey: ['tags-all'], queryFn: () => api.get<{ id: number; name: string; ticket_count: number }[]>('/api/tags') }),
    savedReplies: useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ saved_replies: { id: number; name: string; preview: string; text: string | null }[] }>('/api/saved-replies') })
  };
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
