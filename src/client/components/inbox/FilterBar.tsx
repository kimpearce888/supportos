import { type ReactNode, useState } from 'react';
import { Bookmark, Trash2, Save, Filter, ChevronDown } from 'lucide-react';
import { api } from '../../api/client.js';
import { useInboxViews, useTicketStates } from '../../api/hooks.js';
import { useUiStore } from '../../state/uiStore.js';
import { ACTIVITY_FIELDS, DATE_MODES, RESPONSE_STATES, RESPONSE_STATE_LABELS, TICKET_PRIORITIES, PRIORITY_LABELS, type SavedInboxView, type ViewDefinition, type ViewCondition } from '../../../shared/activity.js';
import { AI_ATTRIBUTE_CATALOG, type AiAttributeKey } from '../../../shared/constants.js';

/**
 * Inbox filter bar (v1.7.0): activity-field + date-mode + response-state +
 * priority + ticket-state filters, sort control and the saved-view manager.
 *
 * All filter state lives in the PAGE URL (search params) - shareable,
 * back-button-safe, no hidden client state. The bar reads/writes params via
 * the callbacks the page provides; it never re-renders the list itself.
 */

const ACTIVITY_LABELS: Record<string, string> = {
  created_at: 'Created',
  first_customer_message_at: 'First customer message',
  first_response_at: 'First response',
  last_customer_reply_at: 'Last customer reply',
  last_human_agent_response_at: 'Last agent response',
  last_system_response_at: 'Last system response',
  last_note_at: 'Last note',
  last_activity_at: 'Last activity',
  closed_at: 'Closed',
  customer_waiting_since: 'Customer waiting since',
  last_status_change_at: 'Last status change',
  last_assignment_change_at: 'Last assignment change',
  last_tag_change_at: 'Last tag change',
  last_custom_field_change_at: 'Last custom-field change'
};

const DATE_MODE_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  tomorrow: 'Tomorrow',
  last_24h: 'Last 24 hours',
  last_48h: 'Last 48 hours',
  last_7d: 'Last 7 days',
  last_14d: 'Last 14 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  exact_date: 'Exact date',
  custom_range: 'Custom range'
};

const SORT_LABELS: Record<string, string> = {
  newest_activity: 'Newest activity',
  oldest_activity: 'Oldest activity',
  newest_created: 'Newest created',
  oldest_created: 'Oldest created',
  waiting_longest: 'Waiting longest',
  priority: 'Priority',
  priority_then_waiting: 'Priority, then waiting'
};

export interface FilterBarValues {
  activityField: string | null;
  dateMode: string | null;
  from: string | null;
  to: string | null;
  responseState: string | null;
  priority: string | null;
  ticketStateId: string | null;
  sort: string | null;
  savedViewId: string | null;
  /** v1.9.0 (M3): live AI-attribute filter. */
  aiAttribute: string | null;
  aiAttrOp: string | null;
  aiAttrValue: string | null;
}

export function FilterBar({ values, onChange, notes }: { values: FilterBarValues; onChange: (patch: Partial<FilterBarValues>) => void; notes?: string[] }): ReactNode {
  const { data: viewsData } = useInboxViews();
  const { data: statesData } = useTicketStates();
  const views = viewsData?.views ?? [];
  const states = statesData?.states ?? [];
  const active = values.activityField != null || values.dateMode != null || values.responseState != null || values.priority != null || values.ticketStateId != null || values.sort != null || values.savedViewId != null || values.aiAttribute != null;

  const set = (patch: Partial<FilterBarValues>): void => onChange(patch);
  const clearAll = (): void => onChange({ activityField: null, dateMode: null, from: null, to: null, responseState: null, priority: null, ticketStateId: null, sort: null, savedViewId: null, aiAttribute: null, aiAttrOp: null, aiAttrValue: null });

  return (
    <div className="filter-bar" style={{ borderBottom: '1px solid var(--border)', padding: '6px 10px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <span className="text-xs muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Filter size={11} /> Filters</span>

      <SavedViewSelect views={views} current={values.savedViewId} onSelect={(id) => set({ savedViewId: id })} />

      <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Activity field" value={values.activityField ?? ''} onChange={(e) => set({ activityField: e.target.value || null, dateMode: e.target.value ? (values.dateMode ?? 'today') : null })}>
        <option value="">Any activity</option>
        {ACTIVITY_FIELDS.map((f) => <option key={f} value={f}>{ACTIVITY_LABELS[f] ?? f}</option>)}
      </select>

      {values.activityField ? (
        <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Date mode" value={values.dateMode ?? ''} onChange={(e) => set({ dateMode: e.target.value || null, from: null, to: null })}>
          <option value="">Any time</option>
          {DATE_MODES.map((m) => <option key={m} value={m}>{DATE_MODE_LABELS[m] ?? m}</option>)}
        </select>
      ) : null}

      {values.dateMode === 'exact_date' ? (
        <input type="date" className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Exact date" value={values.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
      ) : null}
      {values.dateMode === 'custom_range' ? (
        <>
          <input type="date" className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="From date" value={values.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
          <span className="text-xs muted">to</span>
          <input type="date" className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="To date" value={values.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
        </>
      ) : null}

      <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Response state" value={values.responseState ?? ''} onChange={(e) => set({ responseState: e.target.value || null })}>
        <option value="">Any response state</option>
        {RESPONSE_STATES.map((s) => <option key={s} value={s}>{RESPONSE_STATE_LABELS[s]}</option>)}
      </select>

      <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Priority" value={values.priority ?? ''} onChange={(e) => set({ priority: e.target.value || null })}>
        <option value="">Any priority</option>
        {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
      </select>

      {states.length > 0 ? (
        <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Ticket state" value={values.ticketStateId ?? ''} onChange={(e) => set({ ticketStateId: e.target.value || null })}>
          <option value="">Any state</option>
          {states.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
      ) : null}

      {/* v1.9.0 (M3): live AI-attribute filter - closed catalog, bound values.
          'unknown' finds tickets with no stored value (honest unknown). */}
      <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="AI attribute" title="Filter by local AI attributes (deterministic + AI layers). Missing values count as unknown." value={values.aiAttribute ?? ''} onChange={(e) => set({ aiAttribute: e.target.value || null, aiAttrOp: e.target.value ? (values.aiAttrOp ?? 'equals') : null, aiAttrValue: e.target.value ? (values.aiAttrValue ?? '') : null })}>
        <option value="">Any AI attribute</option>
        {AI_ATTRIBUTE_CATALOG.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </select>
      {values.aiAttribute ? (
        <>
          <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="AI attribute operator" value={values.aiAttrOp ?? 'equals'} onChange={(e) => set({ aiAttrOp: e.target.value || 'equals' })}>
            {['equals', 'not_equals', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte'].map((o) => <option key={o} value={o}>{o === 'not_equals' ? '≠' : o === 'not_contains' ? 'not ~' : o === 'gt' ? '>' : o === 'gte' ? '≥' : o === 'lt' ? '<' : o === 'lte' ? '≤' : o === 'contains' ? '~' : '='}</option>)}
          </select>
          <AiAttributeValueInput
            attribute={values.aiAttribute as AiAttributeKey}
            op={values.aiAttrOp ?? 'equals'}
            value={values.aiAttrValue ?? ''}
            onChange={(v) => set({ aiAttrValue: v || null })}
          />
        </>
      ) : null}

      <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px', marginLeft: 'auto' }} aria-label="Sort" value={values.sort ?? ''} onChange={(e) => set({ sort: e.target.value || null })}>
        <option value="">Sort: newest activity</option>
        {Object.entries(SORT_LABELS).map(([k, label]) => <option key={k} value={k}>Sort: {label}</option>)}
      </select>

      <SaveViewButton values={values} onSaved={(id) => set({ savedViewId: String(id) })} />

      {active ? (
        <button className="btn ghost small" onClick={clearAll}>Clear</button>
      ) : null}

      {notes && notes.length > 0 ? (
        <div style={{ width: '100%' }} className="text-xs muted">
          {notes[notes.length - 1]}
        </div>
      ) : null}
    </div>
  );
}

function SavedViewSelect({ views, current, onSelect }: { views: SavedInboxView[]; current: string | null; onSelect: (id: string | null) => void }): ReactNode {
  if (views.length === 0) return null;
  return (
    <select className="input" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }} aria-label="Saved views" value={current ?? ''} onChange={(e) => onSelect(e.target.value || null)}>
      <option value="">Saved views</option>
      {views.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
    </select>
  );
}

function SaveViewButton({ values, onSaved }: { values: FilterBarValues; onSaved: (id: number) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const pushToast = useUiStore((s) => s.pushToast);
  const hasFilters = values.activityField != null || values.responseState != null || values.priority != null || values.ticketStateId != null || values.aiAttribute != null;

  const buildDefinition = (): ViewDefinition => {
    const conditions: ViewCondition[] = [];
    if (values.activityField && values.dateMode) {
      conditions.push({ kind: 'date_activity', activityField: values.activityField as never, mode: values.dateMode as never, from: values.from ?? null, to: values.to ?? null });
    }
    if (values.responseState) conditions.push({ kind: 'response_state', states: [values.responseState as never] });
    if (values.priority) conditions.push({ kind: 'priority', priorities: [values.priority as never] });
    if (values.ticketStateId) conditions.push({ kind: 'ticket_state', stateIds: [Number(values.ticketStateId)], includeNoState: false });
    if (values.aiAttribute && values.aiAttrValue) {
      conditions.push({ kind: 'ai_attribute', attribute: values.aiAttribute as AiAttributeKey, op: (values.aiAttrOp ?? 'equals') as 'equals', value: values.aiAttrValue });
    }
    return { combinator: 'all', conditions };
  };

  const save = async (): Promise<void> => {
    try {
      const r = await api.post<{ ok: boolean; message: string; view?: SavedInboxView }>('/api/inbox-views', { name: name.trim(), definition: buildDefinition() });
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      if (r.ok && r.view) {
        onSaved(r.view.id);
        setOpen(false);
        setName('');
      }
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not save view.' });
    }
  };

  return (
    <span style={{ position: 'relative' }}>
      <button className="btn small" disabled={!hasFilters} title={hasFilters ? 'Save current filters as a reusable view' : 'Set at least one filter to save a view'} onClick={() => setOpen(!open)}>
        <Save size={11} /> Save view
      </button>
      {open ? (
        <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 500, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 10, minWidth: 240 }}>
          <div className="form-row">
            <label className="field" htmlFor="view-name">View name</label>
            <input id="view-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer replied today, no agent response" autoFocus />
          </div>
          <p className="text-xs muted" style={{ margin: '6px 0' }}>Calendar filters like "Today" stay DYNAMIC - the view always means the day it is opened.</p>
          <div className="flex" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn ghost small" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary small" disabled={!name.trim()} onClick={() => void save()}><Save size={11} /> Save</button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

export function DeleteViewButton({ viewId, onDeleted }: { viewId: number; onDeleted: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const del = async (): Promise<void> => {
    try {
      const r = await api.delete<{ ok: boolean; message: string }>(`/api/inbox-views/${viewId}`);
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      if (r.ok) onDeleted();
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not delete view.' });
    }
  };
  return (
    <button className="btn ghost small" title="Delete saved view" onClick={() => void del()}>
      <Trash2 size={11} />
    </button>
  );
}

/**
 * v1.9.0 (M3): value input for the AI-attribute filter. Enum AND boolean
 * attributes get a closed select (plus 'unknown' = no stored value); text and
 * number attributes get a bounded free-text input. The server re-validates
 * everything anyway.
 */
function AiAttributeValueInput({ attribute, op, value, onChange }: { attribute: AiAttributeKey; op: string; value: string; onChange: (v: string) => void }): ReactNode {
  const def = AI_ATTRIBUTE_CATALOG.find((d) => d.key === attribute);
  const closedValues =
    def?.value_type === 'boolean'
      ? ['unknown', 'true', 'false'] // booleans are a closed vocabulary too
      : def?.value_type === 'enum' && def.values != null
        ? ['unknown', ...def.values]
        : null;
  const style = { width: 'auto', fontSize: 12, padding: '2px 6px' } as const;
  if (closedValues != null && (op === 'equals' || op === 'not_equals')) {
    return (
      <select className="input" style={style} aria-label="AI attribute value" value={value} onChange={(e) => onChange(e.target.value)}>
        {value && !closedValues.includes(value) ? <option value={value}>{value}</option> : null}
        {closedValues.map((v) => <option key={v} value={v}>{v === 'unknown' ? 'unknown (no value)' : v}</option>)}
      </select>
    );
  }
  // Ordered enums compared with gt/gte/lt/lte are expanded server-side by
  // vocabulary position; text/number take bounded free-text values.
  return <input className="input" style={style} aria-label="AI attribute value" placeholder={def?.value_type === 'number' ? 'number' : 'value'} value={value} onChange={(e) => onChange(e.target.value)} maxLength={120} />;
}

/** Compact expandable list of saved views with delete affordances (manager). */
export function SavedViewsManager({ current, onSelect }: { current: string | null; onSelect: (id: string | null) => void }): ReactNode {
  const { data } = useInboxViews();
  const views = data?.views ?? [];
  if (views.length === 0) return null;
  return (
    <details style={{ borderTop: '1px solid var(--border)', padding: '4px 10px' }}>
      <summary className="text-xs muted" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ChevronDown size={10} /> Manage saved views ({views.length})
      </summary>
      <div style={{ padding: '4px 0' }}>
        {views.map((v) => (
          <div key={v.id} className="flex-between" style={{ padding: '2px 0' }}>
            <button className={`btn ghost small ${String(v.id) === current ? 'active' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => onSelect(String(v.id) === current ? null : String(v.id))}>
              <Bookmark size={10} /> {v.name} <span className="text-xs muted">v{v.version}</span>
            </button>
            <DeleteViewButton viewId={v.id} onDeleted={() => onSelect(null)} />
          </div>
        ))}
      </div>
    </details>
  );
}
