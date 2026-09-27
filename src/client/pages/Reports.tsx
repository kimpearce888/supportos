import { type ReactNode, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Spinner, EmptyState, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';

export function ReportsPage(): ReactNode {
  const [tab, setTab] = useState<'overview' | 'questions' | 'intelligence' | 'definitions' | 'helpscout' | 'releases'>('overview');
  const [days, setDays] = useState(30);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: dashboard } = useQuery({ queryKey: ['dashboard', days], queryFn: () => api.get<Record<string, unknown>>(`/api/analytics/dashboard?days=${days}`) });
  const { data: topQuestions } = useQuery({ queryKey: ['top-questions', days], queryFn: () => api.get<{ questions: { question: string; count: number; conversation_ids: number[] }[] }>('/api/reports/top-questions?days=' + days) });
  const { data: whyContacting } = useQuery({ queryKey: ['why-contacting', days], queryFn: () => api.get<{ categories: { category: string; count: number; conversation_ids: number[] }[] }>('/api/reports/why-contacting?days=' + days) });

  const hsReport = useMutation({
    mutationFn: (key: string) => api.get<{ ok: boolean; report: { name: string; data: unknown } | null; message?: string }>(`/api/reports/helpscout/${key}?days=${days}`),
    onSuccess: (r) => { if (!r.ok) pushToast({ kind: 'error', message: r.message ?? 'Report request failed' }); }
  });
  const narrative = useMutation({
    mutationFn: () => api.post<{ ok: boolean; narrative?: string; error?: string }>('/api/reports/narrative', { reportName: 'Support overview', facts: { days, ...dashboard } }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const { data: definitions } = useQuery({ queryKey: ['metric-defs'], queryFn: () => api.get<{ definitions: { key: string; name: string; description: string | null; formula: string | null; source: string; limitations: string | null }[] }>('/api/reports/metric-definitions') });
  const { data: releases } = useQuery({ queryKey: ['release-corr'], queryFn: () => api.get<{ releases: { release: string; version: string | null; occurred_at: string; before_7d: number; after_7d: number }[]; note: string }>('/api/reports/release-correlation') });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle">Every number is labeled: Help Scout (native API) · local calculation · AI-derived</p>
        </div>
        <div className="flex">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`btn small ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`tab ${tab === 'questions' ? 'active' : ''}`} onClick={() => setTab('questions')}>Why customers contact us</button>
        <button className={`tab ${tab === 'intelligence' ? 'active' : ''}`} onClick={() => setTab('intelligence')}>Support intelligence</button>
        <button className={`tab ${tab === 'helpscout' ? 'active' : ''}`} onClick={() => setTab('helpscout')}>Help Scout reports</button>
        <button className={`tab ${tab === 'definitions' ? 'active' : ''}`} onClick={() => setTab('definitions')}>Metric definitions</button>
        <button className={`tab ${tab === 'releases' ? 'active' : ''}`} onClick={() => setTab('releases')}>Release correlation</button>
      </div>

      {tab === 'overview' ? (
        !dashboard ? <Spinner /> : (
          <div className="grid-2">
            <div className="card">
              <h3 className="card-title">Volume (local)</h3>
              <KV k="New conversations" v={String(dashboard.new_conversations)} />
              <KV k="Replies sent" v={String(dashboard.replies_sent)} />
              <KV k="Closed in range" v={String(dashboard.closed_conversations)} />
              <KV k="Ratings" v={`${(dashboard.ratings as Record<string, number> | undefined)?.great ?? 0} great / ${(dashboard.ratings as Record<string, number> | undefined)?.okay ?? 0} okay / ${(dashboard.ratings as Record<string, number> | undefined)?.['not-good'] ?? 0} not-good`} />
            </div>
            <div className="card">
              <h3 className="card-title">AI narrative (clearly labeled AI-generated)</h3>
              <button className="btn small" onClick={() => narrative.mutate()} disabled={narrative.isPending}>Generate narrative from computed facts</button>
              {narrative.data?.narrative ? (
                <div className="alert ai mt-8" style={{ marginBottom: 0 }}>
                  <div>{narrative.data.narrative}</div>
                  <div className="text-xs muted mt-8">AI-generated locally from the computed facts. SQL computed the numbers; the model only explains them.</div>
                </div>
              ) : (
                <p className="text-xs muted mt-8">The narrative is generated from the deterministic metrics shown on this page - the model never recalculates numbers.</p>
              )}
            </div>
          </div>
        )
      ) : null}

      {tab === 'questions' ? (
        <div className="grid-2">
          <div className="card">
            <h3 className="card-title">Why are customers contacting us? (AI-derived categories)</h3>
            <p className="text-xs muted" style={{ marginTop: 0 }}>Categories are discovered from actual ticket data - never hard-coded.</p>
            {whyContacting?.categories.length === 0 ? <EmptyState icon="ai" title="Run AI analysis first" hint="Categories derive from AI ticket analyses (AI Center → Analyze)." /> : null}
            {whyContacting?.categories.map((c) => (
              <div key={c.category} className="flex-between" style={{ padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
                <strong className="text-sm">{c.category}</strong>
                <span className="badge ai">{c.count} tickets</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 className="card-title">Top customer questions</h3>
            {topQuestions?.questions.length === 0 ? <span className="muted text-sm">No AI analyses yet.</span> : null}
            {topQuestions?.questions.slice(0, 12).map((q) => (
              <div key={q.question} style={{ padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
                <div className="flex-between">
                  <span className="text-sm" style={{ maxWidth: '80%' }}>{q.question}</span>
                  <span className="badge">{q.count}×</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'intelligence' ? (
        <IntelligenceReports />
      ) : null}

      {tab === 'helpscout' ? (
        <div className="card">
          <h3 className="card-title">Native Help Scout reports (imported from the API)</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>These numbers use Help Scout's own definitions via the v2 Reports API.</p>
          <div className="flex wrap" style={{ gap: 6 }}>
            {['company', 'conversations', 'happiness', 'productivity'].map((key) => (
              <button key={key} className="btn small" onClick={() => hsReport.mutate(key)} disabled={hsReport.isPending}>Import {key}</button>
            ))}
          </div>
          {hsReport.data?.report ? (
            <pre className="doc-content mt-16">{JSON.stringify(hsReport.data.report.data, null, 2)}</pre>
          ) : (
            <p className="muted text-sm mt-16">No report imported yet.</p>
          )}
        </div>
      ) : null}

      {tab === 'definitions' ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Metric</th><th>Source</th><th>Formula</th><th>Limitations</th></tr></thead>
            <tbody>
              {(definitions?.definitions ?? []).map((d) => (
                <tr key={d.key}>
                  <td><strong>{d.name}</strong><div className="text-xs muted mono">{d.key}</div></td>
                  <td><span className={`badge ${d.source === 'helpscout' ? 'ok' : d.source === 'ai' ? 'ai' : ''}`}>{d.source}</span></td>
                  <td className="text-xs mono">{d.formula}</td>
                  <td className="text-xs">{d.limitations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'releases' ? (
        <div className="card">
          <h3 className="card-title">Release correlation (extensible)</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>{releases?.note}</p>
          <table className="table">
            <thead><tr><th>Release</th><th>When</th><th>7d before</th><th>7d after</th></tr></thead>
            <tbody>
              {(releases?.releases ?? []).map((r) => (
                <tr key={r.release + r.occurred_at}>
                  <td>{r.release} {r.version ? `(${r.version})` : ''}</td>
                  <td className="text-xs">{new Date(r.occurred_at).toLocaleString()}</td>
                  <td>{r.before_7d}</td>
                  <td>{r.after_7d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(releases?.releases ?? []).length === 0 ? <EmptyState title="No release events recorded" hint="Add release events to compare conversation volume before/after each release. Overlaps are only ever 'potentially related'." /> : null}
        </div>
      ) : null}
    </div>
  );
}

function IntelligenceReports(): ReactNode {
  const { data: gaps } = useQuery({ queryKey: ['doc-gaps'], queryFn: () => api.get<{ gaps: { question: string; conversation_count: number; coverage: string }[] }>('/api/reports/doc-gaps') });
  const { data: reuse } = useQuery({ queryKey: ['answer-reuse'], queryFn: () => api.get<{ candidates: { question: string; conversation_count: number }[] }>('/api/reports/answer-reuse') });
  const { data: radar } = useQuery({ queryKey: ['issue-radar'], queryFn: () => api.get<{ alerts: { title: string; detail: string; severity: string }[] }>('/api/reports/issue-radar') });
  const { data: aiAnalytics } = useQuery({ queryKey: ['ai-analytics'], queryFn: () => api.get<Record<string, number | { pattern: string; count: number }[]>>('/api/analytics/ai') });
  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Documentation gaps</h3>
        {(gaps?.gaps ?? []).slice(0, 6).map((g) => (
          <div key={g.question} className="flex-between" style={{ padding: '4px 0' }}>
            <span className="text-sm" style={{ maxWidth: '75%' }}>{g.question}</span>
            <span className={`badge ${g.coverage === 'missing' ? 'err' : 'warn'}`}>{g.coverage} · {g.conversation_count}</span>
          </div>
        ))}
        {(gaps?.gaps ?? []).length === 0 ? <span className="muted text-sm">No gaps detected.</span> : null}
      </div>
      <div className="card">
        <h3 className="card-title">Answer reuse candidates</h3>
        {(reuse?.candidates ?? []).slice(0, 6).map((c) => (
          <div key={c.question} className="flex-between" style={{ padding: '4px 0' }}>
            <span className="text-sm" style={{ maxWidth: '75%' }}>{c.question}</span>
            <span className="badge">{c.conversation_count}×</span>
          </div>
        ))}
        {(reuse?.candidates ?? []).length === 0 ? <span className="muted text-sm">No candidates yet.</span> : null}
      </div>
      <div className="card">
        <h3 className="card-title">Issue alerts</h3>
        {(radar?.alerts ?? []).slice(0, 6).map((a, i) => (
          <div key={i} className={`alert ${a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'}`} style={{ marginBottom: 6 }}>
            {a.title}
          </div>
        ))}
        {(radar?.alerts ?? []).length === 0 ? <span className="muted text-sm">No alerts.</span> : null}
      </div>
      <div className="card">
        <h3 className="card-title">AI assistance report</h3>
        {aiAnalytics ? (
          <>
            <KV k="Tickets analyzed" v={String(aiAnalytics.tickets_analyzed)} />
            <KV k="Draft acceptance" v={`${String(aiAnalytics.draft_accepted)} accepted / ${String(aiAnalytics.draft_rejected)} rejected`} />
            <KV k="Verification warnings" v={String(aiAnalytics.verification_warnings)} />
          </>
        ) : <Spinner />}
      </div>
    </div>
  );
}
