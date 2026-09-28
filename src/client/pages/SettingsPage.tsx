import { type ReactNode, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { SUPPORTED_LANGUAGES } from '../../shared/translation.js';
import { Spinner, ErrorState, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import { useBusinessHours, type BusinessHoursRow } from '../api/hooks.js';
import type { AppSettings } from '../../shared/types.js';

export function SettingsPage(): ReactNode {
  const [tab, setTab] = useState<'general' | 'helpscout' | 'lmstudio' | 'qdrant' | 'hours' | 'backups' | 'encsync' | 'capability'>('general');
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
        {['general', 'helpscout', 'lmstudio', 'qdrant', 'hours', 'backups', 'encsync', 'capability'].map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t as typeof tab)}>
            {t === 'general' ? 'Synchronization & AI' : t === 'capability' ? 'Capability matrix' : t === 'helpscout' ? 'Help Scout' : t === 'lmstudio' ? 'LM Studio' : t === 'qdrant' ? 'Qdrant' : t === 'hours' ? 'Business hours' : t === 'backups' ? 'Backups & export' : t === 'encsync' ? 'Encrypted sync' : t}
          </button>
        ))}
      </div>

      {tab === 'general' ? <GeneralSettings settings={settings} onSave={(patch) => save.mutate(patch)} /> : null}
      {tab === 'helpscout' ? <HelpScoutSettings oauth={oauth} pushToast={pushToast} /> : null}
      {tab === 'lmstudio' ? <LmStudioSettings lm={lm} pushToast={pushToast} /> : null}
      {tab === 'qdrant' ? <QdrantSettings qdrant={qdrant} pushToast={pushToast} /> : null}
      {tab === 'hours' ? <BusinessHoursSettings pushToast={pushToast} /> : null}
      {tab === 'backups' ? <BackupsSettings backups={backups?.backups ?? []} refetch={refetchBackups} pushToast={pushToast} /> : null}
      {tab === 'encsync' ? <EncryptedSyncSettings pushToast={pushToast} /> : null}
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
        <div className="form-row mt-16">
          <label className="field" htmlFor="agent-language">Your drafting language (translation feature)</label>
          <select
            id="agent-language"
            className="input"
            defaultValue={settings.agent_language || 'en'}
            onChange={(e) => onSave({ agent_language: e.target.value })}
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
          <p className="text-xs muted" style={{ marginBottom: 0 }}>
            Customer messages can be translated into this language for your review, and your drafts translated into the customer's language - always side by side, never sent automatically, local model only.
          </p>
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
    onSuccess: (r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });
  const disconnect = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/oauth/disconnect'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
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
  // v1.6.0 audit fix (settings data loss): the form state was initialized ONCE
  // from `lm`, which is undefined until the settings query resolves - the form
  // silently showed DEFAULTS and Save overwrote the real saved settings with
  // them. Re-sync as soon as the loaded settings arrive (before the user edits).
  const [lmLoaded, setLmLoaded] = useState(false);
  useEffect(() => {
    if (lm && !lmLoaded) {
      setBaseUrl(lm.base_url);
      setChatModel(lm.chat_model ?? '');
      setEmbeddingModel(lm.embedding_model ?? '');
      setTimeoutMs(lm.timeout_ms);
      setConcurrency(lm.concurrency);
      setLmLoaded(true);
    }
  }, [lm, lmLoaded]);
  const [models, setModels] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; message: string }>('/api/settings/lmstudio', { base_url: baseUrl, chat_model: chatModel || null, embedding_model: embeddingModel || null, timeout_ms: timeout, concurrency }),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; connected: boolean; models: string[]; message: string }>('/api/settings/lmstudio/test'),
    onSuccess: (r) => {
      setModels(r.models);
      pushToast({ kind: r.connected ? 'success' : 'error', message: r.message });
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
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
  // v1.6.0 audit fix: same default-capture data-loss bug as the LM form - see
  // LmStudioSettings. Re-sync when loaded settings arrive, before first edit.
  const [qdrantLoaded, setQdrantLoaded] = useState(false);
  useEffect(() => {
    if (qdrant && !qdrantLoaded) {
      setUrl(qdrant.url);
      setEnabled(qdrant.enabled);
      setQdrantLoaded(true);
    }
  }, [qdrant, qdrantLoaded]);
  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; message: string }>('/api/settings/qdrant', { url, enabled }),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; connected: boolean; message: string }>('/api/settings/qdrant/test'),
    onSuccess: (r) => {
      setResult(r.message);
      pushToast({ kind: r.connected ? 'success' : 'warning', message: r.message });
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
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
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });
  const exportJson = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/backups/export-json'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });
  const exportCsv = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/backups/export-csv'),
    onSuccess: (r) => pushToast({ kind: 'success', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
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

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMEZONE_SUGGESTIONS = ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Santiago', 'Europe/London', 'Europe/Berlin', 'Europe/Stockholm', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];

function minutesToHHMM(m: number | null): string {
  if (m == null) return '';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function hhmmToMinutes(v: string): number | null {
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** v1.4.0: per-mailbox business hours + SLA targets editor. */
function BusinessHoursSettings({ pushToast }: { pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const qc = useQueryClient();
  const { data, isLoading } = useBusinessHours();
  const [editing, setEditing] = useState<BusinessHoursRow | null>(null);

  const save = useMutation({
    mutationFn: (input: { mailboxId: number; body: Record<string, unknown> }) => api.put<{ ok: boolean; message: string }>(`/api/settings/business-hours/${input.mailboxId}`, input.body),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['business-hours'] });
      void qc.invalidateQueries({ queryKey: ['sla-report'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const clear = useMutation({
    mutationFn: (mailboxId: number) => api.delete<{ ok: boolean; message: string }>(`/api/settings/business-hours/${mailboxId}`),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: r.message });
      void qc.invalidateQueries({ queryKey: ['business-hours'] });
      void qc.invalidateQueries({ queryKey: ['sla-report'] });
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  if (isLoading || !data) return <Spinner label="Loading business hours" />;

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h3 className="card-title">Business hours & SLA targets (per mailbox)</h3>
      <p className="text-xs muted" style={{ marginTop: 0 }}>
        SLA reports measure first-response and resolution times in <strong>business minutes</strong> - nights, weekends and non-configured weekdays contribute zero. Without a schedule the mailbox is measured in wall-clock minutes and labeled as such in Reports → SLA.
      </p>
      <table className="table">
        <thead><tr><th>Mailbox</th><th>Schedule</th><th>First-response target</th><th></th></tr></thead>
        <tbody>
          {data.mailboxes.map((m) => (
            <tr key={m.mailbox_id}>
              <td><strong>{m.name}</strong></td>
              <td className="text-xs">
                {m.configured && m.days
                  ? `${m.days.map((d) => DAY_LABELS[d]).join(' ')} · ${minutesToHHMM(m.start_minute)}–${minutesToHHMM(m.end_minute)} · ${m.timezone}`
                  : <span className="badge">wall-clock (not configured)</span>}
              </td>
              <td className="text-xs">{m.first_response_target_min != null ? `${m.first_response_target_min} business min` : '—'}</td>
              <td>
                <div className="flex" style={{ gap: 4 }}>
                  <button className="btn small" onClick={() => setEditing(m)}>Edit</button>
                  {m.configured ? <button className="btn ghost small" onClick={() => clear.mutate(m.mailbox_id)}>Clear</button> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.mailboxes.length === 0 ? <p className="muted text-sm" style={{ padding: '8px 0' }}>No mailboxes yet - run an initial sync first.</p> : null}
      {editing ? <BusinessHoursEditor row={editing} onSave={(body) => save.mutate({ mailboxId: editing.mailbox_id, body })} onCancel={() => setEditing(null)} saving={save.isPending} /> : null}
    </div>
  );
}

function BusinessHoursEditor({ row, onSave, onCancel, saving }: { row: BusinessHoursRow; onSave: (body: Record<string, unknown>) => void; onCancel: () => void; saving: boolean }): ReactNode {
  const [timezone, setTimezone] = useState(row.timezone ?? 'UTC');
  const [days, setDays] = useState<number[]>(row.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(minutesToHHMM(row.start_minute ?? 540));
  const [end, setEnd] = useState(minutesToHHMM(row.end_minute ?? 1020));
  const [frTarget, setFrTarget] = useState<string>(row.first_response_target_min != null ? String(row.first_response_target_min) : '');
  const [resTarget, setResTarget] = useState<string>(row.resolution_target_min != null ? String(row.resolution_target_min) : '');

  const toggleDay = (d: number): void => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));
  };

  const submit = (): void => {
    const startMin = hhmmToMinutes(start);
    const endMin = hhmmToMinutes(end);
    if (startMin == null || endMin == null || endMin <= startMin) return;
    onSave({
      timezone,
      days,
      start_minute: startMin,
      end_minute: endMin,
      first_response_target_min: frTarget.trim() !== '' && Number.isFinite(Number(frTarget)) && Number(frTarget) > 0 ? Number(frTarget) : null,
      resolution_target_min: resTarget.trim() !== '' && Number.isFinite(Number(resTarget)) && Number(resTarget) > 0 ? Number(resTarget) : null
    });
  };

  return (
    <div className="mt-16" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <strong className="text-sm">Business hours for {row.name}</strong>
      <div className="form-row mt-8">
        <label className="field" htmlFor="bh-tz">Timezone (IANA)</label>
        <input id="bh-tz" className="input mono" list="bh-tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Berlin" />
        <datalist id="bh-tz-list">
          {TIMEZONE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
        </datalist>
      </div>
      <div className="form-row">
        <label className="field">Active weekdays</label>
        <div className="flex wrap" style={{ gap: 4 }}>
          {DAY_LABELS.map((d, i) => (
            <button key={d} className={`btn small ${days.includes(i) ? 'primary' : ''}`} aria-pressed={days.includes(i)} onClick={() => toggleDay(i)}>{d}</button>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="form-row">
          <label className="field" htmlFor="bh-start">Day starts</label>
          <input id="bh-start" type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="field" htmlFor="bh-end">Day ends</label>
          <input id="bh-end" type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div className="grid-2">
        <div className="form-row">
          <label className="field" htmlFor="bh-fr">First-response SLA target (business minutes, blank = none)</label>
          <input id="bh-fr" type="number" min={1} className="input" value={frTarget} onChange={(e) => setFrTarget(e.target.value)} placeholder="e.g. 240 for 4 business hours" />
        </div>
        <div className="form-row">
          <label className="field" htmlFor="bh-res">Resolution SLA target (business minutes, blank = none)</label>
          <input id="bh-res" type="number" min={1} className="input" value={resTarget} onChange={(e) => setResTarget(e.target.value)} placeholder="e.g. 2880 for 2 business days" />
        </div>
      </div>
      <div className="flex mt-8">
        <button className="btn primary" onClick={submit} disabled={saving || days.length === 0}>Save schedule</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

interface EncryptedSyncData {
  bundles: { file: string; size_bytes: number; created_at: string }[];
  log: { id: number; direction: string; file_path: string; size_bytes: number; conversations: number | null; customers: number | null; at: string }[];
  bundle_dir: string;
  design: string;
}

/**
 * v1.5.0: optional end-to-end encrypted sync for multi-device use.
 * File-based by design (no relay server - SupportOS never sees your data):
 * export an encrypted .sosync bundle, move it however you like, import it on
 * the other device with the same passphrase. The passphrase never leaves
 * this browser tab except to the local server over the wire.
 */
function EncryptedSyncSettings({ pushToast }: { pushToast: (t: { kind: 'success' | 'error' | 'warning' | 'info'; message: string }) => void }): ReactNode {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importPass, setImportPass] = useState('');
  const { data, refetch } = useQuery({ queryKey: ['encrypted-sync'], queryFn: () => api.get<EncryptedSyncData>('/api/sync/encrypted') });

  const exportBundle = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; path?: string; size_bytes?: number }>('/api/sync/encrypted/export', { passphrase }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void refetch();
      setPassphrase('');
      setConfirm('');
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const verifyBundle = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/sync/encrypted/verify', { path: importPath, passphrase: importPass }),
    onSuccess: (r) => pushToast({ kind: r.ok ? 'success' : 'error', message: r.message }),
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const importBundle = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; require_restart?: boolean }>('/api/sync/encrypted/import', { path: importPath, passphrase: importPass }),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'warning' : 'error', message: r.message });
      void refetch();
    },
    // v1.6.0 audit fix: surface network failures instead of a silent no-op.
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' })
  });

  const uploadBundle = useMutation({
    mutationFn: async (file: File): Promise<{ ok: boolean; message: string; path?: string }> => {
      const res = await fetch('/api/sync/encrypted/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer()
      });
      const j = (await res.json()) as { ok: boolean; message: string; path?: string };
      if (!res.ok || !j.ok) throw new Error(j.message ?? 'Upload failed');
      return j;
    },
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: r.message });
      if (r.path) setImportPath(r.path);
      void refetch();
    },
    onError: (e) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Upload failed' })
  });

  const strength = passphrase.length >= 12 && /[^a-zA-Z0-9]/.test(passphrase) ? 'strong' : passphrase.length >= 8 ? 'ok' : 'weak';

  return (
    <div className="grid-2">
      <div className="card">
        <h3 className="card-title">Export an encrypted bundle</h3>
        <p className="text-xs muted" style={{ marginTop: 0 }}>
          A .sosync file is your whole support database (customers, conversations, AI analysis, segments, campaigns) encrypted with AES-256-GCM. Attachments are not bundled - they re-download from Help Scout automatically on the other device. No relay server exists by design: move the file yourself (cloud drive, USB, company share). Only the passphrase holder can open it.
        </p>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Passphrase (min 8 chars)</span>
          <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Confirm passphrase</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {passphrase ? <span className={`badge ${strength === 'strong' ? 'ok' : strength === 'ok' ? 'warn' : 'err'}`}>{strength} passphrase</span> : null}
        <div className="mt-8">
          <button
            className="btn primary"
            disabled={passphrase.length < 8 || passphrase !== confirm || exportBundle.isPending}
            onClick={() => exportBundle.mutate()}
          >
            Create encrypted bundle
          </button>
        </div>
        <p className="text-xs muted mt-8" style={{ margin: 0 }}>
          Bundles land in <span className="mono">{data?.bundle_dir ?? '…'}</span> (newest 5 are kept). There is NO passphrase recovery - losing it means the bundle cannot be decrypted by anyone.
        </p>
      </div>
      <div className="card">
        <h3 className="card-title">Import on this device</h3>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Upload a .sosync bundle</span>
          <input
            className="input"
            type="file"
            accept=".sosync,application/octet-stream"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadBundle.mutate(f);
            }}
          />
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">…or server-side path</span>
          <input className="input mono" value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/path/to/supportos-sync-….sosync" />
        </label>
        <label className="text-xs" style={{ display: 'block', marginBottom: 8 }}>
          <span className="muted">Passphrase</span>
          <input className="input" type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} autoComplete="off" />
        </label>
        <div className="flex" style={{ gap: 8 }}>
          <button className="btn" disabled={!importPath || !importPass || verifyBundle.isPending} onClick={() => verifyBundle.mutate()}>
            Verify first (dry run)
          </button>
          <button
            className="btn danger"
            disabled={!importPath || !importPass || importBundle.isPending}
            onClick={() => {
              if (window.confirm('Import replaces the local database with the bundle content (a safety backup of the current data is written first). The app must restart afterwards. Continue?')) importBundle.mutate();
            }}
          >
            Import & replace local data
          </button>
        </div>
        <p className="text-xs muted mt-8" style={{ margin: 0 }}>
          Import checks integrity + schema compatibility first, writes an automatic safety backup, then swaps the database. Restart SupportOS after importing.
        </p>
        {data && data.log.length > 0 ? (
          <div className="mt-16">
            <strong className="text-sm">Sync ledger</strong>
            {data.log.map((l) => (
              <div key={l.id} className="flex" style={{ gap: 8, padding: '2px 0' }}>
                <span className={`badge ${l.direction === 'export' ? 'ok' : 'active'}`}>{l.direction}</span>
                <span className="text-xs mono grow">{l.file_path.split('/').pop() ?? l.file_path}</span>
                <span className="text-xs muted">{(l.size_bytes / 1024 / 1024).toFixed(1)} MB · {l.conversations ?? '?'} conv</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
