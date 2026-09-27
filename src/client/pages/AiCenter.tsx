import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Bot, RefreshCw, Sparkles, FlaskConical, ListChecks } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import type { AiAnalytics } from '../../shared/types.js';

export function AiCenterPage(): ReactNode {
  const [tab, setTab] = useState<'health' | 'analytics' | 'jobs' | 'evaluation'>('health');
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
  const { data: jobs, refetch: refetchJobs } = useQuery({ queryKey: ['ai-jobs'], queryFn: () => api.get<{ jobs: { id: number; type: string; status: string; conversation_id: number | null; model: string | null; error: string | null; created_at: string; latency_ms: number | null }[] }>('/api/ai/jobs') });
  const { data: evaluation } = useQuery({ queryKey: ['ai-evaluation'], queryFn: () => api.get<{ tests: { name: string; category: string; payload: { subject: string; body: string } }[]; evaluation_mode: boolean }>('/api/ai/evaluation') });

  const cluster = useMutation({
    mutationFn: () => api.post<{ ok: boolean; clusters: unknown[]; error?: string }>('/api/ai/cluster-issues', { days: 60 }),
    onSuccess: (r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.ok ? `Discovered ${r.clusters.length} clusters.` : (r.error ?? 'Clustering failed') }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const toggleEval = useMutation({
    mutationFn: (on: boolean) => api.patch<{ ok: boolean }>('/api/settings', { ai_evaluation_mode: on }),
    onSuccess: () => pushToast({ kind: 'success', message: 'AI evaluation mode updated.' })
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

      {tab === 'jobs' ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '10px 14px' }}>
            <h3 className="card-title" style={{ margin: 0 }}>AI job history</h3>
            <button className="btn small" onClick={() => void refetchJobs()}><RefreshCw size={11} /> Refresh</button>
          </div>
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
