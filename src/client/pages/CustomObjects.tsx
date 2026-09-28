import { type ReactNode, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Trash2, Boxes } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../components/common/ui.js';
import { Modal, ConfirmDialog } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import type { CustomFieldType } from '../../shared/workspace.js';

/**
 * Custom objects (plan Phase 21): a local extensible object model. Types
 * define typed fields; the create/edit form is generated from those field
 * definitions and validated server-side by a dynamic Zod schema. Objects
 * relate to customers/organizations/conversations/issues/incidents/campaigns
 * through link edges. This never replaces core Help Scout entities - it is
 * purely local enrichment.
 */

interface FieldTypeDetail {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  object_count: number;
  fields: { key: string; label: string; fieldType: CustomFieldType; required: boolean; options: string[] | null }[];
}

interface ObjectRow {
  id: number;
  type_id: number;
  title: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ObjectDetail extends ObjectRow {
  type_name: string;
  type_slug: string;
  links: { target_kind: string; target_local_id: number; target_label: string | null; note: string | null; linked_at: string }[];
}

const TARGET_KINDS = ['customer', 'organization', 'conversation', 'known_issue', 'incident', 'campaign'] as const;

export function CustomObjectsPage(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const [typeId, setTypeId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [typeModal, setTypeModal] = useState(false);
  const [objectModal, setObjectModal] = useState<{ type: FieldTypeDetail; existing?: ObjectDetail } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'type' | 'object'; id: number; label: string } | null>(null);

  const typesQuery = useQuery({ queryKey: ['custom-object-types'], queryFn: () => api.get<{ types: FieldTypeDetail[] }>('/api/custom-objects/types') });
  const types = typesQuery.data?.types ?? [];
  const activeType = useMemo(() => types.find((t) => t.id === typeId) ?? null, [types, typeId]);

  const objectsQuery = useQuery({
    queryKey: ['custom-objects', typeId, q],
    queryFn: () => api.get<{ objects: ObjectRow[]; total: number }>(`/api/custom-objects${qs({ typeId: typeId ?? undefined, q })}`)
  });

  const reportQuery = useQuery({ queryKey: ['custom-object-report'], queryFn: () => api.get<{ report: { types: { id: number; name: string; object_count: number; link_counts: Record<string, number> }[]; total_objects: number; total_links: number } }>('/api/custom-objects/report') });

  const del = useMutation({
    mutationFn: (input: { kind: 'type' | 'object'; id: number }) => api.delete<{ ok: boolean; message?: string }>(`/api/custom-objects${input.kind === 'type' ? '/types' : ''}/${input.id}`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Deleted.' : 'Failed.') });
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey: ['custom-object-types'] });
      void qc.invalidateQueries({ queryKey: ['custom-objects'] });
      void qc.invalidateQueries({ queryKey: ['custom-object-report'] });
      if (r.ok) setTypeId(null);
    },
    onError: (e: Error) => { pushToast({ kind: 'error', message: e.message }); setConfirmDelete(null); }
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Custom Objects</h1>
          <p className="page-subtitle">{reportQuery.data?.report.total_objects ?? '…'} local objects · {reportQuery.data?.report.total_links ?? '…'} relationships · purely local, never synced to Help Scout</p>
        </div>
        <div className="flex" style={{ gap: 8 }}>
          <form className="searchbar" style={{ marginBottom: 0, width: 280 }} onSubmit={(e) => e.preventDefault()}>
            <input className="input" placeholder="Search objects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search custom objects" />
            <button className="btn" type="submit"><Search size={13} /></button>
          </form>
          <button className="btn" onClick={() => setTypeModal(true)}><Boxes size={12} /> New type</button>
          {activeType ? <button className="btn primary" onClick={() => setObjectModal({ type: activeType })}><Plus size={12} /> New {activeType.name}</button> : null}
        </div>
      </div>

      <div className="flex wrap mb-16" style={{ gap: 6 }}>
        <button className={`chip ${typeId == null ? 'active' : ''}`} onClick={() => setTypeId(null)}>all types</button>
        {types.map((t) => (
          <button key={t.id} className={`chip ${typeId === t.id ? 'active' : ''}`} onClick={() => setTypeId(t.id)}>
            {t.name} <span className="badge">{t.object_count}</span>
          </button>
        ))}
      </div>

      {typesQuery.error ? <ErrorState message="Could not load object types" detail={String(typesQuery.error)} /> : null}
      {types.length === 0 && !typesQuery.isLoading ? (
        <EmptyState icon="boxes" title="No object types yet" hint="Define a type (e.g. Account, Subscription, Deployment) with typed fields, then create objects and link them to customers, organizations, conversations, issues, incidents or campaigns." />
      ) : null}
      {objectsQuery.isLoading ? <Spinner /> : null}
      {objectsQuery.data && objectsQuery.data.objects.length === 0 ? <EmptyState icon="boxes" title={activeType ? `No ${activeType.name} objects yet` : 'No objects match'} /> : null}

      {objectsQuery.data && objectsQuery.data.objects.length > 0 && activeType ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                {activeType.fields.slice(0, 4).map((f) => <th key={f.key}>{f.label}</th>)}
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {objectsQuery.data.objects.map((o) => (
                <ObjectRowView key={o.id} object={o} type={activeType} onEdit={() => {
                  api.get<{ object: ObjectDetail }>(`/api/custom-objects/${o.id}`).then((r) => setObjectModal({ type: activeType, existing: r.object })).catch((e: Error) => pushToast({ kind: 'error', message: e.message }));
                }} onDelete={() => setConfirmDelete({ kind: 'object', id: o.id, label: o.title })} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {objectsQuery.data && objectsQuery.data.objects.length > 0 && !activeType && types.length > 0 ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Object</th><th>Type</th><th>Properties</th><th>Updated</th></tr></thead>
            <tbody>
              {objectsQuery.data.objects.map((o) => {
                const t = types.find((x) => x.id === o.type_id);
                return (
                  <tr key={o.id}>
                    <td><strong className="text-sm">{o.title}</strong></td>
                    <td><span className="badge">{t?.name ?? o.type_id}</span></td>
                    <td className="text-xs muted">{Object.entries(o.properties).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(' · ')}</td>
                    <td><RelativeTime iso={o.updated_at} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {reportQuery.data && reportQuery.data.report.types.length > 0 ? (
        <div className="card mt-16">
          <h3 className="card-title">Relationships by type</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>Custom objects relate to core entities through link edges; counts are deterministic reads.</p>
          {reportQuery.data.report.types.map((t) => {
            const entries = Object.entries(t.link_counts);
            return (
              <div key={t.id} className="mb-8 flex-between">
                <strong className="text-sm">{t.name} <span className="badge">{t.object_count}</span></strong>
                <span className="text-xs muted">{entries.length > 0 ? entries.map(([kind, n]) => `${kind.replace('_', ' ')}: ${n}`).join(' · ') : 'no links yet'}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {typeModal ? <TypeModal onClose={() => setTypeModal(false)} onSaved={() => { setTypeModal(false); void qc.invalidateQueries({ queryKey: ['custom-object-types'] }); }} /> : null}
      {objectModal ? (
        <ObjectModal
          type={objectModal.type}
          existing={objectModal.existing}
          onClose={() => setObjectModal(null)}
          onSaved={() => { setObjectModal(null); void qc.invalidateQueries({ queryKey: ['custom-objects'] }); void qc.invalidateQueries({ queryKey: ['custom-object-types'] }); void qc.invalidateQueries({ queryKey: ['custom-object-report'] }); }}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.kind}`}
          message={confirmDelete.kind === 'type'
            ? `Delete type "${confirmDelete.label}"? Only possible when it has no objects.`
            : `Delete object "${confirmDelete.label}"? Links are removed with it; nothing outside SupportOS is affected.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => del.mutate({ kind: confirmDelete.kind, id: confirmDelete.id })}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  );
}

function ObjectRowView({ object, type, onEdit, onDelete }: { object: ObjectRow; type: FieldTypeDetail; onEdit: () => void; onDelete: () => void }): ReactNode {
  return (
    <tr>
      <td><strong className="text-sm">{object.title}</strong></td>
      {type.fields.slice(0, 4).map((f) => (
        <td key={f.key} className="text-sm">{formatValue(object.properties[f.key])}</td>
      ))}
      <td><RelativeTime iso={object.updated_at} /></td>
      <td className="flex" style={{ gap: 4 }}>
        <button className="btn small ghost" onClick={onEdit}>edit</button>
        <button className="btn small ghost" onClick={onDelete}><Trash2 size={11} /></button>
      </td>
    </tr>
  );
}

function formatValue(v: unknown): ReactNode {
  if (v == null) return <span className="muted">—</span>;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  return String(v).slice(0, 60);
}

// ---------------------------------------------------------------- Type modal

interface FieldDraft { key: string; label: string; fieldType: CustomFieldType; required: boolean; options: string[] | null }

function TypeModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([{ key: '', label: '', fieldType: 'text', required: false, options: null }]);
  const create = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message?: string }>('/api/custom-objects/types', {
      name, description: description || null,
      fields: fields.filter((f) => f.key && f.label).map((f) => ({ key: f.key, label: f.label, fieldType: f.fieldType, required: f.required, options: f.fieldType === 'select' ? (f.options ?? []) : null }))
    }),
    onSuccess: (r) => { pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Type created.' : 'Failed.') }); if (r.ok) onSaved(); },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const update = (i: number, patch: Partial<FieldDraft>) => setFields((fs) => fs.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  return (
    <Modal title="New object type" onClose={onClose} wide>
      <div className="form-grid">
        <label className="label">Type name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Account, Deployment, Subscription" autoFocus />
        <label className="label">Description <span className="muted">(optional)</span></label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <h4 className="card-title" style={{ marginTop: 14 }}>Fields</h4>
      <p className="text-xs muted">Keys are lowercase snake_case identifiers; values are validated by a schema built from these definitions - user data never becomes SQL.</p>
      {fields.map((f, i) => (
        <div key={i} className="flex wrap" style={{ gap: 6, marginBottom: 6 }}>
          <input className="input" style={{ width: 150 }} placeholder="key (snake_case)" value={f.key} onChange={(e) => update(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          <input className="input" style={{ width: 170 }} placeholder="label" value={f.label} onChange={(e) => update(i, { label: e.target.value })} />
          <select className="input" style={{ width: 130 }} value={f.fieldType} onChange={(e) => update(i, { fieldType: e.target.value as CustomFieldType })}>
            <option value="text">text</option>
            <option value="long_text">long text</option>
            <option value="number">number</option>
            <option value="date">date</option>
            <option value="boolean">boolean</option>
            <option value="select">select</option>
          </select>
          {f.fieldType === 'select' ? <input className="input" style={{ width: 220 }} placeholder="options, comma-separated" value={f.options?.join(', ') ?? ''} onChange={(e) => update(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /> : null}
          <label className="flex" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} /> required
          </label>
          <button className="btn small ghost" onClick={() => setFields((fs) => fs.filter((_, idx) => idx !== i))} title="Remove field">✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => setFields((fs) => [...fs, { key: '', label: '', fieldType: 'text', required: false, options: null }])}><Plus size={11} /> Add field</button>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || fields.filter((f) => f.key && f.label).length === 0 || create.isPending} onClick={() => create.mutate()}>Create type</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Object modal

function ObjectModal({ type, existing, onClose, onSaved }: { type: FieldTypeDetail; existing?: ObjectDetail; onClose: () => void; onSaved: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of type.fields) {
      const v = existing?.properties[f.key];
      out[f.key] = v == null ? '' : f.fieldType === 'boolean' ? (v ? 'true' : 'false') : String(v);
    }
    return out;
  });
  const [links, setLinks] = useState<{ targetKind: string; targetLocalId: string }[]>(() => (existing?.links ?? []).map((l) => ({ targetKind: l.target_kind, targetLocalId: String(l.target_local_id) })));

  const save = useMutation({
    mutationFn: () => {
      const properties: Record<string, unknown> = {};
      for (const f of type.fields) {
        const raw = values[f.key] ?? '';
        if (raw === '') continue;
        if (f.fieldType === 'number') properties[f.key] = Number(raw);
        else if (f.fieldType === 'boolean') properties[f.key] = raw === 'true';
        else properties[f.key] = raw;
      }
      const payload = {
        typeId: type.id,
        title,
        properties,
        links: links.filter((l) => l.targetLocalId.trim() !== '' && Number.isFinite(Number(l.targetLocalId))).map((l) => ({ targetKind: l.targetKind, targetLocalId: Number(l.targetLocalId) }))
      };
      return existing
        ? api.patch<{ ok: boolean; message?: string }>(`/api/custom-objects/${existing.id}`, payload)
        : api.post<{ ok: boolean; message?: string }>('/api/custom-objects', payload);
    },
    onSuccess: (r) => { pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Saved.' : 'Failed.') }); if (r.ok) onSaved(); },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <Modal title={existing ? `Edit ${type.name}` : `New ${type.name}`} onClose={onClose} wide>
      <div className="form-grid">
        <label className="label">Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        {type.fields.map((f) => (
          <div key={f.key} style={{ display: 'contents' }}>
            <label className="label">{f.label}{f.required ? ' *' : ''} <span className="muted">({f.fieldType})</span></label>
            {f.fieldType === 'boolean' ? (
              <select className="input" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                <option value="">—</option>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            ) : f.fieldType === 'select' ? (
              <select className="input" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.fieldType === 'date' ? (
              <input className="input" type="date" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : f.fieldType === 'number' ? (
              <input className="input" type="number" step="any" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : f.fieldType === 'long_text' ? (
              <textarea className="input" rows={3} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <input className="input" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
          </div>
        ))}
      </div>
      <h4 className="card-title" style={{ marginTop: 14 }}>Relationships</h4>
      <p className="text-xs muted">Link to local ids: customer, organization, conversation, known issue, incident or campaign. (Find ids on the respective pages.)</p>
      {links.map((l, i) => (
        <div key={i} className="flex" style={{ gap: 6, marginBottom: 6 }}>
          <select className="input" style={{ width: 160 }} value={l.targetKind} onChange={(e) => setLinks((ls) => ls.map((x, idx) => idx === i ? { ...x, targetKind: e.target.value } : x))}>
            {TARGET_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
          </select>
          <input className="input" style={{ width: 140 }} placeholder="local id" value={l.targetLocalId} onChange={(e) => setLinks((ls) => ls.map((x, idx) => idx === i ? { ...x, targetLocalId: e.target.value } : x))} />
          <button className="btn small ghost" onClick={() => setLinks((ls) => ls.filter((_, idx) => idx !== i))}>✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => setLinks((ls) => [...ls, { targetKind: 'customer', targetLocalId: '' }])}><Plus size={11} /> Add relationship</button>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>{existing ? 'Save' : 'Create'}</button>
      </div>
    </Modal>
  );
}
