import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Tags, RefreshCw, ChevronDown } from 'lucide-react';
import { api } from '../../api/client.js';
import { useAttributeSnapshot } from '../../api/hooks.js';
import { useUiStore } from '../../state/uiStore.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../common/ui.js';
import { AI_ATTRIBUTE_CATALOG } from '../../../shared/constants.js';
import type { AiAttributeRow } from '../../../shared/types.js';

/**
 * Per-ticket AI attribute snapshot (v1.9.0 / M3, plan Phase 16).
 *
 * Shows the CURRENT local attribute layer: deterministic slots (always
 * computable from observable local facts) + AI slots (LM Studio, cached).
 * Unknown keys are listed as unknown - never fabricated. Attributes are local
 * intelligence only: nothing here is written back to Help Scout.
 */
export function AttributeSnapshotCard({ conversationId }: { conversationId: number }): ReactNode {
  const { data, isLoading, isError, error } = useAttributeSnapshot(conversationId);
  const [recomputing, setRecomputing] = useState(false);
  const [showUnknown, setShowUnknown] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();

  const recompute = async (): Promise<void> => {
    setRecomputing(true);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/api/attributes/conversation/${conversationId}/recompute`, { force: true });
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.ok ? 'Attribute snapshot recomputed.' : 'Recompute failed.' });
      if (r.ok) void qc.invalidateQueries({ queryKey: ['attributes-snapshot', conversationId] });
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Recompute failed.' });
    } finally {
      setRecomputing(false);
    }
  };

  if (isLoading) return <div className="ai-sidebar-section"><Spinner label="Loading attributes" /></div>;
  if (isError) return <div className="ai-sidebar-section"><ErrorState message="Could not load AI attributes." detail={error instanceof Error ? error.message : undefined} /></div>;

  const known: AiAttributeRow[] = data?.attributes ?? [];
  const unknown: string[] = data?.unknown ?? [];
  const label = (k: string): string => AI_ATTRIBUTE_CATALOG.find((d) => d.key === k)?.label ?? k;

  return (
    <div className="ai-sidebar-section">
      <div className="flex-between" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}><Tags size={12} /> AI attributes</h4>
        <button className="btn ghost small" onClick={() => void recompute()} disabled={recomputing} title="Recompute now (deterministic always; AI when enabled)">
          {recomputing ? <Spinner /> : <RefreshCw size={11} />}
        </button>
      </div>
      {known.length === 0 ? (
        <EmptyState icon="ai" title="No attributes yet" hint="Recompute to build the deterministic layer now; AI slots fill when LM Studio analyzes the ticket." />
      ) : (
        <div className="attribute-grid">
          {known.map((a) => <AttributeRow key={a.attribute} row={a} label={label(a.attribute)} />)}
        </div>
      )}
      {unknown.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          <button className="btn ghost small" onClick={() => setShowUnknown(!showUnknown)} title="Keys with no stored value - honest unknown, never fabricated">
            <ChevronDown size={11} style={{ transform: showUnknown ? 'rotate(180deg)' : 'none' }} /> {unknown.length} unknown
          </button>
          {showUnknown ? (
            <div className="text-xs muted" style={{ marginTop: 4 }}>
              {unknown.map((k) => <span key={k} className="badge" style={{ margin: '0 4px 4px 0' }} title="No stored value (honest unknown)">{label(k)}: unknown</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
      {data?.computed_at ? <p className="text-xs muted" style={{ margin: '6px 0 0' }}>Local layer · computed <RelativeTime iso={data.computed_at} /> · never written to Help Scout</p> : null}
    </div>
  );
}

function AttributeRow({ row, label }: { row: AiAttributeRow; label: string }): ReactNode {
  const [showEvidence, setShowEvidence] = useState(false);
  const confClass = row.confidence === 'high' ? 'ok' : row.confidence === 'medium' ? 'warn' : '';
  return (
    <div className="attribute-row" title={`${label} (${row.source})`}>
      <span className="text-xs muted attribute-key">{label}</span>
      <span className="text-xs attribute-value">{row.value}</span>
      <span className={`badge ${confClass}`}>{row.confidence}</span>
      <span className={`badge ${row.source === 'ai' ? 'ai' : ''}`} title={row.source === 'ai' ? 'Extracted by the local model (LM Studio), evidence-backed' : 'Computed from observable local facts - no AI'}>{row.source === 'ai' ? 'AI' : 'det.'}</span>
      {row.evidence.length > 0 ? (
        <button className="btn ghost small" title="Show evidence" onClick={() => setShowEvidence(!showEvidence)}>
          <ChevronDown size={10} style={{ transform: showEvidence ? 'rotate(180deg)' : 'none' }} />
        </button>
      ) : null}
      {showEvidence && row.evidence.length > 0 ? (
        <div className="attribute-evidence text-xs">
          {row.evidence.map((e, i) => (
            <blockquote key={i} style={{ margin: '4px 0' }}>
              “{e.excerpt}”{e.thread_local_id != null ? <span className="muted"> (thread #{e.thread_local_id})</span> : null}
            </blockquote>
          ))}
        </div>
      ) : null}
    </div>
  );
}
