import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client.js';
import { Spinner, EmptyState, RelativeTime } from './ui.js';
import type { SupportHealthReport } from '../../../shared/workspace.js';

/**
 * Customer event timeline (plan Phase 23) and support health (plan Phase
 * 24) - shared sections for the customer and organization detail pages.
 * The timeline is a local, append-only, deduplicated event log. Support
 * health shows OPERATIONAL FACTS ONLY (no psychological judgments, no
 * aggregate "score" by design); every flag links to evidence.
 */

const KIND_LABEL: Record<string, string> = {
  signup: 'signup',
  support_conversation: 'support',
  customer_message: 'message',
  campaign: 'campaign',
  campaign_reply: 'campaign reply',
  rating: 'rating',
  incident_exposure: 'incident',
  custom_object_event: 'record',
  subscription_event: 'subscription',
  account_event: 'account',
  product_event: 'product',
  integration_event: 'integration'
};

const KIND_CLASS: Record<string, string> = {
  signup: 'ok',
  support_conversation: '',
  customer_message: '',
  campaign: 'ai',
  campaign_reply: 'ai',
  rating: 'warn',
  incident_exposure: 'err',
  custom_object_event: 'warn'
};

interface TimelineEvent {
  id: number;
  customer_local_id: number;
  event_kind: string;
  occurred_at: string | null;
  title: string;
  detail: Record<string, unknown> | null;
  source: string;
  customer_name?: string;
}

export function CustomerTimelineSection({ subjectKind, subjectId }: { subjectKind: 'customer' | 'organization'; subjectId: number }): ReactNode {
  const [kind, setKind] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: [`${subjectKind}-timeline`, subjectId, kind],
    queryFn: () => api.get<{ events: TimelineEvent[]; total: number; kind_counts?: { kind: string; n: number }[] }>(`/api/${subjectKind === 'customer' ? 'customers' : 'organizations'}/${subjectId}/timeline${qs({ kind, pageSize: 60 })}`)
  });
  const kinds = data?.kind_counts ?? [];
  return (
    <div className="card mt-16">
      <div className="flex-between wrap">
        <div>
          <h3 className="card-title">Event timeline</h3>
          <p className="text-xs muted" style={{ marginTop: 0, marginBottom: 0 }}>
            A local event log independent of ticket history: conversations, campaigns, ratings, incident exposure and linked records.
            {' '}Kinds with no observable source stay absent - nothing is fabricated.
          </p>
        </div>
        <div className="flex wrap" style={{ gap: 4 }}>
          <button className={`chip ${kind === '' ? 'active' : ''}`} onClick={() => setKind('')}>all ({data?.total ?? '…'})</button>
          {kinds.map((k) => (
            <button key={k.kind} className={`chip ${kind === k.kind ? 'active' : ''}`} onClick={() => setKind(k.kind)}>
              {KIND_LABEL[k.kind] ?? k.kind} ({k.n})
            </button>
          ))}
        </div>
      </div>
      {isLoading ? <Spinner /> : null}
      {data && data.events.length === 0 ? <EmptyState icon="clock" title="No events yet" hint="Events are derived from the local mirror and new activity; the rebuild action in Settings re-derives the full history." /> : null}
      {data && data.events.length > 0 ? (
        <div className="timeline">
          {data.events.map((ev) => (
            <div key={ev.id} className="timeline-item">
              <span className={`badge ${KIND_CLASS[ev.event_kind] ?? ''}`}>{KIND_LABEL[ev.event_kind] ?? ev.event_kind}</span>
              <div className="grow">
                <div className="flex-between">
                  <span className="text-sm">{ev.title}</span>
                  {/* v2.2.1 audit fix: raw UTC wall time was shown here while the
                      rest of the app renders local relative time. */}
                  <RelativeTime iso={ev.occurred_at} />
                </div>
                {ev.detail && ev.detail.conversation_id ? (
                  <Link className="text-xs" to={`/inbox/conversation/${ev.detail.conversation_id}`}>open conversation</Link>
                ) : null}
                {ev.detail && ev.detail.incident_id ? (
                  <Link className="text-xs" to={`/incidents/${ev.detail.incident_id}`}>open incident {String(ev.detail.code ?? '')}</Link>
                ) : null}
                {ev.customer_name && subjectKind === 'organization' ? <span className="text-xs muted"> · {ev.customer_name}</span> : null}
              </div>
              <span className="text-xs muted" title={`source: ${ev.source}`}>{ev.source.replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Support health

export function SupportHealthSection({ subjectKind, subjectId }: { subjectKind: 'customer' | 'organization'; subjectId: number }): ReactNode {
  const { data, isLoading, error } = useQuery({
    queryKey: [`${subjectKind}-support-health`, subjectId],
    queryFn: () => api.get<{ report: SupportHealthReport }>(`/api/${subjectKind === 'customer' ? 'customers' : 'organizations'}/${subjectId}/support-health`)
  });
  if (isLoading) return <div className="card mt-16"><Spinner /></div>;
  if (error || !data) return null;
  const r = data.report;
  return (
    <div className="card mt-16">
      <div className="flex-between wrap">
        <div>
          <h3 className="card-title">Support health</h3>
          <p className="text-xs muted" style={{ margin: 0 }}>Operational facts with evidence only - no psychological or personal judgments, and deliberately no single "score".</p>
        </div>
        <span className="text-xs muted">{r.subject_label}</span>
      </div>
      {r.flags.length > 0 ? (
        <div className="mb-16">
          {r.flags.map((f) => (
            <div key={f.key} className={`alert ${f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warn' : 'info'}`}>
              <div className="flex-between">
                <strong className="text-sm">{f.label}</strong>
                <span className="badge">{f.severity}</span>
              </div>
              <div className="text-sm" style={{ marginTop: 2 }}>{f.detail}</div>
              {f.evidence_conversation_ids.length > 0 ? (
                <div className="flex wrap" style={{ gap: 4, marginTop: 4 }}>
                  {f.evidence_conversation_ids.map((cid) => <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge">#{cid}</Link>)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {r.incident_exposure.length > 0 ? (
        <div className="mb-16">
          <h4 className="card-title">Current incident exposure</h4>
          {r.incident_exposure.map((i) => (
            <div key={i.incident_id} className="flex-between mb-8">
              <Link to={`/incidents/${i.incident_id}`} className="text-sm" style={{ fontWeight: 600 }}><span className="mono">{i.code}</span> {i.title}</Link>
              <span className="text-xs muted">{i.severity.toUpperCase()} · {i.status.replace('_', ' ')} · {i.conversations} conversation(s)</span>
            </div>
          ))}
        </div>
      ) : null}
      <table className="table">
        <thead>
          <tr><th>Metric</th><th>Value</th><th>Completeness</th><th>Definition</th></tr>
        </thead>
        <tbody>
          {r.metrics.map((m) => (
            <tr key={m.key}>
              <td className="text-sm" style={{ fontWeight: 600 }}>{m.label}</td>
              <td className="text-sm">{m.display}</td>
              <td><span className={`badge ${m.completeness === 'known' ? 'ok' : m.completeness === 'partial' ? 'warn' : ''}`}>{m.completeness}</span></td>
              <td className="text-xs muted">{m.definition}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.metrics.some((m) => m.evidence_conversation_ids.length > 0) ? (
        <details className="mt-8">
          <summary className="text-xs muted">Evidence links per metric</summary>
          {r.metrics.filter((m) => m.evidence_conversation_ids.length > 0).map((m) => (
            <div key={m.key} className="flex wrap" style={{ gap: 4, marginTop: 4 }}>
              <span className="text-xs" style={{ fontWeight: 600 }}>{m.label}:</span>
              {m.evidence_conversation_ids.map((cid) => <Link key={cid} to={`/inbox/conversation/${cid}`} className="badge">#{cid}</Link>)}
            </div>
          ))}
        </details>
      ) : null}
      <p className="text-xs muted" style={{ marginBottom: 0 }}>{r.note}</p>
    </div>
  );
}
