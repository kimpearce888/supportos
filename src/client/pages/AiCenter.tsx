import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, RefreshCw, Sparkles, FlaskConical, ListChecks, Tags, Trash2, MessageSquare } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import { useAttributeReport, useAttributeConversations, useCopilotSessions } from '../api/hooks.js';
import { AI_ATTRIBUTE_CATALOG } from '../../shared/constants.js';
import type { AiAnalytics } from '../../shared/types.js';

export function AiCenterPage(): ReactNode {
  const [tab, setTab] = useState<'health' | 'analytics' | 'attributes' | 'copilot' | 'jobs' | 'evaluation'>('health');
  const pushToast = useUiStore((s) => s.pushToast);

  const { data: status, error: statusError } = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<{
    ai_enabled: boolean;
    settings: { base_url: string; chat_model: string | null; embedding_model: string | null };
    lmstudio: { connected: boolean; models: string[]; error: string | null };
    last_inference: { at: string; latencyMs: number } | null;
    queued_ai_jobs: number;
    failed_ai_jobs: number;
    index: { conversations_indexed: number; chunks_indexed: number; chunks_pending: number; chunks_failed: number };
  }>('/api/ai/status'), refetchInterval: 30_000 });

  const { data: analytics, error: analyticsError } = useQuery<AiAnalytics>({ queryKey: ['ai-analytics'], queryFn: () => api.get('/api/ai/analytics') });
  // v1.6.0 audit fix: the jobs and evaluation queries had no error states
  // (missed in the v1.2 fix wave that covered status/analytics).
  const { data: jobs, refetch: refetchJobs, isError: jobsIsError, error: jobsError } = useQuery({ queryKey: ['ai-jobs'], queryFn: () => api.get<{ jobs: { id: number; type: string; status: string; conversation_id: number | null; model: string | null; error: string | null; created_at: string; latency_ms: number | null }[] }>('/api/ai/jobs') });
  const { data: evaluation, isError: evaluationIsError, error: evaluationError } = useQuery({ queryKey: ['ai-evaluation'], queryFn: () => api.get<{ tests: { name: string; category: string; payload: { subject: string; body: string } }[]; evaluation_mode: boolean }>('/api/ai/evaluation') });
  const queryClient = useQueryClient();

  const cluster = useMutation({
    mutationFn: () => api.post<{ ok: boolean; clusters: unknown[]; error?: string }>('/api/ai/cluster-issues', { days: 60 }),
    onSuccess: (r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.ok ? `Discovered ${r.clusters.length} clusters.` : (r.error ?? 'Clustering failed') }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const toggleEval = useMutation({
    mutationFn: (on: boolean) => api.patch<{ ok: boolean }>('/api/settings', { ai_evaluation_mode: on }),
    // v2.2.1 audit fix: the driving query was never invalidated, so the
    // checkbox snapped back to the stale value after a successful PATCH.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-evaluation'] });
      pushToast({ kind: 'success', message: 'AI evaluation mode updated.' });
    }
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title"><Bot size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> AI Center</h1>
          <p className="page-subtitle">Local AI (LM Studio) - no cloud providers. The app stays fully usable when AI is off.</p>
        </div>
        <button className="btn" onClick={() => cluster.mutate()} disabled={cluster.isPending}>
          <Sparkles size={13} /> {cluster.isPending ? 'Clustering…' : 'Run issue clustering'}
        </button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'health' ? 'active' : ''}`} onClick={() => setTab('health')}>Local AI health</button>
        <button className={`tab ${tab === 'analytics' ? 'active' : ''}`} onClick={() => setTab('analytics')}>AI analytics</button>
        {/* v1.9.0 (M3, plan Phase 16): reportable + searchable attribute layer. */}
        <button className={`tab ${tab === 'attributes' ? 'active' : ''}`} onClick={() => setTab('attributes')}><Tags size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Attributes</button>
        {/* v1.9.0 (M3, plan Phase 15): Local Copilot sessions. */}
        <button className={`tab ${tab === 'copilot' ? 'active' : ''}`} onClick={() => setTab('copilot')}><Bot size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Copilot</button>
        <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>AI jobs</button>
        <button className={`tab ${tab === 'evaluation' ? 'active' : ''}`} onClick={() => setTab('evaluation')}><FlaskConical size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Evaluation</button>
      </div>

      {tab === 'health' ? (
        statusError ? <ErrorState message="Could not load AI status" detail={statusError instanceof Error ? statusError.message : 'The request failed. Retry or check the logs.'} /> : !status ? <Spinner /> : (
          <>
            <div className="grid-2">
              <div className="card">
                <h3 className="card-title">LM Studio connection</h3>
                <KV k="Base URL" v={<span className="mono">{status.settings.base_url}</span>} />
                <KV k="Chat model" v={status.settings.chat_model ?? <span className="muted">auto (first loaded)</span>} />
                <KV k="Embedding model" v={status.settings.embedding_model ?? <span className="muted">not configured</span>} />
                <KV k="Reachable" v={status.lmstudio.connected ? <span className="badge ok">connected · {status.lmstudio.models.length} models</span> : <span className="badge err">offline</span>} />
                {status.lmstudio.error ? <div className="alert warn mt-8" style={{ marginBottom: 0 }}>{status.lmstudio.error}</div> : null}
                {status.lmstudio.models.length > 0 ? (
                  <div className="mt-8">
                    {status.lmstudio.models.slice(0, 8).map((m) => (
                      <span key={m} className="badge" style={{ margin: '0 4px 4px 0' }}>{m}</span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-16"><Link className="btn small" to="/settings">Configure in Settings →</Link></div>
              </div>
              <div className="card">
                <h3 className="card-title">Indexing + jobs</h3>
                <KV k="AI enabled" v={status.ai_enabled ? <span className="badge ok">enabled</span> : <span className="badge">disabled</span>} />
                <KV k="Last inference" v={status.last_inference ? <><RelativeTime iso={status.last_inference.at} /> · {status.last_inference.latencyMs}ms</> : '—'} />
                <KV k="Queued AI jobs" v={status.queued_ai_jobs} />
                <KV k="Failed AI jobs" v={status.failed_ai_jobs > 0 ? <span className="badge err">{status.failed_ai_jobs}</span> : status.failed_ai_jobs} />
                <KV k="Indexed knowledge chunks" v={`${status.index.chunks_indexed} (pending ${status.index.chunks_pending}, failed ${status.index.chunks_failed})`} />
                <KV k="Thread embeddings" v={status.index.conversations_indexed} />
              </div>
            </div>
            <div className="card mt-16">
              <h3 className="card-title">Pipeline safety</h3>
              <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                <li>AI never sends customer replies automatically - drafts require explicit human review (verified-answer mode).</li>
                <li>Verification checks: unanswered questions, unsupported claims, invented timeframes, internal leakage.</li>
                <li>Read tools only (search_conversations, search_knowledge, …) with server-side permission validation - no SQL access.</li>
                <li>Redaction layer masks payment data, tokens, API keys before prompting.</li>
                <li>Every AI result records model, prompt version, latency and sources for auditability.</li>
              </ul>
            </div>
          </>
        )
      ) : null}

      {tab === 'analytics' ? (
        analyticsError ? <ErrorState message="Could not load AI analytics" detail={analyticsError instanceof Error ? analyticsError.message : 'The request failed. Retry or check the logs.'} /> : !analytics ? <Spinner /> : (
          <div className="grid-2">
            <div className="card">
              <h3 className="card-title">Assistance metrics (local, from stored data)</h3>
              <KV k="Tickets analyzed" v={analytics.tickets_analyzed} />
              <KV k="Analysis success rate" v={`${analytics.analysis_success_rate}%`} />
              <KV k="Drafts generated" v={analytics.draft_count} />
              <KV k="Drafts accepted" v={analytics.draft_accepted} />
              <KV k="Drafts rejected" v={analytics.draft_rejected} />
              <KV k="Draft edit rate" v={`${analytics.draft_edit_rate}%`} />
              <KV k="Verification warnings" v={analytics.verification_warnings} />
              <KV k="Unsupported-claim rate" v={`${analytics.unsupported_claim_rate}%`} />
            </div>
            <div className="card">
              <h3 className="card-title">Common AI failure patterns</h3>
              {analytics.common_failure_patterns.length === 0 ? <EmptyState icon="ai" title="No failure patterns recorded" hint="Warnings from draft verification accumulate here." /> : null}
              {analytics.common_failure_patterns.map((p) => (
                <div key={p.pattern} className="flex-between" style={{ padding: '4px 0' }}>
                  <span className="text-sm">{p.pattern}</span>
                  <span className="badge err">{p.count}</span>
                </div>
              ))}
              <p className="text-xs muted mt-8">No claims are made about AI performance beyond what is stored locally.</p>
            </div>
          </div>
        )
      ) : null}

      {tab === 'attributes' ? <AttributeLayerPanel /> : null}

      {tab === 'copilot' ? <CopilotSessionsPanel /> : null}

      {tab === 'jobs' ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '10px 14px' }}>
            <h3 className="card-title" style={{ margin: 0 }}>AI job history</h3>
            <button className="btn small" onClick={() => void refetchJobs()}><RefreshCw size={11} /> Refresh</button>
          </div>
          {jobsIsError ? <div style={{ padding: '0 14px' }}><ErrorState message="Could not load AI jobs." detail={jobsError instanceof Error ? jobsError.message : undefined} /></div> : null}
          <table className="table">
            <thead>
              <tr><th>ID</th><th>Type</th><th>Status</th><th>Conversation</th><th>Model</th><th>Latency</th><th>When</th></tr>
            </thead>
            <tbody>
              {(jobs?.jobs ?? []).slice(0, 60).map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.id}</td>
                  <td>{j.type}</td>
                  <td><span className={`badge ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'err' : j.status === 'running' ? 'warn' : ''}`}>{j.status}</span></td>
                  <td>{j.conversation_id ? <Link to={`/inbox/conversation/${j.conversation_id}`}>#{j.conversation_id}</Link> : '—'}</td>
                  <td className="text-xs mono">{j.model ?? '—'}</td>
                  <td className="text-xs">{j.latency_ms != null ? `${j.latency_ms}ms` : '—'}</td>
                  <td><RelativeTime iso={j.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {jobs && jobs.jobs.length === 0 ? <EmptyState icon="ai" title="No AI jobs yet" /> : null}
        </div>
      ) : null}

      {tab === 'evaluation' ? (
        <>
          {/* v1.6.0 audit fix: error state for the evaluation-set query. */}
          {evaluationIsError ? <ErrorState message="Could not load the evaluation set." detail={evaluationError instanceof Error ? evaluationError.message : undefined} /> : null}
          <div className="card">
            <h3 className="card-title"><FlaskConical size={13} /> Offline AI evaluation mode</h3>
            <p className="text-sm" style={{ marginTop: 0 }}>
              When enabled: no Help Scout writes, no notes, no replies, no status changes, no assignments - only local evaluation. Compare analysis outputs safely.
            </p>
            <label className="flex" style={{ gap: 8, fontWeight: 600 }}>
              <input type="checkbox" checked={evaluation?.evaluation_mode ?? false} onChange={(e) => toggleEval.mutate(e.target.checked)} />
              AI evaluation mode {evaluation?.evaluation_mode ? 'ON' : 'OFF'}
            </label>
          </div>
          <div className="card mt-16">
            <h3 className="card-title"><ListChecks size={13} /> Golden test set (spec scenarios)</h3>
            <table className="table">
              <thead><tr><th>Scenario</th><th>Category</th><th>Sample ticket</th></tr></thead>
              <tbody>
                {(evaluation?.tests ?? []).map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td><span className="badge">{t.category}</span></td>
                    <td className="text-xs">{t.payload.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs muted">The golden set evaluates classification, retrieval, draft generation, verification, internal leakage, missing questions and unsupported claims. Automated runs use the deterministic mocked pipeline (see TESTING.md).</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------- v1.9.0 (M3, plan Phase 16): attribute layer panel ----------------

function AttributeLayerPanel(): ReactNode {
  const { data, isLoading, isError, error, refetch } = useAttributeReport();
  const [attribute, setAttribute] = useState<string>('');
  const [op, setOp] = useState('equals');
  const [value, setValue] = useState('');
  // Blank value means "is unknown" (no stored value) - the honest default.
  const effectiveOp = value.trim() === '' ? 'unknown' : op;
  const { data: drill } = useAttributeConversations(attribute || null, effectiveOp, value, 25);
  const dists = data?.distributions ?? [];

  return (
    <>
      <div className="card">
        <div className="flex-between" style={{ marginBottom: 8 }}>
          <div>
            <h3 className="card-title"><Tags size={13} /> AI attribute layer — coverage report</h3>
            <p className="text-xs muted" style={{ margin: 0 }}>Versioned local attributes (deterministic + AI layers). A missing value is honest 'unknown' — never fabricated. Nothing is written to Help Scout.</p>
          </div>
          <button className="btn small" onClick={() => void refetch()}><RefreshCw size={11} /> Refresh</button>
        </div>
        {isLoading ? <Spinner /> : null}
        {isError ? <ErrorState message="Could not load the attribute report." detail={error instanceof Error ? error.message : undefined} /> : null}
        {!isLoading && !isError && dists.length === 0 ? <EmptyState icon="ai" title="No attributes stored yet" hint="Attributes are computed after the first AI analysis or recompute (deterministic layer needs no AI)." /> : null}
        {dists.map((d) => {
          const knownPct = d.total_conversations > 0 ? Math.round((d.known / d.total_conversations) * 100) : 0;
          return (
            <div key={d.attribute} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="flex-between">
                <span className="text-sm"><strong>{d.label}</strong> <span className="text-xs muted">{d.value_type}</span></span>
                <span className="text-xs muted">{d.known} known · {d.unknown} unknown{d.total_conversations > 0 ? ` · ${knownPct}% coverage` : ''}</span>
              </div>
              <div className="attr-bar" style={{ marginTop: 4 }} title={`known ${d.known} / unknown ${d.unknown}`}>
                <div className="attr-bar-fill" style={{ width: `${knownPct}%` }} />
              </div>
              {d.values.length > 0 ? (
                <div className="flex wrap" style={{ gap: 4, marginTop: 4 }}>
                  {d.values.slice(0, 8).map((v) => (
                    <button key={v.value} className="chip" title={`${v.count} conversation(s)`} onClick={() => { setAttribute(d.attribute); setOp('equals'); setValue(v.value); }}>
                      {v.value} · {v.count}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Searchable drill-down: conversations matching an attribute test. */}
      <div className="card mt-16" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px' }}>
          <h3 className="card-title" style={{ margin: 0 }}>Search by attribute</h3>
          <div className="flex wrap mt-8" style={{ gap: 6 }}>
            <select className="input" style={{ width: 'auto' }} aria-label="Attribute" value={attribute} onChange={(e) => setAttribute(e.target.value)}>
              <option value="">Choose an attribute…</option>
              {AI_ATTRIBUTE_CATALOG.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select className="input" style={{ width: 'auto' }} aria-label="Operator" value={op} onChange={(e) => setOp(e.target.value)}>
              {['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'unknown'].map((o) => <option key={o} value={o}>{o === 'unknown' ? 'is unknown' : o}</option>)}
            </select>
            <input className="input" style={{ width: 200 }} placeholder="value (blank = is unknown)" value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} />
          </div>
        </div>
        {attribute ? (
          drill?.conversations.length ? (
            <table className="table">
              <thead><tr><th>#</th><th>Subject</th><th>Value</th><th>Confidence</th><th>Source</th><th>Computed</th></tr></thead>
              <tbody>
                {drill.conversations.map((c) => (
                  <tr key={c.conversation_id}>
                    <td className="mono"><Link to={`/inbox/conversation/${c.conversation_id}`}>#{c.number}</Link></td>
                    <td className="text-sm">{c.subject ?? '—'}</td>
                    <td><span className="badge">{c.value}</span></td>
                    <td><span className={`badge ${c.confidence === 'high' ? 'ok' : c.confidence === 'medium' ? 'warn' : ''}`}>{c.confidence}</span></td>
                    <td className="text-xs">{c.source}</td>
                    <td className="text-xs"><RelativeTime iso={c.computed_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: '0 14px 10px' }}><EmptyState icon="search" title="No conversations match" hint="Unknown or missing values only match the 'is unknown' / 'equals unknown' operator." /></div>
          )
        ) : (
          <p className="text-xs muted" style={{ padding: '0 14px 10px' }}>Pick an attribute to see matching conversations. Values come from the local layer only.</p>
        )}
      </div>
    </>
  );
}

// ---------------- v1.9.0 (M3, plan Phase 15): Copilot sessions panel ----------------

function CopilotSessionsPanel(): ReactNode {
  const { data, refetch, isLoading } = useCopilotSessions(50);
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/copilot/sessions/${id}`),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Copilot session deleted.' });
      void qc.invalidateQueries({ queryKey: ['copilot-sessions'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const sessions = data?.sessions ?? [];
  return (
    <>
      <div className="card">
        <h3 className="card-title"><Bot size={13} /> Local Copilot</h3>
        <p className="text-sm" style={{ marginTop: 0 }}>
          An interactive, read-only assistant inside every conversation (context pane → Copilot tab). It answers with local evidence — this ticket, the customer's history, similar cases, knowledge, known issues and the AI attribute layer — through an allowlisted read-only tool registry. It never writes to Help Scout and never sends anything to the customer; citations are generated by the server from the tools it actually executed.
        </p>
        <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Runs fully locally via LM Studio — no cloud LLM, ever.</li>
          <li>The model never sees SQL: tools are parameter-validated reads.</li>
          <li>Tool budget is bounded per turn; answers must cite real evidence.</li>
          <li>If LM Studio is off, the Copilot says so instead of pretending.</li>
        </ul>
        <div className="mt-16"><Link className="btn small" to="/inbox">Open a conversation to use it →</Link></div>
      </div>
      <div className="card mt-16" style={{ padding: 0 }}>
        <div className="flex-between" style={{ padding: '10px 14px' }}>
          <h3 className="card-title" style={{ margin: 0 }}><MessageSquare size={13} style={{ display: 'inline', verticalAlign: 'middle' }} /> Copilot sessions</h3>
          <button className="btn small" onClick={() => void refetch()}><RefreshCw size={11} /> Refresh</button>
        </div>
        {isLoading ? <div style={{ padding: 14 }}><Spinner /></div> : null}
        {!isLoading && sessions.length === 0 ? <div style={{ padding: 14 }}><EmptyState icon="bot" title="No Copilot sessions yet" hint="Ask a question from any conversation's Copilot tab." /></div> : null}
        {sessions.length > 0 ? (
          <table className="table">
            <thead><tr><th>Session</th><th>Conversation</th><th>Messages</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="text-sm">{s.title}</td>
                  <td>{s.conversation_id != null ? <Link to={`/inbox/conversation/${s.conversation_id}`}>#{s.conversation_number ?? s.conversation_id}</Link> : <span className="muted text-xs">global</span>}</td>
                  <td>{s.message_count}</td>
                  <td className="text-xs"><RelativeTime iso={s.updated_at} /></td>
                  <td><button className="btn ghost small" title="Delete session" onClick={() => del.mutate(s.id)}><Trash2 size={11} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}
