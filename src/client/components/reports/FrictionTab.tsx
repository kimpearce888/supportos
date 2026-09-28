import { type ReactNode, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Spinner, EmptyState, ErrorState } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { FrictionOverview } from '../../../shared/quality.js';

/**
 * Conversation friction overview tab (v2.1.0, plan Phase 29).
 * Six deterministic detection kinds with conversation evidence. Findings
 * are patterns, not judgments about people - the copy says so, repeatedly,
 * because heuristics about support conversations must never read as
 * verdicts about individuals.
 */
export function FrictionTab(): ReactNode {
  const [days, setDays] = useState(30);
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();

  const { data, isError, error, isLoading } = useQuery({
    queryKey: ['friction-overview', days],
    queryFn: () => api.get<FrictionOverview>(`/api/friction/overview?days=${days}`)
  });

  const rebuild = useMutation({
    mutationFn: () => api.post<{ conversations: number; findings: number }>('/api/friction/rebuild', {}),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Friction rebuild complete: ${r.findings} findings across ${r.conversations} conversations.` });
      void queryClient.invalidateQueries({ queryKey: ['friction-overview'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (isError) return <ErrorState message="The friction report failed to load." detail={error instanceof Error ? error.message : undefined} />;
  if (isLoading || !data) return <Spinner />;

  return (
    <div className="card">
      <div className="flex between mb-8">
        <h3 className="card-title">Conversation friction (customer effort)</h3>
        <div className="flex gap-4">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`btn small ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
          <button className="btn small" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>{rebuild.isPending ? 'Rebuilding…' : 'Rebuild findings'}</button>
        </div>
      </div>
      {data.kinds.every((k) => k.conversations === 0) ? (
        <EmptyState title="No friction findings yet" hint="Findings appear after conversations are analyzed. Press Rebuild to cover existing history." />
      ) : (
        <div className="flex col gap-12">
          {data.kinds.map((k) => (
            <div key={k.kind} className="friction-kind">
              <div className="flex between">
                <strong>{k.label}</strong>
                <span className="muted text-sm">
                  {k.conversations} conversation{k.conversations === 1 ? '' : 's'}
                  {k.high_severity > 0 ? <span className="badge warn"> {k.high_severity} high</span> : null}
                </span>
              </div>
              {k.sample.length > 0 ? (
                <table className="table compact mt-8">
                  <thead>
                    <tr><th>Conversation</th><th>Severity</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {k.sample.slice(0, 5).map((f) => (
                      <tr key={`${f.conversation_id}-${f.kind}`}>
                        <td>
                          <button className="btn tiny ghost" onClick={() => navigate(`/inbox/conversation/${f.conversation_id}`)}>#{f.conversation_number}</button>
                        </td>
                        <td><span className={`badge ${f.severity === 'high' ? 'err' : f.severity === 'moderate' ? 'warn' : ''}`}>{f.severity}</span></td>
                        <td className="text-sm">
                          <div>{f.detail}</div>
                          {f.evidence.length > 0 ? (
                            <div className="muted text-xs mt-4">Evidence: {f.evidence.slice(0, 2).map((e, i) => <span key={i} className="mono"> {e.excerpt.slice(0, 80)} </span>)}</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {data.customers_most_affected.length > 0 ? (
        <div className="mt-16">
          <h4 className="card-title">Customers with most findings</h4>
          <div className="flex gap-8 wrap mt-8">
            {data.customers_most_affected.map((c) => (
              <button key={c.customer_local_id} className="btn small ghost" onClick={() => navigate(`/customers/${c.customer_local_id}`)}>
                {[c.first_name, c.last_name].filter(Boolean).join(' ') || `customer #${c.customer_local_id}`}
                <span className="badge warn ml-4">{c.findings} findings</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="alert info mt-12 text-sm">
        {data.notes.map((n, i) => <div key={i}>{n}</div>)}
      </div>
    </div>
  );
}
