import { type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useDashboard, useReference } from '../api/hooks.js';
import { Spinner, EmptyState, ErrorState } from '../components/common/ui.js';
import type { HealthStatus, IssueRadarAlert } from '../../shared/types.js';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' }
];

const CHANNELS = [
  { value: null, label: 'All channels' },
  { value: 'email', label: 'Email' },
  { value: 'chat', label: 'Chat (Beacon)' }
] as const;

export function DashboardPage(): ReactNode {
  // Scope lives in the URL: /?days=30&mailboxes=1,2&channel=chat — shareable + back-button safe.
  const [searchParams, setSearchParams] = useSearchParams();
  const days = Number(searchParams.get('days') ?? 30) || 30;
  const mailboxIds = (searchParams.get('mailboxes') ?? '')
    .split(',')
    .map((t) => Number(t.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  const channelParam = searchParams.get('channel');
  const channel = channelParam === 'email' || channelParam === 'chat' ? channelParam : null;

  const { data, isLoading, error } = useDashboard(days, mailboxIds, channel);
  const { data: mailboxes } = useReference().mailboxes;
  const { data: health } = useQuery({ queryKey: ['health-ui'], queryFn: () => api.get<HealthStatus>('/health/detailed?format=ui'), refetchInterval: 60_000 });
  const { data: radar } = useQuery({ queryKey: ['issue-radar'], queryFn: () => api.get<{ alerts: IssueRadarAlert[] }>('/api/reports/issue-radar'), refetchInterval: 120_000 });

  const setParam = (key: string, value: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  /** Multi-select toggle: clicking a mailbox adds/removes it; empty selection = all mailboxes. */
  const toggleMailbox = (id: number): void => {
    const next = mailboxIds.includes(id) ? mailboxIds.filter((m) => m !== id) : [...mailboxIds, id];
    setParam('mailboxes', next.length > 0 ? next.join(',') : null);
  };

  const fmtMin = (m: number | null): string => {
    if (m == null) return '—';
    if (m < 60) return `${m}m`;
    if (m < 60 * 24) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / (60 * 24))}d`;
  };

  if (error) return <div className="page"><ErrorState message="Could not load dashboard" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} /></div>;
  if (isLoading || !data) return <div className="page"><Spinner label="Loading dashboard" /></div>;

  const maxDaily = Math.max(1, ...data.daily_new.map((d) => d.value));
  const maxMailboxNew = Math.max(1, ...data.mailbox_comparison.map((m) => m.new_conversations));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            Local metrics · sources labeled Help Scout / local / AI-derived everywhere
            {mailboxIds.length > 0 ? ` · ${mailboxIds.length} mailbox${mailboxIds.length > 1 ? 'es' : ''} selected` : ' · all mailboxes'}
            {channel ? ` · ${channel === 'chat' ? 'chat (Beacon)' : channel} channel` : ''}
          </p>
        </div>
        <div className="flex" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.days} className={`btn small ${days === r.days ? 'primary' : ''}`} onClick={() => setParam('days', String(r.days))}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scope: multi-mailbox + channel (v1.3.0 roadmap: multi-mailbox dashboards) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex wrap" style={{ gap: 8, alignItems: 'center' }}>
          <span className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mailboxes</span>
          <button className={`btn small ${mailboxIds.length === 0 ? 'primary' : ''}`} onClick={() => setParam('mailboxes', null)}>All</button>
          {(mailboxes ?? []).map((m) => (
            <button
              key={m.id}
              className={`btn small ${mailboxIds.includes(m.id) ? 'primary' : ''}`}
              aria-pressed={mailboxIds.includes(m.id)}
              onClick={() => toggleMailbox(m.id)}
            >
              {m.name}
            </button>
          ))}
          <span className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', marginLeft: 12 }}>Channel</span>
          {CHANNELS.map((c) => (
            <button
              key={c.label}
              className={`btn small ${channel === c.value ? 'primary' : ''}`}
              aria-pressed={channel === c.value}
              onClick={() => setParam('channel', c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {health && health.status !== 'ok' ? (
        <div className={`alert ${health.status === 'degraded' ? 'warn' : 'error'} mb-16`}>
          System status: <strong>{health.status}</strong>.{' '}
          {!health.helpscout.connected && !health.helpscout.demo_mode ? 'Help Scout is unreachable - remote actions disabled, local data remains browsable. ' : ''}
          {!health.lmstudio.connected ? 'LM Studio is offline - AI features unavailable (everything else works). ' : ''}
          {!health.qdrant.connected ? 'Qdrant is offline - keyword search remains fully functional. ' : ''}
          <Link to="/sync-health">Open Sync Health</Link>
        </div>
      ) : null}

      <div className="stat-grid">
        <Link to="/inbox?view=active" className="stat-card" style={{ color: 'inherit' }}>
          <div className="stat-value">{data.active_conversations}</div>
          <div className="stat-label">Active</div>
        </Link>
        <Link to="/inbox?view=pending" className="stat-card" style={{ color: 'inherit' }}>
          <div className="stat-value">{data.pending_conversations}</div>
          <div className="stat-label">Pending</div>
        </Link>
        <Link to="/inbox?view=closed" className="stat-card" style={{ color: 'inherit' }}>
          <div className="stat-value">{data.closed_conversations}</div>
          <div className="stat-label">Closed (in range)</div>
        </Link>
        <Link to="/inbox?view=unassigned" className="stat-card" style={{ color: 'inherit' }}>
          <div className="stat-value">{data.unassigned}</div>
          <div className="stat-label">Unassigned</div>
        </Link>
        <div className="stat-card">
          <div className="stat-value">{data.backlog}</div>
          <div className="stat-label">Backlog (7d+)</div>
          <div className="stat-hint">local definition</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{fmtMin(data.first_response_time_avg_min)}</div>
          <div className="stat-label">First response (avg)</div>
          <div className="stat-hint">local definition</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{fmtMin(data.resolution_time_avg_min)}</div>
          <div className="stat-label">Resolution (avg)</div>
          <div className="stat-hint">local definition</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.replies_sent}</div>
          <div className="stat-label">Replies sent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {data.ratings.great + data.ratings.okay + data.ratings['not-good'] > 0 ? Math.round((data.ratings.great / (data.ratings.great + data.ratings.okay + data.ratings['not-good'])) * 100) + '%' : '—'}
          </div>
          <div className="stat-label">Great ratings</div>
          <div className="stat-hint">{data.ratings.great} great · {data.ratings.okay} okay · {data.ratings['not-good']} not-good · live via /api/events</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">New conversations per day (local)</h3>
          {data.daily_new.length === 0 ? <EmptyState title="No conversations in range" /> : null}
          <div className="barchart" role="img" aria-label="New conversations per day">
            {data.daily_new.map((d) => (
              <div key={d.date} className="bar" style={{ height: `${(d.value / maxDaily) * 100}%` }} title={`${d.date}: ${d.value}`} />
            ))}
          </div>
          <div className="flex-between text-xs muted mt-8">
            <span>{data.daily_new[0]?.date ?? ''}</span>
            <span>{data.daily_new[data.daily_new.length - 1]?.date ?? ''}</span>
          </div>
        </div>
        <div className="card">
          <h3 className="card-title">Issue Radar (AI + local)</h3>
          {(radar?.alerts ?? []).length === 0 ? <EmptyState title="No alerts right now" hint="Alerts appear when clusters rise, new issues appear or volume spikes." /> : null}
          {(radar?.alerts ?? []).slice(0, 6).map((a, i) => (
            <div key={i} className={`alert ${a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'}`} style={{ marginBottom: 8 }}>
              <strong>{a.title}</strong>
              <div className="text-xs" style={{ marginTop: 2 }}>{a.detail}</div>
              <div className="flex wrap" style={{ gap: 4, marginTop: 4 }}>
                {a.conversation_ids.slice(0, 6).map((cid) => (
                  <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge">#{cid}</Link>
                ))}
              </div>
            </div>
          ))}
          <Link to="/issues" className="text-xs">Open Issues screen →</Link>
        </div>
      </div>

      {/* v1.3.0: channel mix + speed (email vs Beacon chat) */}
      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="card-title">Channel mix & speed</h3>
          {data.channel_metrics.length === 0 ? <EmptyState title="No conversations in range" /> : null}
          {data.channel_metrics.map((c) => (
            <div key={c.channel} style={{ padding: '6px 0' }}>
              <div className="flex-between">
                <Link to={`/inbox?view=all&channel=${encodeURIComponent(c.channel)}`} className="flex" style={{ gap: 6, alignItems: 'center' }}>
                  <span className={`badge ${c.channel === 'chat' ? 'ok' : ''}`}>{c.channel === 'chat' ? 'Chat (Beacon)' : c.channel}</span>
                </Link>
                <span className="badge">{c.count}</span>
              </div>
              <div className="text-xs muted" style={{ marginTop: 2 }}>
                first response {fmtMin(c.first_response_avg_min)} · resolution {fmtMin(c.resolution_avg_min)}
              </div>
            </div>
          ))}
          <p className="text-xs muted mt-8">Chat sessions are Beacon conversations (type=chat, source via=beacon) — see the Docs page for the mirror overview.</p>
        </div>
        <div className="card">
          <h3 className="card-title">Mailbox comparison</h3>
          {data.mailbox_comparison.length === 0 ? <EmptyState title="No mailboxes yet" /> : null}
          {data.mailbox_comparison.map((m) => (
            <div key={m.mailbox_id} style={{ padding: '6px 0' }}>
              <div className="flex-between">
                <button className="btn ghost small" onClick={() => setParam('mailboxes', String(m.mailbox_id))}>{m.name}</button>
                <span className="badge">{m.new_conversations} new</span>
              </div>
              <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(m.new_conversations / maxMailboxNew) * 100}%`, background: 'var(--primary, #37A4FF)' }} />
              </div>
              <div className="text-xs muted" style={{ marginTop: 2 }}>
                {m.active_conversations} active · {m.closed_conversations} closed · backlog {m.backlog} · first response {fmtMin(m.first_response_avg_min)} · resolution {fmtMin(m.resolution_avg_min)} · {m.total_ratings > 0 ? `${Math.round((m.great_ratings / m.total_ratings) * 100)}% great` : 'no ratings'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid-3 mt-16">
        <div className="card">
          <h3 className="card-title">Tickets by inbox</h3>
          {data.by_mailbox.map((m) => (
            <div key={m.name} className="flex-between" style={{ padding: '3px 0' }}>
              <Link to={`/inbox?view=all`}>{m.name}</Link>
              <span className="badge">{m.count}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-title">Tickets by tag</h3>
          {data.by_tag.slice(0, 8).map((t) => (
            <div key={t.name} className="flex-between" style={{ padding: '3px 0' }}>
              <Link to={`/inbox?view=all&tag=${encodeURIComponent(t.name)}`}>{t.name}</Link>
              <span className="badge">{t.count}</span>
            </div>
          ))}
          {data.by_tag.length === 0 ? <span className="muted text-sm">No tags yet</span> : null}
        </div>
        <div className="card">
          <h3 className="card-title">Tickets by agent</h3>
          {data.by_agent.map((a) => (
            <div key={a.name} className="flex-between" style={{ padding: '3px 0' }}>
              <span>{a.name}</span>
              <span className="badge">{a.count}</span>
            </div>
          ))}
          {data.by_agent.length === 0 ? <span className="muted text-sm">Unassigned work only</span> : null}
          {data.by_team.length > 0 ? (
            <>
              <div className="text-xs muted mt-8" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>By team</div>
              {data.by_team.map((t) => (
                <div key={t.name} className="flex-between" style={{ padding: '3px 0' }}>
                  <span>{t.name}</span>
                  <span className="badge">{t.count}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
      <p className="text-xs muted mt-16">
        All metrics are local calculations from the synchronized mirror; definitions and limitations are listed in Reports → Metric definitions. AI-derived numbers are labeled as AI-derived. Ratings update in real time over Server-Sent Events (/api/events).
      </p>
    </div>
  );
}
