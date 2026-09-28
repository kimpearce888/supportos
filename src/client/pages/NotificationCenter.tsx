import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Check, CheckCheck, AtSign, RefreshCw, Settings2, Users } from 'lucide-react';
import { api } from '../api/client.js';
import { useNotifications, useNotificationPrefs, useMentionQueue, useUnreadNotificationCount, type NotificationRow } from '../api/hooks.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';

/**
 * Notification Center (v1.8.0, plan Phase 12) + "mentions for me" queue
 * (plan Phase 13).
 *
 * Everything the plan requires: unread count, notification list, mark read,
 * mark all read, source conversation/issue/customer links, timestamps, and
 * per-type notification preferences. Live updates arrive over SSE
 * ('notification' events invalidate the queries below).
 */

const TYPE_LABEL: Record<string, string> = {
  customer_replied: 'Customer replied',
  ticket_assigned: 'Assigned',
  mentioned: 'Mention',
  team_mentioned: 'Team mention',
  sla_risk: 'SLA risk',
  sla_breach: 'SLA breach',
  automation_approval: 'Approval',
  ai_escalation: 'AI escalation',
  known_issue_detected: 'Known issue',
  issue_spike: 'Issue spike',
  campaign_reply: 'Campaign reply',
  sync_failure: 'Sync',
  job_failure: 'Job failure',
  customer_event: 'Customer event'
};

const TYPE_OPTIONS: { value: string; label: string }[] = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }));

export function NotificationCenterPage(): ReactNode {
  const [tab, setTab] = useState<'notifications' | 'mentions' | 'prefs'>('notifications');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [type, setType] = useState<string>('');
  const { data, isLoading, isError, error } = useNotifications({ unreadOnly, type: type || null, limit: 100 });
  const { data: unreadData } = useUnreadNotificationCount();
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();

  const markRead = useMutation({
    mutationFn: (input: { id: number; read: boolean }) => api.post<{ unread: number }>(`/api/notifications/${input.id}/read`, { read: input.read }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notification-unread'] });
      void qc.invalidateQueries({ queryKey: ['mention-queue'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post<{ marked: number; unread: number }>('/api/notifications/read-all'),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Marked ${r.marked} notification(s) read.` });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notification-unread'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const sweepNow = useMutation({
    mutationFn: () => api.post<{ created: number }>('/api/notifications/sweep'),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Notification check complete — ${r.created} new.` });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notification-unread'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Notification Center</h1>
          <p className="page-subtitle">
            {unreadData ? `${unreadData.unread} unread` : 'Local notifications'}
            {' '}· customer replies, assignments, mentions, SLA, approvals, jobs, campaigns — all local, never sent to Help Scout
          </p>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => sweepNow.mutate()} disabled={sweepNow.isPending}>
            <RefreshCw size={11} /> Check now
          </button>
          <button className="btn small" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending || (unreadData?.unread ?? 0) === 0}>
            <CheckCheck size={11} /> Mark all read
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'notifications' ? 'active' : ''}`} onClick={() => setTab('notifications')}>
          <Bell size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Notifications
        </button>
        <button className={`tab ${tab === 'mentions' ? 'active' : ''}`} onClick={() => setTab('mentions')}>
          <AtSign size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Mentions for me
        </button>
        <button className={`tab ${tab === 'prefs' ? 'active' : ''}`} onClick={() => setTab('prefs')}>
          <Settings2 size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Preferences
        </button>
      </div>

      {tab === 'notifications' ? (
        <>
          <div className="flex wrap mb-8" style={{ gap: 8, alignItems: 'center' }}>
            <label className="flex" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
            </label>
            <select className="input" style={{ width: 'auto', padding: '2px 6px' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
              <option value="">All types</option>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {data ? <span className="text-xs muted">{data.total} total · {data.unread} unread</span> : null}
          </div>
          {isLoading ? <Spinner label="Loading notifications" /> : null}
          {isError ? <ErrorState message="Could not load notifications." detail={(error as Error | null)?.message} /> : null}
          {data && data.notifications.length === 0 ? (
            <EmptyState icon="bell" title="No notifications yet" hint="Notifications start from the moment SupportOS runs — history never spams the center. Customer replies, assignments, mentions, SLA states and job failures will appear here within seconds." />
          ) : null}
          {data && data.notifications.length > 0 ? (
            <div className="notification-list">
              {data.notifications.map((n) => (
                <NotificationRowView key={n.id} n={n} onToggleRead={(read) => markRead.mutate({ id: n.id, read })} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'mentions' ? <MentionsQueue /> : null}
      {tab === 'prefs' ? <PrefsEditor /> : null}
    </div>
  );
}

function sourceLink(n: NotificationRow): ReactNode {
  if (n.conversation_id != null) {
    return <Link to={`/inbox/conversation/${n.conversation_id}`} className="btn ghost small">#{n.conversation_number ?? n.conversation_id} →</Link>;
  }
  if (n.issue_id != null) {
    return <Link to="/issues" className="btn ghost small">Issue Radar →</Link>;
  }
  if (n.campaign_id != null) {
    return <Link to="/outreach" className="btn ghost small">Campaign #{n.campaign_id} →</Link>;
  }
  if (n.customer_local_id != null) {
    return <Link to={`/customers/${n.customer_local_id}`} className="btn ghost small">Customer →</Link>;
  }
  if (n.type === 'sync_failure') {
    return <Link to="/sync-health" className="btn ghost small">Sync Health →</Link>;
  }
  if (n.type === 'automation_approval' || n.type === 'job_failure') {
    return <Link to="/automation" className="btn ghost small">Queue →</Link>;
  }
  return null;
}

function NotificationRowView({ n, onToggleRead }: { n: NotificationRow; onToggleRead: (read: boolean) => void }): ReactNode {
  const unread = n.read_at == null;
  return (
    <div className={`notification-row ${unread ? 'unread' : ''} sev-${n.severity}`}>
      <div className="notification-main">
        <div className="flex wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className={`badge ${n.severity === 'critical' ? 'err' : n.severity === 'warning' ? 'warn' : 'tag'}`}>
            {TYPE_LABEL[n.type] ?? n.type}
          </span>
          <strong style={{ fontSize: 13 }}>{n.title}</strong>
          {n.target_user_local_id != null ? <span className="text-xs muted" title="Targeted notification (visible only to its target here)"><Users size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> targeted</span> : null}
        </div>
        {n.body ? <div className="text-xs muted" style={{ marginTop: 2 }}>{n.body}</div> : null}
        <div className="text-xs muted" style={{ marginTop: 2 }}>
          <RelativeTime iso={n.created_at} />
        </div>
      </div>
      <div className="flex" style={{ gap: 4 }}>
        {sourceLink(n)}
        <button
          className="btn ghost small"
          title={unread ? 'Mark read' : 'Mark unread'}
          onClick={() => onToggleRead(!unread)}
        >
          <Check size={11} />
        </button>
      </div>
    </div>
  );
}

function MentionsQueue(): ReactNode {
  const { data, isLoading, isError, error } = useMentionQueue();
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  // v2.2.1 audit fix: the mention rows rendered the same mark-read affordance
  // as the main list but its handler was a literal no-op - the check button
  // did nothing. It posts to the same endpoint the main list uses.
  const markRead = useMutation({
    mutationFn: (input: { id: number; read: boolean }) => api.post<{ unread: number }>(`/api/notifications/${input.id}/read`, { read: input.read }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notification-unread'] });
      void qc.invalidateQueries({ queryKey: ['mention-queue'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  if (isLoading) return <Spinner label="Loading mentions" />;
  if (isError) return <ErrorState message="Could not load the mentions queue." detail={(error as Error | null)?.message} />;
  const noteMentions = data?.notifications ?? [];
  const threadMentions = data?.side_thread_mentions ?? [];
  const total = noteMentions.length + threadMentions.length;
  return (
    <>
      {total === 0 ? (
        <EmptyState icon="at" title="No mentions for you" hint="When someone @mentions you (or a team you are in) in an internal note or a side thread, it lands here with a link back to the conversation." />
      ) : null}
      {noteMentions.length > 0 ? (
        <div className="card">
          <h3 className="card-title"><AtSign size={14} /> In internal notes</h3>
          <div className="notification-list">
            {noteMentions.map((n) => (
              <NotificationRowView key={`n-${n.id}`} n={n} onToggleRead={(read) => markRead.mutate({ id: n.id, read })} />
            ))}
          </div>
        </div>
      ) : null}
      {threadMentions.length > 0 ? (
        <div className="card">
          <h3 className="card-title"><AtSign size={14} /> In side threads</h3>
          <div className="notification-list">
            {threadMentions.map((m) => (
              <div key={`s-${m.message_id}`} className="notification-row unread">
                <div className="notification-main">
                  <div className="flex wrap" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="badge tag">{m.thread_title || 'side thread'}</span>
                    <strong style={{ fontSize: 13 }}>{m.author ?? 'Someone'} mentioned you</strong>
                  </div>
                  <div className="text-xs muted" style={{ marginTop: 2 }}>{m.body.slice(0, 200)}</div>
                  <div className="text-xs muted" style={{ marginTop: 2 }}><RelativeTime iso={m.created_at} /></div>
                </div>
                <Link to={`/inbox/conversation/${m.conversation_id}`} className="btn ghost small">#{m.conversation_number ?? m.conversation_id} →</Link>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function PrefsEditor(): ReactNode {
  const { data, isLoading, isError, error } = useNotificationPrefs();
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const update = useMutation({
    mutationFn: (input: { type: string; enabled: boolean }) => api.put<{ prefs: { type: string; enabled: boolean; default_enabled: boolean }[] }>(`/api/notifications/prefs/${input.type}`, { enabled: input.enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notification-prefs'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  if (isLoading) return <Spinner label="Loading preferences" />;
  if (isError) return <ErrorState message="Could not load notification preferences." detail={(error as Error | null)?.message} />;
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 className="card-title"><Settings2 size={14} /> Notification preferences</h3>
      <p className="text-xs muted" style={{ marginTop: 0 }}>
        Disabled types produce no rows at all (they are not hidden after the fact). Mention notifications follow internal notes and side threads.
      </p>
      <table className="table">
        <thead>
          <tr><th>Type</th><th style={{ width: 90 }}>Enabled</th></tr>
        </thead>
        <tbody>
          {(data?.prefs ?? []).map((p) => (
            <tr key={p.type}>
              <td>{TYPE_LABEL[p.type] ?? p.type}{!p.default_enabled ? <span className="text-xs muted"> (off by default)</span> : null}</td>
              <td>
                <button className="btn ghost small" onClick={() => update.mutate({ type: p.type, enabled: !p.enabled })} disabled={update.isPending}>
                  {p.enabled ? <><Bell size={11} /> On</> : <><BellOff size={11} /> Off</>}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
