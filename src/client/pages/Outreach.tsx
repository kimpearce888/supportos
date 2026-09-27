import { type ReactNode, Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Users } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, RelativeTime, TagChips } from '../components/common/ui.js';
import { ConditionEditor, describeCondition } from '../components/outreach/ConditionEditor.js';
import { useUiStore } from '../state/uiStore.js';
import type {
  SegmentDefinition,
  SegmentCondition,
  SegmentPreviewResult,
  SegmentMatchRow,
  OutreachMeta,
  SavedSegment,
  CampaignSummary,
  CampaignDetail,
  CampaignValidation,
  RenderedMessage
} from '../../shared/segmentation.js';

/**
 * Outreach page (v1.5.0): Client Segmentation & Outreach.
 *
 * The four-stage flow mirrors the spec's workflow (#55): build audience ->
 * review recipients (with WHY-selected evidence for every row) -> compose ->
 * explicit final review. Sending is ALWAYS an explicit user action (#58);
 * the deterministic segment engine (never the AI) decides who matches (#42).
 */
type WizardStep = 'audience' | 'recipients' | 'compose' | 'review';

const EMPTY_DEF: SegmentDefinition = { combinator: 'all', conditions: [], exclude: [] };

export function OutreachPage(): ReactNode {
  const [tab, setTab] = useState<'campaigns' | 'new' | 'segments' | 'dnc'>('campaigns');
  const [wizardStep, setWizardStep] = useState<WizardStep>('audience');
  const [definition, setDefinition] = useState<SegmentDefinition>(EMPTY_DEF);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [savedSegmentId, setSavedSegmentId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: '', subject: '', body: '', mailbox_local_id: 0, tags: '' });
  const [createdCampaignId, setCreatedCampaignId] = useState<number | null>(null);
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);

  const { data: meta } = useQuery({ queryKey: ['outreach-meta'], queryFn: () => api.get<OutreachMeta>('/api/outreach/meta') });
  const { data: segments } = useQuery({ queryKey: ['outreach-segments'], queryFn: () => api.get<{ segments: SavedSegment[] }>('/api/outreach/segments') });
  const { data: campaigns } = useQuery({
    queryKey: ['outreach-campaigns'],
    queryFn: () => api.get<{ campaigns: CampaignSummary[] }>('/api/outreach/campaigns'),
    refetchInterval: 15_000
  });

  // Live preview of the current definition (the engine runs server-side)
  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ['outreach-preview', definition],
    queryFn: () => api.post<SegmentPreviewResult & { page: number }>('/api/outreach/segments/preview', { ...definition, page: 1, pageSize: 100 })
  });

  const createCampaign = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; id: number; recipients: number; message: string }>('/api/outreach/campaigns', {
        name: draft.name,
        subject: draft.subject,
        body: draft.body,
        mailbox_local_id: Number(draft.mailbox_local_id),
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        segment_id: savedSegmentId,
        definition,
        customer_ids: selectedIds
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        pushToast({ kind: 'error', message: r.message });
        return;
      }
      setCreatedCampaignId(r.id);
      void qc.invalidateQueries({ queryKey: ['outreach-campaigns'] });
      pushToast({ kind: 'success', message: r.message });
    },
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Campaign creation failed' })
  });

  const goRecipients = (): void => {
    setSelectedIds((preview?.rows ?? []).filter((r) => !r.excluded && r.chosen_email).map((r) => r.customer_local_id));
    setWizardStep('recipients');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Outreach</h1>
          <p className="page-subtitle">Contact-first segments · individual Help Scout conversations · full audit trail</p>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'campaigns' ? 'active' : ''}`} onClick={() => setTab('campaigns')}>
          Campaigns
        </button>
        <button className={`tab ${tab === 'new' ? 'active' : ''}`} onClick={() => setTab('new')}>
          New campaign
        </button>
        <button className={`tab ${tab === 'segments' ? 'active' : ''}`} onClick={() => setTab('segments')}>
          Saved segments
        </button>
        <button className={`tab ${tab === 'dnc' ? 'active' : ''}`} onClick={() => setTab('dnc')}>
          Do Not Contact
        </button>
      </div>

      {tab === 'campaigns' ? <CampaignsPanel campaigns={campaigns?.campaigns} /> : null}
      {tab === 'new' ? (
        <div>
          <div className="flex" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {(['audience', 'recipients', 'compose', 'review'] as WizardStep[]).map((s, i) => (
              <span key={s} className={`badge ${wizardStep === s ? 'active' : ''}`} style={{ padding: '4px 10px' }}>
                {i + 1}. {s === 'audience' ? 'Audience' : s === 'recipients' ? 'Recipients' : s === 'compose' ? 'Compose' : 'Final review'}
              </span>
            ))}
          </div>

          {wizardStep === 'audience' ? (
            <AudienceStep
              meta={meta}
              definition={definition}
              setDefinition={setDefinition}
              preview={preview}
              previewLoading={previewLoading}
              segments={segments?.segments ?? []}
              savedSegmentId={savedSegmentId}
              setSavedSegmentId={setSavedSegmentId}
              onNext={goRecipients}
            />
          ) : null}

          {wizardStep === 'recipients' ? (
            <RecipientsStep
              preview={preview}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              onBack={(): void => setWizardStep('audience')}
              onNext={(): void => setWizardStep('compose')}
            />
          ) : null}

          {wizardStep === 'compose' ? (
            <ComposeStep
              meta={meta}
              draft={draft}
              setDraft={setDraft}
              preview={preview}
              selectedIds={selectedIds}
              onBack={(): void => setWizardStep('recipients')}
              onNext={(): void => setWizardStep('review')}
            />
          ) : null}

          {wizardStep === 'review' ? (
            <ReviewStep
              draft={draft}
              selectedCount={selectedIds.length}
              createdCampaignId={createdCampaignId}
              createCampaign={createCampaign}
              onBack={(): void => setWizardStep('compose')}
              onDone={(): void => {
                setTab('campaigns');
                setWizardStep('audience');
                setDefinition(EMPTY_DEF);
                setDraft({ name: '', subject: '', body: '', mailbox_local_id: 0, tags: '' });
                setCreatedCampaignId(null);
                setSavedSegmentId(null);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {tab === 'segments' ? <SegmentsPanel segments={segments?.segments ?? []} onUse={(s): void => { setDefinition(s.definition); setSavedSegmentId(s.id); setTab('new'); setWizardStep('audience'); }} /> : null}
      {tab === 'dnc' ? <DncPanel /> : null}
    </div>
  );
}

// =================== Step 1: audience ===================

function AudienceStep({
  meta,
  definition,
  setDefinition,
  preview,
  previewLoading,
  segments,
  savedSegmentId,
  setSavedSegmentId,
  onNext
}: {
  meta: OutreachMeta | undefined;
  definition: SegmentDefinition;
  setDefinition: (d: SegmentDefinition) => void;
  preview: (SegmentPreviewResult & { page: number }) | undefined;
  previewLoading: boolean;
  segments: SavedSegment[];
  savedSegmentId: number | null;
  setSavedSegmentId: (id: number | null) => void;
  onNext: () => void;
}): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [saveName, setSaveName] = useState('');
  const setConditions = (conditions: SegmentCondition[]): void => setDefinition({ ...definition, conditions });

  const save = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/outreach/segments', { name: saveName, definition }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setSaveName('');
    }
  });

  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Audience builder</h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          Properties answer “which customers?” · tags answer “which tickets?” · SupportOS resolves tickets to unique contacts.
        </p>
        <div className="flex" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <span className="text-xs muted">Match</span>
          <select className="input" style={{ width: 90 }} value={definition.combinator} onChange={(e) => setDefinition({ ...definition, combinator: e.target.value as 'all' | 'any' })}>
            <option value="all">ALL</option>
            <option value="any">ANY</option>
          </select>
          <span className="text-xs muted">of the conditions below (one row each)</span>
        </div>

        {definition.conditions.map((node, i) => {
          if ((node as { kind?: string }).kind === 'group') return null;
          return (
            <ConditionEditor
              key={i}
              node={node as SegmentCondition}
              meta={meta}
              onChange={(next): void => setConditions(definition.conditions.map((n, j) => (j === i ? next : n)) as SegmentCondition[])}
              onRemove={(): void => setConditions(definition.conditions.filter((_, j) => j !== i) as SegmentCondition[])}
            />
          );
        })}
        <div className="flex" style={{ gap: 8 }}>
          <button
            className="btn small"
            onClick={(): void => {
              const def = meta?.property_definitions[0];
              setConditions([...definition.conditions, { kind: 'customer_property', definitionId: def?.id ?? 0, name: def?.name ?? '', type: (def?.type ?? 'text') as 'text', op: 'equals', value: '' }] as SegmentCondition[]);
            }}
          >
            + Customer property
          </button>
          <button className="btn small" onClick={(): void => setConditions([...definition.conditions, { kind: 'ticket', tags: [], tagMode: 'any' }] as SegmentCondition[])}>
            + Ticket condition
          </button>
          <button className="btn small" onClick={(): void => setConditions([...definition.conditions, { kind: 'contact', field: 'email', op: 'contains', value: '' }] as SegmentCondition[])}>
            + Contact field
          </button>
          <button className="btn small" onClick={(): void => setConditions([...definition.conditions, { kind: 'history', metric: 'ticket_count', op: 'gte', value: 1 }] as SegmentCondition[])}>
            + Support history
          </button>
        </div>

        <h3 className="card-title" style={{ marginTop: 18 }}>
          Exclusions
        </h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          Customers matching ANY exclusion are removed. The Do-Not-Contact list always applies on top.
        </p>
        {definition.exclude.map((node, i) => {
          if ((node as { kind?: string }).kind === 'group') return null;
          return (
            <ConditionEditor
              key={i}
              node={node as SegmentCondition}
              meta={meta}
              onChange={(next): void => setDefinition({ ...definition, exclude: definition.exclude.map((n, j) => (j === i ? next : n)) as SegmentCondition[] })}
              onRemove={(): void => setDefinition({ ...definition, exclude: definition.exclude.filter((_, j) => j !== i) as SegmentCondition[] })}
            />
          );
        })}
        <button className="btn small" onClick={(): void => setDefinition({ ...definition, exclude: [...definition.exclude, { kind: 'ticket', tags: [], tagMode: 'any' }] as SegmentCondition[] })}>
          + Exclusion condition
        </button>

        <div className="flex mt-16" style={{ gap: 8, alignItems: 'center' }}>
          <input className="input" style={{ width: 220 }} placeholder="Save this segment as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <button className="btn small" disabled={!saveName.trim() || save.isPending} onClick={(): void => save.mutate()}>
            Save segment
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Live preview</h3>
        {previewLoading ? <Spinner label="Evaluating segment…" /> : null}
        {preview ? (
          <>
            <div className="flex" style={{ gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span className="badge active" style={{ fontSize: 13 }}>
                {preview.matched} matching customers
              </span>
              {preview.excluded > 0 ? <span className="badge warn">{preview.excluded} excluded</span> : null}
              {preview.without_email > 0 ? <span className="badge warn">{preview.without_email} without email</span> : null}
              {preview.on_dnc > 0 ? <span className="badge err">{preview.on_dnc} on Do-Not-Contact</span> : null}
            </div>
            {preview.notes.map((n, i) => (
              <p key={i} className="text-xs muted" style={{ margin: '2px 0' }}>
                · {n}
              </p>
            ))}
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {preview.rows.slice(0, 20).map((r) => (
                <div key={r.customer_local_id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div className="flex-between">
                    <strong className="text-sm">
                      {r.first_name} {r.last_name}
                    </strong>
                    <span className="text-xs muted">{r.chosen_email ?? 'no email'}</span>
                  </div>
                  <div className="text-xs muted">{r.why.slice(0, 2).map((w) => w.text).join(' · ')}</div>
                </div>
              ))}
              {preview.rows.length > 20 ? <p className="text-xs muted">…and {preview.rows.length - 20} more (full list in the next step)</p> : null}
              {preview.rows.length === 0 ? <EmptyState icon="users" title="No customers match" hint="Loosen a condition or check the honest notes above." /> : null}
            </div>
            <button className="btn mt-16" disabled={preview.matched === 0} onClick={onNext}>
              Review {preview.matched} recipients →
            </button>
          </>
        ) : null}
        <div className="mt-16">
          <p className="text-xs muted" style={{ margin: 0 }}>
            Load a saved segment:
          </p>
          <select
            className="input"
            style={{ width: '100%' }}
            value={savedSegmentId ?? ''}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              setSavedSegmentId(id);
              const s = segments.find((x) => x.id === id);
              if (s) setDefinition(s.definition);
            }}
          >
            <option value="">— none —</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} (v{s.version})
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// =================== Step 2: recipients ===================

function RecipientsStep({
  preview,
  selectedIds,
  setSelectedIds,
  onBack,
  onNext
}: {
  preview: (SegmentPreviewResult & { page: number }) | undefined;
  selectedIds: number[];
  setSelectedIds: (ids: number[]) => void;
  onBack: () => void;
  onNext: () => void;
}): ReactNode {
  const rows = preview?.rows ?? [];
  const allIds = rows.filter((r) => !r.excluded && r.chosen_email).map((r) => r.customer_local_id);
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="flex-between" style={{ padding: '10px 12px' }}>
        <div>
          <h3 className="card-title" style={{ marginBottom: 0 }}>
            Recipient review — {selectedIds.length} selected of {rows.length} matched
          </h3>
          <p className="text-xs muted" style={{ margin: '2px 0 0' }}>
            One email per customer. Every row explains why it matched; clicking a row shows the matching tickets.
          </p>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          <button className="btn ghost small" onClick={(): void => setSelectedIds(allIds)}>
            Select all
          </button>
          <button className="btn ghost small" onClick={(): void => setSelectedIds([])}>
            Clear
          </button>
          <button className="btn ghost small" onClick={(): void => setSelectedIds(allIds.filter((id) => !selectedIds.includes(id)))}>
            Invert
          </button>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 30 }} />
            <th>Customer</th>
            <th>Email</th>
            <th>Properties</th>
            <th>Open</th>
            <th>Why selected</th>
            <th>Matching tickets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.customer_local_id}>
              <tr className="clickable" onClick={(): void => setExpanded(expanded === r.customer_local_id ? null : r.customer_local_id)}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(r.customer_local_id)}
                    disabled={r.excluded || !r.chosen_email}
                    onClick={(e): void => e.stopPropagation()}
                    onChange={(e): void => setSelectedIds(e.target.checked ? [...selectedIds, r.customer_local_id] : selectedIds.filter((id) => id !== r.customer_local_id))}
                  />
                </td>
                <td>
                  <strong className="text-sm">
                    {r.first_name} {r.last_name}
                  </strong>
                  {r.organization ? <div className="text-xs muted">{r.organization}</div> : null}
                </td>
                <td className="text-sm">{r.chosen_email ?? <span className="badge warn">no email</span>}</td>
                <td className="text-xs">{r.properties.map((p) => `${p.name}=${p.value}`).join(' · ') || '—'}</td>
                <td className="text-sm">{r.open_tickets > 0 ? <span className="badge active">{r.open_tickets}</span> : '0'}</td>
                <td className="text-xs">
                  {r.why.slice(0, 2).map((w, i) => (
                    <div key={i}>✓ {w.text}</div>
                  ))}
                  {r.why.length > 2 ? <span className="muted">+{r.why.length - 2} more</span> : null}
                </td>
                <td className="text-sm">
                  {r.matching_tickets.length > 0 ? (
                    <span className="badge">
                      {r.matching_tickets.length} ticket{r.matching_tickets.length > 1 ? 's' : ''}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
              {expanded === r.customer_local_id ? (
                <tr>
                  <td colSpan={7} style={{ background: 'var(--bg-hover)' }}>
                    <div className="text-xs">
                      <strong>Why selected:</strong>
                      {r.why.map((w, i) => (
                        <div key={i}>✓ {w.text}</div>
                      ))}
                    </div>
                    {r.matching_tickets.length > 0 ? (
                      <div className="mt-8">
                        <strong className="text-xs">Matching conversations:</strong>
                        {r.matching_tickets.map((t) => (
                          <div key={t.conversationId} className="flex" style={{ gap: 8, alignItems: 'center', padding: '2px 0' }}>
                            <Link to={`/inbox/conversation/${t.conversationId}`} className="text-xs mono">
                              #{t.number}
                            </Link>
                            <span className="text-xs grow">{t.subject}</span>
                            <TagChips tags={t.tags} />
                            <span className="badge">{t.status}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex" style={{ padding: '10px 12px', gap: 8, justifyContent: 'space-between' }}>
        <button className="btn ghost" onClick={onBack}>
          ← Back to audience
        </button>
        <button className="btn" disabled={selectedIds.length === 0} onClick={onNext}>
          Compose for {selectedIds.length} recipients →
        </button>
      </div>
    </div>
  );
}

// =================== Step 3: compose ===================

function ComposeStep({
  meta,
  draft,
  setDraft,
  preview,
  selectedIds,
  onBack,
  onNext
}: {
  meta: OutreachMeta | undefined;
  draft: { name: string; subject: string; body: string; mailbox_local_id: number; tags: string };
  setDraft: (d: { name: string; subject: string; body: string; mailbox_local_id: number; tags: string }) => void;
  preview: (SegmentPreviewResult & { page: number }) | undefined;
  selectedIds: number[];
  onBack: () => void;
  onNext: () => void;
}): ReactNode {
  const [previewCustomerId, setPreviewCustomerId] = useState<number | null>(null);
  const rows = preview?.rows.filter((r) => selectedIds.includes(r.customer_local_id)) ?? [];
  const { data: rendered } = useQuery({
    queryKey: ['outreach-render', previewCustomerId, draft.subject, draft.body],
    queryFn: () =>
      api.post<{ rendered: RenderedMessage; customer: { first_name: string | null; last_name: string | null; email: string | null }; sources: { number: number; subject: string | null }[] }>('/api/outreach/render', {
        customer_local_id: previewCustomerId,
        subject: draft.subject,
        body: draft.body
      }),
    enabled: previewCustomerId != null && draft.subject.trim() !== '' && draft.body.trim() !== ''
  });

  const insertVariable = (v: string): void => setDraft({ ...draft, body: `${draft.body}{{${v}}}` });

  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Campaign message</h3>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Campaign name</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Timezone issue update" />
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">From mailbox</span>
          <select className="input" value={draft.mailbox_local_id || ''} onChange={(e) => setDraft({ ...draft, mailbox_local_id: Number(e.target.value) })}>
            <option value="">choose a mailbox…</option>
            {(meta?.mailboxes ?? []).map((m) => (
              <option key={m.local_id} value={m.local_id}>
                {m.name}
                {m.email ? ` (${m.email})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Subject</span>
          <input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Update on the timezone issue you reported" />
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Message (HTML or plain text)</span>
          <textarea className="input" rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder={'Hi {{first_name}},\n\nWe wanted to share an update…'} />
        </label>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="text-xs muted" style={{ alignSelf: 'center' }}>
            Personalization:
          </span>
          {(meta?.personalization_variables ?? ['first_name']).map((v) => (
            <button key={v} type="button" className="badge" style={{ cursor: 'pointer', border: '1px solid var(--border)' }} onClick={(): void => insertVariable(v)}>
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Tags on created conversations (comma separated)</span>
          <input className="input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="outreach, timezone" />
        </label>
        <div className="flex" style={{ gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button className="btn ghost" onClick={onBack}>
            ← Back to recipients
          </button>
          <button className="btn" disabled={!draft.name.trim() || !draft.subject.trim() || !draft.body.trim() || !draft.mailbox_local_id} onClick={onNext}>
            Final review →
          </button>
        </div>
      </div>
      <div className="card">
        <h3 className="card-title">Preview personalized message</h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          Rendering uses the same code path as the send. Nothing is personalized silently - inspect it here first.
        </p>
        <select className="input" value={previewCustomerId ?? ''} onChange={(e) => setPreviewCustomerId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">choose a recipient…</option>
          {rows.slice(0, 50).map((r) => (
            <option key={r.customer_local_id} value={r.customer_local_id}>
              {r.first_name} {r.last_name}
            </option>
          ))}
        </select>
        {rendered ? (
          <div className="mt-16">
            <div className="flex-between">
              <strong className="text-sm">Subject</strong>
              {rendered.rendered.unresolved.length > 0 ? <span className="badge warn">unresolved: {rendered.rendered.unresolved.join(', ')}</span> : null}
            </div>
            <div className="text-sm" style={{ padding: '6px 0' }}>
              {rendered.rendered.subject}
            </div>
            <strong className="text-sm">Body</strong>
            <pre className="text-sm" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-hover)', padding: 8, borderRadius: 6 }}>
              {rendered.rendered.body}
            </pre>
            {rendered.sources.length > 0 ? (
              <p className="text-xs muted">
                Sources used for personalization: {rendered.sources.map((s) => `#${s.number}`).join(', ')}
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyState icon="search" title="Pick a recipient" hint="The rendered message appears here before you send anything." />
        )}
      </div>
    </div>
  );
}

// =================== Step 4: review ===================

function ReviewStep({
  draft,
  selectedCount,
  createdCampaignId,
  createCampaign,
  onBack,
  onDone
}: {
  draft: { name: string; subject: string; body: string; mailbox_local_id: number; tags: string };
  selectedCount: number;
  createdCampaignId: number | null;
  createCampaign: { mutate: () => void; isPending: boolean };
  onBack: () => void;
  onDone: () => void;
}): ReactNode {
  const { data: validation } = useQuery({
    queryKey: ['outreach-validate', createdCampaignId],
    queryFn: () => api.get<CampaignValidation>(`/api/outreach/campaigns/${createdCampaignId}/validate`),
    enabled: createdCampaignId != null
  });
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);

  const queueCampaign = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>(`/api/outreach/campaigns/${createdCampaignId}/queue`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      if (r.ok) {
        void qc.invalidateQueries({ queryKey: ['outreach-campaigns'] });
        onDone();
      }
    }
  });

  if (createdCampaignId == null) {
    return (
      <div className="card">
        <h3 className="card-title">Final review</h3>
        <div className="mb-8">
          <KV2 k="Campaign" v={draft.name} />
          <KV2 k="Subject" v={draft.subject} />
          <KV2 k="Mailbox" v={String(draft.mailbox_local_id)} />
          <KV2 k="Tags" v={draft.tags || '—'} />
          <KV2 k="Recipients (selected)" v={String(selectedCount)} />
        </div>
        <p className="text-xs muted">
          Sending is explicit: creating the campaign snapshots its recipients (audience changes later will NOT alter it), then you queue it on the next screen. Each selected customer receives their own Help Scout conversation - never a shared BCC email.
        </p>
        <div className="flex" style={{ gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button className="btn ghost" onClick={onBack}>
            ← Back to compose
          </button>
          <button className="btn" disabled={createCampaign.isPending} onClick={(): void => createCampaign.mutate()}>
            Create campaign ({selectedCount} recipients)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="card-title">Campaign created — final check before sending</h3>
      {validation ? (
        <>
          <div className="flex" style={{ gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="badge active">recipients: {validation.counts.recipients}</span>
            <span className="badge ok">ready: {validation.counts.ready}</span>
            {validation.counts.invalid_email > 0 ? <span className="badge err">invalid email: {validation.counts.invalid_email}</span> : null}
            {validation.counts.on_dnc > 0 ? <span className="badge warn">do-not-contact: {validation.counts.on_dnc}</span> : null}
            {validation.counts.no_email > 0 ? <span className="badge warn">no email: {validation.counts.no_email}</span> : null}
          </div>
          {validation.errors.map((e, i) => (
            <p key={i} className="text-sm" style={{ color: 'var(--danger)' }}>
              ✗ {e}
            </p>
          ))}
          {validation.warnings.map((w, i) => (
            <p key={i} className="text-sm" style={{ color: 'var(--warning)' }}>
              ⚠ {w}
            </p>
          ))}
        </>
      ) : (
        <Spinner label="Validating…" />
      )}
      <div className="flex" style={{ gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
        <button className="btn ghost" onClick={onDone}>
          Done for now (campaign stays in drafts)
        </button>
        <button className="btn danger" disabled={!validation?.ok || queueCampaign.isPending} onClick={(): void => queueCampaign.mutate()}>
          Send to {validation?.counts.ready ?? 0} clients
        </button>
      </div>
    </div>
  );
}

function KV2({ k, v }: { k: string; v: string }): ReactNode {
  return (
    <div className="flex" style={{ gap: 8 }}>
      <span className="text-xs muted" style={{ width: 160 }}>
        {k}
      </span>
      <span className="text-sm">{v}</span>
    </div>
  );
}

// =================== Campaigns monitor ===================

function CampaignsPanel({ campaigns }: { campaigns: CampaignSummary[] | undefined }): ReactNode {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [openId, setOpenId] = useState<number | null>(null);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api.post<{ ok: boolean; message: string }>(`/api/outreach/campaigns/${id}/${action}`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void qc.invalidateQueries({ queryKey: ['outreach-campaigns'] });
      void qc.invalidateQueries({ queryKey: ['outreach-campaign'] });
    }
  });

  const { data: detail } = useQuery({
    queryKey: ['outreach-campaign', openId],
    queryFn: () => api.get<{ campaign: CampaignDetail; events: { id: number; event: string; detail: string | null; at: string }[] }>(`/api/outreach/campaigns/${openId}`),
    enabled: openId != null,
    refetchInterval: 10_000
  });

  const { data: report } = useQuery({
    queryKey: ['outreach-report', openId],
    queryFn: () =>
      api.get<{
        campaign: { id: number; name: string; status: string } | null;
        totals: { recipients: number; sent: number; failed: number; skipped: number; cancelled: number; unknown: number; replied: number; reply_rate: number | null };
        replies: { customer: string; conversation_number: number | null; conversation_local_id: number | null; replied_at: string | null }[];
        note: string;
      }>(`/api/outreach/campaigns/${openId}/report`),
    enabled: openId != null,
    refetchInterval: 30_000
  });

  if (campaigns == null) return <Spinner />;
  if (campaigns.length === 0)
    return (
      <EmptyState
        icon="megaphone"
        title="No campaigns yet"
        hint="Build an audience from your local mirror, review why each customer matched, and send each of them an individual Help Scout conversation."
        action={
          <span />
        }
      />
    );

  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Sent</th>
              <th>Failed</th>
              <th>Replied</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="clickable" onClick={(): void => setOpenId(openId === c.id ? null : c.id)}>
                <td>
                  <strong className="text-sm">{c.name}</strong>
                  <div className="text-xs muted">{c.subject}</div>
                </td>
                <td>
                  <StatusPill status={c.status} />
                </td>
                <td className="text-sm">{c.recipients}</td>
                <td className="text-sm">
                  {c.sent > 0 ? <span className="badge ok">{c.sent}</span> : '0'}
                </td>
                <td className="text-sm">{c.failed > 0 ? <span className="badge err">{c.failed}</span> : '0'}</td>
                <td className="text-sm">{c.replied}</td>
                <td className="text-xs muted">
                  <RelativeTime iso={c.created_at} />
                </td>
                <td onClick={(e): void => e.stopPropagation()}>
                  <div className="flex" style={{ gap: 4 }}>
                    {(c.status === 'draft' || c.status === 'paused') && <button className="btn small" onClick={(): void => act.mutate({ id: c.id, action: 'queue' })}>Queue</button>}
                    {(c.status === 'queued' || c.status === 'sending') && <button className="btn ghost small" onClick={(): void => act.mutate({ id: c.id, action: 'pause' })}>Pause</button>}
                    {c.status === 'paused' && <button className="btn small" onClick={(): void => act.mutate({ id: c.id, action: 'resume' })}>Resume</button>}
                    {(c.status === 'queued' || c.status === 'sending' || c.status === 'paused') && <button className="btn ghost small" onClick={(): void => act.mutate({ id: c.id, action: 'cancel' })}>Cancel rest</button>}
                    {c.failed > 0 && <button className="btn ghost small" onClick={(): void => act.mutate({ id: c.id, action: 'retry' })}>Retry failed</button>}
                    {c.unknown > 0 && <button className="btn ghost small" onClick={(): void => act.mutate({ id: c.id, action: 'reconcile' })}>Reconcile</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId != null && detail ? (
        <div className="card mt-16">
          <div className="flex-between">
            <h3 className="card-title" style={{ marginBottom: 0 }}>
              {detail.campaign.name} — recipient monitor
            </h3>
            <button className="btn ghost small" onClick={(): void => setOpenId(null)}>
              Close
            </button>
          </div>
          {report ? (
            <div className="flex mt-8" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="badge">recipients {report.totals.recipients}</span>
              <span className="badge ok">sent {report.totals.sent}</span>
              <span className="badge err">failed {report.totals.failed}</span>
              <span className="badge warn">skipped {report.totals.skipped}</span>
              <span className="badge warn">cancelled {report.totals.cancelled}</span>
              <span className="badge warn">unknown {report.totals.unknown}</span>
              <span className="badge active">replied {report.totals.replied}{report.totals.reply_rate != null ? ` (${Math.round(report.totals.reply_rate * 100)}%)` : ''}</span>
            </div>
          ) : null}
          <table className="table mt-8">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Email</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Conversation</th>
                <th>Sent</th>
                <th>Replied</th>
                <th>Why selected</th>
              </tr>
            </thead>
            <tbody>
              {detail.campaign.recipients_list.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm">
                    {r.first_name} {r.last_name}
                  </td>
                  <td className="text-xs">{r.email ?? '—'}</td>
                  <td>
                    <RecipientStatePill state={r.state} />
                    {r.last_error ? <div className="text-xs" style={{ color: 'var(--danger)' }}>{r.last_error.slice(0, 140)}</div> : null}
                  </td>
                  <td className="text-sm">{r.attempts}</td>
                  <td className="text-sm">{r.conversation_local_id ? <Link to={`/inbox/conversation/${r.conversation_local_id}`}>#{r.hs_conversation_number}</Link> : r.hs_conversation_number ? `#${r.hs_conversation_number}` : '—'}</td>
                  <td className="text-xs muted">
                    <RelativeTime iso={r.sent_at} />
                  </td>
                  <td className="text-xs muted">
                    <RelativeTime iso={r.replied_at} />
                  </td>
                  <td className="text-xs">
                    {r.why.slice(0, 2).map((w, i) => (
                      <div key={i}>✓ {w.text}</div>
                    ))}
                    {r.matching_tickets.slice(0, 2).map((t) => (
                      <Link key={t.conversationId} to={`/inbox/conversation/${t.conversationId}`} className="text-xs mono">
                        #{t.number}
                      </Link>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report && report.replies.length > 0 ? (
            <div className="mt-16">
              <h4 className="card-title">Reply intelligence</h4>
              {report.replies.map((r, i) => (
                <div key={i} className="flex" style={{ gap: 8, padding: '3px 0' }}>
                  <strong className="text-sm">{r.customer}</strong>
                  {r.conversation_local_id ? (
                    <Link to={`/inbox/conversation/${r.conversation_local_id}`} className="text-xs mono">
                      #{r.conversation_number}
                    </Link>
                  ) : null}
                  <RelativeTime iso={r.replied_at} prefix="replied" />
                </div>
              ))}
              <p className="text-xs muted">{report.note}</p>
            </div>
          ) : null}
          <div className="mt-16">
            <h4 className="card-title">Audit events</h4>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {detail.events.map((e) => (
                <div key={e.id} className="flex" style={{ gap: 8 }}>
                  <span className="text-xs mono muted">{e.at}</span>
                  <span className="text-xs">{e.event}</span>
                  <span className="text-xs muted">{e.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatusPill({ status }: { status: string }): ReactNode {
  const cls: Record<string, string> = { draft: '', queued: 'warn', sending: 'active', paused: 'warn', completed: 'ok', cancelled: '' };
  return <span className={`badge ${cls[status] ?? ''}`}>{status}</span>;
}

function RecipientStatePill({ state }: { state: string }): ReactNode {
  const cls: Record<string, string> = { selected: '', queued: 'warn', sending: 'active', sent: 'ok', failed: 'err', skipped: 'warn', cancelled: '', unknown: 'warn' };
  return <span className={`badge ${cls[state] ?? ''}`}>{state}</span>;
}

// =================== Saved segments ===================

function SegmentsPanel({ segments, onUse }: { segments: SavedSegment[]; onUse: (s: SavedSegment) => void }): ReactNode {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const del = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean; message: string }>(`/api/outreach/segments/${id}`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void qc.invalidateQueries({ queryKey: ['outreach-segments'] });
    }
  });
  if (segments.length === 0) return <EmptyState icon="search" title="No saved segments" hint="Save an audience rule from the New campaign builder to reuse it later." />;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Segment</th>
            <th>Rules</th>
            <th>Version</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => (
            <tr key={s.id}>
              <td>
                <strong className="text-sm">{s.name}</strong>
                {s.description ? <div className="text-xs muted">{s.description}</div> : null}
              </td>
              <td className="text-xs">
                <div>
                  {s.definition.combinator === 'all' ? 'ALL' : 'ANY'} of {s.definition.conditions.length} condition{s.definition.conditions.length === 1 ? '' : 's'}
                </div>
                {s.definition.conditions.slice(0, 3).map((c, i) => (
                  <div key={i} className="muted">
                    · {describeCondition(c)}
                  </div>
                ))}
                {s.definition.exclude.length > 0 ? <div className="muted">excluding {s.definition.exclude.length} rule(s)</div> : null}
              </td>
              <td className="text-sm">v{s.version}</td>
              <td className="text-xs muted">
                <RelativeTime iso={s.updated_at} />
              </td>
              <td>
                <div className="flex" style={{ gap: 4 }}>
                  <button className="btn small" onClick={(): void => onUse(s)}>
                    Use
                  </button>
                  <button className="btn ghost small" onClick={(): void => del.mutate(s.id)}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =================== Do Not Contact ===================

function DncPanel(): ReactNode {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const { data } = useQuery({
    queryKey: ['outreach-dnc'],
    queryFn: () => api.get<{ dnc: { customer_local_id: number; first_name: string | null; last_name: string | null; reason: string | null; created_at: string }[] }>('/api/outreach/dnc')
  });
  const { data: preview } = useQuery({
    queryKey: ['outreach-preview-dnc', { combinator: 'all', conditions: [], exclude: [] }],
    queryFn: () => api.post<SegmentPreviewResult>('/api/outreach/segments/preview', { combinator: 'all', conditions: [], exclude: [], page: 1, pageSize: 200 })
  });
  const add = useMutation({
    mutationFn: (customer_local_id: number) => api.post<{ ok: boolean; message: string }>('/api/outreach/dnc', { customer_local_id }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void qc.invalidateQueries({ queryKey: ['outreach-dnc'] });
    }
  });
  const remove = useMutation({
    mutationFn: (customer_local_id: number) => api.delete<{ ok: boolean; message: string }>(`/api/outreach/dnc/${customer_local_id}`),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: r.message });
      void qc.invalidateQueries({ queryKey: ['outreach-dnc'] });
    }
  });
  const onDnc = new Set((data?.dnc ?? []).map((d) => d.customer_local_id));
  const candidates = (preview?.rows ?? []).filter((r: SegmentMatchRow) => !onDnc.has(r.customer_local_id)).slice(0, 100);
  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">
          <Shield size={13} style={{ verticalAlign: -2 }} /> Do-Not-Contact list
        </h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          Every campaign skips these customers - always, before any other check.
        </p>
        {(data?.dnc ?? []).length === 0 ? <EmptyState icon="shield" title="Nobody on the list" /> : null}
        {(data?.dnc ?? []).map((d) => (
          <div key={d.customer_local_id} className="flex-between" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <strong className="text-sm">
                {d.first_name} {d.last_name}
              </strong>
              {d.reason ? <div className="text-xs muted">{d.reason}</div> : null}
            </div>
            <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
              <RelativeTime iso={d.created_at} />
              <button className="btn ghost small" onClick={(): void => remove.mutate(d.customer_local_id)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h3 className="card-title">
          <Users size={13} style={{ verticalAlign: -2 }} /> Add a customer
        </h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          From your local mirror:
        </p>
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {candidates.map((r) => (
            <div key={r.customer_local_id} className="flex-between" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong className="text-sm">
                  {r.first_name} {r.last_name}
                </strong>
                <div className="text-xs muted">{r.chosen_email}</div>
              </div>
              <button className="btn ghost small" onClick={(): void => add.mutate(r.customer_local_id)}>
                Add
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
