import { type ReactNode, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { Spinner, EmptyState } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { PostResolutionQa, FrictionFinding } from '../../../shared/quality.js';

/**
 * Post-resolution QA panel (v2.1.0, plan Phase 27) - per conversation, in
 * the detail view. Two layers: the deterministic one always computable; the
 * AI layer optional via the local model (honest error when disabled).
 * Deliberately separate from pre-send draft verification. Collapsed by
 * default; expands on click.
 */
export function QaPanel({ conversationId, closed }: { conversationId: number; closed: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();
  const [includeAi, setIncludeAi] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['qa', conversationId],
    queryFn: () => api.get<{ qa: PostResolutionQa | null; friction: FrictionFinding[] }>(`/api/qa/${conversationId}`),
    enabled: open
  });

  const analyze = useMutation({
    mutationFn: () => api.post<{ ok: boolean; qa: PostResolutionQa | null; ai: unknown; error: string | null }>(`/api/qa/${conversationId}/analyze`, includeAi ? { includeAi: true } : {}),
    onSuccess: (r) => {
      if (r.error) pushToast({ kind: 'info', message: r.error });
      else pushToast({ kind: 'success', message: 'QA recomputed.' });
      void queryClient.invalidateQueries({ queryKey: ['qa', conversationId] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const qa = data?.qa;
  const det = qa?.deterministic;

  return (
    <section className="card qa-panel">
      <button className="card-title collapsible" onClick={() => setOpen((v) => !v)}>
        Post-resolution QA {closed ? '' : '(conversation still open)'} {open ? '▾' : '▸'}
      </button>
      {open ? (
        <>
          <p className="muted text-xs mb-8">
            After-close quality signals, separate from pre-send draft verification. The deterministic layer is always computable; the AI layer is optional (local model only).
          </p>
          <div className="flex gap-8 mb-12 wrap">
            <button className="btn small" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
              {analyze.isPending ? 'Analyzing…' : 'Recompute (deterministic)'}
            </button>
            <label className="flex gap-4 align-center text-sm">
              <input type="checkbox" checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} />
              Include AI layer (LM Studio)
            </label>
          </div>

          {isLoading ? <Spinner /> : null}

          {det ? (
            <div className="grid-2">
              <div>
                <h4 className="card-title">Deterministic signals</h4>
                <div className="kv-list text-sm">
                  <div className="kv-row"><span>Closed</span><strong>{det.closed ? 'yes' : 'no'}</strong></div>
                  <div className="kv-row"><span>Back-and-forth after first reply</span><strong>{det.back_and_forth_count}</strong></div>
                  <div className="kv-row"><span>Repeated information spans</span><strong>{det.repeated_information_count}</strong></div>
                  <div className="kv-row"><span>Customer messages after close</span><strong>{det.messages_after_close}</strong></div>
                  <div className="kv-row"><span>Handoffs observed</span><strong>{det.handoff_count}{det.handoff_history_complete ? '' : ' (pre-sync unknown)'}</strong></div>
                  <div className="kv-row"><span>Customer questions vs agent replies</span><strong>{det.customer_question_count} / {det.agent_reply_count}</strong></div>
                  <div className="kv-row"><span>First response</span><strong>{det.first_response_minutes != null ? `${det.first_response_minutes} min` : '—'}</strong></div>
                  <div className="kv-row"><span>Resolution</span><strong>{det.resolution_minutes != null ? `${det.resolution_minutes} min` : '—'}</strong></div>
                </div>
                {det.repeated_information_evidence.length > 0 ? (
                  <div className="mt-8">
                    <div className="muted text-xs">Repeated spans:</div>
                    {det.repeated_information_evidence.map((e, i) => (
                      <div key={i} className="mono text-xs mt-4">#{e.thread_id}: {e.excerpt}</div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <h4 className="card-title">AI layer {qa?.ai_available ? '' : '(AI disabled)'}</h4>
                {qa?.ai ? (
                  <div className="flex col gap-8 text-sm">
                    {qa.ai.answered ? (
                      <div>
                        <strong>Question answered:</strong> <span className={`badge ${qa.ai.answered.value === 'yes' ? 'ok' : qa.ai.answered.value === 'no' ? 'err' : 'warn'}`}>{qa.ai.answered.value}</span>
                        <div className="muted text-xs mt-4">{qa.ai.answered.reasoning}</div>
                        {qa.ai.answered.evidence_thread_ids.length > 0 ? <div className="muted text-xs">Evidence threads: {qa.ai.answered.evidence_thread_ids.join(', ')}</div> : null}
                      </div>
                    ) : null}
                    {qa.ai.evidence_supported ? (
                      <div>
                        <strong>Response supported by evidence:</strong> <span className={`badge ${qa.ai.evidence_supported.value === 'yes' ? 'ok' : qa.ai.evidence_supported.value === 'no' ? 'err' : 'warn'}`}>{qa.ai.evidence_supported.value}</span>
                        <div className="muted text-xs mt-4">{qa.ai.evidence_supported.reasoning}</div>
                      </div>
                    ) : null}
                    {qa.ai.correct_issue ? (
                      <div>
                        <strong>Correct issue identified:</strong> <span className={`badge ${qa.ai.correct_issue.value === 'yes' ? 'ok' : qa.ai.correct_issue.value === 'no' ? 'err' : 'warn'}`}>{qa.ai.correct_issue.value}</span>
                        <div className="muted text-xs mt-4">{qa.ai.correct_issue.reasoning}</div>
                      </div>
                    ) : null}
                    {qa.ai.suggestions ? (
                      <div className="alert info text-xs">
                        <div>Knowledge base improvement suggested: {qa.ai.suggestions.kb_improve ? `yes - ${qa.ai.suggestions.kb_reason}` : 'no'}</div>
                        <div>Saved reply suggested: {qa.ai.suggestions.saved_reply_suggested ? `yes (${qa.ai.suggestions.saved_reply_title ?? 'untitled'})` : 'no'}</div>
                        {qa.ai.suggestions.issue_association ? <div>Issue association: {qa.ai.suggestions.issue_association}</div> : null}
                        <div className="muted">Suggestions are recommendations for humans - nothing applies automatically.</div>
                      </div>
                    ) : null}
                    <div className="muted text-xs">Model: {qa.ai.model ?? 'unknown'}</div>
                  </div>
                ) : (
                  <EmptyState title="AI layer not computed" hint={qa?.ai_available ? 'Check "Include AI layer" and press recompute to run the local model analysis.' : 'AI is disabled in Settings; the deterministic layer above works without it.'} />
                )}
              </div>
            </div>
          ) : null}

          {data?.friction && data.friction.length > 0 ? (
            <div className="mt-12">
              <h4 className="card-title">Friction findings ({data.friction.length})</h4>
              <div className="flex col gap-8">
                {data.friction.map((f) => (
                  <div key={`${f.conversation_id}-${f.kind}`} className="friction-finding">
                    <div className="flex between">
                      <strong>{f.kind.replace(/_/g, ' ')}</strong>
                      <span className={`badge ${f.severity === 'high' ? 'err' : f.severity === 'moderate' ? 'warn' : ''}`}>{f.severity}</span>
                    </div>
                    <div className="muted text-xs mt-4">{f.detail}</div>
                    {f.evidence.length > 0 ? (
                      <div className="mt-4 flex col gap-4">
                        {f.evidence.slice(0, 3).map((e, i) => (
                          <div key={i} className="mono text-xs">[{e.author_type}] {e.excerpt.slice(0, 120)}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="muted text-xs mt-8">No friction findings detected for this conversation.</div>
          )}

          {det?.computed_honestly ? (
            <div className="alert info mt-12 text-xs">
              {det.computed_honestly.map((n, i) => <div key={i}>{n}</div>)}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
