import { type ReactNode, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Spinner, EmptyState, ErrorState } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { ReportConfig, ReportRunResult, SavedReport } from '../../../shared/reporting.js';
import { SUPPORTED_LANGUAGES } from '../../../shared/translation.js';

interface CatalogResponse {
  metrics: { key: string; label: string; definition: string; limitations: string; format: string; needsAttribute?: boolean }[];
  dimensions: { key: string; label: string; definition: string }[];
  origin: 'local';
  note: string;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Custom report builder tab (v2.1.0, plan Phase 33).
 * Metric + dimension + date range + comparison + sorting; every metric
 * shows its definition and limitations next to the numbers. Charts are the
 * same CSS bars the dashboard uses - no chart library needed for bar shapes.
 */
export function BuilderTab(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [metric, setMetric] = useState('conversations');
  const [dimension, setDimension] = useState('day');
  const [dateFrom, setDateFrom] = useState(isoDaysAgo(30));
  const [dateTo, setDateTo] = useState(isoDaysAgo(0));
  const [comparison, setComparison] = useState<'none' | 'previous_period'>('previous_period');
  const [sort, setSort] = useState<'metric_desc' | 'metric_asc' | 'dimension_asc'>('dimension_asc');
  const [limit, setLimit] = useState(30);
  const [attributeKey, setAttributeKey] = useState('');
  const [stateKey, setStateKey] = useState('');
  const [name, setName] = useState('');
  const [chart, setChart] = useState<'bar' | 'table'>('bar');

  const { data: catalog, isError: catalogIsError } = useQuery({ queryKey: ['builder-catalog'], queryFn: () => api.get<CatalogResponse>('/api/reports/builder/catalog') });
  const { data: saved } = useQuery({ queryKey: ['builder-saved'], queryFn: () => api.get<{ saved: SavedReport[] }>('/api/reports/builder/saved') });

  const config: ReportConfig = useMemo(
    () => ({
      metric: metric as ReportConfig['metric'],
      dimension: dimension as ReportConfig['dimension'],
      dateFrom,
      dateTo,
      comparison,
      filters: attributeKey ? { attributeKey, attributeValue: '' } : stateKey ? { stateKey } : {},
      sort,
      limit
    }),
    [metric, dimension, dateFrom, dateTo, comparison, sort, limit, attributeKey, stateKey]
  );

  const run = useMutation({
    mutationFn: (cfg: ReportConfig) => api.post<ReportRunResult>('/api/reports/builder/run', cfg),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const save = useMutation({
    mutationFn: () => api.post<{ ok: boolean; saved: SavedReport }>('/api/reports/builder/saved', { name, ...config }),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Report definition saved.' });
      void queryClient.invalidateQueries({ queryKey: ['builder-saved'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const removeSaved = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/reports/builder/saved/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['builder-saved'] }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (catalogIsError) return <ErrorState message="The report catalog failed to load." />;
  if (!catalog) return <Spinner />;

  const metricEntry = catalog.metrics.find((m) => m.key === metric);
  const dimensionEntry = catalog.dimensions.find((d) => d.key === dimension);
  const totalOnly = metricEntry?.needsAttribute === true || ['campaign_sent', 'campaign_replies', 'campaign_reply_rate', 'avg_state_hours', 'state_changes'].includes(metric);
  const result = run.data;

  const fmtValue = (v: number): string => {
    const format = metricEntry?.format ?? 'count';
    if (format === 'rate') return `${(v * 100).toFixed(1)}%`;
    if (format === 'minutes' || format === 'hours') return `${Math.round(v)} ${format === 'minutes' ? 'min' : 'h'}`;
    if (format === 'score') return v.toFixed(1);
    return String(Math.round(v));
  };

  return (
    <div className="flex col gap-12">
      <div className="card">
        <h3 className="card-title">Custom report builder</h3>
        <p className="muted text-sm mb-12">{catalog.note}</p>
        <div className="builder-grid">
          <label>
            <span>Metric</span>
            <select value={metric} onChange={(e) => { setMetric(e.target.value); if (totalOnly && e.target.value !== metric) setDimension('none'); }}>
              {catalog.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
          <label>
            <span>Group by</span>
            <select value={dimension} onChange={(e) => setDimension(e.target.value)} disabled={totalOnly}>
              {catalog.dimensions.map((d) => <option key={d.key} value={d.key} disabled={totalOnly && d.key !== 'none'}>{d.label}</option>)}
            </select>
          </label>
          <label>
            <span>From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label>
            <span>To (inclusive)</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label>
            <span>Comparison</span>
            <select value={comparison} onChange={(e) => setComparison(e.target.value as 'none' | 'previous_period')}>
              <option value="none">None</option>
              <option value="previous_period">Previous period</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="metric_desc">Metric (high to low)</option>
              <option value="metric_asc">Metric (low to high)</option>
              <option value="dimension_asc">Dimension (A to Z)</option>
            </select>
          </label>
          <label>
            <span>Max rows</span>
            <input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 30)))} />
          </label>
          <label>
            <span>Display</span>
            <select value={chart} onChange={(e) => setChart(e.target.value as 'bar' | 'table')}>
              <option value="bar">Bar chart</option>
              <option value="table">Table</option>
            </select>
          </label>
          {metricEntry?.needsAttribute ? (
            <label>
              <span>AI attribute key</span>
              <select value={attributeKey} onChange={(e) => setAttributeKey(e.target.value)}>
                <option value="">(choose an attribute)</option>
                {['intent', 'urgency', 'frustration_cues', 'technical_familiarity', 'question_count', 'escalation_signal', 'response_style', 'known_issue', 'issue_cluster', 'customer_goal'].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          ) : null}
          {metric === 'avg_state_hours' || metric === 'state_changes' ? (
            <label>
              <span>Custom state</span>
              <select value={stateKey} onChange={(e) => setStateKey(e.target.value)}>
                <option value="">(choose a state)</option>
                {['new', 'investigating', 'waiting-customer', 'waiting-engineering', 'ready-verify', 'resolved'].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <div className="flex gap-8 mt-12 wrap">
          <button className="btn primary" onClick={() => run.mutate(config)} disabled={run.isPending || (metricEntry?.needsAttribute === true && !attributeKey) || ((metric === 'avg_state_hours' || metric === 'state_changes') && !stateKey)}>
            {run.isPending ? 'Running…' : 'Run report'}
          </button>
          <input className="grow" placeholder="Name to save this report definition…" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <button className="btn" onClick={() => save.mutate()} disabled={save.isPending || name.trim() === ''}>Save definition</button>
        </div>
        {metricEntry ? (
          <div className="alert info mt-12 text-sm">
            <div><strong>{metricEntry.label}</strong> — {metricEntry.definition}</div>
            <div className="muted">Limitations: {metricEntry.limitations}</div>
            {dimensionEntry && dimensionEntry.key !== 'none' ? <div className="muted">Grouping: {dimensionEntry.definition}</div> : null}
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="card">
          <div className="flex between mb-8">
            <h3 className="card-title">{result.metric.label}{result.dimension.key !== 'none' ? ` by ${result.dimension.label.toLowerCase()}` : ''}</h3>
            <span className="muted text-sm">{result.date_range.dateFrom} → {result.date_range.dateTo}{result.comparison_range ? ` (vs ${result.comparison_range.dateFrom} → ${result.comparison_range.dateTo})` : ''}</span>
          </div>
          {result.rows.length === 0 ? (
            <EmptyState title="No data in this range" hint="Try a wider date range or different filters." />
          ) : chart === 'bar' && result.dimension.key !== 'none' ? (
            <div className="barchart">
              {result.rows.map((r) => {
                const max = Math.max(...result.rows.map((x) => x.value), 1);
                const cmp = result.comparison_rows?.find((c) => c.dimension_value === r.dimension_value);
                return (
                  <div key={r.dimension_value} className="bar-row" title={`${r.dimension_label}: ${fmtValue(r.value)}${cmp ? ` (previous: ${fmtValue(cmp.value)})` : ''}`}>
                    <span className="bar-label">{r.dimension_label}</span>
                    <div className="bar-track">
                      <div className="bar" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}>{fmtValue(r.value)}</div>
                      {cmp && cmp.value > 0 ? <div className="bar compare" style={{ width: `${Math.max(1, (cmp.value / max) * 100)}%` }} /> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{result.dimension.key === 'none' ? 'Total' : result.dimension.label}</th>
                  <th>{result.metric.label}</th>
                  {result.comparison_rows ? <th>Previous period</th> : null}
                  <th>Samples</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => {
                  const cmp = result.comparison_rows?.find((c) => c.dimension_value === r.dimension_value);
                  const delta = cmp != null && cmp.value !== 0 ? ((r.value - cmp.value) / Math.abs(cmp.value)) * 100 : null;
                  return (
                    <tr key={r.dimension_value}>
                      <td>{r.dimension_label}</td>
                      <td className="mono">{fmtValue(r.value)}</td>
                      {result.comparison_rows ? (
                        <td className="mono">
                          {cmp ? fmtValue(cmp.value) : '—'}
                          {delta != null ? <span className={`badge ${delta > 0 ? 'warn' : 'ok'} ml-4`}>{delta > 0 ? '+' : ''}{delta.toFixed(0)}%</span> : null}
                        </td>
                      ) : null}
                      <td>
                        <div className="flex gap-4 wrap">
                          {r.sample_conversation_ids.map((id) => (
                            <button key={id} className="btn tiny ghost" onClick={() => navigate(`/inbox/conversation/${id}`)}>#{id}</button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="alert info mt-12 text-sm">
            {result.notes.map((n, i) => <div key={i}>{n}</div>)}
          </div>
        </div>
      ) : null}

      {saved && saved.saved.length > 0 ? (
        <div className="card">
          <h3 className="card-title">Saved report definitions</h3>
          <div className="flex col gap-4 mt-8">
            {saved.saved.map((s) => (
              <div key={s.id} className="flex between gap-8">
                <button
                  className="btn small ghost"
                  onClick={() => {
                    setMetric(s.config.metric);
                    setDimension(s.config.dimension);
                    setDateFrom(s.config.dateFrom);
                    setDateTo(s.config.dateTo);
                    setComparison(s.config.comparison);
                    setSort(s.config.sort);
                    setLimit(s.config.limit ?? 30);
                    if (s.config.filters?.attributeKey) setAttributeKey(s.config.filters.attributeKey);
                    if (s.config.filters?.stateKey) setStateKey(s.config.filters.stateKey);
                    run.mutate(s.config);
                  }}
                >
                  {s.name} <span className="muted text-xs">({s.config.metric} · {s.config.dimension})</span>
                </button>
                <button className="btn tiny" onClick={() => removeSaved.mutate(s.id)}>Delete</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <p className="muted text-xs">Supported languages for future i18n of report labels: {SUPPORTED_LANGUAGES.length} (labels are English today). Origin of every number above: <strong>local</strong>.</p>
    </div>
  );
}
