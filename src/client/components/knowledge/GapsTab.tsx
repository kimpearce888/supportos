import { type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Spinner, EmptyState, ErrorState } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { KnowledgeGapReport, KnowledgeCandidateDraft } from '../../../shared/quality.js';

/**
 * Knowledge gap engine tab (v2.1.0, plan Phase 26).
 * Five deterministic detection kinds -> persisted candidates -> human
 * approval. Approving marks a candidate; drafting returns a suggested
 * title/outline for a human author. Nothing auto-publishes - the copy says
 * so at every decision point.
 */
export function GapsTab(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isError, error, isLoading } = useQuery({
    queryKey: ['knowledge-gaps'],
    queryFn: () => api.get<KnowledgeGapReport>('/api/knowledge/gaps')
  });

  const rebuild = useMutation({
    mutationFn: () => api.post<{ candidates: number; new: number }>('/api/knowledge/gaps/rebuild', { days: 90 }),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Gap rebuild complete: ${r.candidates} candidates (${r.new} new). Human decisions were preserved.` });
      void queryClient.invalidateQueries({ queryKey: ['knowledge-gaps'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const decide = useMutation({
    mutationFn: (input: { id: number; decision: 'approved' | 'rejected' }) => api.post<{ ok: boolean; candidate: { id: number; status: string } }>(`/api/knowledge/gaps/candidates/${input.id}/decide`, { decision: input.decision }),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Candidate ${r.candidate.status}. Nothing is published automatically.` });
      void queryClient.invalidateQueries({ queryKey: ['knowledge-gaps'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const draft = useMutation({
    mutationFn: (id: number) => api.get<KnowledgeCandidateDraft>(`/api/knowledge/gaps/candidates/${id}/draft`)
  });

  if (isError) return <ErrorState message="The gap report failed to load." detail={error instanceof Error ? error.message : undefined} />;
  if (isLoading || !data) return <Spinner />;

  return (
    <div className="flex col gap-12">
      <div className="card">
        <div className="flex between">
          <div>
            <h3 className="card-title">Knowledge gap engine</h3>
            <p className="muted text-sm">{data.totals.candidates} open candidates · {data.totals.approved} approved · {data.totals.rejected} rejected</p>
          </div>
          <button className="btn small" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>{rebuild.isPending ? 'Rebuilding…' : 'Rebuild detections'}</button>
        </div>
        <div className="alert info mt-12 text-sm">
          {data.notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      </div>

      {data.kinds.map((k) => (
        <div key={k.kind} className="card">
          <h3 className="card-title">{k.label}</h3>
          {k.candidates.length === 0 ? (
            <EmptyState title="No candidates of this kind" hint="This detection found nothing in the current data." />
          ) : (
            <div className="flex col gap-8">
              {k.candidates.map((c) => (
                <div key={c.id} className={`gap-candidate status-${c.status}`}>
                  <div className="flex between gap-8 wrap">
                    <div className="grow">
                      <div className="text-sm">
                        <strong>{c.question.slice(0, 120)}{c.question.length > 120 ? '…' : ''}</strong>
                        <span className={`badge ml-8 ${c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'err' : 'warn'}`}>{c.status}</span>
                      </div>
                      <div className="muted text-xs mt-4">{c.detail.explanation}</div>
                      <div className="muted text-xs mt-4">Method: {c.detail.method}</div>
                      {c.evidence_conversation_ids.length > 0 ? (
                        <div className="flex gap-4 wrap mt-4">
                          <span className="muted text-xs">Evidence:</span>
                          {c.evidence_conversation_ids.slice(0, 6).map((id) => (
                            <button key={id} className="btn tiny ghost" onClick={() => navigate(`/inbox/conversation/${id}`)}>#{id}</button>
                          ))}
                        </div>
                      ) : null}
                      {c.decision_note ? <div className="text-xs mt-4">Decision note: {c.decision_note}</div> : null}
                      {draft.data && draft.data.candidate_id === c.id ? (
                        <div className="gap-draft mt-8">
                          <div><strong>Suggested title:</strong> {draft.data.suggested_title}</div>
                          <ol className="text-sm mt-4" style={{ paddingLeft: 20 }}>
                            {draft.data.suggested_outline.map((o, i) => <li key={i}>{o}</li>)}
                          </ol>
                          {draft.data.evidence_conversations.length > 0 ? (
                            <div className="flex gap-4 wrap mt-4">
                              <span className="muted text-xs">Read first:</span>
                              {draft.data.evidence_conversations.map((e) => (
                                <button key={e.conversation_local_id} className="btn tiny ghost" onClick={() => navigate(`/inbox/conversation/${e.conversation_local_id}`)}>#{e.number}</button>
                              ))}
                            </div>
                          ) : null}
                          <div className="muted text-xs mt-4">{draft.data.note}</div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex col gap-4">
                      {c.status === 'candidate' ? (
                        <>
                          <button className="btn small primary" onClick={() => decide.mutate({ id: c.id, decision: 'approved' })} disabled={decide.isPending}>Approve</button>
                          <button className="btn small" onClick={() => decide.mutate({ id: c.id, decision: 'rejected' })} disabled={decide.isPending}>Reject</button>
                        </>
                      ) : null}
                      <button className="btn small ghost" onClick={() => (draft.data && draft.data.candidate_id === c.id ? draft.reset() : draft.mutate(c.id))}>
                        {draft.data && draft.data.candidate_id === c.id ? 'Hide draft' : 'Draft outline'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
