import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Gauge, Wrench, Check, RotateCcw, Plus } from 'lucide-react';
import { api } from '../../api/client.js';
import { useInteractionProfile } from '../../api/hooks.js';
import { Spinner } from './ui.js';
import { useUiStore } from '../../state/uiStore.js';
import { RESPONSE_PREFERENCE_VALUES } from '../../../shared/constants.js';

/**
 * Client Interaction Profile section for the customer page
 * (interaction spec #25): timeline, observed preferences with human
 * override (spec #22, #45), outcomes, playbook — never psychology.
 */
export function InteractionProfileSection({ customerId }: { customerId: number }): ReactNode {
  const { data, isLoading, refetch } = useInteractionProfile(customerId);
  if (isLoading) return <div className="card mt-16"><Spinner label="Loading interaction profile…" /></div>;
  if (!data?.profile) return null;
  const p = data.profile;

  return (
    <div className="card mt-16" data-testid="interaction-profile">
      <h3 className="card-title">Client Interaction Profile</h3>
      <p className="text-xs muted" style={{ marginTop: 0 }}>
        Observable support-communication behavior — {p.client_kind === 'returning' ? 'returning client' : 'first-time client'}. Never a psychological assessment.
      </p>

      {p.baseline ? (
        <div className="mb-16">
          <h4 className="text-sm" style={{ marginBottom: 4 }}>Historical interaction pattern</h4>
          <div className="flex wrap" style={{ gap: 4 }}>
            {p.baseline.dimensions.map((d) => (
              <span key={d.dimension} className="badge" title={`${d.observation_count} observations, last ${d.last_observed ?? '—'}`}>
                {d.dimension.replace(/_/g, ' ')}: usually {d.typical_value.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
          <div className="text-xs muted mt-4">
            {p.baseline.observation_count} observations across {p.baseline.conversation_count} conversations · profile v{p.baseline.profile_version} · recency-weighted
          </div>
        </div>
      ) : null}

      <div className="grid-2">
        <div>
          <h4 className="text-sm" style={{ marginBottom: 4 }}>Observed communication preferences</h4>
          {p.preferences.length === 0 ? <span className="muted text-sm">No preferences yet — repeated evidence across 3+ interactions is required before a preference is inferred.</span> : null}
          {p.preferences.map((pref) => (
            <PreferenceRow key={pref.preference} customerId={customerId} preference={pref} onChanged={() => void refetch()} />
          ))}
          <ManualPreference customerId={customerId} onChanged={() => void refetch()} showWhenEmpty={p.preferences.length === 0} />
        </div>
        <div>
          <h4 className="text-sm" style={{ marginBottom: 4 }}>Historical timeline</h4>
          {p.timeline.length === 0 ? <span className="muted text-sm">No history yet.</span> : null}
          {p.timeline.map((t) => (
            <div key={t.month} className="mb-8">
              <div className="flex-between">
                <strong className="text-sm">{t.month}</strong>
                <span className="badge">{t.conversation_count} {t.conversation_count === 1 ? 'ticket' : 'tickets'}</span>
              </div>
              <div className="text-xs muted">{t.summary}</div>
              <div className="flex wrap" style={{ gap: 4 }}>
                {t.conversation_local_ids.slice(0, 5).map((cid) => (
                  <Link key={cid} className="text-xs" to={`/inbox/conversation/${cid}`}>#{cid}</Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {p.outcomes ? (
        <div className="mt-16">
          <h4 className="text-sm" style={{ marginBottom: 4 }}>Previous support outcomes</h4>
          <div className="flex wrap" style={{ gap: 6 }}>
            {p.outcomes.first_response_resolution_rate != null ? <span className="badge ok">first-response resolution: {Math.round(p.outcomes.first_response_resolution_rate * 100)}%</span> : null}
            {p.outcomes.follow_up_rate != null ? <span className="badge">follow-up rate: {Math.round(p.outcomes.follow_up_rate * 100)}%</span> : null}
            {p.outcomes.clarification_rate != null ? <span className="badge">clarification rate: {Math.round(p.outcomes.clarification_rate * 100)}%</span> : null}
            {p.outcomes.escalation_rate != null ? <span className="badge">escalation rate: {Math.round(p.outcomes.escalation_rate * 100)}%</span> : null}
            {p.outcomes.avg_effort_score != null ? <span className="badge" title="Customer effort score (local metric of support friction)"><Gauge size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> avg effort {p.outcomes.avg_effort_score}/10</span> : null}
          </div>
          {p.outcomes.effective_approaches.length ? (
            <div className="mt-8">
              <div className="text-xs" style={{ fontWeight: 700 }}>Historically effective approaches</div>
              {p.outcomes.effective_approaches.map((a) => (
                <div key={a.approach} className="text-xs">
                  • {a.approach} — worked in {a.worked_count} {a.worked_count === 1 ? 'case' : 'cases'}
                  {a.example_conversation_local_id ? <Link className="ml-4" to={`/inbox/conversation/${a.example_conversation_local_id}`}>#{a.example_number}</Link> : null}
                </div>
              ))}
            </div>
          ) : null}
          {p.outcomes.friction_flags.length ? (
            <div className="alert warn mt-8" style={{ marginBottom: 0 }}>
              <strong>Conversation friction detected</strong>
              {p.outcomes.friction_flags.map((f) => (
                <div key={f.conversation_local_id} className="text-xs">
                  <Link to={`/inbox/conversation/${f.conversation_local_id}`}>#{f.number}</Link> {f.subject} — {f.friction} friction
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {p.playbook ? (
        <div className="mt-16" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <h4 className="text-sm" style={{ marginBottom: 4 }}><BookOpen size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Support playbook</h4>
          <div className="text-sm"><strong>Best opening:</strong> {p.playbook.best_opening ?? '—'}</div>
          <div className="text-sm"><strong>Explanation style:</strong> {p.playbook.best_explanation_style ?? '—'}</div>
          <div className="text-sm"><strong>Troubleshooting style:</strong> {p.playbook.best_troubleshooting_style ?? '—'}</div>
          {p.playbook.likely_follow_up ? <div className="text-sm"><strong>Likely follow-up:</strong> {p.playbook.likely_follow_up}</div> : null}
          {p.playbook.historically_successful ? <div className="text-sm"><strong>Historically successful:</strong> {p.playbook.historically_successful}</div> : null}
          {p.playbook.avoid.length ? (
            <div className="text-sm"><strong>Avoid:</strong> {p.playbook.avoid.join('; ')}</div>
          ) : null}
          <p className="text-xs muted mt-4" style={{ marginBottom: 0 }}>Generated from this client's observed support outcomes.</p>
        </div>
      ) : null}
    </div>
  );
}

function PreferenceRow({ customerId, preference, onChanged }: { customerId: number; preference: { preference: string; evidence_count: number; first_observed: string | null; last_observed: string | null; confidence: string; origin: string; human_override: { value: string; reason: string | null; overridden_at: string } | null }; onChanged: () => void }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      // The override FIELD is always response_preference (the only dimension
      // the engine consumes); the VALUE is the preference itself. The previous
      // code sent the preference value as the field, which always failed with 422.
      const r = await api.post<{ ok: boolean; message: string }>(`/api/interaction/profile/${customerId}/override`, { field: 'response_preference', value, reason: reason || null });
      if (!r.ok) throw new Error(r.message);
    },
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Human preference saved — it now takes precedence over AI inference.' });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['interaction-profile', customerId] });
      void qc.invalidateQueries({ queryKey: ['interaction'] });
      onChanged();
    },
    onError: (e) => pushToast({ kind: 'error', message: (e as Error).message })
  });

  const clear = useMutation({
    mutationFn: async (): Promise<void> => {
      const r = await api.delete<{ ok: boolean; message: string }>(`/api/interaction/profile/${customerId}/override/response_preference`);
      if (!r.ok) throw new Error(r.message);
    },
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Override removed — AI-inferred preference applies again.' });
      void qc.invalidateQueries({ queryKey: ['interaction-profile', customerId] });
      void qc.invalidateQueries({ queryKey: ['interaction'] });
      onChanged();
    },
    onError: (e) => pushToast({ kind: 'error', message: (e as Error).message })
  });

  const effective = preference.human_override?.value ?? preference.preference;
  const isHuman = !!preference.human_override || preference.origin === 'human_entered';
  return (
    <div className="mb-8">
      <div className="flex-between">
        <strong className="text-sm">{isHuman ? 'Response preference' : preference.preference.replace(/_/g, ' ')}: {effective.replace(/_/g, ' ')}</strong>
        <span className={`badge ${isHuman ? 'ok' : 'ai'}`}>
          {preference.human_override ? 'human override' : preference.origin === 'human_entered' ? 'human-entered' : `AI-inferred · ${preference.evidence_count} obs.`}
        </span>
      </div>
      {preference.human_override ? (
        <div className="text-xs muted">
          AI inferred: {preference.preference.replace(/_/g, ' ')}
          {preference.human_override.reason ? ` · reason: ${preference.human_override.reason}` : ''}
        </div>
      ) : (
        <div className="text-xs muted">
          Evidence: {preference.evidence_count} {preference.evidence_count === 1 ? 'interaction' : 'interactions'}
          {preference.last_observed ? ` · last observed ${preference.last_observed.slice(0, 10)}` : ''}
        </div>
      )}
      <div className="flex mt-4" style={{ gap: 6 }}>
        {!editing ? (
          <button className="btn small ghost" onClick={() => { setValue(effective); setReason(preference.human_override?.reason ?? ''); setEditing(true); }}><Wrench size={10} /> Override</button>
        ) : (
          <>
            <select className="input" style={{ maxWidth: 160 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Override value">
              {RESPONSE_PREFERENCE_VALUES.map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <input className="input grow" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, e.g. customer asked for short answers)" aria-label="Override reason" />
            <button className="btn small" onClick={() => save.mutate()} disabled={save.isPending || !value.trim()}><Check size={10} /> Save</button>
            <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
          </>
        )}
        {isHuman ? (
          <button className="btn small ghost" onClick={() => clear.mutate()} disabled={clear.isPending}><RotateCcw size={10} /> Revert to AI</button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Manual override entry for customers with NO inferred preferences yet -
 * without it, the human-overrides safety feature (spec #22) was unreachable
 * until the AI had already inferred something.
 */
function ManualPreference({ customerId, onChanged, showWhenEmpty }: { customerId: number; onChanged: () => void; showWhenEmpty: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(RESPONSE_PREFERENCE_VALUES[0]);
  const [reason, setReason] = useState('');
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/interaction/profile/${customerId}/override`, { field: 'response_preference', value, reason: reason || null });
      if (!r.ok) throw new Error(r.message);
    },
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Human preference saved — it now takes precedence over AI inference.' });
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['interaction-profile', customerId] });
      void qc.invalidateQueries({ queryKey: ['interaction'] });
      onChanged();
    },
    onError: (e) => pushToast({ kind: 'error', message: (e as Error).message })
  });
  return (
    <div className="mt-4">
      {!open ? (
        <button className="btn small ghost" onClick={() => setOpen(true)}><Plus size={10} /> {showWhenEmpty ? 'Set a preference manually' : 'Override preference manually'}</button>
      ) : (
        <div className="flex" style={{ gap: 6 }}>
          <select className="input" style={{ maxWidth: 160 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Manual preference value">
            {RESPONSE_PREFERENCE_VALUES.map((v) => (
              <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <input className="input grow" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Manual preference reason" />
          <button className="btn small" onClick={() => save.mutate()} disabled={save.isPending}><Check size={10} /> Save</button>
          <button className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
