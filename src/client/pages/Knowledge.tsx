import { type ReactNode, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FilePlus2, Trash2, RefreshCw, FileText, Clock, CheckCheck, Eye } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime, KV } from '../components/common/ui.js';
import { Modal } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import type { KnowledgeFreshnessRow } from '../../shared/workspace.js';
import { GapsTab } from '../components/knowledge/GapsTab.js';

interface KnowledgeDoc { id: number; source_id: number; title: string; visibility: string; version: number; content_preview: string; chunk_count: number; created_at: string; updated_at: string }

export function KnowledgePage(): ReactNode {
  const [tab, setTab] = useState<'documents' | 'sources' | 'freshness' | 'gaps'>('documents');
  const [importing, setImporting] = useState(false);
  // Deep links: /knowledge?doc=N opens that document's reader (used by search
  // results and the AI evidence chips - previously this link was dead).
  const [searchParams, setSearchParams] = useSearchParams();
  const docParam = searchParams.get('doc');
  const [reading, setReading] = useState<number | null>(docParam != null && Number.isFinite(Number(docParam)) ? Number(docParam) : null);
  useEffect(() => {
    if (docParam != null && Number.isFinite(Number(docParam))) setReading(Number(docParam));
  }, [docParam]);
  const openDoc = (id: number): void => {
    setReading(id);
    const next = new URLSearchParams(searchParams);
    next.set('doc', String(id));
    setSearchParams(next, { replace: true });
  };
  const closeDoc = (): void => {
    setReading(null);
    const next = new URLSearchParams(searchParams);
    next.delete('doc');
    setSearchParams(next, { replace: true });
  };
  const pushToast = useUiStore((s) => s.pushToast);
  // v1.6.0 audit fix: the document list query had no error state - a failed
  // fetch showed neither list nor error.
  const { data, refetch, isFetching, isError, error } = useQuery({ queryKey: ['knowledge-docs'], queryFn: () => api.get<{ documents: KnowledgeDoc[] }>('/api/knowledge/documents') });
  const { data: sources } = useQuery({ queryKey: ['knowledge-sources'], queryFn: () => api.get<{ sources: { id: number; name: string; kind: string; visibility: string; document_count: number }[] }>('/api/knowledge/sources') });
  const { data: importable } = useQuery({ queryKey: ['knowledge-importable'], queryFn: () => api.get<{ dir: string; files: string[] }>('/api/knowledge/importable') });

  const importDocs = useMutation({
    mutationFn: (body: { sourceName: string; visibility: string; documents: { title: string; content: string; format: string }[] }) => api.post<{ ok: boolean; imported: number; message?: string }>('/api/knowledge/import', body),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: `Imported ${r.imported} document(s).` });
      setImporting(false);
      void refetch();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const importFile = useMutation({
    mutationFn: (file: string) => api.post<{ ok: boolean; imported: number; message?: string }>('/api/knowledge/import-file', { path: file, visibility: 'internal_only' }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.ok ? `Imported ${r.imported} document(s) from file.` : (r.message ?? 'Import failed') });
      void refetch();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/knowledge/documents/${id}`),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Document deleted.' });
      void refetch();
    },
    // v1.6.0 audit fix: failed deletes/reindexes were silent no-ops.
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const reindex = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/knowledge/reindex'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title"><BookOpen size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Knowledge</h1>
          <p className="page-subtitle">Local knowledge base - indexed by FTS and (optionally) vector search. Visibility separates customer-safe from internal-only.</p>
        </div>
        <div className="flex">
          <button className="btn" onClick={() => reindex.mutate()} disabled={reindex.isPending}><RefreshCw size={13} /> Reindex</button>
          <button className="btn primary" onClick={() => setImporting(true)}><FilePlus2 size={13} /> Import</button>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'documents' ? 'active' : ''}`} onClick={() => setTab('documents')}>Documents</button>
        <button className={`tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>Sources</button>
        <button className={`tab ${tab === 'freshness' ? 'active' : ''}`} onClick={() => setTab('freshness')}><Clock size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Freshness</button>
        <button className={`tab ${tab === 'gaps' ? 'active' : ''}`} onClick={() => setTab('gaps')}>Gaps</button>
      </div>

      {tab === 'documents' ? (
        <>
          {isFetching && !data ? <Spinner /> : null}
          {isError ? <ErrorState message="Could not load documents." detail={error instanceof Error ? error.message : undefined} /> : null}
          {data && data.documents.length === 0 && !isError ? (
            <EmptyState icon="knowledge" title="No knowledge documents yet" hint="Import Markdown/TXT/CSV/JSON/HTML/PDF/DOCX files or paste content directly. Knowledge feeds AI drafts and search." />
          ) : null}
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Title</th><th>Visibility</th><th>Version</th><th>Chunks</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {(data?.documents ?? []).map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => openDoc(d.id)}>
                    <td><strong>{d.title}</strong><div className="text-xs muted">{d.content_preview.slice(0, 90)}…</div></td>
                    <td><span className={`badge ${d.visibility === 'customer_safe' ? 'ok' : ''}`}>{d.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span></td>
                    <td>v{d.version}</td>
                    <td>{d.chunk_count}</td>
                    <td><RelativeTime iso={d.updated_at} /></td>
                    <td>
                      <button className="btn ghost small" aria-label={`Delete ${d.title}`} onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${d.title}"? This also removes its search-index entries.`)) del.mutate(d.id); }}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {tab === 'freshness' ? <FreshnessTab /> : null}
      {tab === 'gaps' ? <GapsTab /> : null}
      {tab === 'sources' ? (
        <div className="card">
          <h3 className="card-title">Knowledge sources</h3>
          {(sources?.sources ?? []).map((s) => (
            <KV key={s.id} k={s.name} v={<span>{s.document_count} docs · {s.kind} · <span className={`badge ${s.visibility === 'customer_safe' ? 'ok' : ''}`}>{s.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span></span>} />
          ))}
          {(sources?.sources ?? []).length === 0 ? <EmptyState title="No sources yet" /> : null}
        </div>
      ) : null}

      {importing ? (
        <Modal title="Import knowledge" onClose={() => setImporting(false)} wide>
          <ImportForm onSubmit={(body) => importDocs.mutate(body)} />
          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <h4 className="mb-8"><FileText size={13} style={{ display: 'inline', verticalAlign: 'middle' }} /> Import from the knowledge-import folder</h4>
          <p className="text-xs muted" style={{ marginTop: 0 }}>For safety, file imports must live in <span className="mono">{importable?.dir ?? './knowledge-import'}</span>. Supported: MD, TXT, CSV, JSON, HTML, PDF, DOCX.</p>
          {(importable?.files ?? []).map((f) => (
            <div key={f} className="flex-between" style={{ padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
              <span className="mono text-sm">{f}</span>
              <button className="btn small" onClick={() => importFile.mutate(f)} disabled={importFile.isPending}>Import</button>
            </div>
          ))}
          {(importable?.files ?? []).length === 0 ? <span className="muted text-sm">The folder is empty or does not exist. Create it and copy your documents there.</span> : null}
        </Modal>
      ) : null}
      {reading ? <DocReader id={reading} onClose={closeDoc} /> : null}
    </div>
  );
}

function ImportForm({ onSubmit }: { onSubmit: (body: { sourceName: string; visibility: string; documents: { title: string; content: string; format: string }[] }) => void }): ReactNode {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [visibility, setVisibility] = useState('internal_only');
  const [sourceName, setSourceName] = useState('Manual import');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && content.trim()) onSubmit({ sourceName, visibility, documents: [{ title, content, format: 'markdown' }] });
      }}
    >
      <div className="grid-2">
        <div className="form-row"><label className="field" htmlFor="k-title">Title *</label><input id="k-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
        <div className="form-row"><label className="field" htmlFor="k-vis">Visibility</label>
          <select id="k-vis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="internal_only">internal-only (never in customer drafts)</option>
            <option value="customer_safe">customer-safe (may support customer drafts)</option>
          </select>
        </div>
      </div>
      <div className="form-row"><label className="field" htmlFor="k-src">Source name</label><input id="k-src" className="input" value={sourceName} onChange={(e) => setSourceName(e.target.value)} /></div>
      <div className="form-row"><label className="field" htmlFor="k-content">Content (Markdown) *</label><textarea id="k-content" className="input" style={{ minHeight: 180 }} value={content} onChange={(e) => setContent(e.target.value)} required /></div>
      <button className="btn primary" type="submit">Import document</button>
    </form>
  );
}

function DocReader({ id, onClose }: { id: number; onClose: () => void }): ReactNode {
  // v1.6.0 audit fix: a failed/deleted document fetch (or a stale ?doc= deep
  // link) previously left an infinite Spinner; show an error instead. The
  // dialog still closes cleanly when dismissed (Escape/backdrop/X -> onClose).
  const { data, isError, error } = useQuery({ queryKey: ['knowledge-doc', id], queryFn: () => api.get<{ document: KnowledgeDoc & { content: string; source_name: string }; related_ticket_estimate: number; related_known_issues: { id: number; title: string }[] }>(`/api/knowledge/documents/${id}`) });
  return (
    <Modal title={data?.document.title ?? 'Document'} onClose={onClose} wide>
      {isError ? <ErrorState message="Could not open this document." detail={error instanceof Error ? error.message : undefined} /> : !data ? <Spinner /> : (
        <>
          <div className="flex wrap mb-16" style={{ gap: 6 }}>
            <span className={`badge ${data.document.visibility === 'customer_safe' ? 'ok' : ''}`}>{data.document.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span>
            <span className="badge">v{data.document.version}</span>
            <span className="badge">source: {data.document.source_name}</span>
            <span className="badge">{data.document.chunk_count} chunks</span>
          </div>
          <div className="doc-content">{data.document.content}</div>
          <div className="mt-16 text-sm">
            <strong>Related:</strong> cited by AI analysis in {data.related_ticket_estimate} conversation{data.related_ticket_estimate === 1 ? '' : 's'} ·{' '}
            {data.related_known_issues.map((ki) => (
              <span key={ki.id} className="source-chip">{ki.title}</span>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- v2.0.0 Freshness

/**
 * Knowledge freshness (plan Phase 25): lifecycle observability for the local
 * knowledge base. Flags are deterministic associations - stale age, review
 * gaps, title-overlap conflict candidates, low local search usage, articles
 * followed by support tickets (temporal/topic association only) and articles
 * associated with recurring questions. Review/verify are HUMAN actions that
 * stamp timestamps; nothing is published automatically.
 */
function FreshnessTab(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const [flagFilter, setFlagFilter] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['knowledge-freshness'], queryFn: () => api.get<{ documents: KnowledgeFreshnessRow[] }>('/api/knowledge/freshness') });

  const mark = useMutation({
    mutationFn: (input: { id: number; action: 'review' | 'verify' }) => api.post<{ ok: boolean; message: string }>(`/api/knowledge/documents/${input.id}/${input.action}`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void qc.invalidateQueries({ queryKey: ['knowledge-freshness'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorState message="Could not load the freshness report" detail={error instanceof Error ? error.message : undefined} />;
  const docs = data?.documents ?? [];
  const filtered = flagFilter
    ? docs.filter((d) => {
        const f = d.flags as unknown as Record<string, boolean>;
        return f[flagFilter] === true;
      })
    : docs;
  const countWith = (key: string): number => docs.filter((d) => (d.flags as unknown as Record<string, boolean>)[key] === true).length;

  return (
    <>
      <div className="flex wrap mb-16" style={{ gap: 6 }}>
        <button className={`chip ${flagFilter === '' ? 'active' : ''}`} onClick={() => setFlagFilter('')}>all ({docs.length})</button>
        <button className={`chip ${flagFilter === 'stale' ? 'active' : ''}`} onClick={() => setFlagFilter('stale')}>stale ({countWith('stale')})</button>
        <button className={`chip ${flagFilter === 'unreviewed_long' ? 'active' : ''}`} onClick={() => setFlagFilter('unreviewed_long')}>needs review ({countWith('unreviewed_long')})</button>
        <button className={`chip ${flagFilter === 'conflict_candidate' ? 'active' : ''}`} onClick={() => setFlagFilter('conflict_candidate')}>possible conflicts ({countWith('conflict_candidate')})</button>
        <button className={`chip ${flagFilter === 'low_usage' ? 'active' : ''}`} onClick={() => setFlagFilter('low_usage')}>low usage ({countWith('low_usage')})</button>
        <button className={`chip ${flagFilter === 'followed_by_tickets' ? 'active' : ''}`} onClick={() => setFlagFilter('followed_by_tickets')}>followed by tickets ({countWith('followed_by_tickets')})</button>
        <button className={`chip ${flagFilter === 'fails_common_questions' ? 'active' : ''}`} onClick={() => setFlagFilter('fails_common_questions')}>recurring questions ({countWith('fails_common_questions')})</button>
      </div>
      {filtered.length === 0 ? <EmptyState icon="clock" title="Nothing flagged in this view" hint="Flags appear as documents age, go unreviewed, overlap in content, go unused, or keep being followed by support tickets." /> : null}
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Document</th><th>Version</th><th>Updated</th><th>Reviewed</th><th>Verified</th><th>Usage</th><th>Flags</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.document_id}>
                <td><strong className="text-sm">{d.title}</strong><div className="text-xs muted">{d.source_name ?? '—'} · {d.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</div></td>
                <td className="text-sm">v{d.version}</td>
                <td className="text-xs">{d.days_since_update != null ? `${d.days_since_update}d ago` : '—'}</td>
                <td className="text-xs">{d.last_reviewed_at ? `${d.days_since_review ?? '—'}d ago` : <span className="muted">never</span>}</td>
                <td className="text-xs">{d.last_verified_at ? <RelativeTime iso={d.last_verified_at} /> : <span className="muted">never</span>}</td>
                <td className="text-xs">{d.search_hits} search hits</td>
                <td>
                  <div className="flex wrap" style={{ gap: 3 }}>
                    {d.flags.stale ? <span className="badge err">stale</span> : null}
                    {d.flags.unreviewed_long ? <span className="badge warn">needs review</span> : null}
                    {d.flags.conflict_candidate ? <span className="badge warn" title={d.conflict_candidates.map((c) => c.title).join('; ')}>possible conflict</span> : null}
                    {d.flags.low_usage ? <span className="badge">low usage</span> : null}
                    {d.flags.followed_by_tickets ? <span className="badge warn" title="Conversations started within 14 days after the last update match this document's topic - a temporal association">followed by {d.followed_by_ticket_count} tickets</span> : null}
                    {d.flags.fails_common_questions ? <span className="badge warn">recurring questions</span> : null}
                  </div>
                </td>
                <td className="flex" style={{ gap: 4 }}>
                  <button className="btn small" title="Mark reviewed (human action; nothing is published)" onClick={() => mark.mutate({ id: d.document_id, action: 'review' })}><Eye size={11} /> Review</button>
                  <button className="btn small" title="Mark verified (human action; nothing is published)" onClick={() => mark.mutate({ id: d.document_id, action: 'verify' })}><CheckCheck size={11} /> Verify</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.some((d) => d.associated_questions.length > 0) ? (
        <div className="card mt-16">
          <h3 className="card-title">Recurring questions associated with flagged documents</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>Questions that keep coming back (2+ analyzed tickets in 90 days) where knowledge search matches these documents - the question recurring is the signal, not proof the article failed.</p>
          {filtered.filter((d) => d.associated_questions.length > 0).map((d) => (
            <div key={d.document_id} className="mb-8">
              <strong className="text-sm">{d.title}</strong>
              {d.associated_questions.map((q, i) => (
                <div key={i} className="text-xs muted" style={{ padding: '2px 0' }}>
                  <span className="badge">{q.conversation_count} tickets</span> <span className={`badge ${q.coverage === 'ambiguous' ? 'warn' : ''}`}>{q.coverage}</span> {q.question.slice(0, 120)}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <p className="text-xs muted mt-8">Review and verify are human-only timestamps - SupportOS never edits or publishes knowledge automatically. Conflict flags come from title-term overlap and need a human read.</p>
    </>
  );
}
