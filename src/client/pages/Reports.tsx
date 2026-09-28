import { type ReactNode, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import { useSlaReport } from '../api/hooks.js';
import type { SlaMailboxRowInfo } from '../../shared/types.js';
import { EffectivenessTab } from '../components/reports/EffectivenessTab.js';
import { FrictionTab } from '../components/reports/FrictionTab.js';
import { BuilderTab } from '../components/reports/BuilderTab.js';

export function ReportsPage(): ReactNode {
  const [tab, setTab] = useState<'overview' | 'sla' | 'questions' | 'intelligence' | 'effectiveness' | 'friction' | 'builder' | 'definitions' | 'helpscout' | 'releases'>('overview');
  const [days, setDays] = useState(30);
  const pushToast = useUiStore((s) => s.pushToast);
  // v1.6.0 audit fix: every tab query lacked an error state - a failed fetch
  // left the overview tab spinning forever (or silently empty lists).
  const { data: dashboard, isError: dashboardIsError, error: dashboardError } = useQuery({ queryKey: ['dashboard', days], queryFn: () => api.get<Record<string, unknown>>(`/api/analytics/dashboard?days=${days}`) });
  const { data: topQuestions, isError: topQuestionsIsError, error: topQuestionsError } = useQuery({ queryKey: ['top-questions', days], queryFn: () => api.get<{ questions: { question: string; count: number; conversation_ids: number[] }[] }>('/api/reports/top-questions?days=' + days) });
  const { data: whyContacting, isError: whyContactingIsError, error: whyContactingError } = useQuery({ queryKey: ['why-contacting', days], queryFn: () => api.get<{ categories: { category: string; count: number; conversation_ids: number[] }[] }>('/api/reports/why-contacting?days=' + days) });

  const hsReport = useMutation({
    mutationFn: (key: string) => api.get<{ ok: boolean; report: { name: string; data: unknown } | null; message?: string }>(`/api/reports/helpscout/${key}?days=${days}`),
    onSuccess: (r) => { if (!r.ok) pushToast({ kind: 'error', message: r.message ?? 'Report request failed' }); }
  });
  const narrative = useMutation({
    mutationFn: () => api.post<{ ok: boolean; narrative?: string; error?: string }>('/api/reports/narrative', { reportName: 'Support overview', facts: { days, ...dashboard } }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const { data: definitions, isError: definitionsIsError, error: definitionsError } = useQuery({ queryKey: ['metric-defs'], queryFn: () => api.get<{ definitions: { key: string; name: string; description: string | null; formula: string | null; source: string; limitations: string | null }[] }>('/api/reports/metric-definitions') });
  const { data: releases, isError: releasesIsError, error: releasesError } = useQuery({ queryKey: ['release-corr'], queryFn: () => api.get<{ releases: { release: string; version: string | null; occurred_at: string; before_7d: number; after_7d: number }[]; note: string }>('/api/reports/release-correlation') });

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
        <button className={`tab ${tab === 'sla' ? 'active' : ''}`} onClick={() => setTab('sla')}>SLA & business hours</button>
        <button className={`tab ${tab === 'questions' ? 'active' : ''}`} onClick={() => setTab('questions')}>Why customers contact us</button>
        <button className={`tab ${tab === 'intelligence' ? 'active' : ''}`} onClick={() => setTab('intelligence')}>Support intelligence</button>
        <button className={`tab ${tab === 'effectiveness' ? 'active' : ''}`} onClick={() => setTab('effectiveness')}>Response effectiveness</button>
        <button className={`tab ${tab === 'friction' ? 'active' : ''}`} onClick={() => setTab('friction')}>Friction</button>
        <button className={`tab ${tab === 'builder' ? 'active' : ''}`} onClick={() => setTab('builder')}>Report builder</button>
        <button className={`tab ${tab === 'helpscout' ? 'active' : ''}`} onClick={() => setTab('helpscout')}>Help Scout reports</button>
        <button className={`tab ${tab === 'definitions' ? 'active' : ''}`} onClick={() => setTab('definitions')}>Metric definitions</button>
        <button className={`tab ${tab === 'releases' ? 'active' : ''}`} onClick={() => setTab('releases')}>Release correlation</button>
      </div>

      {/* v1.6.0 audit fix: overview tab spun on a Spinner forever when the dashboard query failed. */}
      {tab === 'overview' ? (
        dashboardIsError ? <ErrorState message="This report failed to load." detail={dashboardError instanceof Error ? dashboardError.message : undefined} /> : !dashboard ? <Spinner /> : (
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

      {tab === 'sla' ? <SlaReports days={days} /> : null}

      {/* v2.1.0 (M5, plan phases 28, 29, 33). */}
      {tab === 'effectiveness' ? <EffectivenessTab /> : null}
      {tab === 'friction' ? <FrictionTab /> : null}
      {tab === 'builder' ? <BuilderTab /> : null}

      {tab === 'questions' ? (
        <div className="grid-2">
          <div className="card">
            <h3 className="card-title">Why are customers contacting us? (AI-derived categories)</h3>
            <p className="text-xs muted" style={{ marginTop: 0 }}>Categories are discovered from actual ticket data - never hard-coded.</p>
            {/* v1.6.0 audit fix: error state for the why-contacting report query. */}
            {whyContactingIsError ? <ErrorState message="This report failed to load." detail={whyContactingError instanceof Error ? whyContactingError.message : undefined} /> : null}
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
            {/* v1.6.0 audit fix: error state for the top-questions report query. */}
            {topQuestionsIsError ? <ErrorState message="This report failed to load." detail={topQuestionsError instanceof Error ? topQuestionsError.message : undefined} /> : null}
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
          {/* v1.6.0 audit fix: error state for the metric-definitions query. */}
          {definitionsIsError ? <div style={{ padding: '10px 14px 0' }}><ErrorState message="This report failed to load." detail={definitionsError instanceof Error ? definitionsError.message : undefined} /></div> : null}
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
          {/* v1.6.0 audit fix: error state for the release-correlation query. */}
          {releasesIsError ? <ErrorState message="This report failed to load." detail={releasesError instanceof Error ? releasesError.message : undefined} /> : null}
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
  // v1.6.0 audit fix: the intelligence tab queries had no error states - the
  // AI assistance card spun forever on failure and the other cards silently
  // rendered empty.
  const { data: gaps, isError: gapsIsError, error: gapsError } = useQuery({ queryKey: ['doc-gaps'], queryFn: () => api.get<{ gaps: { question: string; conversation_count: number; coverage: string }[] }>('/api/reports/doc-gaps') });
  const { data: reuse, isError: reuseIsError, error: reuseError } = useQuery({ queryKey: ['answer-reuse'], queryFn: () => api.get<{ candidates: { question: string; conversation_count: number }[] }>('/api/reports/answer-reuse') });
  const { data: radar, isError: radarIsError, error: radarError } = useQuery({ queryKey: ['issue-radar'], queryFn: () => api.get<{ alerts: { title: string; detail: string; severity: string }[] }>('/api/reports/issue-radar') });
  const { data: aiAnalytics, isError: aiAnalyticsIsError, error: aiAnalyticsError } = useQuery({ queryKey: ['ai-analytics'], queryFn: () => api.get<Record<string, number | { pattern: string; count: number }[]>>('/api/analytics/ai') });
  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Documentation gaps</h3>
        {gapsIsError ? <ErrorState message="This report failed to load." detail={gapsError instanceof Error ? gapsError.message : undefined} /> : null}
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
        {reuseIsError ? <ErrorState message="This report failed to load." detail={reuseError instanceof Error ? reuseError.message : undefined} /> : null}
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
        {radarIsError ? <ErrorState message="This report failed to load." detail={radarError instanceof Error ? radarError.message : undefined} /> : null}
        {(radar?.alerts ?? []).slice(0, 6).map((a, i) => (
          <div key={i} className={`alert ${a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'}`} style={{ marginBottom: 6 }}>
            {a.title}
          </div>
        ))}
        {(radar?.alerts ?? []).length === 0 ? <span className="muted text-sm">No alerts.</span> : null}
      </div>
      <div className="card">
        <h3 className="card-title">AI assistance report</h3>
        {aiAnalyticsIsError ? <ErrorState message="This report failed to load." detail={aiAnalyticsError instanceof Error ? aiAnalyticsError.message : undefined} /> : aiAnalytics ? (
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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtMin(m: number | null): string {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (60 * 24))}d`;
}

function SlaStats({ label, s }: { label: string; s: SlaMailboxRowInfo['first_response'] }): ReactNode {
  const total = s.met + s.missed + s.no_target;
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
      <div className="flex-between">
        <strong className="text-sm">{label}</strong>
        <span className="text-xs muted">{s.count} measured{s.target_min != null ? ` · target ${fmtMin(s.target_min)}` : ' · no target set'}</span>
      </div>
      <div className="text-xs muted" style={{ marginTop: 2 }}>
        avg {fmtMin(s.avg_wall_min)} wall{s.avg_business_min != null ? ` · ${fmtMin(s.avg_business_min)} business (median ${fmtMin(s.median_business_min)})` : ''}
      </div>
      {total > 0 && s.target_min != null ? (
        <div className="flex" style={{ gap: 4, marginTop: 4 }}>
          <span className="badge ok">{s.met} met</span>
          <span className={`badge ${s.missed > 0 ? 'err' : ''}`}>{s.missed} missed</span>
          <span className="badge">{s.no_target} n/a</span>
        </div>
      ) : null}
    </div>
  );
}

/** v1.4.0: SLA report - first response / resolution in business minutes per mailbox. */
function SlaReports({ days }: { days: number }): ReactNode {
  const { data, isLoading, error } = useSlaReport(days);
  if (error) return <ErrorState message="Could not load the SLA report" detail={error instanceof Error ? error.message : 'The request failed.'} />;
  if (isLoading || !data) return <Spinner label="Computing SLA report" />;
  return (
    <div>
      {data.unconfigured_mailboxes.length > 0 ? (
        <div className="alert info mb-16">
          <strong>Wall-clock mode:</strong> {data.unconfigured_mailboxes.join(', ')} {data.unconfigured_mailboxes.length === 1 ? 'has' : 'have'} no business hours configured, so {data.unconfigured_mailboxes.length === 1 ? 'its' : 'their'} numbers are measured in wall-clock minutes. Configure schedules in <strong>Settings → Business hours</strong> for business-minute measurement.
        </div>
      ) : null}
      <div className="grid-2">
        {data.mailboxes.map((m) => (
          <div className="card" key={m.mailbox_id}>
            <h3 className="card-title">{m.mailbox_name}</h3>
            <KV k="Schedule" v={m.schedule ? `${DAY_NAMES.filter((_, i) => m.schedule!.days.includes(i)).join(' ')} · ${String(Math.floor(m.schedule.startMinute / 60)).padStart(2, '0')}:${String(m.schedule.startMinute % 60).padStart(2, '0')}–${String(Math.floor(m.schedule.endMinute / 60)).padStart(2, '0')}:${String(m.schedule.endMinute % 60).padStart(2, '0')} · ${m.schedule.timezone}` : 'not configured (wall-clock)'} />
            <KV k="Conversations in range" v={String(m.conversations_in_range)} />
            <SlaStats label="First response" s={m.first_response} />
            <SlaStats label="Resolution" s={m.resolution} />
            <div style={{ padding: '6px 0' }}>
              <div className="flex-between">
                <strong className="text-sm">Currently waiting</strong>
                <span className="badge">{m.waiting.count} open</span>
              </div>
              <div className="text-xs muted" style={{ marginTop: 2 }}>
                avg age {fmtMin(m.waiting.avg_business_min)} · oldest {fmtMin(m.waiting.oldest_business_min)}
                {m.waiting.at_risk > 0 ? ` · ${m.waiting.at_risk} past first-response target` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      {data.mailboxes.length === 0 ? <EmptyState title="No mailboxes in the local mirror" hint="Run an initial sync first." /> : null}
      <p className="text-xs muted mt-16">
        Business minutes count only time inside each mailbox's configured schedule (nights, weekends and holidays excluded); wall minutes are shown alongside for honesty. Waiting ages are measured since each conversation's last activity. All numbers are local calculations from the mirror.
      </p>
    </div>
  );
}
