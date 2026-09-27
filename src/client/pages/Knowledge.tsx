import { type ReactNode, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { BookOpen, FilePlus2, Trash2, RefreshCw, FileText } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, RelativeTime, KV } from '../components/common/ui.js';
import { Modal } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';

interface KnowledgeDoc { id: number; source_id: number; title: string; visibility: string; version: number; content_preview: string; chunk_count: number; created_at: string; updated_at: string }

export function KnowledgePage(): ReactNode {
  const [tab, setTab] = useState<'documents' | 'sources'>('documents');
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState<number | null>(null);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data, refetch, isFetching } = useQuery({ queryKey: ['knowledge-docs'], queryFn: () => api.get<{ documents: KnowledgeDoc[] }>('/api/knowledge/documents') });
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
    }
  });

  const reindex = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/knowledge/reindex'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
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
      </div>

      {tab === 'documents' ? (
        <>
          {isFetching && !data ? <Spinner /> : null}
          {data && data.documents.length === 0 ? (
            <EmptyState icon="knowledge" title="No knowledge documents yet" hint="Import Markdown/TXT/CSV/JSON/HTML/PDF/DOCX files or paste content directly. Knowledge feeds AI drafts and search." />
          ) : null}
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Title</th><th>Visibility</th><th>Version</th><th>Chunks</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {(data?.documents ?? []).map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => setReading(d.id)}>
                    <td><strong>{d.title}</strong><div className="text-xs muted">{d.content_preview.slice(0, 90)}…</div></td>
                    <td><span className={`badge ${d.visibility === 'customer_safe' ? 'ok' : ''}`}>{d.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span></td>
                    <td>v{d.version}</td>
                    <td>{d.chunk_count}</td>
                    <td><RelativeTime iso={d.updated_at} /></td>
                    <td>
                      <button className="btn ghost small" aria-label={`Delete ${d.title}`} onClick={(e) => { e.stopPropagation(); del.mutate(d.id); }}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="card">
          <h3 className="card-title">Knowledge sources</h3>
          {(sources?.sources ?? []).map((s) => (
            <KV key={s.id} k={s.name} v={<span>{s.document_count} docs · {s.kind} · <span className={`badge ${s.visibility === 'customer_safe' ? 'ok' : ''}`}>{s.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span></span>} />
          ))}
          {(sources?.sources ?? []).length === 0 ? <EmptyState title="No sources yet" /> : null}
        </div>
      )}

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
      {reading ? <DocReader id={reading} onClose={() => setReading(null)} /> : null}
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
  const { data } = useQuery({ queryKey: ['knowledge-doc', id], queryFn: () => api.get<{ document: KnowledgeDoc & { content: string; source_name: string }; related_ticket_estimate: number; related_known_issues: { id: number; title: string }[] }>(`/api/knowledge/documents/${id}`) });
  return (
    <Modal title={data?.document.title ?? 'Document'} onClose={onClose} wide>
      {!data ? <Spinner /> : (
        <>
          <div className="flex wrap mb-16" style={{ gap: 6 }}>
            <span className={`badge ${data.document.visibility === 'customer_safe' ? 'ok' : ''}`}>{data.document.visibility === 'customer_safe' ? 'customer-safe' : 'internal-only'}</span>
            <span className="badge">v{data.document.version}</span>
            <span className="badge">source: {data.document.source_name}</span>
            <span className="badge">{data.document.chunk_count} chunks</span>
          </div>
          <div className="doc-content">{data.document.content}</div>
          <div className="mt-16 text-sm">
            <strong>Related:</strong> ~{data.related_ticket_estimate} matching searches ·{' '}
            {data.related_known_issues.map((ki) => (
              <span key={ki.id} className="source-chip">{ki.title}</span>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
