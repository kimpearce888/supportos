import { type ReactNode, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Flame, Trash2 } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, StatusBadge, RelativeTime, KV } from '../components/common/ui.js';
import { Modal, ConfirmDialog } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import type { IncidentStatus, IncidentSeverity, IssueImpact } from '../../shared/workspace.js';

/**
 * Incidents / master-issue workspace (plan Phase 18-19). The list view is
 * the triage board; the detail page is the full workspace: explanations,
 * impact panel, linked conversations, affected customers/organizations,
 * related entities, engineering refs, releases, notes and the timeline.
 * Affected counts are always DERIVED (distinct customers, never ticket
 * counts) - the API computes them, this view only labels them honestly.
 */

interface IncidentListRow {
  id: number;
  code: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  product: string | null;
  feature: string | null;
  owner_name: string | null;
  conversation_count: number;
  customer_count: number;
  organization_count: number;
  updated_at: string;
}

const SEVERITY_CLASS: Record<string, string> = { sev1: 'err', sev2: 'warn', sev3: '', sev4: 'ok' };
const STATUS_CLASS: Record<string, string> = { investigating: 'warn', identified: '', fix_in_progress: 'warn', monitoring: '', resolved: 'ok' };

function SeverityBadge({ severity }: { severity: string }): ReactNode {
  return <span className={`badge ${SEVERITY_CLASS[severity] ?? ''}`} title={`Severity ${severity}`}>{severity.toUpperCase()}</span>;
}

export function IncidentsPage(): ReactNode {
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [open, setOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['incidents', q, statusFilter, open],
    queryFn: () => api.get<{ incidents: IncidentListRow[]; total: number }>(`/api/incidents${qs({ q, status: statusFilter, open: open ? 'true' : '' })}`)
  });
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Incidents</h1>
          <p className="page-subtitle">{data?.total ?? '…'} master issues · affected customers are derived from linked conversations (never ticket counts)</p>
        </div>
        <div className="flex" style={{ gap: 8 }}>
          <form className="searchbar" style={{ marginBottom: 0, width: 300 }} onSubmit={(e) => e.preventDefault()}>
            <input className="input" placeholder="Search code or title…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search incidents" />
            <button className="btn" type="submit"><Search size={13} /></button>
          </form>
          <button className="btn" onClick={() => setCreateOpen(true)}><Plus size={12} /> Declare incident</button>
        </div>
      </div>
      <div className="flex wrap mb-16" style={{ gap: 6 }}>
        {['', 'investigating', 'identified', 'fix_in_progress', 'monitoring', 'resolved'].map((s) => (
          <button key={s || 'all'} className={`chip ${statusFilter === s ? 'active' : ''}`} onClick={() => setStatusFilter(s)}>
            {s ? s.replace('_', ' ') : 'all statuses'}
          </button>
        ))}
        <button className={`chip ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} title="Hide resolved incidents">open only</button>
      </div>
      {isLoading ? <Spinner /> : null}
      {error ? <ErrorState message="Could not load incidents" detail={error instanceof Error ? error.message : 'The request failed.'} /> : null}
      {data && data.incidents.length === 0 ? (
        <EmptyState icon="shield" title="No incidents" hint="Declare an incident from the Issues page (cluster or known issue) or create one here to group many conversations under one master issue." />
      ) : null}
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Title</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Conversations</th>
              <th>Customers</th>
              <th>Orgs</th>
              <th>Owner</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(data?.incidents ?? []).map((i) => (
              <tr key={i.id} className="clickable" onClick={() => navigate(`/incidents/${i.id}`)}>
                <td className="mono"><Link to={`/incidents/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.code}</Link></td>
                <td><strong className="text-sm">{i.title}</strong>{i.product ? <div className="text-xs muted">{i.product}{i.feature ? ` · ${i.feature}` : ''}</div> : null}</td>
                <td><span className={`badge ${STATUS_CLASS[i.status] ?? ''}`}>{i.status.replace('_', ' ')}</span></td>
                <td><SeverityBadge severity={i.severity} /></td>
                <td><span className="badge">{i.conversation_count}</span></td>
                <td><span className="badge">{i.customer_count}</span></td>
                <td className="text-sm">{i.organization_count || '—'}</td>
                <td className="text-sm">{i.owner_name ?? '—'}</td>
                <td><RelativeTime iso={i.updated_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {createOpen ? <CreateIncidentModal onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); pushToast({ kind: 'success', message: 'Incident declared.' }); navigate(`/incidents/${id}`); }} /> : null}
    </div>
  );
}

function CreateIncidentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('sev3');
  const [status, setStatus] = useState<IncidentStatus>('investigating');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ ok: boolean; incident: { id: number }; message?: string }>('/api/incidents', { title, severity, status, description: description || null }),
    onSuccess: (r) => {
      if (r.ok) onCreated(r.incident.id);
      else pushToast({ kind: 'error', message: r.message ?? 'Could not create incident' });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  return (
    <Modal title="Declare incident" onClose={onClose}>
      <div className="form-grid">
        <label className="label">Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Timezone display issue" autoFocus />
        <label className="label">Severity</label>
        <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}>
          <option value="sev1">SEV1 — critical</option>
          <option value="sev2">SEV2 — major</option>
          <option value="sev3">SEV3 — moderate</option>
          <option value="sev4">SEV4 — minor</option>
        </select>
        <label className="label">Status</label>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)}>
          <option value="investigating">investigating</option>
          <option value="identified">identified</option>
          <option value="fix_in_progress">fix in progress</option>
          <option value="monitoring">monitoring</option>
          <option value="resolved">resolved</option>
        </select>
        <label className="label">Description <span className="muted">(optional)</span></label>
        <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is going on?" />
      </div>
      <p className="text-xs muted">Conversations can be linked after creation. Everything here is LOCAL SupportOS data - nothing is written to Help Scout.</p>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>Declare</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Detail

interface IncidentDetailData {
  incident: IncidentListRow & {
    description: string | null;
    internal_explanation: string | null;
    customer_safe_explanation: string | null;
    known_cause: string | null;
    workaround: string | null;
    resolution: string | null;
    started_at: string | null;
    resolved_at: string | null;
    owner_user_local_id: number | null;
  };
  impact: IssueImpact;
  conversations: { conversation_id: number; number: number; subject: string | null; status: string; mailbox: string | null; customer_name: string | null; customer_local_id: number | null; remote_created_at: string | null; linked_by: string }[];
  affected_customers: { customer_local_id: number; name: string | null; email: string | null; organization: string | null; conversations: number; open_conversations: number }[];
  affected_organizations: { organization_id: number; name: string | null; customers: number; conversations: number }[];
  related: { target_kind: string; target_local_id: number; target_label: string; note: string | null; linked_at: string }[];
  refs: { id: number; system: string; reference: string; url: string | null; title: string | null; status: string | null; notes: string | null }[];
  releases: { id: number; version_label: string; notes: string | null; released_at: string | null; correlation: string | null }[];
  notes: { id: number; author_name: string | null; body: string; created_at: string }[];
  timeline: { id: number; event_type: string; occurred_at: string; detail: string | null }[];
}

export function IncidentDetailPage(): ReactNode {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [linkNumber, setLinkNumber] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api.get<IncidentDetailData>(`/api/incidents/${id}`)
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['incident', id] }); void qc.invalidateQueries({ queryKey: ['incidents'] }); };
  const act = useMutation({
    mutationFn: (input: { path: string; body?: unknown; method?: 'post' | 'delete' | 'patch' }) => {
      if (input.method === 'delete') return api.delete<{ ok: boolean; message?: string }>(input.path);
      if (input.method === 'patch') return api.patch<{ ok: boolean; message?: string }>(input.path, input.body);
      return api.post<{ ok: boolean; message?: string }>(input.path, input.body);
    },
    onSuccess: (r) => { pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Done.' : 'Failed.') }); refresh(); },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (error) return <div className="page"><ErrorState message="Could not load incident" detail={error instanceof Error ? error.message : 'The request failed.'} /></div>;
  if (isLoading || !data) return <div className="page"><Spinner /></div>;
  const inc = data.incident;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <span className="mono">{inc.code}</span> {inc.title}
          </h1>
          <p className="page-subtitle">
            <span className={`badge ${STATUS_CLASS[inc.status] ?? ''}`}>{inc.status.replace('_', ' ')}</span>{' '}
            <SeverityBadge severity={inc.severity} />
            {inc.product ? ` · ${inc.product}` : ''}{inc.feature ? ` · ${inc.feature}` : ''}
            {' · '}{data.impact.affected_conversations} conversations · {data.impact.affected_customers} customers · {data.impact.affected_organizations} organizations
          </p>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          <select className="input" style={{ width: 160 }} value={inc.status} onChange={(e) => act.mutate({ path: `/api/incidents/${id}`, method: 'patch', body: { status: e.target.value } })} aria-label="Incident status">
            <option value="investigating">investigating</option>
            <option value="identified">identified</option>
            <option value="fix_in_progress">fix in progress</option>
            <option value="monitoring">monitoring</option>
            <option value="resolved">resolved</option>
          </select>
          <select className="input" style={{ width: 120 }} value={inc.severity} onChange={(e) => act.mutate({ path: `/api/incidents/${id}`, method: 'patch', body: { severity: e.target.value } })} aria-label="Incident severity">
            <option value="sev1">SEV1</option>
            <option value="sev2">SEV2</option>
            <option value="sev3">SEV3</option>
            <option value="sev4">SEV4</option>
          </select>
          <Link to="/incidents" className="btn">← All incidents</Link>
          <button className="btn danger" onClick={() => setConfirmDelete(true)}><Trash2 size={11} /> Delete</button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">Impact — deterministic, derived from linked conversations</h3>
          <div className="impact-grid">
            <div className="impact-stat"><span className="impact-value">{data.impact.affected_conversations}</span><span className="impact-label">conversations</span></div>
            <div className="impact-stat"><span className="impact-value">{data.impact.affected_customers}</span><span className="impact-label">unique customers</span></div>
            <div className="impact-stat"><span className="impact-value">{data.impact.affected_organizations}</span><span className="impact-label">organizations</span></div>
            <div className="impact-stat"><span className="impact-value">{data.impact.customer_waiting_count}</span><span className="impact-label">waiting now</span></div>
          </div>
          <KV k="First seen" v={data.impact.first_seen_at ? <RelativeTime iso={data.impact.first_seen_at} /> : 'unknown'} />
          <KV k="Last seen" v={data.impact.last_seen_at ? <RelativeTime iso={data.impact.last_seen_at} /> : 'unknown'} />
          <KV k="7-day growth" v={`${data.impact.growth_rate_7d.recent} recent vs ${data.impact.growth_rate_7d.previous} previous (${data.impact.growth_rate_7d.direction})`} />
          <KV k="Trend" v={data.impact.trend} />
          <KV k="Open / closed" v={`${data.impact.open_closed_distribution.open} open · ${data.impact.open_closed_distribution.closed} closed`} />
          {data.impact.affected_inboxes.length > 0 ? <KV k="Inboxes" v={data.impact.affected_inboxes.map((m) => `${m.mailbox ?? 'unassigned'} (${m.conversations})`).join(', ')} /> : null}
          {data.impact.top_tags.length > 0 ? <KV k="Tags" v={data.impact.top_tags.map((t) => `${t.tag} (${t.conversations})`).join(', ')} /> : null}
          {data.impact.products.length > 0 ? <KV k="Products (AI attributes)" v={data.impact.products.map((p) => `${p.product} (${p.conversations})`).join(', ')} /> : <KV k="Products (AI attributes)" v={<span className="muted">unknown until conversations are analyzed</span>} />}
          <p className="text-xs muted" style={{ marginBottom: 0 }}>{data.impact.note}</p>
        </div>

        <div className="card">
          <h3 className="card-title">Explanations & resolution</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>Internal explanation and engineering references are never exposed to customers; the customer-safe text is what outreach and drafts may use.</p>
          <div className="mb-8"><strong className="text-sm">Description</strong><div className="text-sm">{inc.description ?? <span className="muted">—</span>}</div></div>
          <div className="mb-8"><strong className="text-sm">Internal explanation</strong><div className="text-sm">{inc.internal_explanation ?? <span className="muted">—</span>}</div></div>
          <div className="mb-8"><strong className="text-sm">Customer-safe explanation</strong><div className="text-sm">{inc.customer_safe_explanation ?? <span className="muted">—</span>}</div></div>
          <div className="mb-8"><strong className="text-sm">Known cause</strong><div className="text-sm">{inc.known_cause ?? <span className="muted">—</span>}</div></div>
          <div className="mb-8"><strong className="text-sm">Workaround</strong><div className="text-sm">{inc.workaround ?? <span className="muted">—</span>}</div></div>
          <div className="mb-8"><strong className="text-sm">Resolution</strong><div className="text-sm">{inc.resolution ?? <span className="muted">—</span>}</div></div>
          <textarea className="input" rows={2} placeholder="Append to resolution…" onBlur={(e) => { if (e.target.value.trim()) { act.mutate({ path: `/api/incidents/${id}`, method: 'patch', body: { resolution: [inc.resolution, e.target.value.trim()].filter(Boolean).join('\n\n') } }); e.target.value = ''; } }} />
        </div>
      </div>

      <div className="card mt-16">
        <div className="flex-between">
          <h3 className="card-title">Linked conversations ({data.conversations.length})</h3>
          <form className="flex" style={{ gap: 6 }} onSubmit={(e) => {
            e.preventDefault();
            const num = Number(linkNumber.trim().replace('#', ''));
            if (Number.isFinite(num) && num > 0) {
              // Exact number lookup (?number=N) - the list endpoint's
              // conversation summaries carry the local id for the link call.
              api.get<{ conversations: { id: number; number: number }[] }>(`/api/conversations${qs({ number: num, view: 'all', pageSize: 5 })}`).then((r) => {
                const match = r.conversations.find((c) => c.number === num);
                if (match) act.mutate({ path: `/api/incidents/${id}/conversations/${match.id}` });
                else pushToast({ kind: 'error', message: `No conversation #${num} in the local mirror.` });
              }).catch((e2: Error) => pushToast({ kind: 'error', message: e2.message }));
              setLinkNumber('');
            }
          }}>
            <input className="input" style={{ width: 160 }} placeholder="Link #number…" value={linkNumber} onChange={(e) => setLinkNumber(e.target.value)} aria-label="Link conversation by number" />
            <button className="btn small" type="submit"><Plus size={11} /> Link</button>
          </form>
        </div>
        {data.conversations.length === 0 ? <EmptyState icon="inbox" title="No conversations linked yet" hint="Link conversations by number to make affected customers and impact counts real." /> : (
          <table className="table">
            <thead>
              <tr><th>#</th><th>Subject</th><th>Status</th><th>Customer</th><th>Mailbox</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.conversations.map((c) => (
                <tr key={c.conversation_id}>
                  <td className="mono"><Link to={`/inbox/conversation/${c.conversation_id}`}>#{c.number}</Link></td>
                  <td className="text-sm"><Link to={`/inbox/conversation/${c.conversation_id}`}>{c.subject ?? '(no subject)'}</Link></td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="text-sm">{c.customer_local_id ? <Link to={`/customers/${c.customer_local_id}`}>{c.customer_name ?? '—'}</Link> : '—'}</td>
                  <td className="text-sm">{c.mailbox ?? '—'}</td>
                  <td><RelativeTime iso={c.remote_created_at} /></td>
                  <td><button className="btn small ghost" title="Unlink" onClick={() => act.mutate({ path: `/api/incidents/${id}/conversations/${c.conversation_id}`, method: 'delete' })}>unlink</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="card-title">Affected customers ({data.affected_customers.length})</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>Distinct customers derived from the linked conversations - a ticket count is never used as a customer count.</p>
          {data.affected_customers.length === 0 ? <span className="muted text-sm">None yet.</span> : (
            <table className="table">
              <thead><tr><th>Customer</th><th>Organization</th><th>Conversations</th><th>Open</th></tr></thead>
              <tbody>
                {data.affected_customers.map((c) => (
                  <tr key={c.customer_local_id}>
                    <td><Link to={`/customers/${c.customer_local_id}`} className="text-sm" style={{ fontWeight: 600 }}>{c.name ?? `customer #${c.customer_local_id}`}</Link><div className="text-xs muted">{c.email ?? ''}</div></td>
                    <td className="text-sm">{c.organization ?? '—'}</td>
                    <td><span className="badge">{c.conversations}</span></td>
                    <td>{c.open_conversations > 0 ? <span className="badge active">{c.open_conversations}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.affected_organizations.length > 0 ? (
            <>
              <h3 className="card-title" style={{ marginTop: 14 }}>Affected organizations</h3>
              {data.affected_organizations.map((o) => (
                <div key={o.organization_id} className="flex-between mb-8">
                  <Link to={`/organizations/${o.organization_id}`} className="text-sm" style={{ fontWeight: 600 }}>{o.name ?? `organization #${o.organization_id}`}</Link>
                  <span className="text-xs muted">{o.customers} customers · {o.conversations} conversations</span>
                </div>
              ))}
            </>
          ) : null}
        </div>

        <div className="card">
          <h3 className="card-title">Engineering references, releases & related</h3>
          {data.refs.length === 0 && data.releases.length === 0 && data.related.length === 0 ? (
            <EmptyState icon="flame" title="No references yet" hint="Attach the Jira/Linear ticket, the release that may be associated, related known issues, knowledge articles or campaigns." />
          ) : null}
          {data.refs.map((r) => (
            <div key={r.id} className="mb-8">
              <div className="flex-between">
                <strong className="text-sm">{r.system}: {r.reference} {r.title ? <span className="muted">· {r.title}</span> : null}</strong>
                <button className="btn small ghost" onClick={() => act.mutate({ path: `/api/incidents/${id}/refs/${r.id}`, method: 'delete' })}>remove</button>
              </div>
              <div className="text-xs muted">{r.status ?? ''}{r.notes ?? ''}</div>
            </div>
          ))}
          {data.releases.map((r) => (
            <div key={r.id} className="mb-8">
              <div className="flex-between">
                <strong className="text-sm"><Flame size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Release {r.version_label}</strong>
                <button className="btn small ghost" onClick={() => act.mutate({ path: `/api/incidents/${id}/releases/${r.id}`, method: 'delete' })}>remove</button>
              </div>
              <div className="text-xs muted">{r.released_at ? `released ${r.released_at.slice(0, 10)}` : 'no date'}{r.correlation ? ` — ${r.correlation}` : ''}</div>
            </div>
          ))}
          {data.related.map((r, i) => (
            <div key={i} className="mb-8 flex-between">
              <span className="text-sm"><span className="badge">{r.target_kind.replace('_', ' ')}</span> {r.target_label}{r.note ? <span className="muted"> · {r.note}</span> : null}</span>
              <button className="btn small ghost" onClick={() => act.mutate({ path: `/api/incidents/${id}/related/${r.target_kind}/${r.target_local_id}`, method: 'delete' })}>unlink</button>
            </div>
          ))}
          <div className="flex mt-8" style={{ gap: 6 }}>
            <button className="btn small" onClick={() => setReleaseOpen(true)}>Add release</button>
            <button className="btn small" onClick={() => {
              const system = window.prompt('Reference system (e.g. linear, jira, github)');
              if (!system) return;
              const reference = window.prompt('Reference id (e.g. ENG-4471)');
              if (!reference) return;
              act.mutate({ path: `/api/incidents/${id}/refs`, body: { system, reference } });
            }}>Add engineering ref</button>
          </div>
        </div>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="card-title">Notes</h3>
          <form onSubmit={(e) => { e.preventDefault(); if (noteBody.trim()) { act.mutate({ path: `/api/incidents/${id}/notes`, body: { body: noteBody.trim() } }); setNoteBody(''); } }}>
            <textarea className="input" rows={2} placeholder="Add an operational note…" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
            <button className="btn small mt-8" type="submit" disabled={!noteBody.trim()}>Add note</button>
          </form>
          {data.notes.map((n) => (
            <div key={n.id} className="mt-16">
              <div className="flex-between"><strong className="text-sm">{n.author_name ?? 'local user'}</strong><RelativeTime iso={n.created_at} /></div>
              <div className="text-sm">{n.body}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-title">Incident timeline</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>Append-only, idempotent by dedup key - created, status/severity changes, links, notes, refs and releases.</p>
          {data.timeline.map((ev) => (
            <div key={ev.id} className="timeline-row">
              <span className="badge">{ev.event_type.replace(/_/g, ' ')}</span>
              {/* v2.2.1 audit fix: raw UTC wall time (slice of the ISO string) was
                  shown while every other timestamp renders in local time. */}
              <RelativeTime iso={ev.occurred_at} />
              {ev.detail ? <span className="text-xs">{(() => { try { return Object.entries(JSON.parse(ev.detail) as Record<string, unknown>).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' · '); } catch { return ''; } })()}</span> : null}
            </div>
          ))}
        </div>
      </div>

      {releaseOpen ? (
        <Modal title="Add release" onClose={() => setReleaseOpen(false)}>
          <ReleaseForm incidentId={Number(id)} onClose={() => setReleaseOpen(false)} onSaved={() => { setReleaseOpen(false); refresh(); }} />
        </Modal>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete incident"
          message={`Delete ${inc.code}? Linked conversations stay untouched - only the local incident workspace is removed.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            api.delete<{ ok: boolean }>(`/api/incidents/${id}`).then(() => { pushToast({ kind: 'success', message: 'Incident deleted.' }); void qc.invalidateQueries({ queryKey: ['incidents'] }); navigate('/incidents'); }).catch((e: Error) => pushToast({ kind: 'error', message: e.message }));
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}

function ReleaseForm({ incidentId, onClose, onSaved }: { incidentId: number; onClose: () => void; onSaved: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [versionLabel, setVersionLabel] = useState('');
  const [releasedAt, setReleasedAt] = useState('');
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message?: string }>(`/api/incidents/${incidentId}/releases`, { versionLabel, releasedAt: releasedAt || null, notes: notes || null }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Release added.' : 'Failed.') });
      if (r.ok) onSaved(); else onClose();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  return (
    <div className="form-grid">
      <label className="label">Version label</label>
      <input className="input" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} placeholder="e.g. v4.12.0" autoFocus />
      <label className="label">Released at <span className="muted">(optional)</span></label>
      <input className="input" type="date" value={releasedAt} onChange={(e) => setReleasedAt(e.target.value)} />
      <label className="label">Notes <span className="muted">(optional)</span></label>
      <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <p className="text-xs muted">Release correlation is reported as a temporal association only - SupportOS never claims the release caused the incident.</p>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!versionLabel.trim() || create.isPending} onClick={() => create.mutate()}>Add</button>
      </div>
    </div>
  );
}
