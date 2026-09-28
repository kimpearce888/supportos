import { type ReactNode, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useUiStore } from '../../state/uiStore.js';
import type { CoachingReview, CoachingCheckResult } from '../../../shared/coaching.js';

/**
 * Pre-send coaching panel (v2.2.0, plan Phase 35) - lives INSIDE the
 * composer. ADVISORY ONLY: the agent asks for a review of the current draft
 * text; nothing ever blocks the send button. The full checklist renders
 * (pass / flagged / not applicable) so silence means "checked, clean".
 */
const STATUS_CLASS: Record<CoachingCheckResult['status'], string> = {
  pass: 'ok',
  flagged: 'err',
  not_applicable: '',
  unavailable: 'warn'
};

export function CoachingPanel({ conversationId, draft, includeAiDefault = false }: { conversationId: number; draft: string; includeAiDefault?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [includeAi, setIncludeAi] = useState(includeAiDefault);
  const [review, setReview] = useState<CoachingReview | null>(null);
  const pushToast = useUiStore((s) => s.pushToast);

  const check = useMutation({
    mutationFn: () =>
      api.post<CoachingReview>(`/api/coaching/${conversationId}/review`, {
        draft,
        includeAi: includeAi || undefined
      }),
    onSuccess: (r) => {
      setReview(r);
      if (r.ai.error != null) {
        pushToast({ kind: 'info', message: r.ai.error });
      } else if (r.summary.flagged > 0) {
        pushToast({ kind: 'info', message: `Coaching: ${r.summary.flagged} check(s) flagged - review below. Nothing is blocked.` });
      } else {
        pushToast({ kind: 'success', message: 'Coaching: no issues flagged.' });
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const flagged = review?.summary.flagged ?? 0;

  return (
    <section className="coaching-panel">
      <div className="flex gap-8 align-center wrap">
        <button
          className={`btn small ${flagged > 0 && review ? 'warn-btn' : ''}`}
          onClick={() => {
            if (!draft.trim()) {
              pushToast({ kind: 'info', message: 'Write your reply first - coaching reviews the draft text.' });
              return;
            }
            setOpen(true);
            check.mutate();
          }}
          disabled={check.isPending}
          title="Optional, advisory-only review of your draft before sending"
        >
          {check.isPending ? 'Checking…' : 'Check draft (coaching)'}
        </button>
        <label className="flex gap-4 align-center text-xs muted">
          <input type="checkbox" checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} />
          Include AI layer (LM Studio)
        </label>
        {review ? (
          <span className="text-xs muted">
            {review.summary.flagged} flagged · {review.summary.checks_run} checks · {review.draft_words} words
          </span>
        ) : null}
        {review && open ? (
          <button className="btn ghost small" onClick={() => setOpen(false)}>Hide</button>
        ) : null}
      </div>

      {review && open ? (
        <div className="coaching-results mt-8">
          <p className="text-xs muted mb-8">{review.note}</p>
          {review.checks.map((c) => (
            <div key={`${c.kind}-${c.layer}`} className={`coaching-check ${c.status}`}>
              <div className="flex between align-center">
                <strong className="text-sm">{c.label}</strong>
                <span className={`badge ${STATUS_CLASS[c.status]}`}>
                  {c.status === 'not_applicable' ? 'n/a' : c.status}
                  {c.layer === 'ai' ? ' · AI' : ''}
                </span>
              </div>
              <div className="muted text-xs mt-4">{c.detail}</div>
              {c.findings.map((f, i) => (
                <div key={i} className="coaching-finding">
                  {f.draft_excerpt && f.draft_excerpt !== '(the draft does not appear to address this)' && f.draft_excerpt !== '(no sorry / understand / appreciate / patience wording found)' ? (
                    <div className="text-xs"><span className="muted">Draft:</span> “{f.draft_excerpt.slice(0, 200)}”</div>
                  ) : null}
                  {f.evidence.map((e, j) => (
                    <div key={j} className="mono text-xs mt-4">
                      {e.description}: {e.excerpt.slice(0, 160)}
                      {e.incident_code ? ` [${e.incident_code}]` : ''}
                    </div>
                  ))}
                  <div className="text-xs mt-4"><span className="muted">Advice:</span> {f.advice}</div>
                </div>
              ))}
            </div>
          ))}
          {review.ai.available && review.ai.model ? <div className="muted text-xs mt-8">AI model: {review.ai.model}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
