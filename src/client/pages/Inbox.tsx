import { type ReactNode, useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Reply, StickyNote, Send, Bookmark, ExternalLink, Paperclip, Download,
  ChevronLeft, ChevronRight, Bot, User, Clock, Trash2, CheckCircle2, XCircle,   ShieldCheck, Sparkles, Wand2, ChevronDown, ChevronUp, Tag, Mail, Building2,
  AlertTriangle, Workflow, MessageCircle, Flame
} from 'lucide-react';
import { api } from '../api/client.js';
import { useConversations, useConversationDetail, useReference } from '../api/hooks.js';
import { ClientIntelligenceCard } from '../components/common/InteractionCard.js';
import { Spinner, EmptyState, ErrorState, StatusBadge, TagChips, RelativeTime, ConfidenceBadge, VerifiedBadge } from '../components/common/ui.js';
import { ConfirmDialog, Modal } from '../components/common/overlays.js';
import { SafeHtml } from '../components/common/SafeHtml.js';
import { useUiStore } from '../state/uiStore.js';
import { FilterBar, SavedViewsManager, type FilterBarValues } from '../components/inbox/FilterBar.js';
import { PriorityBadge, ResponseStateBadge, TicketStateBadge, ActivityTimeline, PriorityPicker, TicketStatePicker } from '../components/inbox/ActivityUI.js';
import { SideThreadsPanel } from '../components/inbox/SideThreads.js';
import { QaPanel } from '../components/inbox/QaPanel.js';
import { TranslationPanel } from '../components/inbox/TranslationPanel.js';
import { CoachingPanel } from '../components/inbox/CoachingPanel.js';
import { MemoryPanel } from '../components/inbox/MemoryPanel.js';
import { CopilotPanel } from '../components/inbox/CopilotPanel.js';
import { AttributeSnapshotCard } from '../components/inbox/AttributeSnapshotCard.js';
import { MentionTextarea } from '../components/inbox/MentionTextarea.js';
import { useMentionDirectory } from '../api/hooks.js';
import type { } from '../../shared/types.js';

const VIEWS = [
  { key: 'active', label: 'Active' },
  { key: 'my-tickets', label: 'My Tickets' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'pending', label: 'Pending' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' }
];

const CHANNEL_FILTERS = [
  { value: null, label: 'All' },
  { value: 'email', label: 'Email' },
  { value: 'chat', label: 'Chat' }
] as const;

export function InboxPage(): ReactNode {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { id } = useParams();
  const view = params.get('view') ?? 'active';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const channelParam = params.get('channel');
  const channel = channelParam === 'email' || channelParam === 'chat' ? channelParam : null;
  const selectedId = id != null && Number.isFinite(Number(id)) ? Number(id) : null;

  // v1.7.0: activity/date/state filters live in the URL, like view/channel/tag.
  const filterValues: FilterBarValues = {
    activityField: params.get('activityField'),
    dateMode: params.get('dateMode'),
    from: params.get('from'),
    to: params.get('to'),
    responseState: params.get('responseState'),
    priority: params.get('priority'),
    ticketStateId: params.get('ticketStateId'),
    sort: params.get('sort'),
    savedViewId: params.get('savedViewId'),
    // v1.9.0 (M3): live AI-attribute filter (closed catalog, server-validated).
    aiAttribute: params.get('aiAttribute'),
    aiAttrOp: params.get('aiAttrOp'),
    aiAttrValue: params.get('aiAttrValue')
  };
  const setFilters = (patch: Partial<FilterBarValues>): void => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    next.set('page', '1');
    setParams(next, { replace: false });
    setSelection([]);
  };
  const { data, isLoading, isError, error } = useConversations(view, page, params.get('tag'), channel, filterValues);
  const pushToast = useUiStore((s) => s.pushToast);

  const [selection, setSelection] = useState<number[]>([]);
  const [bulkAction, setBulkAction] = useState<string | null>(null);

  const setView = (v: string): void => {
    // Preserve the tag filter (and any other params) when switching views -
    // replacing the whole object silently dropped an active tag filter.
    const next = new URLSearchParams(params);
    next.set('view', v);
    next.set('page', '1');
    setParams(next);
    setSelection([]);
  };

  const setChannel = (c: string | null): void => {
    // Channel filter (v1.3.0): email vs Beacon chat sessions. Preserves view/tag.
    const next = new URLSearchParams(params);
    next.set('page', '1');
    if (c == null) next.delete('channel');
    else next.set('channel', c);
    setParams(next, { replace: true });
    setSelection([]);
  };

  const conversations = data?.conversations ?? [];

  const toggleSelect = (convId: number, e: React.ChangeEvent): void => {
    void e;
    setSelection((s) => (s.includes(convId) ? s.filter((x) => x !== convId) : [...s, convId]));
  };

  const queryClient = useQueryClient();
  const bulk = useMutation({
    mutationFn: (input: { action: string; params: Record<string, string | number | null> }) => api.post<{ ok: boolean; message: string }>('/api/conversations/bulk', { conversationIds: selection, action: input.action, params: input.params }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setBulkAction(null);
      setSelection([]);
      // v1.6.0 audit fix: bulk tag/assign/close changed server state but the
      // list (and nav badge counts) kept showing the pre-bulk state until a
      // manual refresh. Invalidate the conversation-shaped queries.
      // v2.2.1 audit fix: the OPEN conversation detail also showed pre-bulk
      // status/tags - invalidate it too when the selection includes it.
      if (r.ok) {
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
        if (selectedId != null && selection.includes(selectedId)) {
          void queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
        }
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <div className="inbox-layout">
      <div className="conversation-list-pane" role="region" aria-label="Conversation list">
        <div className="view-tabs" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.key} role="tab" aria-selected={view === v.key} className={`view-tab ${view === v.key ? 'active' : ''}`} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="view-tabs secondary" role="group" aria-label="Channel filter">
          {CHANNEL_FILTERS.map((f) => (
            <button key={f.label} role="tab" aria-selected={channel === f.value} className={`view-tab small ${channel === f.value ? 'active' : ''}`} onClick={() => setChannel(f.value)}>
              {f.value === 'chat' ? <MessageCircle size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} /> : f.value === 'email' ? <Mail size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} /> : null}
              {f.label}
            </button>
          ))}
        </div>
        {/* v1.7.0: activity/date/state filters + saved views (URL-backed) */}
        <FilterBar values={filterValues} onChange={setFilters} notes={data?.notes} />
        <SavedViewsManager current={filterValues.savedViewId} onSelect={(v) => setFilters({ savedViewId: v })} />
        {selection.length > 0 ? (
          <div className="flex wrap" style={{ padding: '6px 10px', gap: 6, borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs muted">{selection.length} selected</span>
            <button className="btn small" onClick={() => setBulkAction('tag')}>
              <Tag size={11} /> Tag
            </button>
            <button className="btn small" onClick={() => setBulkAction('assign')}>
              <User size={11} /> Assign
            </button>
            <button className="btn small" onClick={() => setBulkAction('close')}>
              <CheckCircle2 size={11} /> Close
            </button>
            <button className="btn ghost small" onClick={() => setSelection([])}>
              Clear
            </button>
          </div>
        ) : null}
        <div style={{ flex: 1, overflowY: 'auto' }} role="list">
          {isLoading ? <Spinner label="Loading conversations" /> : null}
          {isError ? <ErrorState message="Could not load conversations." detail={error instanceof Error ? error.message : undefined} /> : null}
          {!isLoading && !isError && conversations.length === 0 ? <EmptyState title="No conversations in this view" hint="Try another view, or run a sync from Sync Health." /> : null}
          {conversations.map((c) => (
            <div
              key={c.id}
              role="listitem"
              // v1.6.0 audit fix: rows were click-only - keyboard users could
              // never open a conversation from the main list. Search results
              // already did this correctly; the inbox now matches.
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/inbox/conversation/${c.id}`);
                }
              }}
              className={`conversation-item ${selectedId === c.id ? 'selected' : ''} ${c.is_unread ? 'unread' : ''}`}
              onClick={() => navigate(`/inbox/conversation/${c.id}`)}
            >
              <div className="flex" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" aria-label={`Select conversation ${c.number}`} checked={selection.includes(c.id)} onChange={(e) => toggleSelect(c.id, e)} onClick={(e) => e.stopPropagation()} style={{ marginTop: 3, marginRight: 6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="conv-subject">
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
                  </div>
                  <div className="conv-preview">{c.customer_name ?? 'Unknown'} · {c.preview}</div>
                  <div className="conv-meta">
                    <StatusBadge status={c.status} />
                    <ResponseStateBadge state={c.response_state} />
                    <PriorityBadge priority={c.priority} />
                    {c.customer_waiting_since ? (
                      <span className="badge warn" title={`Customer waiting since ${new Date(c.customer_waiting_since).toLocaleString()}`}>
                        <Clock size={10} /> waiting <RelativeTime iso={c.customer_waiting_since} />
                      </span>
                    ) : null}
                    {c.type === 'chat' ? <span className="badge ok"><MessageCircle size={10} /> {c.source_via === 'beacon' ? 'Beacon' : 'chat'}</span> : null}
                    <span className="text-xs muted">#{c.number}</span>
                    {c.mailbox_name ? <span className="badge">{c.mailbox_name}</span> : null}
                    {c.ai_analysis_status === 'analyzed' ? <span className="badge ai"><Bot size={10} /> AI</span> : null}
                    {c.known_issue_id ? <span className="badge warn">known issue</span> : null}
                    {c.snoozed_until ? <span className="badge"><Clock size={10} /> snoozed</span> : null}
                    <span style={{ marginLeft: 'auto' }}>
                      <RelativeTime iso={c.last_activity_at} />
                    </span>
                  </div>
                  {c.tags.length > 0 ? (
                    <div className="mt-8">
                      <TagChips tags={c.tags.slice(0, 5)} />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
        {data && data.total > (data.page_size ?? 50) ? (
          <div className="flex-between" style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
            <button className="btn small" disabled={page <= 1} onClick={() => { const next = new URLSearchParams(params); next.set('view', view); next.set('page', String(Math.max(1, page - 1))); setParams(next); }}>
              <ChevronLeft size={12} /> Prev
            </button>
            <span className="text-xs muted">
              {data.total} conversations
            </span>
            <button className="btn small" disabled={page * (data.page_size ?? 50) >= data.total} onClick={() => { const next = new URLSearchParams(params); next.set('view', view); next.set('page', String(page + 1)); setParams(next); }}>
              Next <ChevronRight size={12} />
            </button>
          </div>
        ) : null}
      </div>
      {/* v2.2.1 audit fix: key by conversation id - without it, React reused the
          same ConversationDetail instance across conversations and the composer
          kept the PREVIOUS conversation's typed reply / AI draft / panel state,
          making it one click away from being sent to the wrong customer. */}
      <div className="conversation-pane">{selectedId ? <ConversationDetail key={selectedId} id={selectedId} /> : <EmptyState icon="inbox" title="Select a conversation" hint="Choose a conversation from the list to view its thread, customer context and AI analysis." />}</div>
      {bulkAction ? (
        <BulkActionModal
          action={bulkAction}
          count={selection.length}
          onClose={() => setBulkAction(null)}
          onConfirm={(params) => bulk.mutate({ action: bulkAction, params })}
        />
      ) : null}
    </div>
  );
}

function BulkActionModal({ action, count, onClose, onConfirm }: { action: string; count: number; onClose: () => void; onConfirm: (params: Record<string, string | number | null>) => void }): ReactNode {
  const [tag, setTag] = useState('');
  const [assignee, setAssignee] = useState('');
  // v2.2.1 audit fix: removed leftover dead destructuring
  // (`const { data: users } = useReference().tags` voided immediately below) -
  // the assign picker fetches its own reference data.
  return (
    <Modal
      title={`Bulk ${action}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={action === 'tag' && !tag.trim()} onClick={() => onConfirm(action === 'tag' ? { tag } : action === 'assign' ? { userId: assignee === '' ? null : Number(assignee) } : {})}>
            Apply to {count} conversation{count > 1 ? 's' : ''}
          </button>
        </>
      }
    >
      <p className="text-sm">This action is processed through the local API queue. Each conversation is updated individually with fresh-state merge protection.</p>
      {action === 'tag' ? (
        <div className="form-row">
          <label className="field" htmlFor="bulk-tag">Tag to add</label>
          <input id="bulk-tag" className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. timezone" />
        </div>
      ) : null}
      {action === 'assign' ? <AssigneePicker onChange={setAssignee} /> : null}
      {action === 'close' ? <div className="alert warn">These conversations will be closed in Help Scout. This is a customer-visible state change.</div> : null}
    </Modal>
  );
}

function AssigneePicker({ onChange }: { onChange: (v: string) => void }): ReactNode {
  const [users, setUsers] = useState<{ remote_id: number; first_name: string; last_name: string }[]>([]);
  const [teams, setTeams] = useState<{ remote_id: number; name: string }[]>([]);
  useEffect(() => {
    api.get<{ users: { remote_id: number; first_name: string; last_name: string }[]; }>('/api/users').then((r) => setUsers(r.users)).catch(() => undefined);
    api.get<{ remote_id: number; name: string }[]>('/api/teams').then(setTeams).catch(() => undefined);
  }, []);
  return (
    <div className="form-row">
      <label className="field" htmlFor="assignee">Assign to</label>
      <select id="assignee" className="input" onChange={(e) => onChange(e.target.value)} defaultValue="">
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.remote_id} value={String(u.remote_id)}>{u.first_name} {u.last_name}</option>
        ))}
        {teams.map((t) => (
          <option key={t.remote_id} value={String(t.remote_id)}>{t.name} (team)</option>
        ))}
      </select>
    </div>
  );
}

// ====================================================================

function ConversationDetail({ id }: { id: number }): ReactNode {
  const { data, isLoading, error, invalidate } = useConversationDetail(id);
  const [showAudit, setShowAudit] = useState(false);
  if (isLoading) return <Spinner label="Loading conversation" />;
  if (error || !data) return <div className="page"><div className="alert error">Could not load conversation: {(error as Error | null)?.message ?? 'unknown error'}</div></div>;
  const c = data.conversation;
  return (
    <>
      <ConversationHeader data={data} onRefresh={invalidate} />
      <div className="thread-scroller" role="region" aria-label="Conversation thread">
        {c.merged_into_conversation_id ? (
          <div className="alert info mb-16">
            This conversation was merged into <Link to={`/inbox/conversation/${c.merged_into_conversation_id}`}>another conversation</Link>. Historical references are preserved.
          </div>
        ) : null}
        {data.threads.map((t) => <ThreadItem key={t.id} thread={t} conversationId={id} onRefresh={invalidate} />)}
        {data.threads.length === 0 ? <EmptyState title="No threads synced yet" hint="Refresh the conversation to fetch its threads." /> : null}
      </div>
      <Composer conversationId={id} customerId={c.customer_id} customerEmail={c.customer_email} drafts={data.ai_drafts} onSent={invalidate} />
      <div style={{ borderTop: '1px solid var(--border)', padding: '6px 16px', background: 'var(--bg-raised)' }} className="flex-between">
        <button className="btn ghost small" onClick={() => setShowAudit(!showAudit)}>
          {showAudit ? <ChevronUp size={11} /> : <ChevronDown size={11} />} Audit trail ({data.audit.length})
        </button>
        <a className="btn ghost small" href={c.hs_url ?? '#'} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={11} /> Open in Help Scout
        </a>
      </div>
      {showAudit ? (
        <div style={{ maxHeight: 160, overflowY: 'auto', padding: '6px 16px', background: 'var(--bg-raised)', borderTop: '1px solid var(--border)' }}>
          {data.audit.map((a) => (
            <div key={a.id} className="text-xs" style={{ padding: '2px 0' }}>
              <RelativeTime iso={a.timestamp} /> · {a.actor} · <strong>{a.action}</strong>
              {a.ai_involvement ? <span className="badge ai" style={{ marginLeft: 6 }}>AI involved</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <ActivityTimeline conversationId={id} historyComplete={data.activity.history_complete} />
      <SideThreadsPanel conversationId={id} />
      {/* v2.1.0 (M5, plan phases 27 + 30): after-close QA + local translation. */}
      {/* v2.2.0 (M6, plan phases 35 + 36): advisory pre-send coaching lives in
          the Composer; customer memory composes here per customer. */}
      <div className="detail-extra-panels">
        <QaPanel conversationId={id} closed={c.status === 'closed'} />
        <TranslationPanel conversationId={id} />
        <MemoryPanel customerId={c.customer_id} conversationId={id} />
      </div>
      <ContextPane data={data} onRefresh={invalidate} />
    </>
  );
}

function ConversationHeader({ data, onRefresh }: { data: NonNullable<ReturnType<typeof useConversationDetail>['data']>; onRefresh: () => void }): ReactNode {
  const c = data.conversation;
  const pushToast = useUiStore((s) => s.pushToast);
  const [tagEdit, setTagEdit] = useState(false);
  const [fieldEdit, setFieldEdit] = useState(false);
  const [subjectEdit, setSubjectEdit] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const act = useMutation({
    mutationFn: (input: { path: string; body?: unknown; method?: 'post' | 'delete' }) =>
      input.method === 'delete' ? api.delete<{ ok: boolean; message: string; detail?: string }>(input.path, input.body) : api.post<{ ok: boolean; message: string; detail?: string }>(input.path, input.body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      onRefresh();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-raised)' }}>
      <div className="flex-between wrap">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {subjectEdit ? (
              <input
                className="input"
                defaultValue={c.subject}
                style={{ fontSize: 15, fontWeight: 600 }}
                autoFocus
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== c.subject) act.mutate({ path: `/api/conversations/${c.id}/subject`, body: { subject: e.target.value.trim() } });
                  setSubjectEdit(false);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <span onClick={() => setSubjectEdit(true)} title="Click to edit subject">{c.subject}</span>
            )}
          </h2>
          <div className="flex wrap mt-8" style={{ gap: 6 }}>
            <StatusBadge status={c.status} />
            <ResponseStateBadge state={c.response_state} />
            {data.activity.ticket_state ? <TicketStateBadge state={data.activity.ticket_state} /> : null}
            <span className="badge">#{c.number}</span>
            {data.active_incident ? (
              <Link
                to={`/incidents/${data.active_incident.incident_id}`}
                className={`badge ${data.active_incident.severity === 'sev1' || data.active_incident.severity === 'sev2' ? 'err' : 'warn'}`}
                title={`This conversation is counted in active incident ${data.active_incident.code} (${data.active_incident.status})`}
              >
                <Flame size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> {data.active_incident.code} · {data.active_incident.title.slice(0, 40)}
              </Link>
            ) : null}
            {c.mailbox_name ? <span className="badge">{c.mailbox_name}</span> : null}
            <span className="text-xs muted"><Mail size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {c.customer_email ?? c.customer_name}</span>
            <RelativeTime iso={c.remote_created_at} prefix="opened " />
            <RelativeTime iso={c.last_activity_at} prefix="· active " />
            {data.activity.ages_human.customer_waiting_duration ? (
              <span className="badge warn" title="Customer has been waiting for a response (deterministic, from local thread history)">
                <Clock size={10} /> waiting {data.activity.ages_human.customer_waiting_duration}
              </span>
            ) : null}
            {data.activity.state_lifecycle.time_in_current_state_min != null ? (
              <span className="badge" title="Time in the current SupportOS state">in state {data.activity.state_lifecycle.time_in_current_state_min >= 1440 ? `${Math.round(data.activity.state_lifecycle.time_in_current_state_min / 1440)}d` : data.activity.state_lifecycle.time_in_current_state_min >= 60 ? `${Math.round(data.activity.state_lifecycle.time_in_current_state_min / 60)}h` : `${data.activity.state_lifecycle.time_in_current_state_min}m`}</span>
            ) : null}
          </div>
        </div>
        <div className="flex wrap" style={{ gap: 6 }}>
          <PriorityPicker conversationId={c.id} current={c.priority} onDone={onRefresh} />
          <TicketStatePicker conversationId={c.id} current={data.activity.ticket_state} states={data.ticket_states} onDone={onRefresh} />
          <button className="btn small" onClick={() => act.mutate({ path: `/api/conversations/${c.id}/refresh` })} disabled={act.isPending}>
            <RefreshCw size={11} /> Refresh
          </button>
          <button className="btn small" onClick={() => setTagEdit(true)}><Tag size={11} /> Tags</button>
          <button className="btn small" onClick={() => setFieldEdit(true)}>Fields</button>
          <AssigneePickerInline conversationId={c.id} current={c.assignee_name} onDone={onRefresh} />
          <button className="btn small" onClick={() => setSnoozeOpen(true)}><Clock size={11} /> {c.snoozed_until ? 'Snoozed' : 'Snooze'}</button>
          {c.status !== 'closed' ? (
            <button className="btn small" onClick={() => setConfirmClose(true)}><CheckCircle2 size={11} /> Close</button>
          ) : (
            <button className="btn small" onClick={() => act.mutate({ path: `/api/conversations/${c.id}/status`, body: { status: 'active' } })}>Reopen</button>
          )}
        </div>
      </div>
      <div className="mt-8">
        <TagChips tags={c.tags} onRemove={(t) => act.mutate({ path: `/api/conversations/${c.id}/tags`, body: { remove: [t] } })} />
      </div>
      {tagEdit ? <TagEditor conversationId={c.id} current={c.tags} onClose={() => setTagEdit(false)} onSaved={onRefresh} /> : null}
      {fieldEdit ? <FieldEditor conversationId={c.id} fields={data.custom_fields} inboxFields={data.inbox_fields} onClose={() => setFieldEdit(false)} onSaved={onRefresh} /> : null}
      {snoozeOpen ? <SnoozeModal conversationId={c.id} snoozed={c.snoozed_until} onClose={() => setSnoozeOpen(false)} onSaved={onRefresh} /> : null}
      {confirmClose ? (
        <ConfirmDialog
          title="Close conversation"
          message="This changes the conversation status in Help Scout (customer-visible). Continue?"
          confirmLabel="Close conversation"
          onCancel={() => setConfirmClose(false)}
          onConfirm={() => {
            act.mutate({ path: `/api/conversations/${c.id}/status`, body: { status: 'closed' } });
            setConfirmClose(false);
          }}
        />
      ) : null}
    </div>
  );
}

function AssigneePickerInline({ conversationId, current, onDone }: { conversationId: number; current: string | null; onDone: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const act = useMutation({
    mutationFn: (userId: number | null) => api.post<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/assign`, { userId }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setOpen(false);
      onDone();
    }
  });
  const [users, setUsers] = useState<{ remote_id: number; first_name: string; last_name: string }[]>([]);
  const [teams, setTeams] = useState<{ remote_id: number; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    api.get<{ users: { remote_id: number; first_name: string; last_name: string }[] }>('/api/users').then((r) => setUsers(r.users)).catch(() => undefined);
    api.get<{ remote_id: number; name: string }[]>('/api/teams').then(setTeams).catch(() => undefined);
  }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)}>
        <User size={11} /> {current ?? 'Unassigned'}
      </button>
      {open ? (
        <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 500, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', minWidth: 180, maxHeight: 240, overflowY: 'auto' }}>
          <button className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => act.mutate(null)}>Unassign</button>
          {users.map((u) => (
            <button key={`u${u.remote_id}`} className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => act.mutate(u.remote_id)}>
              {u.first_name} {u.last_name}
            </button>
          ))}
          {teams.map((t) => (
            <button key={`t${t.remote_id}`} className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => act.mutate(t.remote_id)}>
              {t.name} (team)
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TagEditor({ conversationId, current, onClose, onSaved }: { conversationId: number; current: string[]; onClose: () => void; onSaved: () => void }): ReactNode {
  const [newTag, setNewTag] = useState('');
  const pushToast = useUiStore((s) => s.pushToast);
  const act = useMutation({
    mutationFn: (body: { add?: string[]; remove?: string[] }) => api.post<{ ok: boolean; message: string; detail?: string }>(`/api/conversations/${conversationId}/tags`, body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      onSaved();
    }
  });
  return (
    <Modal title="Edit tags" onClose={onClose}>
      <p className="text-sm muted">Tag updates always merge with the CURRENT Help Scout state - remote tags changed elsewhere are never overwritten.</p>
      <div className="mb-8">
        <TagChips tags={current} onRemove={(t) => act.mutate({ remove: [t] })} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newTag.trim()) {
            act.mutate({ add: [newTag.trim()] });
            setNewTag('');
          }
        }}
        className="flex"
      >
        <input className="input" placeholder="Add tag (Enter to apply)" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
        <button className="btn primary" type="submit">Add</button>
      </form>
    </Modal>
  );
}

function FieldEditor({ conversationId, fields, inboxFields, onClose, onSaved }: { conversationId: number; fields: { field_id: number; name: string; type: string; system_type: string | null; value: string | null; text_value: string | null; field_remote_id: number; options: { id: number; label: string }[] }[]; inboxFields: { id: number; remote_id: number; name: string; type: string; system_type: string | null; options: { id: number; remote_id: number; label: string }[] }[]; onClose: () => void; onSaved: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [values, setValues] = useState<Record<number, string>>(() => {
    // Keyed by the REMOTE field id: that is what the write path (Help Scout
    // PUT /fields and the fake provider) resolves. The previous local-id
    // keys made every save of existing values fail silently.
    const init: Record<number, string> = {};
    for (const f of fields) init[f.field_remote_id] = f.value ?? '';
    return init;
  });
  const act = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message: string; detail?: string }>(`/api/conversations/${conversationId}/fields`, {
        fields: Object.entries(values)
          .filter(([k]) => inboxFields.some((f) => f.remote_id === Number(k)) || fields.some((f) => f.field_remote_id === Number(k)))
          .map(([k, v]) => ({ id: Number(k), value: v || null }))
      }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      onSaved();
      onClose();
    }
  });
  const allFields = [
    ...inboxFields.map((f) => ({ remote_id: f.remote_id, name: f.name, type: f.type, system_type: f.system_type, options: f.options.map((o) => ({ id: o.id, label: o.label })), value: values[f.remote_id] ?? '' })),
    ...fields.filter((f) => !inboxFields.some((i) => i.remote_id === f.field_remote_id)).map((f) => ({ remote_id: f.field_remote_id, name: f.name, type: f.type, system_type: f.system_type, options: f.options, value: values[f.field_remote_id] ?? f.text_value ?? f.value ?? '' }))
  ];
  return (
    <Modal
      title="Custom fields"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => act.mutate()} disabled={act.isPending}>Save fields</button>
        </>
      }
    >
      <p className="text-sm muted">The complete field state is sent. Help Scout system fields (Topics, Sentiment) are preserved automatically when unchanged.</p>
      {allFields.length === 0 ? <EmptyState title="No custom fields for this inbox" /> : null}
      {allFields.map((f) => (
        <div className="form-row" key={f.remote_id}>
          <label className="field" htmlFor={`field-${f.remote_id}`}>
            {f.name} {f.system_type ? <span className="badge" style={{ marginLeft: 4 }}>system: {f.system_type}</span> : null}
          </label>
          {f.type === 'dropdown' ? (
            <select id={`field-${f.remote_id}`} className="input" value={values[f.remote_id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.remote_id]: e.target.value }))}>
              <option value="">—</option>
              {f.options.map((o) => (
                <option key={o.id} value={String(o.id)}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input id={`field-${f.remote_id}`} className="input" value={values[f.remote_id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.remote_id]: e.target.value }))} />
          )}
        </div>
      ))}
    </Modal>
  );
}

/** v2.2.1 audit fix: format an instant as the LOCAL wall-clock string a
 *  datetime-local input expects. The old code sliced the UTC ISO string, so
 *  the default snooze fired hours off local "tomorrow" and a stored UTC snooze
 *  pre-filled the field with UTC wall time (or nothing, Z-suffix inputs
 *  reject). Saving already parsed the input as local - only display was wrong. */
function toLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SnoozeModal({ conversationId, snoozed, onClose, onSaved }: { conversationId: number; snoozed: string | null; onClose: () => void; onSaved: () => void }): ReactNode {
  const snoozedMs = snoozed ? Date.parse(snoozed) : NaN;
  const [until, setUntil] = useState(
    Number.isFinite(snoozedMs) ? toLocalDatetimeInput(snoozedMs) : toLocalDatetimeInput(Date.now() + 86400000)
  );
  const pushToast = useUiStore((s) => s.pushToast);
  const act = useMutation({
    mutationFn: (body: { snoozedUntil: string; unsnoozeOnCustomerReply: boolean }) => api.post<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/snooze`, body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      onSaved();
      onClose();
    }
  });
  return (
    <Modal
      title="Snooze conversation"
      onClose={onClose}
      footer={
        <>
          {snoozed ? (
            <button
              className="btn"
              onClick={() =>
                api.delete<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/snooze`).then((r) => {
                  pushToast({ kind: 'success', message: r.message });
                  onSaved();
                  onClose();
                }).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not remove snooze.' }))
              }
            >
              Remove snooze
            </button>
          ) : null}
          <button
            className="btn primary"
            onClick={() => {
              // v1.6.0 audit fix: a cleared datetime-local input yields '' and
              // new Date('') is Invalid Date -> toISOString() throws RangeError.
              const t = new Date(until).getTime();
              if (!Number.isFinite(t)) {
                pushToast({ kind: 'error', message: 'Pick a valid snooze date and time first.' });
                return;
              }
              act.mutate({ snoozedUntil: new Date(t).toISOString(), unsnoozeOnCustomerReply: true });
            }}
          >
            Snooze
          </button>
        </>
      }
    >
      <div className="form-row">
        <label className="field" htmlFor="snooze-until">Snooze until</label>
        <input id="snooze-until" type="datetime-local" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <p className="text-xs muted">Customer replies can automatically unsnooze the conversation (recommended).</p>
    </Modal>
  );
}

function ThreadItem({ thread, conversationId, onRefresh }: { thread: NonNullable<ReturnType<typeof useConversationDetail>['data']>['threads'][number]; conversationId: number; onRefresh: () => void }): ReactNode {
  const isNote = thread.type === 'note';
  const isReply = thread.type === 'reply';
  const pushToast = useUiStore((s) => s.pushToast);
  const download = useMutation({
    mutationFn: (attachmentId: number) => api.post<{ ok: boolean; message: string }>(`/api/attachments/${attachmentId}/download`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      onRefresh();
    },
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Attachment download failed.' })
  });
  const initials = (thread.from_name ?? thread.created_by_name ?? '?')
    .split(' ')
    .map((p) => p.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className={`thread-item ${isNote ? 'note' : isReply ? 'reply' : thread.type === 'customer' ? 'customer' : ''}`}>
      <div className="thread-avatar" aria-hidden="true">{initials}</div>
      <div className="thread-bubble">
        <div className="thread-head">
          <span className="thread-author">{thread.from_name ?? thread.created_by_name ?? (thread.from_type === 'customer' ? 'Customer' : 'System')}</span>
          {isNote ? <span className="badge warn">internal note</span> : null}
          {thread.state === 'draft' ? <span className="badge">draft</span> : null}
          {thread.state === 'scheduled' ? <span className="badge warn">scheduled {thread.scheduled_for ? new Date(thread.scheduled_for).toLocaleString() : ''}</span> : null}
          {thread.from_type === 'system_user' ? <span className="badge ai"><Bot size={10} /> AI</span> : null}
          <RelativeTime iso={thread.remote_created_at} />
        </div>
        <SafeHtml html={thread.body_html} fallbackText={thread.body_text} />
        {isNote ? <NoteMentionChips bodyText={thread.body_text} /> : null}
        {thread.cc.length > 0 ? <div className="text-xs muted">cc: {thread.cc.join(', ')}</div> : null}
        {thread.attachments.length > 0 ? (
          <div className="mt-8">
            {thread.attachments.map((a) => (
              <span key={a.id} className="attachment-chip">
                <Paperclip size={11} />
                {a.filename}
                {a.size ? <span className="muted">({(a.size / 1024).toFixed(0)} KB)</span> : null}
                {a.state !== 'downloaded' ? (
                  <button className="btn ghost small" title="Download attachment" onClick={() => download.mutate(a.id)} disabled={download.isPending}>
                    <Download size={10} />
                  </button>
                ) : (
                  <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noopener noreferrer" className="btn ghost small" title="View attachment">
                    <ExternalLink size={10} />
                  </a>
                )}
              </span>
            ))}
          </div>
        ) : null}
        {thread.state === 'scheduled' ? (
          <div className="mt-8 flex" style={{ gap: 6 }}>
            <button
              className="btn small"
              onClick={() =>
                api.post<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/schedule/publish`, { threadId: thread.id }).then((r) => {
                  pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
                  onRefresh();
                }).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Publish failed.' }))
              }
            >
              <Send size={11} /> Send now
            </button>
            <button
              className="btn small"
              onClick={() =>
                api.delete<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/schedule`, { threadId: thread.id }).then((r) => {
                  pushToast({ kind: 'success', message: r.message });
                  onRefresh();
                }).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Delete failed.' }))
              }
            >
              <Trash2 size={11} /> Delete schedule
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ====================================================================

/**
 * v1.8.0: @mention chips under internal notes. Shows which identity tokens
 * in the note text resolve to real agents/teams (matching the server-side
 * parser's rules). Purely informational highlighting - notifications for
 * mentions are produced by the server sweep from new note events.
 */
function NoteMentionChips({ bodyText }: { bodyText: string | null }): ReactNode {
  const { data: directory } = useMentionDirectory();
  if (!bodyText) return null;
  const tokens = bodyText.match(/@([A-Za-z0-9._-]+)/g) ?? [];
  if (tokens.length === 0) return null;
  const known = new Map<string, string>();
  for (const u of directory?.users ?? []) {
    if (u.mention) known.set(u.mention.toLowerCase(), u.display_name);
    const first = (u.display_name.split(' ')[0] ?? '').toLowerCase();
    if (first) known.set(first, u.display_name);
    known.set(u.display_name.toLowerCase().replace(/\s+/g, ''), u.display_name);
    known.set(u.display_name.toLowerCase(), u.display_name);
  }
  for (const t of directory?.teams ?? []) known.set(t.name.toLowerCase(), `${t.name} (team)`);
  const resolved = [...new Set(tokens.map((t) => t.slice(1).toLowerCase()))]
    .filter((t) => known.has(t))
    .map((t) => `@${t}`);
  if (resolved.length === 0) return null;
  return (
    <div className="text-xs mt-8" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="muted">mentions:</span>
      {resolved.map((r) => <span key={r} className="mention-token">{r}</span>)}
    </div>
  );
}

interface ComposerState {
  mode: 'reply' | 'note';
  text: string;
  cc: string;
  bcc: string;
  statusAfter: string;
  savedReplyId: number | null;
}

function Composer({ conversationId, customerId: _customerId, customerEmail, drafts, onSent }: { conversationId: number; customerId: number | null; customerEmail: string | null; drafts: NonNullable<ReturnType<typeof useConversationDetail>['data']>['ai_drafts']; onSent: () => void }): ReactNode {
  const [state, setState] = useState<ComposerState>({ mode: 'reply', text: '', cc: '', bcc: '', statusAfter: '', savedReplyId: null });
  const [savedReplyOpen, setSavedReplyOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState<{ id: number; content: string; verification: { verified: boolean; unsupported_claims: string[]; missing_questions: string[]; internal_leakage: string[]; conflicts: string[]; warnings: string[] } | null; sources: { source_type: string; source_id: number; title: string; visibility: string }[] } | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const { savedReplies } = useReference();
  const pushToast = useUiStore((s) => s.pushToast);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Composer state survives AI actions and async failures (spec #20): text is kept in this component state.
  const send = useMutation({
    mutationFn: (asDraft: boolean) =>
      api.post<{ ok: boolean; message: string; detail?: string }>(`/api/conversations/${conversationId}/reply`, {
        text: state.text,
        draft: asDraft,
        cc: state.cc ? state.cc.split(',').map((s) => s.trim()).filter(Boolean) : [],
        bcc: state.bcc ? state.bcc.split(',').map((s) => s.trim()).filter(Boolean) : [],
        statusAfter: state.statusAfter || null
      }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      if (r.ok) {
        setState((s) => ({ ...s, text: '', cc: '', bcc: '' }));
        setAiDraft(null);
        onSent();
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: `Your text is preserved in the composer. ${e.message}` })
  });

  const addNote = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; detail?: string }>(`/api/conversations/${conversationId}/note`, { text: state.text }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      if (r.ok) {
        setState((s) => ({ ...s, text: '' }));
        onSent();
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: `Your text is preserved. ${e.message}` })
  });

  const insertText = (text: string): void => {
    setState((s) => ({ ...s, text: s.text ? s.text + '\n\n' + text : text }));
    textareaRef.current?.focus();
  };

  const generateAiDraft = async (instruction?: 'shorten' | 'expand' | 'warmer' | 'more_direct'): Promise<void> => {
    if (aiDraft && instruction) {
      setAiBusy(`rewriting (${instruction})`);
      try {
        const r = await api.post<{ ok: boolean; text: string; error?: string }>(`/api/ai/draft/${aiDraft.id}/rewrite`, { instruction });
        if (r.ok) setAiDraft({ ...aiDraft, content: r.text });
        else pushToast({ kind: 'error', message: r.error ?? 'Rewrite failed' });
      } catch (e) {
        pushToast({ kind: 'error', message: (e as Error).message });
      } finally {
        setAiBusy(null);
      }
      return;
    }
    setAiBusy('generating draft');
    try {
      const r = await api.post<{ ok: boolean; draft?: { id: number; content: string; verification: { verified: boolean; unsupported_claims: string[]; missing_questions: string[]; internal_leakage: string[]; conflicts: string[]; warnings: string[] } | null; sources: { source_type: string; source_id: number; title: string; visibility: string }[] }; error?: string }>(`/api/ai/draft/${conversationId}`, { mode: 'verified_answer' });
      if (r.ok && r.draft) setAiDraft(r.draft);
      else pushToast({ kind: 'error', message: r.error ?? 'Draft generation failed' });
    } catch (e) {
      pushToast({ kind: 'error', message: (e as Error).message });
    } finally {
      setAiBusy(null);
    }
  };

  const insertSavedReply = (id: number): void => {
    const sr = (savedReplies.data?.saved_replies ?? []).find((r) => r.id === id);
    if (sr) insertText(sr.text ?? sr.preview);
    setSavedReplyOpen(false);
  };

  return (
    <div className="composer">
      <div className="composer-modes" role="tablist">
        <button role="tab" aria-selected={state.mode === 'reply'} className={`btn small ${state.mode === 'reply' ? 'primary' : ''}`} onClick={() => setState((s) => ({ ...s, mode: 'reply' }))}>
          <Reply size={11} /> Reply
        </button>
        <button role="tab" aria-selected={state.mode === 'note'} className={`btn small ${state.mode === 'note' ? 'primary' : ''}`} onClick={() => setState((s) => ({ ...s, mode: 'note' }))}>
          <StickyNote size={11} /> Internal note
        </button>
        <div className="flex" style={{ marginLeft: 'auto', gap: 6 }}>
          <button className="btn small" onClick={() => setSavedReplyOpen(true)} disabled={!savedReplies.data?.saved_replies.length}>
            <Bookmark size={11} /> Saved reply
          </button>
          <button className="btn small" onClick={() => void generateAiDraft()} disabled={aiBusy != null}>
            <Sparkles size={11} /> {aiBusy ?? 'AI draft'}
          </button>
        </div>
      </div>
      {savedReplyOpen ? (
        <div className="card mb-8" style={{ maxHeight: 220, overflowY: 'auto' }}>
          {(savedReplies.data?.saved_replies ?? []).map((sr) => (
            <div key={sr.id} className="conversation-item" onClick={() => insertSavedReply(sr.id)}>
              <div className="conv-subject">{sr.name}</div>
              <div className="conv-preview">{sr.preview}</div>
            </div>
          ))}
        </div>
      ) : null}
      {aiDraft ? (
        <div className="card mb-8" style={{ borderColor: 'var(--ai)' }}>
          <div className="flex-between mb-8">
            <strong className="ai-mark"><Bot size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> AI draft (verified-answer mode)</strong>
            <div className="flex" style={{ gap: 4 }}>
              <VerifiedBadge verified={aiDraft.verification?.verified ?? null} />
            </div>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }} className="text-sm">{aiDraft.content}</div>
          {aiDraft.verification ? (
            <div className="mt-8 text-xs">
              {aiDraft.verification.unsupported_claims.length ? <div className="alert error" style={{ marginTop: 4 }}>Unsupported claims: {aiDraft.verification.unsupported_claims.join('; ')}</div> : null}
              {aiDraft.verification.missing_questions.length ? <div className="alert warn" style={{ marginTop: 4 }}>Unanswered questions: {aiDraft.verification.missing_questions.join('; ')}</div> : null}
              {aiDraft.verification.internal_leakage.length ? <div className="alert error" style={{ marginTop: 4 }}>Internal leakage: {aiDraft.verification.internal_leakage.join('; ')}</div> : null}
              {aiDraft.verification.warnings.length ? <div className="alert warn" style={{ marginTop: 4 }}>Warnings: {aiDraft.verification.warnings.join('; ')}</div> : null}
            </div>
          ) : null}
          {aiDraft.sources.length > 0 ? (
            <div className="mt-8">
              <span className="text-xs muted">Sources (clickable evidence): </span>
              {aiDraft.sources.map((s, i) => (
                <span key={i} className="source-chip">
                  {s.source_type === 'conversation' ? (
                    <Link to={`/inbox/conversation/${s.source_id}`}>{s.title}</Link>
                  ) : s.source_type === 'knowledge_document' ? (
                    <Link to={`/knowledge?doc=${s.source_id}`}>{s.title}</Link>
                  ) : (
                    s.title
                  )}
                  <span className="muted">[{s.visibility === 'customer_safe' ? 'customer-safe' : s.visibility === 'internal_only' ? 'internal' : 'uncertain'}]</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex wrap mt-8" style={{ gap: 6 }}>
            <button className="btn small primary" onClick={() => insertText(aiDraft.content)}>
              <Wand2 size={11} /> Insert into composer
            </button>
            <button className="btn small" onClick={() => void generateAiDraft('shorten')}>Shorten</button>
            <button className="btn small" onClick={() => void generateAiDraft('expand')}>Expand</button>
            <button className="btn small" onClick={() => void generateAiDraft('warmer')}>Warmer</button>
            <button className="btn small" onClick={() => void generateAiDraft('more_direct')}>More direct</button>
            <button
              className="btn small"
              onClick={() =>
                api.post<{ ok: boolean }>(`/api/ai/draft/${aiDraft.id}/verify`).then(() => pushToast({ kind: 'success', message: 'Draft re-verified.' })).catch((e: Error) => pushToast({ kind: 'error', message: e.message }))
              }
            >
              <ShieldCheck size={11} /> Verify
            </button>
            <button className="btn small" onClick={() => setAiDraft(null)}><XCircle size={11} /> Discard</button>
            <button
              className="btn small"
              title="Create this draft in Help Scout (does not send)"
              onClick={() => {
                void api.post<{ ok: boolean; message: string }>(`/api/conversations/${conversationId}/reply`, { text: aiDraft.content, draft: true }).then((r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.message })).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Draft creation failed.' }));
              }}
            >
              Create HS draft
            </button>
          </div>
          <p className="text-xs muted mt-8">Generated locally by AI - review before sending. Nothing is sent to the customer automatically.</p>
        </div>
      ) : null}
      {state.mode === 'note' ? (
        <MentionTextarea
          value={state.text}
          onChange={(text) => setState((s) => ({ ...s, text }))}
          placeholder="Internal note (never sent to the customer)… @mention a teammate or team to notify them"
          rows={3}
          onSubmit={() => {
            // v2.2.1 consistency fix: side threads already send with Cmd/Ctrl+Enter.
            if (state.text.trim() && !addNote.isPending) addNote.mutate();
          }}
        />
      ) : (
        <textarea
          ref={textareaRef}
          className="input"
          placeholder={`Reply to ${customerEmail ?? 'customer'}…`}
          value={state.text}
          onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))}
          onKeyDown={(e) => {
            // v2.2.1 consistency fix: side threads already send with Cmd/Ctrl+Enter;
            // the main composer was mouse-only. Opens the SAME confirmation
            // dialog the Send button opens - never bypasses it.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.text.trim() && !send.isPending) {
              e.preventDefault();
              setConfirmSend(true);
            }
          }}
          aria-label="Reply text"
        />
      )}
      {state.mode === 'reply' ? (
        <div className="flex wrap mt-8" style={{ gap: 8 }}>
          <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="cc (comma-separated)" value={state.cc} onChange={(e) => setState((s) => ({ ...s, cc: e.target.value }))} aria-label="CC recipients" />
          <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="bcc (comma-separated)" value={state.bcc} onChange={(e) => setState((s) => ({ ...s, bcc: e.target.value }))} aria-label="BCC recipients" />
          <select className="input" style={{ width: 170 }} value={state.statusAfter} onChange={(e) => setState((s) => ({ ...s, statusAfter: e.target.value }))} aria-label="Status after sending">
            <option value="">Keep status</option>
            <option value="active">Set active</option>
            <option value="pending">Set pending</option>
            <option value="closed">Set closed</option>
          </select>
        </div>
      ) : null}
      {/* v2.2.0 (M6, plan Phase 35): optional advisory coaching on the current
          draft - never blocks the send. */}
      {state.mode === 'reply' ? <CoachingPanel conversationId={conversationId} draft={state.text} /> : null}
      <div className="composer-actions">
        {state.mode === 'reply' ? (
          <>
            <button className="btn primary" disabled={!state.text.trim() || send.isPending} onClick={() => setConfirmSend(true)}>
              <Send size={12} /> Send reply
            </button>
            <button className="btn" disabled={!state.text.trim() || send.isPending} onClick={() => send.mutate(true)}>
              <Bookmark size={12} /> Save as draft
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!state.text.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
            <StickyNote size={12} /> Add note
          </button>
        )}
        <span className="save-hint">Cmd/Ctrl+Enter sends · Your text is preserved across AI actions and network failures.</span>
      </div>
      {confirmSend ? (
        <ConfirmDialog
          title="Send reply to customer"
          message={`Send this reply to ${customerEmail ?? 'the customer'} via Help Scout? This is a customer-visible action.`}
          confirmLabel="Send reply"
          onCancel={() => setConfirmSend(false)}
          onConfirm={() => {
            setConfirmSend(false);
            send.mutate(false);
          }}
        />
      ) : null}
      {drafts.length > 0 && !aiDraft ? (
        <div className="mt-8 text-xs muted">
          Earlier AI drafts: {drafts.slice(0, 3).map((d) => (
            <button key={d.id} className="btn ghost small" onClick={() => setAiDraft({ id: d.id, content: d.content, verification: d.verification, sources: d.sources })}>
              {new Date(d.created_at).toLocaleString()} {d.state !== 'generated' ? `(${d.state})` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ====================================================================

function ContextPane({ data, onRefresh }: { data: NonNullable<ReturnType<typeof useConversationDetail>['data']>; onRefresh: () => void }): ReactNode {
  const [tab, setTab] = useState<'customer' | 'ai' | 'copilot'>('ai');
  const contextOpen = useUiStore((s) => s.contextPaneOpen);
  const setContextPane = useUiStore((s) => s.setContextPane);
  if (!contextOpen) {
    return (
      <button className="btn" style={{ position: 'fixed', right: 12, top: 70, zIndex: 400 }} onClick={() => setContextPane(true)}>
        <ChevronLeft size={12} /> Context
      </button>
    );
  }
  return (
    <aside className="context-pane" aria-label="Context panel">
      <div className="flex-between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <div className="tabs" style={{ margin: 0, borderBottom: 'none' }}>
          <button className={`tab ${tab === 'ai' ? 'active' : ''}`} onClick={() => setTab('ai')}>AI</button>
          <button className={`tab ${tab === 'customer' ? 'active' : ''}`} onClick={() => setTab('customer')}>Customer</button>
          {/* v1.9.0 (M3, plan Phase 15): the interactive Local Copilot lives here -
              read-only tools, evidence-cited answers, never sends anything. */}
          <button className={`tab ${tab === 'copilot' ? 'active' : ''}`} onClick={() => setTab('copilot')} title="Ask the Local Copilot about this ticket (read-only, evidence-cited)"><Bot size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />Copilot</button>
        </div>
        <button className="btn ghost small" aria-label="Hide context pane" onClick={() => setContextPane(false)}>
          <ChevronRight size={12} />
        </button>
      </div>
      {tab === 'ai' ? <AiSidebar data={data} onRefresh={onRefresh} /> : tab === 'customer' ? <CustomerSidebar data={data} /> : <CopilotPanel conversationId={data.conversation.id} />}
    </aside>
  );
}

function AiSidebar({ data, onRefresh }: { data: NonNullable<ReturnType<typeof useConversationDetail>['data']>; onRefresh: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const navigate = useNavigate();
  const [analyzing, setAnalyzing] = useState(false);
  const analysis = data.ai_analysis;
  void analysis;
  const analyze = useCallback(async (): Promise<void> => {
    setAnalyzing(true);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/api/ai/analyze/${data.conversation.id}`, { force: true });
      if (r.ok) {
        pushToast({ kind: 'success', message: 'AI analysis completed.' });
        onRefresh();
      } else pushToast({ kind: 'error', message: r.error ?? 'Analysis failed' });
    } catch (e) {
      pushToast({ kind: 'error', message: (e as Error).message });
    } finally {
      setAnalyzing(false);
    }
  }, [data.conversation.id, onRefresh, pushToast]);

  const similar = useMutation({
    mutationFn: () => api.get<{ similar: { conversation_id: number; number: number; subject: string; resolution: string; date: string | null; status: string; score: number; why: string[] }[] }>(`/api/ai/similar/${data.conversation.id}`)
  });

  return (
    <>
      <ClientIntelligenceCard conversationId={data.conversation.id} onRefresh={onRefresh} />
      {/* v1.9.0 (M3, plan Phase 16): the per-ticket AI attribute snapshot -
          deterministic + AI layers, honest unknowns, one-click recompute. */}
      <AttributeSnapshotCard conversationId={data.conversation.id} />
      <div className="ai-sidebar-section">
        <h4><Bot size={12} /> What is the customer asking?</h4>
        {analyzing ? <Spinner label="Analyzing…" /> : null}
        {analysis ? (
          <div className="text-sm">
            <div className="mb-8"><strong>Intent:</strong> {analysis.analysis.intent ?? '—'} <ConfidenceBadge level={analysis.analysis.confidence} /></div>
            <div className="mb-8"><strong>Main question:</strong> {analysis.analysis.primary_question ?? '—'}</div>
            {/* v2.2.1 audit fix: secondary_questions and missing_information are
                OPTIONAL in the stored analysis JSON (demo-seeded and older rows
                may lack them) - bare .length crashed the whole detail render
                with "Cannot read properties of undefined". */}
            {(analysis.analysis.secondary_questions ?? []).length ? <div className="mb-8"><strong>Other questions:</strong> {analysis.analysis.secondary_questions.join(' | ')}</div> : null}
            {analysis.analysis.customer_goal ? <div className="mb-8"><strong>Goal:</strong> {analysis.analysis.customer_goal}</div> : null}
            <div className="flex wrap mb-8" style={{ gap: 4 }}>
              {analysis.analysis.product ? <span className="badge">{analysis.analysis.product}</span> : null}
              {analysis.analysis.feature ? <span className="badge">{analysis.analysis.feature}</span> : null}
              {analysis.analysis.urgency ? <span className="badge warn">urgency: {analysis.analysis.urgency}</span> : null}
              {analysis.analysis.sentiment ? <span className="badge">sentiment: {analysis.analysis.sentiment}</span> : null}
            </div>
            {analysis.analysis.summary ? <p style={{ margin: 0 }}>{analysis.analysis.summary}</p> : null}
            {(analysis.analysis.missing_information ?? []).length ? (
              <div className="alert warn mt-8" style={{ marginBottom: 0 }}>Missing: {analysis.analysis.missing_information.join('; ')}</div>
            ) : null}
            <p className="text-xs muted mt-8">AI-generated locally · {analysis.run.model ?? 'model?'} · <RelativeTime iso={analysis.run.created_at} /></p>
          </div>
        ) : (
          <EmptyState icon="ai" title="Not analyzed yet" hint="Run the local AI analysis to extract intent, questions and evidence." action={<button className="btn small" onClick={() => void analyze()} disabled={analyzing}><Sparkles size={11} /> Analyze with AI</button>} />
        )}
        {analysis ? (
          <button className="btn small mt-8" onClick={() => void analyze()} disabled={analyzing}>
            <RefreshCw size={11} /> Re-analyze
          </button>
        ) : null}
      </div>
      {analysis?.analysis.known_issue_candidate ? (
        <div className="ai-sidebar-section">
          <h4><AlertIcon /> Known issue candidate</h4>
          <div className="similar-ticket">
            <div style={{ fontWeight: 620 }}>{analysis.analysis.known_issue_candidate}</div>
            <p className="text-xs muted" style={{ margin: '2px 0 0' }}>Check the Issues screen to confirm or create the known issue.</p>
          </div>
        </div>
      ) : null}
      <div className="ai-sidebar-section">
        <h4><Sparkles size={12} /> Similar tickets</h4>
        <button className="btn small mb-8" onClick={() => similar.mutate()} disabled={similar.isPending}>
          <RefreshCw size={11} /> {similar.isPending ? 'Finding…' : 'Find similar (hybrid)'}
        </button>
        {(similar.data?.similar ?? []).length === 0 ? <span className="muted text-xs">No similar tickets retrieved yet.</span> : null}
        {(similar.data?.similar ?? []).map((s) => (
          <div key={s.conversation_id} className="similar-ticket" onClick={() => navigate(`/inbox/conversation/${s.conversation_id}`)}>
            <div className="flex-between">
              <strong className="text-sm">#{s.number} {s.subject}</strong>
              <span className="badge">{s.score.toFixed(2)}</span>
            </div>
            <div className="text-xs muted" style={{ marginTop: 2 }}>{s.resolution.slice(0, 140) || '(no resolution recorded)'}</div>
            <div className="flex wrap" style={{ gap: 4, marginTop: 4 }}>
              <StatusBadge status={s.status} />
              {s.why.map((w, i) => (
                <span key={`${i}-${w}`} className="badge">{w}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {analysis?.sources.length ? (
        <div className="ai-sidebar-section">
          <h4><ShieldCheck size={12} /> Evidence</h4>
          {analysis.sources.map((s, i) => (
            <span key={i} className="source-chip">
              {s.source_type === 'conversation' ? <Link to={`/inbox/conversation/${s.source_id}`}>{s.title}</Link> : s.source_type === 'knowledge_document' ? <Link to={`/knowledge?doc=${s.source_id}`}>{s.title}</Link> : s.title}
              <span className="muted">[{s.visibility === 'customer_safe' ? 'safe' : s.visibility === 'internal_only' ? 'internal' : '?'}]</span>
            </span>
          ))}
        </div>
      ) : null}
      {data.workflows.length > 0 ? (
        <div className="ai-sidebar-section">
          <h4><WorkflowIcon /> Help Scout workflows</h4>
          <p className="text-xs muted" style={{ marginTop: 0 }}>These are Help Scout workflows (distinct from local SupportOS automation).</p>
          {data.workflows.map((w) => (
            <button
              key={w.id}
              className="btn small mb-8"
              onClick={() =>
                api.post<{ ok: boolean; message: string }>(`/api/conversations/${data.conversation.id}/workflow/${w.remote_id}`).then((r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.message })).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Workflow failed.' }))
              }
            >
              Run “{w.name}”
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function AlertIcon(): ReactNode {
  return <AlertTriangle size={12} />;
}
function WorkflowIcon(): ReactNode {
  return <Workflow size={12} />;
}

function CustomerSidebar({ data }: { data: NonNullable<ReturnType<typeof useConversationDetail>['data']>}): ReactNode {
  const navigate = useNavigate();
  const customer = data.customer;
  if (!customer) return <div className="ai-sidebar-section"><EmptyState title="No customer data" /></div>;
  return (
    <>
      <div className="ai-sidebar-section">
        <h4><User size={12} /> Customer</h4>
        <div style={{ fontWeight: 700 }}>{customer.first_name} {customer.last_name}</div>
        {customer.job_title ? <div className="text-xs muted">{customer.job_title}</div> : null}
        <div className="mt-8">
          {customer.emails.map((e) => (
            <div key={e} className="text-sm"><Mail size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {e}</div>
          ))}
          {customer.phones.map((p) => (
            <div key={p} className="text-sm muted">{p}</div>
          ))}
        </div>
        {customer.organization_name ? (
          <div className="mt-8 text-sm"><Building2 size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {customer.organization_name}</div>
        ) : null}
        <div className="mt-8">
          <Link className="btn small" to={`/customers/${customer.id}`}>View all conversations</Link>
        </div>
        <div className="mt-8 text-xs muted">
          {customer.conversation_count} total · {customer.open_conversation_count} open
          {customer.average_rating != null ? ` · avg rating ${customer.average_rating.toFixed(1)}` : ''}
        </div>
      </div>
      <div className="ai-sidebar-section">
        <h4>Recent tickets</h4>
        {data.customer_history.slice(0, 8).map((h) => (
          <div key={h.id} className="similar-ticket" onClick={() => navigate(`/inbox/conversation/${h.id}`)}>
            <div className="flex-between">
              <span className="text-sm" style={{ fontWeight: 600 }}>#{h.number} {h.subject}</span>
              <StatusBadge status={h.status} />
            </div>
            <RelativeTime iso={h.remote_created_at} />
          </div>
        ))}
        {data.customer_history.length === 0 ? <span className="muted text-xs">No other conversations.</span> : null}
      </div>
      {data.customer_memories.length > 0 ? (
        <div className="ai-sidebar-section">
          <h4><Sparkles size={12} /> AI customer memory</h4>
          {data.customer_memories.map((m) => (
            <div key={m.id} className="mb-8">
              <strong className="text-sm">{m.key}:</strong> <span className="text-sm">{m.value}</span>
              <div>
                <span className={`badge ${m.source === 'ai' ? 'ai' : 'ok'}`}>{m.source === 'ai' ? 'AI-derived' : 'human-entered'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
