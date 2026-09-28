import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Users, Gauge, UserPlus, Save, TriangleAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { useOperationsCenter, useWorkload, useSuggestedAssignees } from '../api/hooks.js';
import { useReference } from '../api/hooks.js';
import { Spinner, EmptyState, ErrorState, RelativeTime, ProgressBar } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import type { CapacityModel } from '../../shared/collaboration.js';

/**
 * Operations Center (v1.8.0, plan Phases 10-11): the live operational state
 * (16 tiles, mailbox-scoped, drill-down into the exact filtered inbox list)
 * plus the team workload / capacity view with the read-only suggested
 * assignee.
 *
 * Live updates: SSE conversation/sync/campaign/notification events invalidate
 * ['operations-center'] and ['operations-workload'], plus a 30s refetch.
 */

const SEVERITY_CLASS: Record<string, string> = { info: 'tile-info', warning: 'tile-warning', critical: 'tile-critical' };

const PAGE_DRILL: Record<string, string> = {
  issues: '/issues',
  automation: '/automation',
  'sync-health': '/sync-health',
  outreach: '/outreach',
  notifications: '/notifications'
};

export function OperationsCenterPage(): ReactNode {
  const [tab, setTab] = useState<'overview' | 'workload'>('overview');
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Operations Center</h1>
          <p className="page-subtitle">Live operational state — updates in real time over SSE, refreshed every 30s</p>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          <Activity size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Overview
        </button>
        <button className={`tab ${tab === 'workload' ? 'active' : ''}`} onClick={() => setTab('workload')}>
          <Users size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Team workload
        </button>
      </div>
      {tab === 'overview' ? <TilesView /> : <WorkloadView />}
    </div>
  );
}

function TilesView(): ReactNode {
  const { mailboxes: mailboxesQuery } = useReference();
  const mailboxes = mailboxesQuery.data;
  const [selected, setSelected] = useState<number[]>([]);
  const { data, isLoading, isError, error } = useOperationsCenter(selected.length > 0 ? selected : null);
  const navigate = useNavigate();

  if (isLoading) return <Spinner label="Computing operational state" />;
  if (isError) return <ErrorState message="Could not load the Operations Center." detail={(error as Error | null)?.message} />;
  if (!data) return null;

  const toggleMailbox = (id: number): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const openTile = (drill: { type: string; params: Record<string, string>; page?: string }): void => {
    if (drill.type === 'inbox') {
      const qs = new URLSearchParams(drill.params).toString();
      navigate(`/inbox?${qs}`);
    } else if (drill.type === 'page' && drill.page != null && drill.page in PAGE_DRILL) {
      const target = PAGE_DRILL[drill.page];
      if (target != null) navigate(target);
    }
  };

  return (
    <>
      <div className="flex wrap mb-8" style={{ gap: 6, alignItems: 'center' }}>
        <span className="text-xs muted">Scope:</span>
        <button className={`btn small ${selected.length === 0 ? 'primary' : ''}`} onClick={() => setSelected([])}>All inboxes</button>
        {(mailboxes ?? []).map((m) => (
          <button key={m.id} className={`btn small ${selected.includes(m.id) ? 'primary' : ''}`} onClick={() => toggleMailbox(m.id)}>
            {m.name}
          </button>
        ))}
        <span className="text-xs muted" style={{ marginLeft: 'auto' }}>
          <RelativeTime iso={data.generated_at} prefix="computed " /> · waiting threshold {data.waiting_threshold_minutes} min
        </span>
      </div>
      <div className="ops-grid">
        {data.tiles.map((t) => (
          <button
            key={t.key}
            className={`ops-tile ${SEVERITY_CLASS[t.severity] ?? 'tile-info'} ${t.count === 0 ? 'tile-zero' : ''}`}
            onClick={() => openTile(t.drill as unknown as { type: string; params: Record<string, string>; page?: string })}
            title={t.note ?? t.label}
          >
            <span className="ops-tile-count">{t.count}</span>
            <span className="ops-tile-label">{t.label}</span>
            {t.note ? <span className="ops-tile-note">{t.note}</span> : null}
          </button>
        ))}
      </div>
      <div className="card mt-12">
        <h3 className="card-title"><TriangleAlert size={14} /> How to read these numbers</h3>
        <ul className="text-xs muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Conversation tiles drill into the <strong>exact same filtered inbox list</strong> — tile and list are computed from one SQL fragment, so they can never disagree.</li>
          <li>SLA tiles measure <strong>business minutes</strong> (mailbox schedule + targets); the waiting threshold is wall-clock minutes.</li>
          <li>"High customer effort" is a labeled heuristic (strong frustration signal or 5+ customer messages), not a measurement.</li>
          <li>AI escalation reflects the latest AI analysis (urgency high/critical or frustrated sentiment, medium/high confidence) — a flag to look, never an action.</li>
        </ul>
      </div>
    </>
  );
}

function WorkloadView(): ReactNode {
  const { data, isLoading, isError, error } = useWorkload();
  if (isLoading) return <Spinner label="Computing workload" />;
  if (isError) return <ErrorState message="Could not load workload." detail={(error as Error | null)?.message} />;
  if (!data) return null;
  return (
    <>
      {data.method_notes.map((n, i) => <p key={i} className="text-xs muted" style={{ marginTop: i === 0 ? 0 : 2 }}>· {n}</p>)}
      <div className="ops-grid mt-8">
        <div className="ops-tile tile-info">
          <span className="ops-tile-count">{data.unassigned_work}</span>
          <span className="ops-tile-label">Unassigned work</span>
        </div>
        {data.agents.map((a) => (
          <div key={a.user_local_id} className={`ops-tile ${a.pressure >= 1 ? 'tile-critical' : a.pressure >= 0.75 ? 'tile-warning' : 'tile-info'}`}>
            <span className="ops-tile-label" style={{ fontWeight: 650 }}>
              {a.display_name}
              <span className={`dot ${a.availability.email_status === 'active' ? 'dot-active' : a.availability.email_status === 'away' ? 'dot-away' : 'dot-unknown'}`} title={`email: ${a.availability.email_status ?? 'unknown'} · chat: ${a.availability.chat_status ?? 'unknown'} (Help Scout user status)`} />
            </span>
            <span className="ops-tile-count">{a.open_workload}<span className="text-xs muted"> / {a.capacity}</span></span>
            <div style={{ width: '100%' }}><ProgressBar value={Math.min(1, a.pressure)} /></div>
            <span className="ops-tile-note">
              pressure {Math.round(a.pressure * 100)}% · urgent {a.urgent_workload} · SLA {a.sla_risk_workload} · waiting {a.customer_waiting_workload} · pending {a.pending_workload}
            </span>
            <span className="ops-tile-note">
              weighted {a.weighted_load} · avg load 7d {a.avg_active_load_7d ?? '—'} · closed 7d {a.recent_closed_7d}
            </span>
          </div>
        ))}
        {data.teams.map((t) => (
          <div key={`team-${t.team_local_id}`} className={`ops-tile ${t.pressure >= 1 ? 'tile-critical' : t.pressure >= 0.75 ? 'tile-warning' : 'tile-info'}`}>
            <span className="ops-tile-label" style={{ fontWeight: 650 }}>{t.name} <span className="text-xs muted">({t.available_members}/{t.total_members} available)</span></span>
            <span className="ops-tile-count">{t.open_workload}<span className="text-xs muted"> / {t.capacity}</span></span>
            <div style={{ width: '100%' }}><ProgressBar value={Math.min(1, t.pressure)} /></div>
            <span className="ops-tile-note">pressure {Math.round(t.pressure * 100)}% · closed 7d {t.recent_closed_7d}</span>
          </div>
        ))}
      </div>
      <SuggestedAssigneesPanel />
      <CapacityEditor model={data.capacity_model} />
    </>
  );
}

function SuggestedAssigneesPanel(): ReactNode {
  const { data, isLoading, isError, error } = useSuggestedAssignees(10);
  const pushToast = useUiStore((s) => s.pushToast);
  const assign = useMutation({
    mutationFn: (input: { conversationId: number; userLocalId: number }) =>
      api.post<{ ok: boolean; message: string; detail?: string }>(`/api/conversations/${input.conversationId}/assign`, { userId: input.userLocalId }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  if (isLoading) return <Spinner label="Computing suggestions" />;
  if (isError) return <ErrorState message="Could not load suggested assignees." detail={(error as Error | null)?.message} />;
  const suggestions = data?.suggestions ?? [];
  return (
    <div className="card mt-12">
      <h3 className="card-title"><UserPlus size={14} /> Suggested assignees (read-only recommendation)</h3>
      <p className="text-xs muted" style={{ marginTop: 0 }}>
        Deterministic ranking: available agents first, then lowest resulting pressure. SupportOS never reassigns automatically — the Assign button is an explicit human action.
      </p>
      {suggestions.length === 0 ? (
        <EmptyState icon="users" title="No unassigned conversations" hint="Nothing needs an owner right now." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Priority</th>
              <th>Waiting</th>
              <th>Suggested</th>
              <th>Reasoning</th>
              <th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s) => (
              <tr key={s.conversation_id}>
                <td>
                  <Link to={`/inbox/conversation/${s.conversation_id}`}>
                    #{s.conversation_number ?? s.conversation_id}{s.subject ? ` — ${s.subject.slice(0, 40)}` : ''}
                  </Link>
                </td>
                <td><span className={`badge ${s.supportos_priority === 'urgent' || s.supportos_priority === 'high' ? 'err' : 'tag'}`}>{s.supportos_priority}</span></td>
                <td className="text-xs">{s.waiting_minutes != null ? `${s.waiting_minutes}m` : '—'}</td>
                <td>
                  <strong>{s.suggested_display_name ?? '—'}</strong>
                  <div className="text-xs muted">pressure after {s.suggested_pressure_after ?? '—'} · {s.suggested_availability}</div>
                </td>
                <td className="text-xs muted">{s.reason}{s.all_away ? ' ⚠ all agents away' : ''}</td>
                <td>
                  {s.suggested_user_local_id != null ? (
                    <button className="btn small" disabled={assign.isPending} onClick={() => assign.mutate({ conversationId: s.conversation_id, userLocalId: s.suggested_user_local_id! })}>
                      Assign
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CapacityEditor({ model }: { model: CapacityModel }): ReactNode {
  const [defaultMax, setDefaultMax] = useState(String(model.default_max_open));
  const [urgent, setUrgent] = useState(String(model.weights.urgent));
  const [sla, setSla] = useState(String(model.weights.sla));
  const [waiting, setWaiting] = useState(String(model.weights.waiting));
  const [open, setOpen] = useState(String(model.weights.open));
  const [perUser, setPerUser] = useState(() => Object.entries(model.per_user_max).map(([k, v]) => `${k}=${v}`).join(', '));
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (m: CapacityModel) => api.put<{ saved: boolean; capacity_model: CapacityModel }>('/api/operations/capacity', m),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Capacity model saved.' });
      void qc.invalidateQueries({ queryKey: ['operations-workload'] });
      void qc.invalidateQueries({ queryKey: ['suggested-assignees'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const submit = (): void => {
    const parseNum = (s: string, fallback: number): number => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };
    const overrides: Record<string, number> = {};
    for (const part of perUser.split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const [k, v] = entry.split('=').map((x) => x.trim());
      const id = Number(k);
      const max = Number(v);
      if (Number.isInteger(id) && id > 0 && Number.isFinite(max) && max > 0) overrides[String(id)] = Math.trunc(max);
    }
    save.mutate({
      default_max_open: Math.trunc(parseNum(defaultMax, 25)),
      per_user_max: overrides,
      weights: {
        urgent: parseNum(urgent, 3),
        sla: parseNum(sla, 2),
        waiting: parseNum(waiting, 1.5),
        open: parseNum(open, 1)
      }
    });
  };
  return (
    <div className="card mt-12" style={{ maxWidth: 560 }}>
      <h3 className="card-title"><Gauge size={14} /> Capacity model (explicit configuration)</h3>
      <p className="text-xs muted" style={{ marginTop: 0 }}>
        Capacity is never inferred from anything about a person — it is this configuration. Per-user overrides use local user ids (<code>user_local_id=max</code>, comma-separated).
      </p>
      <div className="flex wrap" style={{ gap: 8 }}>
        <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Default max open
          <input className="input" style={{ width: 90 }} value={defaultMax} onChange={(e) => setDefaultMax(e.target.value)} inputMode="numeric" />
        </label>
        <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Weight: urgent
          <input className="input" style={{ width: 70 }} value={urgent} onChange={(e) => setUrgent(e.target.value)} inputMode="decimal" />
        </label>
        <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          SLA
          <input className="input" style={{ width: 70 }} value={sla} onChange={(e) => setSla(e.target.value)} inputMode="decimal" />
        </label>
        <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Waiting
          <input className="input" style={{ width: 70 }} value={waiting} onChange={(e) => setWaiting(e.target.value)} inputMode="decimal" />
        </label>
        <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Open
          <input className="input" style={{ width: 70 }} value={open} onChange={(e) => setOpen(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
        Per-user overrides
        <input className="input" placeholder="1=30, 3=15" value={perUser} onChange={(e) => setPerUser(e.target.value)} />
      </label>
      <button className="btn primary small mt-8" onClick={submit} disabled={save.isPending}>
        <Save size={11} /> Save capacity model
      </button>
    </div>
  );
}
