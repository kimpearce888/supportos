import { type ReactNode, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Plus, Trash2, Plug, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../components/common/ui.js';
import { Modal, ConfirmDialog } from '../components/common/overlays.js';
import { useUiStore } from '../state/uiStore.js';
import type { ConnectorKind, ConnectorAuthMode } from '../../shared/workspace.js';

/**
 * Connectors (plan Phase 22): approved local data sources. The HTTP kind is
 * SSRF-guarded server-side (private networks, localhost and cloud metadata
 * endpoints are refused); file kinds live in the connectors/ folder jail.
 * The allowed_ai flag is an EXPLICIT, per-connector decision - the AI sees
 * connector data only where a human turned that on.
 */

interface ConnectorRow {
  id: number;
  name: string;
  kind: ConnectorKind;
  config: Record<string, unknown>;
  auth: Record<string, unknown>;
  refresh_method: 'manual' | 'interval';
  refresh_seconds: number;
  allowed_ai: boolean;
  enabled: boolean;
  schema_json: { name: string; type: string }[] | null;
  last_sync_at: string | null;
  last_sync_status: 'ok' | 'error' | null;
  last_sync_error: string | null;
  last_sync_rows: number | null;
  health: 'never' | 'ok' | 'error';
  row_count: number;
  created_at: string;
  updated_at: string;
}

const KIND_CLASS: Record<string, string> = { local_json: 'ok', csv: '', sqlite: 'warn', http: 'ai' };

export function ConnectorsPage(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [rowQuery, setRowQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<ConnectorRow | null>(null);

  const listQuery = useQuery({ queryKey: ['connectors'], queryFn: () => api.get<{ connectors: ConnectorRow[] }>('/api/connectors') });
  const active = listQuery.data?.connectors.find((c) => c.id === selected) ?? null;

  const rowsQuery = useQuery({
    queryKey: ['connector-rows', selected, rowQuery],
    queryFn: () => api.get<{ rows: { id: number; row_key: string; data: Record<string, unknown>; fetched_at: string }[]; total: number }>(`/api/connectors/${selected}/rows${qs({ q: rowQuery })}`),
    enabled: selected != null
  });

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['connectors'] }); void qc.invalidateQueries({ queryKey: ['connector-rows'] }); };

  const refreshNow = useMutation({
    mutationFn: (id: number) => api.post<{ ok: boolean; message?: string; result?: { rows: number; pruned: number } }>(`/api/connectors/${id}/refresh`),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.ok ? `Refreshed: ${r.result?.rows ?? 0} rows (${r.result?.pruned ?? 0} pruned).` : (r.message ?? 'Refresh failed.') });
      refresh();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const toggleAi = useMutation({
    mutationFn: (input: { id: number; allowedAi: boolean }) => api.patch<{ ok: boolean }>(`/api/connectors/${input.id}`, { allowedAi: input.allowedAi }),
    onSuccess: () => { pushToast({ kind: 'success', message: 'AI visibility updated.' }); refresh(); },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const toggleEnabled = useMutation({
    mutationFn: (input: { id: number; enabled: boolean }) => api.patch<{ ok: boolean }>(`/api/connectors/${input.id}`, { enabled: input.enabled }),
    onSuccess: () => { pushToast({ kind: 'success', message: 'Connector updated.' }); refresh(); },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/connectors/${id}`),
    onSuccess: () => { pushToast({ kind: 'success', message: 'Connector deleted.' }); setConfirmDelete(null); setSelected(null); refresh(); },
    onError: (e: Error) => { pushToast({ kind: 'error', message: e.message }); setConfirmDelete(null); }
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Connectors</h1>
          <p className="page-subtitle">Approved local data sources · HTTP targets are SSRF-guarded (private networks, localhost and metadata endpoints refused) · AI sees only explicitly allowed data</p>
        </div>
        <button className="btn primary" onClick={() => setCreateOpen(true)}><Plus size={12} /> Add connector</button>
      </div>

      {listQuery.isLoading ? <Spinner /> : null}
      {listQuery.error ? <ErrorState message="Could not load connectors" detail={String(listQuery.error)} /> : null}
      {listQuery.data && listQuery.data.connectors.length === 0 ? (
        <EmptyState icon="plug" title="No connectors yet" hint="Connect a local JSON file, a CSV, a SQLite database or an HTTP endpoint. Files live in the connectors/ folder of the project; HTTP targets must be public (SSRF-guarded)." />
      ) : null}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Source</th><th>Health</th><th>Rows</th><th>AI visibility</th><th>Last sync</th><th></th></tr>
          </thead>
          <tbody>
            {(listQuery.data?.connectors ?? []).map((c) => (
              <tr key={c.id} className={`clickable ${selected === c.id ? 'selected' : ''}`} onClick={() => setSelected(selected === c.id ? null : c.id)}>
                <td><strong className="text-sm">{c.name}</strong>{!c.enabled ? <span className="badge warn" style={{ marginLeft: 6 }}>disabled</span> : null}</td>
                <td><span className={`badge ${KIND_CLASS[c.kind] ?? ''}`}>{c.kind.replace('_', ' ')}</span></td>
                <td className="text-xs mono">{sourceLabel(c)}</td>
                <td>
                  <span className={`badge ${c.health === 'ok' ? 'ok' : c.health === 'error' ? 'err' : ''}`}>{c.health}</span>
                  {c.health === 'error' && c.last_sync_error ? <div className="text-xs err" title={c.last_sync_error}>{c.last_sync_error.slice(0, 60)}</div> : null}
                </td>
                <td><span className="badge">{c.row_count}</span></td>
                <td>
                  <button
                    className={`btn small ${c.allowed_ai ? 'primary' : 'ghost'}`}
                    title={c.allowed_ai ? 'AI (Local Copilot) may search this connector' : 'AI may NOT see this data - explicit allow required'}
                    onClick={(e) => { e.stopPropagation(); toggleAi.mutate({ id: c.id, allowedAi: !c.allowed_ai }); }}
                  >
                    {c.allowed_ai ? <><Eye size={11} /> allowed</> : <><EyeOff size={11} /> private</>}
                  </button>
                </td>
                <td className="text-xs">{c.last_sync_at ? <RelativeTime iso={c.last_sync_at} /> : 'never'}{c.refresh_method === 'interval' ? <span className="muted"> · every {Math.round(c.refresh_seconds / 60)}m</span> : ''}</td>
                <td className="flex" style={{ gap: 4 }}>
                  <button className="btn small" title="Refresh now" onClick={(e) => { e.stopPropagation(); refreshNow.mutate(c.id); }} disabled={refreshNow.isPending}><RefreshCw size={11} /></button>
                  <button className="btn small ghost" title={c.enabled ? 'Disable' : 'Enable'} onClick={(e) => { e.stopPropagation(); toggleEnabled.mutate({ id: c.id, enabled: !c.enabled }); }}>{c.enabled ? 'disable' : 'enable'}</button>
                  <button className="btn small ghost" title="Delete" onClick={(e) => { e.stopPropagation(); setConfirmDelete(c); }}><Trash2 size={11} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active ? (
        <div className="card mt-16">
          <div className="flex-between">
            <div>
              <h3 className="card-title" style={{ marginBottom: 0 }}><Plug size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> {active.name} — cached rows</h3>
              <p className="text-xs muted" style={{ marginTop: 2 }}>
                {active.row_count} rows · schema inferred from the source · snapshot semantics: vanished rows are pruned on refresh
              </p>
            </div>
            <form className="searchbar" style={{ marginBottom: 0, width: 260 }} onSubmit={(e) => { e.preventDefault(); void qc.invalidateQueries({ queryKey: ['connector-rows', selected, rowQuery] }); }}>
              <input className="input" placeholder="Filter rows…" value={rowQuery} onChange={(e) => setRowQuery(e.target.value)} aria-label="Filter connector rows" />
              <button className="btn" type="submit"><RefreshCw size={13} /></button>
            </form>
          </div>
          {active.schema_json && active.schema_json.length > 0 ? (
            <p className="text-xs muted">Inferred schema: {active.schema_json.map((s) => `${s.name} (${s.type})`).join(' · ')}</p>
          ) : null}
          {rowsQuery.isLoading ? <Spinner /> : null}
          {rowsQuery.data && rowsQuery.data.rows.length === 0 ? <EmptyState icon="plug" title="No rows cached" hint="Refresh the connector to pull its first snapshot." /> : null}
          {rowsQuery.data && rowsQuery.data.rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>key</th>
                    {schemaColumns(active).map((col) => <th key={col}>{col}</th>)}
                    <th>fetched</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsQuery.data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono text-xs">{r.row_key.slice(0, 24)}</td>
                      {schemaColumns(active).map((col) => (
                        <td key={col} className="text-sm">{r.data[col] != null ? String(r.data[col]).slice(0, 60) : '—'}</td>
                      ))}
                      <td className="text-xs"><RelativeTime iso={r.fetched_at} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {active.auth && active.auth.mode !== 'none' ? (
            <p className="text-xs muted"><ShieldAlert size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Auth material ({String(active.auth.mode)}) is stored locally only and always redacted in API responses.</p>
          ) : null}
        </div>
      ) : null}

      {createOpen ? <ConnectorModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); refresh(); }} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete connector"
          message={`Delete "${confirmDelete.name}" and its cached rows? The source file/endpoint itself is untouched.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => del.mutate(confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  );
}

function sourceLabel(c: ConnectorRow): string {
  if (c.kind === 'http') return String(c.config.url ?? '');
  const file = String(c.config.file ?? '');
  return c.kind === 'sqlite' ? `${file} · ${String(c.config.table ?? '')}` : file;
}

function schemaColumns(c: ConnectorRow): string[] {
  if (c.schema_json && c.schema_json.length > 0) return c.schema_json.slice(0, 6).map((s) => s.name);
  return [];
}

// ---------------------------------------------------------------- Create modal

function ConnectorModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ConnectorKind>('local_json');
  const [file, setFile] = useState('');
  const [url, setUrl] = useState('');
  const [table, setTable] = useState('');
  const [keyColumn, setKeyColumn] = useState('');
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>('none');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [refreshMethod, setRefreshMethod] = useState<'manual' | 'interval'>('manual');
  const [refreshSeconds, setRefreshSeconds] = useState(3600);
  const [allowedAi, setAllowedAi] = useState(false);

  const create = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> =
        kind === 'http' ? { kind, url: url.trim() } : { kind, file: file.trim(), ...(kind === 'sqlite' ? { table: table.trim() } : {}) };
      if (keyColumn.trim()) config.keyColumn = keyColumn.trim();
      const auth: Record<string, unknown> =
        authMode === 'header' ? { mode: 'header', headerName: headerName.trim(), headerValue: headerValue.trim() }
        : authMode === 'bearer' ? { mode: 'bearer', token: bearerToken.trim() }
        : { mode: 'none' };
      return api.post<{ ok: boolean; message?: string; connector?: { id: number } }>('/api/connectors', {
        name, config: config as never, auth: auth as never, refreshMethod, refreshSeconds, allowedAi
      });
    },
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message ?? (r.ok ? 'Connector created.' : 'Failed.') });
      if (r.ok && r.connector) {
        api.post<{ ok: boolean; message?: string }>(`/api/connectors/${r.connector.id}/refresh`).then((rr) => {
          if (rr.ok) pushToast({ kind: 'success', message: 'First refresh completed.' });
        }).catch(() => { /* refresh can fail for manual setup */ });
        onSaved();
      }
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <Modal title="Add connector" onClose={onClose} wide>
      <div className="form-grid">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Product releases" autoFocus />
        <label className="label">Kind</label>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ConnectorKind)}>
          <option value="local_json">local JSON file</option>
          <option value="csv">CSV file</option>
          <option value="sqlite">SQLite database</option>
          <option value="http">HTTP endpoint</option>
        </select>
        {kind !== 'http' ? (
          <>
            <label className="label">File <span className="muted">(inside the connectors/ folder)</span></label>
            <input className="input" value={file} onChange={(e) => setFile(e.target.value)} placeholder="e.g. product-releases.json" />
          </>
        ) : (
          <>
            <label className="label">URL <span className="muted">(public only - SSRF-guarded)</span></label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/releases" />
          </>
        )}
        {kind === 'sqlite' ? (
          <>
            <label className="label">Table</label>
            <input className="input" value={table} onChange={(e) => setTable(e.target.value)} placeholder="releases" />
          </>
        ) : null}
        <label className="label">Key column <span className="muted">(optional - stable row identity)</span></label>
        <input className="input" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} placeholder="e.g. version" />
        <label className="label">Authentication</label>
        <select className="input" value={authMode} onChange={(e) => setAuthMode(e.target.value as ConnectorAuthMode)}>
          <option value="none">none</option>
          <option value="header">header</option>
          <option value="bearer">bearer token</option>
        </select>
        {authMode === 'header' ? (
          <>
            <label className="label">Header name</label>
            <input className="input" value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="X-API-Key" />
            <label className="label">Header value</label>
            <input className="input" type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
          </>
        ) : null}
        {authMode === 'bearer' ? (
          <>
            <label className="label">Bearer token</label>
            <input className="input" type="password" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} />
          </>
        ) : null}
        <label className="label">Refresh</label>
        <div className="flex" style={{ gap: 6 }}>
          <select className="input" value={refreshMethod} onChange={(e) => setRefreshMethod(e.target.value as 'manual' | 'interval')} style={{ width: 140 }}>
            <option value="manual">manual</option>
            <option value="interval">interval</option>
          </select>
          {refreshMethod === 'interval' ? (
            <input className="input" type="number" min={60} max={86400} value={refreshSeconds} onChange={(e) => setRefreshSeconds(Number(e.target.value) || 3600)} style={{ width: 160 }} title="Seconds between automatic refreshes (min 60)" />
          ) : null}
        </div>
        <label className="label">AI visibility</label>
        <label className="flex" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={allowedAi} onChange={(e) => setAllowedAi(e.target.checked)} />
          <span className="text-sm">Allow the Local Copilot to search this connector's data</span>
        </label>
      </div>
      <p className="text-xs muted">
        File connectors read only from the project's connectors/ folder (path-jail). HTTP connectors are refused for localhost, private ranges and cloud metadata endpoints - and DNS-resolved addresses are re-checked before every request. Auth material stays in the local database, redacted in every read.
      </p>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || (kind === 'http' ? !url.trim() : !file.trim()) || create.isPending} onClick={() => create.mutate()}>Add connector</button>
      </div>
    </Modal>
  );
}
