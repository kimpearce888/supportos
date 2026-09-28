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
  OutreachMeta,
  OrganizationPropertyCondition,
  HistoryIssueCondition,
  IncidentExposureCondition,
  CampaignHistoryCondition,
  SupportHealthCondition,
  CustomObjectLinkCondition,
  CustomerEventCondition,
  TicketCustomFieldTest
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
    history_tag: 'Ever tagged',
    // v2.1.0 (M5, plan Phase 31): advanced condition kinds.
    organization_property: 'Organization data / property',
    history_issue: 'Previous issues',
    incident_exposure: 'Incident exposure',
    campaign_history: 'Campaign history',
    support_health: 'Support health',
    custom_object_link: 'Custom object link',
    customer_event: 'Customer timeline event'
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
            } else if (kind === 'organization_property') {
              onChange({ kind: 'organization_property', field: 'name', op: 'contains', value: '' });
            } else if (kind === 'history_issue') {
              onChange({ kind: 'history_issue', issueKind: 'known_issue', issueLocalId: null, op: 'gte', value: 1 });
            } else if (kind === 'incident_exposure') {
              onChange({ kind: 'incident_exposure', incidentId: null, withinDays: null });
            } else if (kind === 'campaign_history') {
              onChange({ kind: 'campaign_history', relation: 'received', campaignId: null });
            } else if (kind === 'support_health') {
              onChange({ kind: 'support_health', metric: 'avg_rating', op: 'gte', value: 4 });
            } else if (kind === 'custom_object_link') {
              onChange({ kind: 'custom_object_link', typeId: null });
            } else if (kind === 'customer_event') {
              onChange({ kind: 'customer_event', eventKind: 'campaign_reply', withinDays: null });
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
      {node.kind === 'organization_property' ? <OrganizationPropertyEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'history_issue' ? <HistoryIssueEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'incident_exposure' ? <IncidentExposureEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'campaign_history' ? <CampaignHistoryEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'support_health' ? <SupportHealthEditor c={node} onChange={onChange} row={row} /> : null}
      {node.kind === 'custom_object_link' ? <CustomObjectLinkEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
      {node.kind === 'customer_event' ? <CustomerEventEditor c={node} meta={meta} onChange={onChange} row={row} /> : null}
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
        {row(
          'Channel',
          <select className="input" style={{ width: 130 }} value={c.channel ?? ''} onChange={(e) => set({ channel: e.target.value || null })}>
            <option value="">any channel</option>
            {(meta?.channels ?? []).map((ch) => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>
        )}
      </div>
      {(meta?.ticket_custom_fields ?? []).length > 0 ? (
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {(meta?.ticket_custom_fields ?? []).slice(0, 12).map((f) => {
            const active = (c.customFields ?? []).some((cf) => cf.fieldLocalId === f.local_id);
            return (
              <button
                key={f.local_id}
                type="button"
                className="badge"
                style={{ border: '1px solid var(--border)', background: active ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer' }}
                onClick={() => {
                  const list = c.customFields ?? [];
                  if (active) set({ customFields: list.filter((cf) => cf.fieldLocalId !== f.local_id) });
                  else set({ customFields: [...list, { fieldLocalId: f.local_id, op: 'is_not_empty', value: null }] });
                }}
                title={active ? 'Click to remove this custom-field filter' : 'Click to filter on this custom field (same conversation)'}
              >
                field: {f.name}
              </button>
            );
          })}
          {(c.customFields ?? []).map((cf, idx) => {
            const f = (meta?.ticket_custom_fields ?? []).find((x) => x.local_id === cf.fieldLocalId);
            if (!f) return null;
            const update = (patch: Partial<TicketCustomFieldTest>): void => {
              const list: TicketCustomFieldTest[] = [...(c.customFields ?? [])];
              list[idx] = { ...list[idx]!, ...patch };
              set({ customFields: list });
            };
            return (
              <div key={cf.fieldLocalId} className="flex" style={{ gap: 4, alignItems: 'flex-end' }}>
                <select className="input" style={{ width: 110 }} value={cf.op} onChange={(e) => update({ op: e.target.value as 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty' })}>
                  <option value="is_not_empty">is set</option>
                  <option value="is_empty">is empty</option>
                  <option value="equals">=</option>
                  <option value="not_equals">≠</option>
                  <option value="contains">contains</option>
                </select>
                {cf.op !== 'is_empty' && cf.op !== 'is_not_empty' ? (
                  <input className="input" style={{ width: 120 }} value={cf.value ?? ''} onChange={(e) => update({ value: e.target.value })} placeholder={f.type ?? 'value'} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
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
          <option value="waited_over_hours_count">waited over (hours) at least once</option>
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


// ---------------- v2.1.0 (M5, plan Phase 31): advanced condition editors ----------------

function OrganizationPropertyEditor({ c, meta, onChange, row }: { c: OrganizationPropertyCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const orgDefs = meta?.organization_property_definitions ?? [];
  const set = (patch: Partial<OrganizationPropertyCondition>): void => onChange({ ...c, ...patch });
  const usingStandard = c.field === 'name' || c.field === 'domains';
  const ops: PropertyOperator[] = usingStandard ? ['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'] : (meta?.operators_by_type?.text ?? ['equals', 'contains']);
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Field',
        <select className="input" style={{ width: 200 }} value={c.field ?? String(c.definitionId ?? '')} onChange={(e) => {
          const v = e.target.value;
          if (v === 'name' || v === 'domains') set({ field: v, definitionId: null, op: 'contains', value: '' });
          else {
            const def = orgDefs.find((d) => d.id === Number(v));
            set({ field: null, definitionId: def?.id ?? null, name: def?.name ?? null, type: def?.type ?? 'text', op: 'equals', value: '' });
          }
        }}>
          <option value="name">Organization name</option>
          <option value="domains">Organization domains</option>
          {orgDefs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · org property{d.populated === 0 ? ' (no values locally)' : ''}
            </option>
          ))}
        </select>
      )}
      {row(
        'Operator',
        <select className="input" style={{ width: 150 }} value={c.op} onChange={(e) => set({ op: e.target.value as PropertyOperator })}>
          {ops.map((op) => (
            <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>
          ))}
        </select>
      )}
      {!NO_VALUE_OPS.has(c.op) ? row('Value', <input className="input" style={{ width: 180 }} value={c.value ?? ''} onChange={(e) => set({ value: e.target.value })} placeholder={usingStandard && c.field === 'domains' ? 'company.com' : 'value'} />) : null}
    </div>
  );
}

function HistoryIssueEditor({ c, meta, onChange, row }: { c: HistoryIssueCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const issues = (meta?.issues ?? []).filter((i) => (c.issueKind === 'cluster' ? i.kind === 'cluster' : i.kind === 'known_issue'));
  const set = (patch: Partial<HistoryIssueCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Issue kind',
        <select className="input" style={{ width: 150 }} value={c.issueKind} onChange={(e) => set({ issueKind: e.target.value as 'cluster' | 'known_issue', issueLocalId: null })}>
          <option value="known_issue">Known issues</option>
          <option value="cluster">Issue clusters</option>
        </select>
      )}
      {row(
        'Issue',
        <select className="input" style={{ width: 260 }} value={c.issueLocalId ?? ''} onChange={(e) => set({ issueLocalId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">any {c.issueKind === 'cluster' ? 'cluster' : 'known issue'}</option>
          {issues.map((i) => (
            <option key={`${i.kind}-${i.id}`} value={i.id}>{i.label.slice(0, 60)}</option>
          ))}
        </select>
      )}
      {row(
        'Linked conversations',
        <select className="input" style={{ width: 110 }} value={c.op} onChange={(e) => set({ op: e.target.value as 'gte' | 'eq' })}>
          <option value="gte">at least</option>
          <option value="eq">none (complement)</option>
        </select>
      )}
      {c.op === 'gte' ? row('Count', <input className="input" style={{ width: 80 }} type="number" min={1} value={c.value} onChange={(e) => set({ value: Number(e.target.value) })} />) : null}
    </div>
  );
}

function IncidentExposureEditor({ c, meta, onChange, row }: { c: IncidentExposureCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const incidents = meta?.incidents ?? [];
  const set = (patch: Partial<IncidentExposureCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Incident',
        <select className="input" style={{ width: 280 }} value={c.incidentId ?? ''} onChange={(e) => set({ incidentId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">any ACTIVE incident</option>
          {incidents.map((i) => (
            <option key={i.id} value={i.id}>{i.code} · {i.title.slice(0, 50)} ({i.status})</option>
          ))}
        </select>
      )}
      {row('Within (days)', <input className="input" style={{ width: 120 }} type="number" min={1} value={c.withinDays ?? ''} onChange={(e) => set({ withinDays: e.target.value ? Number(e.target.value) : null })} placeholder="any time" />)}
      <span className="text-xs muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
        Customers whose conversations are linked to the incident.
      </span>
    </div>
  );
}

function CampaignHistoryEditor({ c, meta, onChange, row }: { c: CampaignHistoryCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const campaigns = meta?.campaigns ?? [];
  const set = (patch: Partial<CampaignHistoryCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Relation',
        <select className="input" style={{ width: 200 }} value={c.relation} onChange={(e) => set({ relation: e.target.value as 'received' | 'replied' | 'not_received' })}>
          <option value="received">received a campaign</option>
          <option value="replied">replied to a campaign</option>
          <option value="not_received">never received a campaign</option>
        </select>
      )}
      {row(
        'Campaign',
        <select className="input" style={{ width: 240 }} value={c.campaignId ?? ''} onChange={(e) => set({ campaignId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">any campaign</option>
          {campaigns.map((cm) => (
            <option key={cm.id} value={cm.id}>{cm.name} ({cm.status})</option>
          ))}
        </select>
      )}
    </div>
  );
}

const HEALTH_METRIC_LABEL: Record<string, string> = {
  avg_rating: 'average rating (1-5)',
  avg_effort_score: 'average effort score (0-10)',
  first_response_resolution_rate: 'first-response resolution rate (0-1)',
  high_friction_rate: 'high-friction rate (0-1)'
};

function SupportHealthEditor({ c, onChange, row }: { c: SupportHealthCondition; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const set = (patch: Partial<SupportHealthCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Metric',
        <select className="input" style={{ width: 260 }} value={c.metric} onChange={(e) => set({ metric: e.target.value as SupportHealthCondition['metric'] })}>
          {Object.entries(HEALTH_METRIC_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      )}
      {row(
        'Comparison',
        <select className="input" style={{ width: 120 }} value={c.op} onChange={(e) => set({ op: e.target.value as 'gte' | 'lte' })}>
          <option value="gte">is at least</option>
          <option value="lte">is at most</option>
        </select>
      )}
      {row('Value', <input className="input" style={{ width: 110 }} type="number" step="0.1" value={c.value} onChange={(e) => set({ value: Number(e.target.value) })} />)}
      <span className="text-xs muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
        Deterministic aggregates over the local mirror (ratings, effort scores).
      </span>
    </div>
  );
}

function CustomObjectLinkEditor({ c, meta, onChange, row }: { c: CustomObjectLinkCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const types = meta?.custom_object_types ?? [];
  const set = (patch: Partial<CustomObjectLinkCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Object type',
        <select className="input" style={{ width: 260 }} value={c.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">any custom object type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      )}
      <span className="text-xs muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
        Customers linked to at least one object of this type (locally defined records).
      </span>
    </div>
  );
}

function CustomerEventEditor({ c, meta, onChange, row }: { c: CustomerEventCondition; meta: OutreachMeta | undefined; onChange: (n: SegmentCondition) => void; row: RowFn }): ReactNode {
  const kinds = meta?.customer_event_kinds ?? [];
  const set = (patch: Partial<CustomerEventCondition>): void => onChange({ ...c, ...patch });
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {row(
        'Event kind',
        <select className="input" style={{ width: 220 }} value={c.eventKind} onChange={(e) => set({ eventKind: e.target.value as CustomerEventCondition['eventKind'] })}>
          {kinds.map((k) => (
            <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>
          ))}
        </select>
      )}
      {row('Within (days)', <input className="input" style={{ width: 120 }} type="number" min={1} value={c.withinDays ?? ''} onChange={(e) => set({ withinDays: e.target.value ? Number(e.target.value) : null })} placeholder="any time" />)}
      <span className="text-xs muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
        Customer timeline includes at least one event of this kind.
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
      if (c.channel) bits.push(`channel ${c.channel}`);
      if ((c.customFields ?? []).length > 0) bits.push(`${c.customFields!.length} custom field filter(s)`);
      if (c.createdWithinDays != null) bits.push(`created ≤ ${c.createdWithinDays}d`);
      if (c.modifiedWithinDays != null) bits.push(`modified ≤ ${c.modifiedWithinDays}d`);
      return bits.join(' + ') || 'ticket condition';
    }
    case 'history': {
      const metric: Record<string, string> = { ticket_count: 'total tickets', open_count: 'open tickets', closed_count: 'closed tickets', last_contact_within_days: 'last contact ≤ (days)', first_contact_before_days: 'first contact ≥ (days)', waited_over_hours_count: 'waited over (hours)' };
      const op = c.op === 'gte' ? '≥' : c.op === 'lte' ? '≤' : '=';
      return `${metric[c.metric] ?? c.metric} ${op} ${c.value}`;
    }
    case 'history_tag':
      return `ever had a ticket tagged "${c.tag}"${c.withinDays != null ? ` within ${c.withinDays} days` : ''}`;
    case 'organization_property':
      return `organization ${c.field === 'name' ? 'name' : c.field === 'domains' ? 'domains' : (c.name ?? `property #${c.definitionId ?? '?'}`)} ${OP_LABEL[c.op] ?? c.op} ${c.value ?? ''}`.trim();
    case 'history_issue':
      return `${c.issueLocalId != null ? `issue #${c.issueLocalId}` : `any ${c.issueKind === 'cluster' ? 'cluster' : 'known issue'}`} linked conversations ${c.op === 'gte' ? `≥ ${c.value}` : '= none'}`;
    case 'incident_exposure':
      return `exposed to ${c.incidentId != null ? `incident #${c.incidentId}` : 'an active incident'}${c.withinDays != null ? ` within ${c.withinDays}d` : ''}`;
    case 'campaign_history':
      return `${c.relation === 'not_received' ? 'never received' : c.relation} a campaign${c.campaignId != null ? ` (#${c.campaignId})` : ''}`;
    case 'support_health':
      return `support health: ${HEALTH_METRIC_LABEL[c.metric] ?? c.metric} ${c.op === 'gte' ? '≥' : '≤'} ${c.value}`;
    case 'custom_object_link':
      return `linked to a custom object${c.typeId != null ? ` of type #${c.typeId}` : ''}`;
    case 'customer_event':
      return `timeline includes "${c.eventKind.replace(/_/g, ' ')}"${c.withinDays != null ? ` within ${c.withinDays}d` : ''}`;
    default:
      return 'condition';
  }
}
