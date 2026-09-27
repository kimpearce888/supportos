import { type ReactNode } from 'react';
import type {
  SegmentNode,
  SegmentCondition,
  CustomerPropertyCondition,
  ContactCondition,
  TicketCondition,
  HistoryCondition,
  HistoryTagCondition,
  PropertyType,
  PropertyOperator,
  ContactField,
  OutreachMeta
} from '../../../shared/segmentation.js';

/**
 * Segment condition editor (v1.5.0): the audience builder's core.
 *
 * Design decisions:
 * - The editor edits the CONDITION TREE, not SQL - saved segments stay
 *   inspectable, versionable rules (spec #48) and the engine stays the only
 *   thing that decides membership.
 * - Ticket conditions keep ALL their filters in ONE node because the
 *   conversation-level tag intersection (ALL semantics) only works within a
 *   single node; the UI explains this instead of letting users unknowingly
 *   build a different query than they see (spec #18).
 * - Operator lists come from the synced property TYPE (spec #4/#11) - the UI
 *   never hard-codes property names or their operators.
 */
export function ConditionEditor({
  node,
  meta,
  onChange,
  onRemove
}: {
  node: SegmentCondition;
  meta: OutreachMeta | undefined;
  onChange: (next: SegmentCondition) => void;
  onRemove: () => void;
}): ReactNode {
  const KIND_LABEL: Record<SegmentCondition['kind'], string> = {
    customer_property: 'Customer property',
    contact: 'Contact field',
    ticket: 'Ticket condition',
    history: 'Support history',
    history_tag: 'Ever tagged'
  };

  const row = (label: string, control: ReactNode): ReactNode => (
    <label className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <span className="muted">{label}</span>
      {control}
    </label>
  );

  return (
    <div className="card" style={{ padding: 10, marginBottom: 8 }}>
      <div className="flex" style={{ gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <select
          className="input"
          style={{ width: 190, fontWeight: 600 }}
          value={node.kind}
          onChange={(e) => {
            const kind = e.target.value as SegmentCondition['kind'];
            if (kind === node.kind) return;
            if (kind === 'customer_property') {
              const def = meta?.property_definitions[0];
              onChange({ kind, definitionId: def?.id ?? 0, name: def?.name ?? '', type: (def?.type ?? 'text') as PropertyType, op: 'equals', value: '' });
            } else if (kind === 'contact') {
              onChange({ kind: 'contact', field: 'email', op: 'contains', value: '' });
            } else if (kind === 'ticket') {
              onChange({ kind: 'ticket', tags: [], tagMode: 'any' });
            } else if (kind === 'history') {
              onChange({ kind: 'history', metric: 'ticket_count', op: 'gte', value: 1 });
            } else {
              onChange({ kind: 'history_tag', tag: '', withinDays: null });
            }
          }}
        >
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-xs muted grow" style={{ alignSelf: 'center' }}>
          {node.kind === 'ticket' ? 'All filters below apply to the SAME conversation (tag ALL/ANY/NONE is evaluated per ticket)' : ''}
        </span>
        <button className="btn ghost small" onClick={onRemove} aria-label="Remove condition">
          Remove
        </button>
      </div>

      {node.kind === 'customer_property' ? <PropertyEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'contact' ? <ContactEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'ticket' ? <TicketEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'history' ? <HistoryEditor c={node} onChange={onChange} row={row} /> : null}
      {node.kind === 'history_tag' ? <HistoryTagEditor c={node} onChange={onChange} row={row} /> : null}
    </div>
  );
}

type RowFn = (label: string, control: ReactNode) => ReactNode;

function PropertyEditor({ c, meta, onChange, row }: { c: CustomerPropertyCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const defs = meta?.property_definitions ?? [];
  const def = defs.find((d) => d.id === c.definitionId);
  const type = (def?.type ?? c.type) as PropertyType;
  const ops: PropertyOperator[] = meta?.operators_by_type?.[type] ?? ['equals', 'not_equals', 'contains'];
  const set = (patch: Partial<CustomerPropertyCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Property',
        <select className="input" style={{ width: 190 }} value={c.definitionId} onChange={(e) => {
          const next = defs.find((d) => d.id === Number(e.target.value));
          if (next) set({ definitionId: next.id, name: next.name, type: next.type, op: (meta?.operators_by_type?.[next.type] ?? ['equals'])[0] ?? 'equals', value: '', values: [] });
        }}>
          {defs.length === 0 ? <option value={0}>(no properties synced)</option> : null}
          {defs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.type}
              {d.populated === 0 ? ' (no values locally)' : ''}
            </option>
          ))}
        </select>
      )}
      {row(
        'Operator',
        <select className="input" style={{ width: 150 }} value={c.op} onChange={(e) => set({ op: e.target.value as PropertyOperator })}>
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op] ?? op}
            </option>
          ))}
        </select>
      )}
      {!NO_VALUE_OPS.has(c.op) && c.op !== 'is_any_of' && c.op !== 'is_none_of' ? row('Value', <input className="input" style={{ width: 160 }} value={c.value ?? ''} onChange={(e) => set({ value: e.target.value })} placeholder={type === 'number' ? 'number' : type === 'date' ? 'YYYY-MM-DD' : 'value'} />) : null}
      {c.op === 'between' ? row('And', <input className="input" style={{ width: 160 }} value={c.value2 ?? ''} onChange={(e) => set({ value2: e.target.value })} placeholder={type === 'number' ? 'number' : 'YYYY-MM-DD'} />) : null}
      {(c.op === 'is_any_of' || c.op === 'is_none_of')
        ? row(
            'Values',
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 340 }}>
              {(def?.observed_values ?? []).map((v) => {
                const selected = (c.values ?? []).includes(v);
                return (
                  <button
                    key={v}
                    type="button"
                    className="badge"
                    style={{ border: '1px solid var(--border)', background: selected ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer' }}
                    onClick={() => set({ values: selected ? (c.values ?? []).filter((x) => x !== v) : [...(c.values ?? []), v] })}
                  >
                    {v}
                  </button>
                );
              })}
              <input className="input" style={{ width: 130 }} placeholder="add + Enter" onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !(c.values ?? []).includes(v)) set({ values: [...(c.values ?? []), v] });
                  (e.target as HTMLInputElement).value = '';
                }
              }} />
            </div>
          )
        : null}
    </div>
  );
}

function ContactEditor({ c, meta, onChange, row }: { c: ContactCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const fields: ContactField[] = meta?.contact_fields ?? ['email'];
  const set = (patch: Partial<ContactCondition>): void => onChange({ ...c, ...patch });
  const needsValue = c.op !== 'is_empty' && c.op !== 'is_not_empty';
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Field',
        <select className="input" style={{ width: 180 }} value={c.field} onChange={(e) => set({ field: e.target.value as ContactField })}>
          {fields.map((f) => (
            <option key={f} value={f}>
              {CONTACT_FIELD_LABEL[f] ?? f}
            </option>
          ))}
        </select>
      )}
      {row(
        'Operator',
        <select className="input" style={{ width: 150 }} value={c.op} onChange={(e) => set({ op: e.target.value as ContactCondition['op'] })}>
          {['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'].map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op] ?? op}
            </option>
          ))}
        </select>
      )}
      {needsValue ? row('Value', <input className="input" style={{ width: 200 }} value={c.value ?? ''} onChange={(e) => set({ value: e.target.value })} placeholder={c.field === 'email_domain' ? 'company.com' : 'value'} />) : null}
    </div>
  );
}

function TicketEditor({ c, meta, onChange, row }: { c: TicketCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const tags = meta?.tags ?? [];
  const statuses = meta?.ticket_statuses ?? ['active', 'pending', 'closed'];
  const mailboxes = meta?.mailboxes ?? [];
  const assignees = meta?.assignees ?? [];
  const set = (patch: Partial<TicketCondition>): void => onChange({ ...c, ...patch });
  const selectedTags = c.tags ?? [];
  return (
    <div>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {row(
          'Tag mode',
          <select className="input" style={{ width: 130 }} value={c.tagMode ?? 'any'} onChange={(e) => set({ tagMode: e.target.value as 'any' | 'all' | 'none' })}>
            <option value="any">has ANY of</option>
            <option value="all">has ALL of</option>
            <option value="none">has NONE of</option>
          </select>
        )}
        {row(
          'Tags',
          <div className="flex" style={{ gap: 4, flexWrap: 'wrap', maxWidth: 430 }}>
            {selectedTags.map((t) => (
              <button key={t} type="button" className="badge active" style={{ cursor: 'pointer' }} onClick={() => set({ tags: selectedTags.filter((x) => x !== t) })} title="Click to remove">
                {t} ×
              </button>
            ))}
            <input
              className="input"
              style={{ width: 140 }}
              placeholder="add tag + Enter"
              list="outreach-tag-list"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
                  if (v && !selectedTags.includes(v)) set({ tags: [...selectedTags, v] });
                  (e.target as HTMLInputElement).value = '';
                }
              }}
            />
            <datalist id="outreach-tag-list">
              {tags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        )}
        {row(
          'Status',
          <select className="input" style={{ width: 140 }} value={c.statuses?.[0] ?? ''} onChange={(e) => set({ statuses: e.target.value ? [e.target.value] : [] })}>
            <option value="">any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {row(
          'Inbox',
          <select className="input" style={{ width: 160 }} value={c.mailboxLocalIds?.[0] ?? ''} onChange={(e) => set({ mailboxLocalIds: e.target.value ? [Number(e.target.value)] : [] })}>
            <option value="">any inbox</option>
            {mailboxes.map((m) => (
              <option key={m.local_id} value={m.local_id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
        {row(
          'Assignee',
          <select className="input" style={{ width: 160 }} value={c.assigneeLocalIds?.[0] ?? ''} onChange={(e) => set({ assigneeLocalIds: e.target.value ? [Number(e.target.value)] : [] })}>
            <option value="">any assignee</option>
            <option value="-1">unassigned</option>
            {assignees.map((a) => (
              <option key={a.local_id} value={a.local_id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {row(
          'Created ≤ days',
          <input className="input" style={{ width: 110 }} type="number" min={1} value={c.createdWithinDays ?? ''} onChange={(e) => set({ createdWithinDays: e.target.value ? Number(e.target.value) : null })} placeholder="any" />
        )}
        {row(
          'Modified ≤ days',
          <input className="input" style={{ width: 110 }} type="number" min={1} value={c.modifiedWithinDays ?? ''} onChange={(e) => set({ modifiedWithinDays: e.target.value ? Number(e.target.value) : null })} placeholder="any" />
        )}
        {row(
          'Number ≥',
          <input className="input" style={{ width: 100 }} type="number" value={c.numberMin ?? ''} onChange={(e) => set({ numberMin: e.target.value ? Number(e.target.value) : null })} placeholder="any" />
        )}
        {row(
          'Number ≤',
          <input className="input" style={{ width: 100 }} type="number" value={c.numberMax ?? ''} onChange={(e) => set({ numberMax: e.target.value ? Number(e.target.value) : null })} placeholder="any" />
        )}
      </div>
    </div>
  );
}

function HistoryEditor({ c, onChange, row }: { c: HistoryCondition; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const set = (patch: Partial<HistoryCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Metric',
        <select className="input" style={{ width: 230 }} value={c.metric} onChange={(e) => set({ metric: e.target.value as HistoryCondition['metric'] })}>
          <option value="ticket_count">total tickets</option>
          <option value="open_count">open tickets</option>
          <option value="closed_count">closed tickets</option>
          <option value="last_contact_within_days">last contact within (days)</option>
          <option value="first_contact_before_days">first contact older than (days)</option>
        </select>
      )}
      {row(
        'Comparison',
        <select className="input" style={{ width: 130 }} value={c.op} onChange={(e) => set({ op: e.target.value as 'gte' | 'lte' | 'eq' })}>
          <option value="gte">is at least</option>
          <option value="lte">is at most</option>
          <option value="eq">equals</option>
        </select>
      )}
      {row('Value', <input className="input" style={{ width: 110 }} type="number" value={c.value} onChange={(e) => set({ value: Number(e.target.value) })} />)}
    </div>
  );
}

function HistoryTagEditor({ c, onChange, row }: { c: HistoryTagCondition; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const set = (patch: Partial<HistoryTagCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Tag',
        <input className="input" style={{ width: 180 }} value={c.tag} list="outreach-tag-list" onChange={(e) => set({ tag: e.target.value })} placeholder="timezone" />
      )}
      {row(
        'Within (days)',
        <input className="input" style={{ width: 120 }} type="number" min={1} value={c.withinDays ?? ''} onChange={(e) => set({ withinDays: e.target.value ? Number(e.target.value) : null })} placeholder="any time" />
      )}
      <span className="text-xs muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
        Customer has at least one ticket with this tag (across their whole history).
      </span>
    </div>
  );
}

const OP_LABEL: Record<string, string> = {
  equals: '=',
  not_equals: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is set',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  before: 'before',
  after: 'after',
  is_any_of: 'is any of',
  is_none_of: 'is none of'
};

const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty']);

const CONTACT_FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  email: 'Email',
  email_domain: 'Email domain',
  organization: 'Organization',
  job_title: 'Job title',
  location: 'Location',
  background: 'Background / notes',
  has_email: 'Has an email',
  has_phone: 'Has a phone',
  has_multiple_emails: 'Has multiple emails'
};

/** Human-readable one-line description of a condition (review + saved segment lists). */
export function describeCondition(n: SegmentNode): string {
  if ((n as { kind?: string }).kind === 'group') {
    const g = n as { combinator: string; children: SegmentNode[] };
    return `(${g.children.map(describeCondition).join(g.combinator === 'all' ? ' AND ' : ' OR ')})`;
  }
  const c = n as SegmentCondition;
  switch (c.kind) {
    case 'customer_property':
      return `${c.name} ${OP_LABEL[c.op] ?? c.op} ${c.op === 'is_any_of' || c.op === 'is_none_of' ? (c.values ?? []).join('/') : (c.value ?? '')}${c.op === 'between' ? ` and ${c.value2 ?? ''}` : ''}`;
    case 'contact':
      return `${CONTACT_FIELD_LABEL[c.field] ?? c.field} ${OP_LABEL[c.op] ?? c.op} ${c.value ?? ''}`.trim();
    case 'ticket': {
      const bits: string[] = [];
      if (c.tags?.length) bits.push(`ticket has ${c.tagMode === 'all' ? 'ALL' : c.tagMode === 'none' ? 'NONE' : 'ANY'} of: ${c.tags.join(', ')}`);
      if (c.statuses?.length) bits.push(`status ${c.statuses.join('/')}`);
      if (c.mailboxLocalIds?.length) bits.push('inbox filtered');
      if (c.assigneeLocalIds?.length) bits.push('assignee filtered');
      if (c.createdWithinDays != null) bits.push(`created ≤ ${c.createdWithinDays}d`);
      if (c.modifiedWithinDays != null) bits.push(`modified ≤ ${c.modifiedWithinDays}d`);
      return bits.join(' + ') || 'ticket condition';
    }
    case 'history': {
      const metric: Record<string, string> = { ticket_count: 'total tickets', open_count: 'open tickets', closed_count: 'closed tickets', last_contact_within_days: 'last contact ≤ (days)', first_contact_before_days: 'first contact ≥ (days)' };
      const op = c.op === 'gte' ? '≥' : c.op === 'lte' ? '≤' : '=';
      return `${metric[c.metric] ?? c.metric} ${op} ${c.value}`;
    }
    case 'history_tag':
      return `ever had a ticket tagged "${c.tag}"${c.withinDays != null ? ` within ${c.withinDays} days` : ''}`;
    default:
      return 'condition';
  }
}
