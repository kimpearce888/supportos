import { type ReactNode, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Spinner, ErrorState, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import type { AppSettings } from '../../shared/types.js';

export function SettingsPage(): ReactNode {
  const [tab, setTab] = useState<'general' | 'helpscout' | 'lmstudio' | 'qdrant' | 'backups' | 'capability'>('general');
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: settings, error: settingsError, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/api/settings') });
  const { data: oauth } = useQuery({ queryKey: ['oauth-status'], queryFn: () => api.get<{ configured: boolean; authenticated: boolean; demo_mode: boolean; expires_at: string | null; me: { name: string; email: string | null } | null }>('/api/oauth/status') });
  const { data: lm } = useQuery({ queryKey: ['lm-settings'], queryFn: () => api.get<{ base_url: string; chat_model: string | null; embedding_model: string | null; timeout_ms: number; concurrency: number }>('/api/settings/lmstudio') });
  const { data: qdrant } = useQuery({ queryKey: ['qdrant-settings'], queryFn: () => api.get<{ url: string; enabled: boolean }>('/api/settings/qdrant') });
  const { data: backups, refetch: refetchBackups } = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ backups: { file: string; size_bytes: number; created_at: string; verified: boolean }[] }>('/api/backups') });
  const { data: capabilities } = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<{ matrix: { resource: string; operation: string; endpoint: string; api_version: string; read_write: string; implemented: boolean; tested: boolean; notes: string }[]; summary: { implemented: number; total: number; tested: number } }>('/api/system/capabilities') });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<{ ok: boolean; message: string }>('/api/settings', patch),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void refetch();
    },
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Settings could not be saved.' })
  });

  if (settingsError) return <div className="page"><ErrorState message="Could not load settings" detail={settingsError instanceof Error ? settingsError.message : 'The request failed. Retry or check the logs.'} /></div>;
  if (!settings) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Secrets are never displayed after storage. Safe defaults: automatic reply sending OFF, automation writes OFF.</p>
        </div>
      </div>
      <div className="tabs">
        {['general', 'helpscout', 'lmstudio', 'qdrant', 'backups', 'capability'].map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t as typeof tab)}>
            {t === 'general' ? 'Synchronization & AI' : t === 'capability' ? 'Capability matrix' : t === 'helpscout' ? 'Help Scout' : t === 'lmstudio' ? 'LM Studio' : t === 'qdrant' ? 'Qdrant' : 'Backups & export'}
          </button>
        ))}
      </div>

      {tab === 'general' ? <GeneralSettings settings={settings} onSave={(patch) => save.mutate(patch)} /> : null}
      {tab === 'helpscout' ? <HelpScoutSettings oauth={oauth} pushToast={pushToast} /> : null}
      {tab === 'lmstudio' ? <LmStudioSettings lm={lm} pushToast={pushToast} /> : null}
      {tab === 'qdrant' ? <QdrantSettings qdrant={qdrant} pushToast={pushToast} /> : null}
      {tab === 'backups' ? <BackupsSettings backups={backups?.backups ?? []} refetch={refetchBackups} pushToast={pushToast} /> : null}
      {tab === 'capability' ? (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 14px' }}>
            <strong>API capability matrix</strong>
            <p className="text-xs muted" style={{ margin: '4px 0 0' }}>
              {capabilities?.summary.implemented ?? 0}/{capabilities?.summary.total ?? 0} operations implemented ({capabilities?.summary.tested ?? 0} covered by automated tests). Verified against current official docs; limitations noted per row. Unsupported features are never faked.
            </p>
          </div>
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Resource</th><th>Operation</th><th>Endpoint</th><th>v</th><th>R/W</th><th>Implemented</th><th>Notes</th></tr></thead>
              <tbody>
                {(capabilities?.matrix ?? []).map((c, i) => (
                  <tr key={i}>
                    <td>{c.resource}</td>
                    <td className="text-sm">{c.operation}</td>
                    <td className="mono text-xs">{c.endpoint}</td>
                    <td><span className="badge">{c.api_version}</span></td>
                    <td className="text-xs">{c.read_write}</td>
                    <td>{c.implemented ? <span className="badge ok">yes{c.tested ? ' · tested' : ''}</span> : <span className="badge err">no</span>}</td>
                    <td className="text-xs muted">{c.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }): ReactNode {
  return (
    <div className="flex-between" style={{ padding: '7px 0', borderBottom: '1px dashed var(--border)' }}>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {hint ? <div className="text-xs muted">{hint}</div> : null}
      </div>
      <label style={{ flexShrink: 0 }}>
        <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      </label>
    </div>
  );
}

function GeneralSettings({ settings, onSave }: { settings: AppSettings; onSave: (patch: Record<string, unknown>) => void }): ReactNode {
  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Synchronization</h3>
        <div className="form-row">
          <label className="field" htmlFor="sync-int">Sync interval (minutes)</label>
          <input id="sync-int" type="number" min={1} max={1440} className="input" defaultValue={settings.sync_interval_minutes} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n) && n !== settings.sync_interval_minutes) onSave({ sync_interval_minutes: n }); }} />
        </div>
        <div className="form-row">
          <label className="field" htmlFor="api-conc">API concurrency</label>
          <input id="api-conc" type="number" min={1} max={10} className="input" defaultValue={settings.api_concurrency} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n) && n !== settings.api_concurrency) onSave({ api_concurrency: n }); }} />
        </div>
        <Toggle label="Attachment auto-download" hint="Download attachments in the background after sync" value={settings.attachment_auto_download} onChange={(v) => onSave({ attachment_auto_download: v })} />
        <div className="form-row mt-16">
          <label className="field" htmlFor="retention">Retention days (blank = keep forever)</label>
          <input id="retention" type="number" className="input" defaultValue={settings.retention_days ?? ''} onBlur={(e) => { const n = Number(e.target.value); onSave({ retention_days: e.target.value !== '' && Number.isFinite(n) && n > 0 ? n : null }); }} />
        </div>
        <div className="form-row">
          <label className="field" htmlFor="backup-int">Automatic backup interval (hours, blank = off)</label>
          <input id="backup-int" type="number" className="input" defaultValue={settings.backup_interval_hours ?? ''} onBlur={(e) => onSave({ backup_interval_hours: e.target.value ? Number(e.target.value) : null })} />
        </div>
      </div>
      <div className="card">
        <h3 className="card-title">AI behaviour (safe defaults)</h3>
        <Toggle label="AI enabled" hint="The app remains fully usable when off" value={settings.ai_enabled} onChange={(v) => onSave({ ai_enabled: v })} />
        <Toggle label="Automatic ticket analysis" hint="Analyze new/changed tickets in the background" value={settings.automatic_analysis_enabled} onChange={(v) => onSave({ automatic_analysis_enabled: v })} />
        <Toggle label="Automatic AI note creation" hint="Create internal Help Scout notes with the AI analysis" value={settings.automatic_note_enabled} onChange={(v) => onSave({ automatic_note_enabled: v })} />
        <Toggle label="Automatic AI draft creation" hint="Generate customer-safe draft suggestions" value={settings.automatic_draft_enabled} onChange={(v) => onSave({ automatic_draft_enabled: v })} />
        <Toggle label="Automation engine" value={settings.automation_enabled} onChange={(v) => onSave({ automation_enabled: v })} />
        <Toggle label="Automation write actions" hint="Without this, all non-read automation actions await approval" value={settings.automation_write_actions_enabled} onChange={(v) => onSave({ automation_write_actions_enabled: v })} />
        <div className="alert error mt-16" style={{ marginBottom: 0 }}>
          <strong>Automatic reply sending: permanently OFF.</strong> AI never sends customer replies in v1 - drafts always require human review and an explicit send action.
        </div>
        <div className="mt-16">
          <Toggle label="Redaction layer" hint="Mask payment data, tokens, API keys before prompting the model" value={settings.redaction_enabled} onChange={(v) => onSave({ redaction_enabled: v })} />
        </div>
      </div>
    </div>
  );
}

function HelpScoutSettings({ oauth, pushToast }: { oauth: { configured: boolean; authenticated: boolean; demo_mode: boolean; expires_at: string | null; me: { name: string; email: string | null } | null } | undefined; pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const authorize = useMutation({
    mutationFn: () => api.get<{ url?: string; demo_mode?: boolean; message?: string }>('/api/oauth/authorize-url'),
    onSuccess: (r) => {
      if (r.url) window.open(r.url, '_blank', 'noopener');
      else pushToast({ kind: 'info', message: r.message ?? 'Demo mode active.' });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });
  const clientCreds = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/oauth/client-credentials'),
    onSuccess: (r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.message })
  });
  const disconnect = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/oauth/disconnect'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
  });
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h3 className="card-title">Help Scout connection</h3>
      {oauth?.demo_mode ? <div className="alert warn">Demo mode is active (simulated Help Scout account). Switch off LOCAL_DEMO_MODE in .env and restart to connect a real account.</div> : null}
      <KV k="App credentials" v={oauth?.configured ? 'configured via .env' : 'not configured (set HELPSCOUT_CLIENT_ID/SECRET in .env)'} />
      <KV k="Connected as" v={oauth?.me ? `${oauth.me.name} (${oauth.me.email ?? '—'})` : '—'} />
      <KV k="Token expires" v={oauth?.expires_at ? new Date(oauth.expires_at).toLocaleString() : '—'} />
      <div className="flex wrap mt-16">
        <button className="btn primary" onClick={() => authorize.mutate()} disabled={authorize.isPending}>Authorize via browser (OAuth code flow)</button>
        <button className="btn" onClick={() => clientCreds.mutate()} disabled={clientCreds.isPending}>Connect with Client Credentials</button>
        <button className="btn danger" onClick={() => disconnect.mutate()}>Disconnect</button>
      </div>
      <p className="text-xs muted mt-16">
        Tokens are stored server-side only and never exposed to the browser. The callback URL for your Help Scout app is <span className="mono">/oauth/callback</span> (configure <span className="mono">HELPSCOUT_REDIRECT_URI</span>). Client Credentials is the simplest flow for a personal internal integration.
      </p>
    </div>
  );
}

function LmStudioSettings({ lm, pushToast }: { lm: { base_url: string; chat_model: string | null; embedding_model: string | null; timeout_ms: number; concurrency: number } | undefined; pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const [baseUrl, setBaseUrl] = useState(lm?.base_url ?? 'http://127.0.0.1:1234');
  const [chatModel, setChatModel] = useState(lm?.chat_model ?? '');
  const [embeddingModel, setEmbeddingModel] = useState(lm?.embedding_model ?? '');
  const [timeout, setTimeoutMs] = useState(lm?.timeout_ms ?? 120000);
  const [concurrency, setConcurrency] = useState(lm?.concurrency ?? 2);
  const [models, setModels] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; message: string }>('/api/settings/lmstudio', { base_url: baseUrl, chat_model: chatModel || null, embedding_model: embeddingModel || null, timeout_ms: timeout, concurrency }),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; connected: boolean; models: string[]; message: string }>('/api/settings/lmstudio/test'),
    onSuccess: (r) => {
      setModels(r.models);
      pushToast({ kind: r.connected ? 'success' : 'error', message: r.message });
    }
  });
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h3 className="card-title">LM Studio (local AI gateway)</h3>
      <div className="form-row">
        <label className="field" htmlFor="lm-url">Base URL</label>
        <input id="lm-url" className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:1234" />
      </div>
      <div className="form-row">
        <label className="field" htmlFor="lm-chat">Chat model (blank = first loaded)</label>
        <input id="lm-chat" className="input mono" list="lm-models" value={chatModel} onChange={(e) => setChatModel(e.target.value)} placeholder="e.g. qwen2.5-7b-instruct" />
      </div>
      <div className="form-row">
        <label className="field" htmlFor="lm-embed">Embedding model (enables vector features)</label>
        <input id="lm-embed" className="input mono" list="lm-models" value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} placeholder="e.g. nomic-embed-text-v1.5" />
      </div>
      <datalist id="lm-models">
        {models.map((m) => <option key={m} value={m} />)}
      </datalist>
      <div className="grid-2">
        <div className="form-row">
          <label className="field" htmlFor="lm-timeout">Timeout (ms)</label>
          <input id="lm-timeout" type="number" className="input" value={timeout} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
        </div>
        <div className="form-row">
          <label className="field" htmlFor="lm-conc">Concurrency</label>
          <input id="lm-conc" type="number" min={1} max={8} className="input" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
        </div>
      </div>
      <div className="flex">
        <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>Test connection + discover models</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button>
      </div>
      {models.length > 0 ? (
        <div className="mt-16">
          <strong className="text-sm">Discovered models:</strong>
          <div className="mt-8">
            {models.map((m) => (
              <button key={m} className="badge" style={{ margin: '0 4px 4px 0' }} onClick={() => setChatModel(m)}>{m}</button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-xs muted mt-16">In LM Studio: load a model, then Developer → Start Server. Requests go to your local machine only - nothing is sent to any cloud AI provider.</p>
    </div>
  );
}

function QdrantSettings({ qdrant, pushToast }: { qdrant: { url: string; enabled: boolean } | undefined; pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const [url, setUrl] = useState(qdrant?.url ?? 'http://127.0.0.1:6333');
  const [enabled, setEnabled] = useState(qdrant?.enabled ?? true);
  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; message: string }>('/api/settings/qdrant', { url, enabled }),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; connected: boolean; message: string }>('/api/settings/qdrant/test'),
    onSuccess: (r) => {
      setResult(r.message);
      pushToast({ kind: r.connected ? 'success' : 'warning', message: r.message });
    }
  });
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h3 className="card-title">Qdrant (local vector store, optional)</h3>
      <div className="form-row">
        <label className="field" htmlFor="q-url">URL</label>
        <input id="q-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:6333" />
      </div>
      <Toggle label="Enabled" hint="When unavailable, keyword search (FTS5) remains fully functional" value={enabled} onChange={setEnabled} />
      <div className="flex mt-16">
        <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>Test connection</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button>
      </div>
      {result ? <div className={`alert ${enabled ? 'info' : 'warn'} mt-16`} style={{ marginBottom: 0 }}>{result}</div> : null}
      <p className="text-xs muted mt-16">Run Qdrant locally (docker run -p 6333:6333 qdrant/qdrant). Embedding-model changes are detected and never silently mixed with old vectors.</p>
    </div>
  );
}

function BackupsSettings({ backups, refetch, pushToast }: { backups: { file: string; size_bytes: number; created_at: string; verified: boolean }[]; refetch: () => void; pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const create = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; verified?: boolean }>('/api/backups/create'),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message + (r.verified ? ' (integrity verified)' : '') });
      void refetch();
    }
  });
  const exportJson = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/backups/export-json'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
  });
  const exportCsv = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/backups/export-csv'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message })
  });
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h3 className="card-title">Backups & export</h3>
      <div className="flex wrap mb-16">
        <button className="btn primary" onClick={() => create.mutate()} disabled={create.isPending}>Backup database now</button>
        <button className="btn" onClick={() => exportJson.mutate()}>Export JSON</button>
        <button className="btn" onClick={() => exportCsv.mutate()}>Export conversations CSV</button>
      </div>
      <table className="table">
        <thead><tr><th>Backup file</th><th>Size</th><th>Created</th><th>Integrity</th></tr></thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.file}>
              <td className="mono text-xs">{b.file}</td>
              <td>{(b.size_bytes / 1024 / 1024).toFixed(1)} MB</td>
              <td>{new Date(b.created_at).toLocaleString()}</td>
              <td>{b.verified ? <span className="badge ok">verified</span> : <span className="badge err">check failed</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {backups.length === 0 ? <p className="muted text-sm">No backups yet.</p> : null}
      <p className="text-xs muted mt-16">
        Restore from the CLI: <span className="mono">npm run db:restore -- backups/&lt;file&gt;.db</span> (the app must be stopped). Exports contain customer data - handle carefully. See docs/BACKUP-RESTORE.md.
      </p>
    </div>
  );
}
