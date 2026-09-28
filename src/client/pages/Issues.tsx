import { type ReactNode, useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, Radar, Layers, BookPlus, Trash2, Link2, Flame } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime, safeExternalHref } from '../components/common/ui.js';
import { Modal, ConfirmDialog } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import type { IssueRadarAlert, DocGap, AnswerReuseCandidate } from '../../shared/types.js';

interface Cluster { id: number; title: string; summary: string; category: string | null; product: string | null; feature: string | null; conversation_count: number; customer_count: number; first_seen_at: string | null; last_seen_at: string | null; trend: string; known_issue_id: number | null; ai_generated: number; conversation_ids: number[] }
interface KnownIssue { id: number; title: string; symptoms: string; product: string | null; feature: string | null; known_cause: string | null; workaround: string | null; customer_safe_explanation: string | null; internal_explanation: string | null; status: string; first_seen_at: string | null; last_seen_at: string | null; conversation_count: number; provenance: string; conversation_ids: number[]; engineering_refs: { id: number; system: string; reference_id: string; url: string | null; title: string | null; status: string | null }[] }

export function IssuesPage(): ReactNode {
  // Deep link: /issues?tab=known (from search results) opens that tab directly
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = (['radar', 'clusters', 'known', 'gaps', 'reuse'] as const).includes(tabParam as never) ? (tabParam as 'radar' | 'clusters' | 'known' | 'gaps' | 'reuse') : 'radar';
  const [tab, setTab] = useState<'radar' | 'clusters' | 'known' | 'gaps' | 'reuse'>(initialTab);
  useEffect(() => {
    if (tabParam && (['radar', 'clusters', 'known', 'gaps', 'reuse'] as const).includes(tabParam as never)) setTab(tabParam as 'radar' | 'clusters' | 'known' | 'gaps' | 'reuse');
  }, [tabParam]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title"><AlertTriangle size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Issues</h1>
          <p className="page-subtitle">Issue intelligence from your local data - every alert links to underlying tickets; correlations are never claimed as causes.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'radar' ? 'active' : ''}`} onClick={() => setTab('radar')}><Radar size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Issue Radar</button>
        <button className={`tab ${tab === 'clusters' ? 'active' : ''}`} onClick={() => setTab('clusters')}><Layers size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Clusters</button>
        <button className={`tab ${tab === 'known' ? 'active' : ''}`} onClick={() => setTab('known')}>Known Issues</button>
        <button className={`tab ${tab === 'gaps' ? 'active' : ''}`} onClick={() => setTab('gaps')}>Doc Gaps</button>
        <button className={`tab ${tab === 'reuse' ? 'active' : ''}`} onClick={() => setTab('reuse')}>Answer Reuse</button>
      </div>
      {tab === 'radar' ? <IssueRadar /> : null}
      {tab === 'clusters' ? <Clusters /> : null}
      {tab === 'known' ? <KnownIssues /> : null}
      {tab === 'gaps' ? <DocGaps /> : null}
      {tab === 'reuse' ? <AnswerReuse /> : null}
    </div>
  );
}

function IssueRadar(): ReactNode {
  const { data, error } = useQuery({ queryKey: ['issue-radar-full'], queryFn: () => api.get<{ alerts: IssueRadarAlert[] }>('/api/reports/issue-radar') });
  const { data: sla } = useQuery({ queryKey: ['sla-alerts'], queryFn: () => api.get<SlaAlertsData>('/api/issues/sla-alerts'), refetchInterval: 60_000 });
  if (error) return <ErrorState message="Could not load issue radar" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} />;
  if (!data) return <Spinner />;
  return (
    <>
      <SlaAlertsPanel data={sla} />
      {data.alerts.length === 0 && (sla == null || (sla.total_breached === 0 && sla.total_at_risk === 0)) ? (
        <EmptyState icon="sparkles" title="No alerts right now" hint="Alerts appear when clusters rise, new issues appear, volume spikes, SLA targets slip, or ratings correlate with topics." />
      ) : null}
      {data.alerts.map((a, i) => (
        <div key={i} className={`alert ${a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'}`}>
          <div className="flex-between">
            <strong>{a.title}</strong>
            <span className="badge">{a.kind}</span>
          </div>
          <div className="text-sm" style={{ marginTop: 4 }}>{a.detail}</div>
          <div className="flex wrap" style={{ gap: 4, marginTop: 6 }}>
            {a.conversation_ids.map((cid) => (
              <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge">conversation #{cid}</Link>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs muted">Every alert carries supporting ticket links. Timing correlations are worded as "associated"/"potentially related", never as proven causation.</p>
    </>
  );
}

interface SlaAlertsData {
  generated_at: string;
  total_breached: number;
  total_at_risk: number;
  alerts: { conversation_id: number; number: number; subject: string | null; status: string; mailbox_name: string; state: 'breached' | 'at_risk'; waited_business_min: number; target_min: number; target_kind: 'first_response' | 'resolution'; overdue_business_min: number; since: string }[];
  per_mailbox: { mailbox_id: number; mailbox_name: string; breached: number; at_risk: number; monitored: number }[];
  unconfigured_mailboxes: string[];
  note: string;
}

/** v1.5.0: business-hours-aware SLA alerts at the top of the Issue Radar. */
function SlaAlertsPanel({ data }: { data: SlaAlertsData | undefined }): ReactNode {
  if (!data) return null;
  if (data.total_breached === 0 && data.total_at_risk === 0) {
    if (data.unconfigured_mailboxes.length > 0) {
      return (
        <div className="alert info">
          <strong>SLA alerts not active for every mailbox</strong>
          <div className="text-sm" style={{ marginTop: 4 }}>
            Configure business hours and SLA targets in Settings → Business hours for: {data.unconfigured_mailboxes.join(', ')}. Until then those mailboxes are reported as unconfigured - nothing is guessed.
          </div>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="card" style={{ padding: 0, marginBottom: 14 }}>
      <div className="flex-between" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <h3 className="card-title" style={{ marginBottom: 0 }}>
            SLA alerts — business-hours aware
          </h3>
          <p className="text-xs muted" style={{ margin: '2px 0 0' }}>{data.note}</p>
        </div>
        <div className="flex" style={{ gap: 8 }}>
          <span className="badge err">{data.total_breached} breached</span>
          <span className="badge warn">{data.total_at_risk} at risk</span>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Conversation</th>
            <th>Mailbox</th>
            <th>State</th>
            <th>Waiting</th>
            <th>Target</th>
            <th>Overdue</th>
          </tr>
        </thead>
        <tbody>
          {data.alerts.map((a) => (
            <tr key={a.conversation_id}>
              <td>
                <Link to={`/inbox/conversation/${a.conversation_id}`} className="text-sm">
                  <span className="mono">#{a.number}</span> {a.subject ?? '(no subject)'}
                </Link>
              </td>
              <td className="text-sm">{a.mailbox_name}</td>
              <td>
                <span className={`badge ${a.state === 'breached' ? 'err' : 'warn'}`}>{a.state === 'breached' ? 'breached' : 'at risk'}</span>
              </td>
              <td className="text-sm">{a.waited_business_min} business min</td>
              <td className="text-xs">
                {a.target_min} min ({a.target_kind.replace('_', ' ')})
              </td>
              <td className="text-sm">{a.overdue_business_min > 0 ? <span className="badge err">+{a.overdue_business_min} min</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.unconfigured_mailboxes.length > 0 ? (
        <p className="text-xs muted" style={{ padding: '6px 12px', margin: 0 }}>
          Not yet configured (no alerts computed): {data.unconfigured_mailboxes.join(', ')} — Settings → Business hours.
        </p>
      ) : null}
    </div>
  );
}

function Clusters(): ReactNode {
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ['clusters'], queryFn: () => api.get<{ clusters: Cluster[] }>('/api/issues/clusters') });
  const [deleting, setDeleting] = useState<number | null>(null);
  const del = useMutation({ mutationFn: (id: number) => api.delete(`/api/issues/clusters/${id}`), onSuccess: () => void refetch() });
  const pushToast = useUiStore((s) => s.pushToast);
  const navigate = useNavigate();
  // v2.0.0 (M4): declare an incident FROM a cluster - pre-fills the workspace
  // and links every member conversation in one action.
  const declareIncident = useMutation({
    mutationFn: (clusterId: number) => api.post<{ ok: boolean; incident: { id: number }; linked_conversations: number }>(`/api/incidents/from-cluster/${clusterId}`),
    onSuccess: (r) => {
      if (r.ok) {
        pushToast({ kind: 'success', message: `Incident declared from the cluster - ${r.linked_conversations} conversation(s) linked.` });
        navigate(`/incidents/${r.incident.id}`);
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  if (error) return <ErrorState message="Could not load issue clusters" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} />;
  if (isFetching && !data) return <Spinner />;
  if (!data || data.clusters.length === 0) return <EmptyState icon="sparkles" title="No issue clusters yet" hint="Run 'Run issue clustering' in the AI Center - clusters are discovered from actual ticket data, not hard-coded categories." />;
  return (
    <>
      {(data?.clusters ?? []).map((c) => (
        <div key={c.id} className="cluster-card">
          <div className="flex-between wrap">
            <div>
              <strong>{c.title}</strong> <span className={`badge trend-badge ${c.trend}`}>{c.trend}</span> {c.ai_generated ? <span className="badge ai">AI-discovered</span> : <span className="badge">local</span>}
              <div className="text-sm muted" style={{ marginTop: 2 }}>{c.summary}</div>
            </div>
            <div className="flex" style={{ gap: 6 }}>
              <span className="badge">{c.conversation_count} tickets</span>
              <span className="badge">{c.customer_count} customers</span>
              <button className="btn small" title="Create a master-issue incident from this cluster and link its conversations" onClick={() => declareIncident.mutate(c.id)} disabled={declareIncident.isPending}><Flame size={11} /> Declare incident</button>
              <button className="btn ghost small" onClick={() => setDeleting(c.id)} aria-label="Delete cluster"><Trash2 size={12} /></button>
            </div>
          </div>
          <div className="text-xs muted mt-8">
            first seen <RelativeTime iso={c.first_seen_at} /> · last seen <RelativeTime iso={c.last_seen_at} />
            {c.category ? ` · category: ${c.category}` : ''}{c.product ? ` · product: ${c.product}` : ''}{c.feature ? ` · feature: ${c.feature}` : ''}
          </div>
          <div className="flex wrap" style={{ gap: 4, marginTop: 6 }}>
            {c.conversation_ids.slice(0, 12).map((cid) => (
              <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge">#{cid}</Link>
            ))}
          </div>
        </div>
      ))}
      {deleting ? <ConfirmDialog title="Delete cluster" message="Delete this cluster? Conversations are not affected." confirmLabel="Delete" danger onCancel={() => setDeleting(null)} onConfirm={() => { del.mutate(deleting); setDeleting(null); }} /> : null}
    </>
  );
}

function KnownIssues(): ReactNode {
  const { data, error, refetch } = useQuery({ queryKey: ['known-issues'], queryFn: () => api.get<{ known_issues: KnownIssue[] }>('/api/issues/known') });
  const [creating, setCreating] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const navigate = useNavigate();
  // v2.0.0 (M4): declare an incident FROM a known issue - carries the
  // explanations over and links its conversations.
  const declareIncident = useMutation({
    mutationFn: (knownIssueId: number) => api.post<{ ok: boolean; incident: { id: number }; linked_conversations: number }>(`/api/incidents/from-known-issue/${knownIssueId}`),
    onSuccess: (r) => {
      if (r.ok) {
        pushToast({ kind: 'success', message: `Incident declared from the known issue - ${r.linked_conversations} conversation(s) linked.` });
        navigate(`/incidents/${r.incident.id}`);
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ ok: boolean; message: string }>('/api/issues/known', body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setCreating(false);
      void refetch();
    }
  });
  if (error) return <ErrorState message="Could not load known issues" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} />;
  if (!data) return <Spinner />;
  const issues = data.known_issues;
  return (
    <>
      <div className="flex mb-16">
        <button className="btn primary" onClick={() => setCreating(true)}><BookPlus size={13} /> New known issue</button>
      </div>
      {issues.length === 0 ? <EmptyState title="No known issues yet" hint="Create one manually, or let AI analysis flag candidates from tickets." /> : null}
      {issues.map((ki) => (
        <div key={ki.id} className="cluster-card">
          <div className="flex-between wrap">
            <div>
              <strong>{ki.title}</strong>{' '}
              <span className={`badge ${ki.status === 'resolved' ? 'ok' : ki.status === 'investigating' ? 'warn' : ''}`}>{ki.status}</span>{' '}
              <span className="badge">{ki.provenance === 'human_local' ? 'human-verified' : 'AI-generated candidate'}</span>
              {ki.known_cause ? <div className="text-sm muted" style={{ marginTop: 2 }}>Cause: {ki.known_cause}</div> : null}
            </div>
            <div className="flex" style={{ gap: 6 }}>
              <span className="badge">{ki.conversation_count} linked tickets</span>
              <button className="btn small" title="Create a master-issue incident from this known issue" onClick={() => declareIncident.mutate(ki.id)} disabled={declareIncident.isPending}><Flame size={11} /> Declare incident</button>
            </div>
          </div>
          <div className="text-sm mt-8">{ki.symptoms}</div>
          {ki.workaround ? <div className="text-sm mt-8"><strong>Workaround:</strong> {ki.workaround}</div> : null}
          {ki.customer_safe_explanation ? <div className="alert info mt-8" style={{ marginBottom: 0 }}><strong>Customer-safe explanation:</strong> {ki.customer_safe_explanation}</div> : null}
          {ki.internal_explanation ? <div className="alert warn mt-8" style={{ marginBottom: 0 }}><strong>Internal explanation (never sent to customers):</strong> {ki.internal_explanation}</div> : null}
          {ki.engineering_refs.length > 0 ? (
            <div className="mt-8 text-xs">
              <strong>Engineering references:</strong>{' '}
              {/* v1.6.0 audit fix: scheme-check engineering-ref URLs (from the local DB) before rendering as links. */}
              {ki.engineering_refs.map((r) => {
                const href = r.url != null ? safeExternalHref(r.url) : undefined;
                return (
                  <span key={r.id} className="source-chip">
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer">{r.system} {r.reference_id}</a> : `${r.system} ${r.reference_id}`}
                    {r.status ? ` (${r.status})` : ''}
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="flex wrap mt-8" style={{ gap: 4 }}>
            {ki.conversation_ids.slice(0, 12).map((cid) => (
              <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge"><Link2 size={10} /> #{cid}</Link>
            ))}
          </div>
          <div className="text-xs muted mt-8">first seen <RelativeTime iso={ki.first_seen_at} /> · last seen <RelativeTime iso={ki.last_seen_at} /></div>
        </div>
      ))}
      {creating ? (
        <Modal
          title="New known issue"
          onClose={() => setCreating(false)}
          footer={<button className="btn primary" form="ki-form" type="submit">Create</button>}
        >
          <form
            id="ki-form"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.target as HTMLFormElement);
              create.mutate(Object.fromEntries(fd.entries()));
            }}
          >
            <div className="form-row"><label className="field" htmlFor="ki-title">Title *</label><input id="ki-title" name="title" className="input" required /></div>
            <div className="form-row"><label className="field" htmlFor="ki-symptoms">Symptoms</label><textarea id="ki-symptoms" name="symptoms" className="input" /></div>
            <div className="grid-2">
              <div className="form-row"><label className="field" htmlFor="ki-product">Product</label><input id="ki-product" name="product" className="input" /></div>
              <div className="form-row"><label className="field" htmlFor="ki-feature">Feature</label><input id="ki-feature" name="feature" className="input" /></div>
            </div>
            <div className="form-row"><label className="field" htmlFor="ki-cause">Known cause (internal)</label><input id="ki-cause" name="known_cause" className="input" /></div>
            <div className="form-row"><label className="field" htmlFor="ki-workaround">Workaround</label><textarea id="ki-workaround" name="workaround" className="input" /></div>
            <div className="form-row"><label className="field" htmlFor="ki-cse">Customer-safe explanation (safe for drafts)</label><textarea id="ki-cse" name="customer_safe_explanation" className="input" /></div>
            <div className="form-row"><label className="field" htmlFor="ki-ie">Internal explanation (never in customer drafts)</label><textarea id="ki-ie" name="internal_explanation" className="input" /></div>
            <div className="form-row">
              <label className="field" htmlFor="ki-status">Status</label>
              <select id="ki-status" name="status" className="input" defaultValue="investigating">
                <option value="investigating">investigating</option>
                <option value="identified">identified</option>
                <option value="fix_in_progress">fix in progress</option>
                <option value="resolved">resolved</option>
                <option value="monitoring">monitoring</option>
              </select>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

function DocGaps(): ReactNode {
  const { data, error } = useQuery({ queryKey: ['doc-gaps'], queryFn: () => api.get<{ gaps: DocGap[] }>('/api/reports/doc-gaps') });
  if (error) return <ErrorState message="Could not load doc gaps" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} />;
  if (!data) return <Spinner />;
  if (data.gaps.length === 0) return <EmptyState title="No documentation gaps detected" hint="Gaps appear when the same question repeats and local knowledge coverage is thin. AI analysis needs to run for question extraction." />;
  return (
    <>
      {data.gaps.map((g, i) => (
        <div key={i} className="cluster-card">
          <div className="flex-between wrap">
            <strong>{g.question}</strong>
            <span className={`badge ${g.coverage === 'missing' ? 'err' : 'warn'}`}>coverage: {g.coverage}</span>
          </div>
          <div className="text-xs muted mt-8">{g.conversation_count} related conversations</div>
          {g.known_answer ? <div className="text-sm mt-8"><strong>Known answer (from past replies):</strong> {g.known_answer}</div> : null}
          <div className="mt-8 flex" style={{ gap: 6 }}>
            <Link className="btn small" to="/knowledge">Create knowledge draft →</Link>
          </div>
        </div>
      ))}
    </>
  );
}

function AnswerReuse(): ReactNode {
  const { data, error } = useQuery({ queryKey: ['answer-reuse'], queryFn: () => api.get<{ candidates: AnswerReuseCandidate[] }>('/api/reports/answer-reuse') });
  if (error) return <ErrorState message="Could not load answer reuse candidates" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} />;
  if (!data) return <Spinner />;
  if (data.candidates.length === 0) return <EmptyState title="No reuse candidates yet" hint="Detected when the same question is answered repeatedly. This is a recommendation system - nothing is modified automatically." />;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <thead><tr><th>Question</th><th>Tickets</th><th>Common resolution</th><th>Saved reply</th><th>Knowledge</th></tr></thead>
        <tbody>
          {data.candidates.map((c) => (
            <tr key={c.question}>
              <td style={{ maxWidth: 280 }}>{c.question}</td>
              <td><span className="badge">{c.conversation_count}</span></td>
              <td className="text-xs" style={{ maxWidth: 320 }}>{c.common_resolution ?? '—'}</td>
              <td>{c.saved_reply_name ?? <span className="badge warn">candidate</span>}</td>
              <td>{c.knowledge_doc_title ?? <span className="badge warn">candidate</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '8px 14px' }} className="text-xs muted">Recommendations only - SupportOS never modifies Help Scout saved replies automatically.</div>
    </div>
  );
}
