import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Spinner, EmptyState, ErrorState } from '../common/ui.js';
import type { EffectivenessReport } from '../../../shared/quality.js';

/**
 * Historical response effectiveness tab (v2.1.0, plan Phase 28).
 * Observable ASSOCIATIONS between response style and outcomes, with sample
 * sizes and evidence conversations. The wording stays associational by
 * design - the report data itself carries the honesty notes.
 */
export function EffectivenessTab(): ReactNode {
  const [days, setDays] = useState(90);
  const navigate = useNavigate();
  const { data, isError, error } = useQuery({
    queryKey: ['effectiveness', days],
    queryFn: () => api.get<EffectivenessReport>(`/api/reports/effectiveness?days=${days}`)
  });

  if (isError) return <ErrorState message="The effectiveness report failed to load." detail={error instanceof Error ? error.message : undefined} />;
  if (!data) return <Spinner />;

  const fmtRate = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

  return (
    <div className="card">
      <div className="flex between mb-8">
        <h3 className="card-title">Response style and observed outcomes</h3>
        <div className="flex gap-4">
          {[30, 90, 365].map((d) => (
            <button key={d} className={`btn small ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      </div>
      <p className="muted text-sm mb-12">{data.total_analyzed} analyzed conversations. {data.notes[0]}</p>
      {data.buckets.length === 0 ? (
        <EmptyState title="No analyzed conversations yet" hint="The interaction engine analyzes conversations as they sync; style outcome data appears here once outcomes exist." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Style / characteristic</th>
              <th>n</th>
              <th>Follow-up rate</th>
              <th>Clarification rate</th>
              <th>Resolved after 1st</th>
              <th>Avg effort</th>
              <th>High friction</th>
              <th>Ratings</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <tr key={b.style_key}>
                <td>
                  <div><strong>{b.style_label}</strong></div>
                  <div className="muted text-xs">{b.kind === 'characteristic' ? 'characteristic (not mutually exclusive)' : 'response style'}</div>
                </td>
                <td className="mono">{b.conversations}</td>
                <td className="mono">{fmtRate(b.follow_up_rate)}</td>
                <td className="mono">{fmtRate(b.clarification_rate)}</td>
                <td className="mono">{fmtRate(b.resolved_after_first_rate)}</td>
                <td className="mono">{b.avg_effort_score ?? '—'}</td>
                <td className="mono">{fmtRate(b.high_friction_rate)}</td>
                <td className="text-xs">
                  {b.rating_distribution
                    ? b.rating_distribution.filter((r) => r.count > 0).map((r) => `${r.rating.replace('not-good', 'not good')}: ${r.count}`).join(' · ') || '—'
                    : '—'}
                </td>
                <td>
                  <div className="flex gap-4 wrap">
                    {b.sample_conversations.map((s) => (
                      <button key={s.conversation_local_id} className="btn tiny ghost" title={s.outcome_summary} onClick={() => navigate(`/inbox/conversation/${s.conversation_local_id}`)}>#{s.number}</button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="alert info mt-12 text-sm">
        {data.notes.map((n, i) => <div key={i}>{n}</div>)}
      </div>
    </div>
  );
}
