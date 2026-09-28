import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../components/common/ui.js';
import { Modal } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import { AI_ATTRIBUTE_CATALOG } from '../../shared/constants.js';
import type { AutomationRule } from '../../shared/types.js';

interface RuleData {
  rules: AutomationRule[];
  runs: { id: number; rule_id: number; conversation_id: number | null; triggered_at: string; status: string; detail: string }[];
  risk_tiers: { read: string[]; non_destructive: string[]; higher_risk: string[]; note: string };
  automation_enabled: boolean;
}

export function AutomationPage(): ReactNode {
  const [creating, setCreating] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data, error, refetch } = useQuery({ queryKey: ['automation'], queryFn: () => api.get<RuleData>('/api/automation/rules') });

  const toggleEngine = useMutation({
    mutationFn: (on: boolean) => api.patch<{ ok: boolean }>('/api/settings', { automation_enabled: on }),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Automation engine setting updated.' });
      void refetch();
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.patch(`/api/automation/rules/${id}`, { enabled }),
    onSuccess: () => void refetch(),
    // v1.6.0 audit fix: rule enable/disable failures were silent no-ops.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api/automation/rules/${id}`),
    onSuccess: () => void refetch(),
    // v1.6.0 audit fix: rule deletion failures were silent no-ops.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ ok: boolean; message: string }>('/api/automation/rules', body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setCreating(false);
      void refetch();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (error) return <div className="page"><ErrorState message="Could not load automation rules" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} /></div>;
  if (!data) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Automation</h1>
          <p className="page-subtitle">Local SupportOS automation - deliberately separate from Help Scout workflows. Higher-risk actions always require approval.</p>
        </div>
        <div className="flex">
          <label className="flex text-sm" style={{ gap: 6, fontWeight: 600 }}>
            <input type="checkbox" checked={data.automation_enabled} onChange={(e) => toggleEngine.mutate(e.target.checked)} />
            Automation engine {data.automation_enabled ? 'ON' : 'OFF'}
          </label>
          <button className="btn primary" onClick={() => setCreating(true)}>New rule</button>
        </div>
      </div>

      <div className="alert info">
        <strong>Action safety tiers:</strong> read ({data.risk_tiers.read.join(', ')}) · non-destructive ({data.risk_tiers.non_destructive.join(', ')}) · higher-risk ({data.risk_tiers.higher_risk.join(', ')}) — higher-risk actions are always queued for explicit approval in v1. {data.risk_tiers.note}
      </div>

      {data.rules.length === 0 ? (
        <EmptyState title="No automation rules yet" hint="Create a rule: e.g. WHEN new conversation AND subject contains 'timezone' THEN analyze ticket + check known issues." action={<button className="btn primary" onClick={() => setCreating(true)}>Create your first rule</button>} />
      ) : null}

      {data.rules.map((r) => (
        <div key={r.id} className="rule-card">
          <div className="flex-between wrap">
            <div>
              <strong>{r.name}</strong>{' '}
              <span className={`badge ${r.enabled ? 'ok' : ''}`}>{r.enabled ? 'enabled' : 'disabled'}</span>{' '}
              <span className="badge">{r.trigger}</span>{' '}
              {r.requires_approval ? <span className="badge warn">approval required</span> : null}
            </div>
            <div className="flex" style={{ gap: 4 }}>
              <button className="btn small" onClick={() => toggleRule.mutate({ id: r.id, enabled: !r.enabled })}>{r.enabled ? 'Disable' : 'Enable'}</button>
              <button className="btn ghost small" onClick={() => del.mutate(r.id)}>Delete</button>
            </div>
          </div>
          <div className="rule-when mt-8">
{`WHEN ${r.trigger}${r.conditions.length ? '\nAND ' + r.conditions.map((c) => `${c.field === 'ai_attribute' && c.attribute ? `ai_attribute.${c.attribute}` : c.field} ${c.operator} "${c.value}"`).join('\nAND ') : ''}\nTHEN ${r.actions.map((a) => a.kind + (Object.keys(a.params).length ? `(${JSON.stringify(a.params)})` : '')).join(' + ')}`}
          </div>
          <div className="text-xs muted mt-8">ran {r.run_count}× · last <RelativeTime iso={r.last_run_at} /> · priority {r.priority}</div>
        </div>
      ))}

      <div className="card mt-16">
        <h3 className="card-title">Recent runs</h3>
        <table className="table">
          <thead><tr><th>When</th><th>Rule</th><th>Conversation</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {data.runs.slice(0, 30).map((run) => (
              <tr key={run.id}>
                <td><RelativeTime iso={run.triggered_at} /></td>
                <td>{data.rules.find((r) => r.id === run.rule_id)?.name ?? run.rule_id}</td>
                <td>{run.conversation_id ? <Link to={`/inbox/conversation/${run.conversation_id}`}>#{run.conversation_id}</Link> : '—'}</td>
                <td><span className={`badge ${run.status === 'completed' ? 'ok' : run.status === 'awaiting_approval' ? 'warn' : run.status === 'failed' ? 'err' : ''}`}>{run.status}</span></td>
                <td className="text-xs">{run.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.runs.length === 0 ? <span className="muted text-sm">No runs yet.</span> : null}
      </div>

      {creating ? <RuleForm onSubmit={(body) => create.mutate(body)} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function RuleForm({ onSubmit, onClose }: { onSubmit: (body: Record<string, unknown>) => void; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('new_conversation');
  const [conditions, setConditions] = useState<{ field: string; operator: string; value: string; attribute?: string }[]>([]);
  const [actions, setActions] = useState<{ kind: string; params: Record<string, string> }[]>([{ kind: 'analyze_ticket', params: {} }]);
  const actionKinds = ['analyze_ticket', 'search_similar', 'check_known_issues', 'create_ai_note', 'create_ai_draft', 'add_tag', 'set_status', 'assign', 'manual_review_queue'];
  // v1.9.0 (M3, plan Phase 17): AI-derived attribute + draft-verification
  // conditions join the closed field list. They only decide whether a rule
  // MATCHES - actions still flow through the same approval tiers.
  const fields = ['subject', 'body', 'tag', 'mailbox', 'confidence', 'known_issue_match', 'ai_attribute', 'ai_verification'];
  const operators = ['contains', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'];
  const conditionBody = (c: { field: string; operator: string; value: string; attribute?: string }): Record<string, unknown> =>
    c.field === 'ai_attribute' ? { field: c.field, operator: c.operator, value: c.value, attribute: c.attribute ?? 'urgency' } : { field: c.field, operator: c.operator, value: c.value };
  return (
    <Modal
      title="New automation rule"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onSubmit({ name, trigger, conditions: conditions.map(conditionBody), actions, priority: 100, requires_approval: true, enabled: false })}>Create (disabled)</button>
        </>
      }
    >
      <div className="form-row"><label className="field" htmlFor="r-name">Name *</label><input id="r-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. High-urgency review queue" /></div>
      <div className="form-row">
        <label className="field" htmlFor="r-trigger">Trigger</label>
        <select id="r-trigger" className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="new_conversation">new conversation</option>
          <option value="customer_reply">customer reply</option>
          <option value="ai_low_confidence">AI confidence below threshold</option>
          <option value="manual">manual</option>
        </select>
      </div>
      <div className="form-row">
        <label className="field">Conditions (all must match)</label>
        {conditions.map((c, i) => (
          <div key={i} className="flex mb-8">
            <select className="input" value={c.field} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: e.target.value, attribute: e.target.value === 'ai_attribute' ? (x.attribute ?? 'urgency') : x.attribute } : x)))}>
              {fields.map((f) => <option key={f} value={f}>{f === 'ai_attribute' ? 'AI attribute' : f === 'ai_verification' ? 'AI draft verification' : f}</option>)}
            </select>
            {c.field === 'ai_attribute' ? (
              <select className="input" title="Attribute key (closed catalog)" value={c.attribute ?? 'urgency'} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, attribute: e.target.value } : x)))}>
                {AI_ATTRIBUTE_CATALOG.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            ) : null}
            {c.field === 'ai_verification' ? (
              <select className="input" value={c.value || 'failed'} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, operator: 'equals', value: e.target.value } : x)))}>
                {['failed', 'passed', 'none'].map((v) => <option key={v} value={v}>{v === 'none' ? 'no verification yet' : v}</option>)}
              </select>
            ) : (
              <>
                <select className="input" style={{ width: 110 }} value={c.operator} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}>
                  {operators.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input className="input" placeholder={c.field === 'ai_attribute' ? 'value (or unknown)' : 'value'} value={c.value} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              </>
            )}
            <button className="btn ghost" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn small" onClick={() => setConditions((cs) => [...cs, { field: 'subject', operator: 'contains', value: '' }])}>+ condition</button>
        <p className="text-xs muted" style={{ margin: '6px 0 0' }}>AI attribute conditions read the local attribute layer (missing value = 'unknown', which never matches a concrete value). They never trigger writes on their own.</p>
      </div>
      <div className="form-row">
        <label className="field">Actions</label>
        {actions.map((a, i) => (
          <div key={i} className="flex mb-8">
            <select className="input" value={a.kind} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
              {actionKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {a.kind === 'add_tag' ? <input className="input" placeholder="tag name" value={a.params.tag ?? ''} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, params: { tag: e.target.value } } : x)))} /> : null}
            {a.kind === 'set_status' ? (
              <select className="input" value={a.params.status ?? 'closed'} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, params: { status: e.target.value } } : x)))}>
                {['active', 'pending', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : null}
            <button className="btn ghost" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn small" onClick={() => setActions((as) => [...as, { kind: 'analyze_ticket', params: {} }])}>+ action</button>
      </div>
      <p className="text-xs muted">Rules are created disabled. Higher-risk actions (set_status, assign) always require explicit approval per run.</p>
    </Modal>
  );
}
