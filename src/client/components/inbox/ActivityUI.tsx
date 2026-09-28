import { type ReactNode, useState } from 'react';
import { ArrowUpCircle, AlertCircle, MessageSquare, User, Bot, StickyNote, Tag, Clock, CheckCircle2, History, Paperclip, Zap, GitBranch, RotateCcw, MoveRight, ChevronDown, ChevronUp, UserCog, Layers } from 'lucide-react';
import { useConversationEvents } from '../../api/hooks.js';
import { RESPONSE_STATE_LABELS, PRIORITY_LABELS, type ConversationEvent, type TicketPriority, type ResponseState, type TicketStateDef } from '../../../shared/activity.js';
import { RelativeTime } from '../common/ui.js';

/**
 * v1.7.0 activity UI atoms: priority/response-state/state badges, the
 * conversation event timeline, and the priority/state controls.
 */

export function PriorityBadge({ priority }: { priority: TicketPriority }): ReactNode {
  if (priority === 'none') return null;
  const cls = priority === 'urgent' ? 'error' : priority === 'high' ? 'warn' : priority === 'medium' ? 'info' : '';
  return (
    <span className={`badge ${cls}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={`SupportOS priority: ${PRIORITY_LABELS[priority]} (local, not a Help Scout field)`}>
      {priority === 'urgent' || priority === 'high' ? <Zap size={10} /> : <ArrowUpCircle size={10} />}
      {priority}
    </span>
  );
}

export function ResponseStateBadge({ state }: { state: ResponseState }): ReactNode {
  const cls =
    state === 'needs_first_response' || state === 'customer_waiting' ? 'warn'
    : state === 'agent_waiting' ? 'info'
    : state === 'recently_responded' ? 'ok'
    : state === 'snoozed' ? ''
    : state === 'closed' ? 'closed'
    : 'muted';
  return <span className={`badge ${cls}`} title={`Deterministic response state: ${RESPONSE_STATE_LABELS[state]}`}>{RESPONSE_STATE_LABELS[state]}</span>;
}

export function TicketStateBadge({ state }: { state: TicketStateDef | null }): ReactNode {
  if (!state) return null;
  return (
    <span className="badge" style={{ background: `${state.color ?? '#64748b'}22`, color: state.color ?? 'inherit', display: 'inline-flex', alignItems: 'center', gap: 3 }} title={`SupportOS state: ${state.name}${state.is_resolved ? ' (resolved)' : ''}`}>
      <Layers size={10} /> {state.name}
    </span>
  );
}

const EVENT_ICONS: Record<string, ReactNode> = {
  conversation_created: <MessageSquare size={12} />,
  customer_message: <MessageSquare size={12} />,
  human_agent_message: <User size={12} />,
  system_agent_message: <Bot size={12} />,
  internal_note: <StickyNote size={12} />,
  status_changed: <RotateCcw size={12} />,
  assignment_changed: <UserCog size={12} />,
  team_changed: <UserCog size={12} />,
  inbox_changed: <MoveRight size={12} />,
  moved: <MoveRight size={12} />,
  tag_added: <Tag size={12} />,
  tag_removed: <Tag size={12} />,
  custom_field_changed: <Layers size={12} />,
  snoozed: <Clock size={12} />,
  unsnoozed: <Clock size={12} />,
  scheduled: <Clock size={12} />,
  closed: <CheckCircle2 size={12} />,
  reopened: <RotateCcw size={12} />,
  merged: <GitBranch size={12} />,
  attachment_added: <Paperclip size={12} />,
  priority_changed: <ArrowUpCircle size={12} />,
  ticket_state_changed: <Layers size={12} />,
  lineitem_action: <History size={12} />
};

const EVENT_LABELS: Record<string, string> = {
  conversation_created: 'Conversation created',
  customer_message: 'Customer message',
  human_agent_message: 'Agent reply',
  system_agent_message: 'System message',
  internal_note: 'Internal note',
  status_changed: 'Status changed',
  assignment_changed: 'Assignment changed',
  team_changed: 'Team changed',
  inbox_changed: 'Inbox changed',
  moved: 'Moved',
  tag_added: 'Tag added',
  tag_removed: 'Tag removed',
  custom_field_changed: 'Custom field changed',
  snoozed: 'Snoozed',
  unsnoozed: 'Unsnoozed',
  scheduled: 'Reply scheduled',
  closed: 'Closed',
  reopened: 'Reopened',
  merged: 'Merged',
  attachment_added: 'Attachment added',
  priority_changed: 'Priority changed',
  ticket_state_changed: 'Ticket state changed',
  lineitem_action: 'Help Scout action'
};

function eventSummary(e: ConversationEvent): string {
  const meta = e.metadata as Record<string, unknown>;
  switch (e.event_type) {
    case 'status_changed':
      return `${String(meta.previous ?? '?')} → ${String(meta.next ?? '?')}`;
    case 'assignment_changed':
      return `${meta.previous == null ? 'unassigned' : `user #${String(meta.previous)}`} → ${meta.next == null ? 'unassigned' : `user #${String(meta.next)}`}`;
    case 'tag_added':
    case 'tag_removed':
      return String(meta.tag ?? '');
    case 'snoozed':
      return meta.next ? `until ${new Date(String(meta.next)).toLocaleString()}` : '';
    case 'priority_changed':
      return `${String(meta.previous ?? 'none')} → ${String(meta.next ?? 'none')}`;
    case 'custom_field_changed':
      return `field #${String(meta.field_local_id ?? '?')}`;
    case 'moved':
      return `mailbox #${String(meta.previous_mailbox ?? '?')} → #${String(meta.next_mailbox ?? '?')}`;
    case 'lineitem_action':
      return String(meta.action_text ?? '');
    case 'ticket_state_changed':
      return `${meta.previous_state_id == null ? 'none' : `state #${String(meta.previous_state_id)}`} → ${meta.new_state_id == null ? 'none' : `state #${String(meta.new_state_id)}`}${meta.reason ? ` (${String(meta.reason)})` : ''}`;
    default:
      return '';
  }
}

/** Collapsible chronological event timeline for the conversation detail pane. */
export function ActivityTimeline({ conversationId, historyComplete }: { conversationId: number; historyComplete: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const { data } = useConversationEvents(open ? conversationId : null);
  const events = data?.events ?? [];
  const count = events.length;

  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-raised)' }}>
      <button className="btn ghost small" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setOpen(!open)}>
        {/* v2.2.1 audit fix: events load only when expanded, so the collapsed
            toggle always claimed "Activity timeline (0)" - a wrong number. The
            count is shown only once actually known (open). */}
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />} Activity timeline{open ? ` (${count})` : ''}
      </button>
      {open ? (
        <div style={{ maxHeight: 300, overflowY: 'auto', padding: '8px 16px' }}>
          {!historyComplete ? (
            <div className="alert info" style={{ marginBottom: 8, padding: '6px 10px', fontSize: 12 }}>
              Full thread history is not locally known for this conversation (it predates the local mirror) - message-derived events may be incomplete. Change events are only recorded from first observation onward.
            </div>
          ) : null}
          {events.length === 0 ? <p className="text-xs muted">No events recorded yet.</p> : null}
          {events.map((e) => (
            <div key={e.id} className="flex" style={{ gap: 8, padding: '3px 0', alignItems: 'baseline' }}>
              <span className="muted">{EVENT_ICONS[e.event_type] ?? <History size={12} />}</span>
              <span className="text-xs" style={{ minWidth: 110 }}><RelativeTime iso={e.occurred_at ?? e.created_at} /></span>
              <span className="text-xs"><strong>{EVENT_LABELS[e.event_type] ?? e.event_type}</strong>{eventSummary(e) ? <span className="muted"> · {eventSummary(e)}</span> : null}</span>
              <span className="text-xs muted" style={{ marginLeft: 'auto' }}>
                {e.actor_name ? `${e.actor_name} · ` : ''}{e.source === 'sync' && e.metadata ? 'observed: ' : ''}{e.source}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Priority selector for the conversation header (local SupportOS value). */
export function PriorityPicker({ conversationId, current, onDone }: { conversationId: number; current: TicketPriority; onDone: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { pushToast } = usePushToast();
  const set = async (priority: TicketPriority): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost(`/api/conversations/${conversationId}/priority`, { priority });
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setOpen(false);
      onDone();
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not set priority.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)} title="SupportOS priority (local triage field, independent of Help Scout)">
        <ArrowUpCircle size={11} /> {PRIORITY_LABELS[current]}
      </button>
      {open ? (
        <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 500, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', minWidth: 150 }}>
          {(['urgent', 'high', 'medium', 'low', 'none'] as const).map((p) => (
            <button key={p} className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={busy} onClick={() => void set(p)}>
              {p === current ? '● ' : ''}{PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** Ticket state selector for the conversation header (records a transition). */
export function TicketStatePicker({ conversationId, current, states, onDone }: { conversationId: number; current: TicketStateDef | null; states: TicketStateDef[]; onDone: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { pushToast } = usePushToast();
  const apply = async (stateId: number | null): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost(`/api/conversations/${conversationId}/state`, { stateId, reason: reason.trim() || undefined });
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setOpen(false);
      setReason('');
      onDone();
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not set state.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)} title="SupportOS custom ticket state (workflow layer on top of Help Scout status)">
        <Layers size={11} /> {current?.name ?? 'No state'}
      </button>
      {open ? (
        <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 500, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', minWidth: 220, padding: 8 }}>
          <input className="input" style={{ fontSize: 12, marginBottom: 6 }} placeholder="Reason (optional, stored in history)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {states.map((s) => (
            <button key={s.id} className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={busy} onClick={() => void apply(s.id)}>
              {current?.id === s.id ? '● ' : ''}<span style={{ color: s.color ?? undefined }}>{s.name}</span>{s.is_resolved ? <span className="text-xs muted"> (resolved)</span> : null}
            </button>
          ))}
          {current ? (
            <button className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={busy} onClick={() => void apply(null)}>
              <AlertCircle size={10} /> Clear state
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

// Small local helpers to avoid importing the full api client twice with types.
import { api } from '../../api/client.js';
import { useUiStore } from '../../state/uiStore.js';
function usePushToast(): { pushToast: (t: { kind: string; message: string }) => void } {
  const pushToast = useUiStore((s) => s.pushToast);
  return { pushToast: (t) => pushToast(t as never) };
}
async function apiPost(path: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  return api.post<{ ok: boolean; message: string }>(path, body);
}
