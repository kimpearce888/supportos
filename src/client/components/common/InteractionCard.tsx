import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Users, TrendingUp, ShieldAlert, Eye, RefreshCw, Gauge, Repeat, Lightbulb, Ban } from 'lucide-react';
import { api } from '../../api/client.js';
import { useInteractionCard, useInteractionEvidence } from '../../api/hooks.js';
import { Spinner, ConfidenceBadge } from './ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { InteractionSignal } from '../../../shared/types.js';

/**
 * CLIENT INTELLIGENCE sidebar card (interaction spec #26, #62):
 * current signals / historical pattern / today's change / recommended approach /
 * avoid / historically effective — every signal evidence-linked, clearly labeled.
 * Deterministic engine output renders even without LM Studio.
 */
export function ClientIntelligenceCard({ conversationId, onRefresh }: { conversationId: number; onRefresh: () => void }): ReactNode {
  const { data, isLoading, error, refetch } = useInteractionCard(conversationId);
  const pushToast = useUiStore((s) => s.pushToast);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useMutation({
    mutationFn: async (): Promise<void> => {
      setRefreshing(true);
      try {
        const r = await api.post<{ ok: boolean; ai_enriched: boolean; error: string | null }>(`/api/interaction/${conversationId}/refresh`, {});
        if (r.ok) {
          pushToast({ kind: 'success', message: r.ai_enriched ? 'Interaction analysis refreshed (with AI enrichment).' : 'Interaction analysis refreshed (deterministic engine; enable LM Studio in Settings for AI enrichment).' });
          await refetch();
          onRefresh();
        } else pushToast({ kind: 'error', message: r.error ?? 'Refresh failed' });
      } catch (e) {
        pushToast({ kind: 'error', message: (e as Error).message });
      } finally {
        setRefreshing(false);
      }
    }
  });

  if (isLoading) return <div className="ai-sidebar-section"><Spinner label="Loading client intelligence…" /></div>;
  // 404 = feature has no data yet (fine to hide); anything else is a real failure
  // that must be visible instead of silently swallowing the card.
  if (error) {
    const status = (error as { status?: number }).status;
    if (status == null || status >= 500) {
      return <div className="ai-sidebar-section"><p className="text-xs" style={{ color: 'var(--danger, #b00)' }}>Client intelligence failed to load — {error instanceof Error ? error.message : 'unknown error'}.</p></div>;
    }
    return null;
  }
  if (!data?.card) return null;
  const card = data.card;
  const significant = card.changes.filter((c) => c.significant);

  return (
    <div className="ai-sidebar-section" data-testid="client-intelligence">
      <h4><Users size={12} /> {card.client_kind === 'returning' ? 'Returning client' : 'First-time client'}</h4>
      <p className="text-xs muted" style={{ marginTop: 0 }}>{data.labels.note}</p>

      <SignalChips signals={card.current.signals} />

      {card.current.customer_goal ? (
        <div className="text-sm mt-8"><strong>Likely goal:</strong> {card.current.customer_goal}</div>
      ) : null}

      {card.baseline ? (
        <div className="mt-8">
          <div className="text-sm" style={{ fontWeight: 700 }}>Historical pattern</div>
          {card.baseline.dimensions.slice(0, 5).map((d) => (
            <div key={d.dimension} className="text-xs">
              usually {d.typical_value.replace(/_/g, ' ')} <span className="muted">({d.observation_count} obs.)</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs muted mt-8">No historical baseline yet — this is a first interaction.</div>
      )}

      {significant.length > 0 ? (
        <div className="alert warn mt-8" style={{ marginBottom: 0 }}>
          <strong><TrendingUp size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Today's change vs normal</strong>
          {significant.map((c) => (
            <div key={c.dimension} className="text-xs">
              {c.dimension.replace(/_/g, ' ')}: {c.baseline_value?.replace(/_/g, ' ')} → {c.current_value?.replace(/_/g, ' ')} ({c.direction === 'changed' ? 'different from usual' : c.direction})
            </div>
          ))}
        </div>
      ) : null}

      {card.recommendation ? (
        <div className="mt-8">
          <div className="text-sm" style={{ fontWeight: 700 }}>
            <Lightbulb size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Support approach
            <ConfidenceBadge level={card.recommendation.confidence} />
          </div>
          {card.recommendation.tone ? <div className="text-xs">Tone: {card.recommendation.tone}</div> : null}
          {card.recommendation.length ? <div className="text-xs">Length: {card.recommendation.length}</div> : null}
          {card.recommendation.start_with ? <div className="text-xs mt-4">Start with: {card.recommendation.start_with}</div> : null}
          {card.recommendation.response_strategy.length ? (
            <ol className="text-xs" style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {card.recommendation.response_strategy.slice(0, 6).map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
            </ol>
          ) : null}
          {card.recommendation.de_escalation ? (
            <div className="alert warn mt-8" style={{ marginBottom: 0, padding: '4px 8px' }}>
              <ShieldAlert size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> De-escalation guidance active — acknowledge impact, answer the central issue.
            </div>
          ) : null}
          {card.recommendation.escalation_recommendation ? (
            <div className="alert warn mt-8" style={{ marginBottom: 0, padding: '4px 8px' }}>{card.recommendation.escalation_recommendation}</div>
          ) : null}
          {card.recommendation.avoid.length ? (
            <div className="mt-8">
              <div className="text-xs" style={{ fontWeight: 700 }}><Ban size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Avoid</div>
              {card.recommendation.avoid.slice(0, 5).map((a, i) => <div key={i} className="text-xs muted">• {a}</div>)}
            </div>
          ) : null}
          {card.recommendation.why.length ? (
            <details className="mt-8">
              <summary className="text-xs" style={{ cursor: 'pointer' }}>Why this approach?</summary>
              {card.recommendation.why.map((w, i) => <div key={i} className="text-xs muted">• {w}</div>)}
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="flex wrap mt-8" style={{ gap: 6 }}>
        {card.effort_score != null ? <span className="badge" title="Customer effort score (local metric)"><Gauge size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> effort {card.effort_score}/10</span> : null}
        {card.friction && card.friction !== 'none' ? <span className={`badge ${card.friction === 'high' ? 'warn' : ''}`}>friction: {card.friction}</span> : null}
        {card.repeat_issue?.detected ? <span className="badge warn" title="Recurring issue for this customer"><Repeat size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> recurring issue</span> : null}
      </div>

      <div className="flex wrap mt-8" style={{ gap: 6 }}>
        {card.customer_local_id ? <Link className="btn small" to={`/customers/${card.customer_local_id}?tab=interaction`}>View client profile</Link> : null}
        <EvidenceDrawer conversationId={conversationId} />
        <button className="btn small ghost" onClick={() => refresh.mutate()} disabled={refreshing}>
          <RefreshCw size={10} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="text-xs muted mt-8" style={{ marginBottom: 0 }}>
        {card.provenance.ai_generated ? 'AI-enriched (labeled ai_generated) · ' : 'Deterministic engine (works without AI) · '}
        {card.current.sources}
      </p>
    </div>
  );
}

function SignalChips({ signals }: { signals: InteractionSignal[] }): ReactNode {
  const priority = ['urgency', 'frustration', 'tone', 'directness', 'detail', 'technical_language', 'question_structure', 'expectation', 'response_preference'];
  const sorted = [...signals].sort((a, b) => priority.indexOf(a.dimension) - priority.indexOf(b.dimension));
  return (
    <div className="flex wrap" style={{ gap: 4 }}>
      {sorted.map((s) => (
        <span
          key={s.dimension}
          className={`badge ${s.dimension === 'frustration' && (s.value === 'strong' || s.value === 'moderate') ? 'warn' : s.dimension === 'urgency' && s.value === 'high' ? 'warn' : ''}`}
          title={s.evidence?.excerpt ? `Evidence: "${s.evidence.excerpt.slice(0, 140)}"` : 'No evidence excerpt (low confidence)'}
        >
          {s.dimension.replace(/_/g, ' ')}: {s.value.replace(/_/g, ' ')}
        </span>
      ))}
    </div>
  );
}

function EvidenceDrawer({ conversationId }: { conversationId: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const { data, isFetching } = useInteractionEvidence(open ? conversationId : null);
  return (
    <>
      <button className="btn small ghost" onClick={() => setOpen((v) => !v)}>
        <Eye size={10} /> {open ? 'Hide evidence' : 'View evidence'}
      </button>
      {open ? (
        <div className="mt-8" style={{ width: '100%' }}>
          {isFetching ? <Spinner label="Loading evidence…" /> : null}
          {(data?.observations ?? []).length === 0 && !isFetching ? <span className="text-xs muted">No observations recorded yet. Click Refresh.</span> : null}
          {(data?.observations ?? []).map((o, i) => (
            <div key={i} className="similar-ticket">
              <div className="flex-between">
                <strong className="text-xs">{o.dimension.replace(/_/g, ' ')}: {o.value.replace(/_/g, ' ')}</strong>
                <span className={`badge ${o.provenance === 'ai_generated' ? 'ai' : ''}`}>{o.provenance === 'ai_generated' ? 'AI-derived' : 'computed'}</span>
              </div>
              {o.evidence_excerpt ? (
                <blockquote className="text-xs muted" style={{ margin: '4px 0 0', borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
                  “{o.evidence_excerpt.slice(0, 180)}”
                  {o.conversation_local_id ? <Link to={`/inbox/conversation/${o.conversation_local_id}`}> #source</Link> : null}
                </blockquote>
              ) : (
                <div className="text-xs muted">no excerpt</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
