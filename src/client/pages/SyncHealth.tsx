import { type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { RefreshCw, Play, Scale, Trash2, Database, Webhook, ListRestart } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, ErrorState, RelativeTime, KV, ProgressBar } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import type { HealthStatus } from '../../shared/types.js';

interface SyncStatusData {
  state: string;
  running: boolean;
  current_run: { id: number; kind: string; state: string; started_at: string; resources_done: number; resources_total: number; records_processed: number; errors: number } | null;
  checkpoints: { resource: string; last_success_at: string | null; records_processed: number; records_failed: number; last_error: string | null; retry_count: number; status: string }[];
  last_success: string | null;
  recent_runs: { id: number; kind: string; state: string; started_at: string; finished_at: string | null; records_processed: number; errors: number }[];
  webhook: { events: { total: number; pending: number; processed: number; failed: number; duplicates: number }; recent: { id: number; event_type: string; received_at: string; processing_state: string }[]; configured: { url: string; events: string[] }[]; secret_configured: boolean };
  rate_limit: { limitPerMinute: number; remaining: number | null; retryAfterSec: number | null; updatedAt: string; inFlightWindow: number } | null;
  api_queue: { queued: number; active: number; dispatched: number; completed: number; failed: number } | null;
}

const STATE_LABELS: Record<string, string> = {
  NEW: 'Not yet synced',
  INITIALIZING: 'Initializing…',
  BACKFILLING: 'Backfilling history…',
  CATCHING_UP: 'Catching up…',
  LIVE: 'Live',
  RECONCILING: 'Reconciling…',
  PAUSED: 'Paused',
  ERROR: 'Error (recoverable)'
};

export function SyncHealthPage(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: status, error: statusError, refetch, isFetching } = useQuery({ queryKey: ['sync-status'], queryFn: () => api.get<SyncStatusData>('/api/sync/status'), refetchInterval: 5000 });
  const { data: health } = useQuery({ queryKey: ['health-detailed'], queryFn: () => api.get<HealthStatus>('/health/detailed'), refetchInterval: 30_000 });
  const { data: db } = useQuery({ queryKey: ['db-stats'], queryFn: () => api.get<{ path: string; size_bytes: number; migrations: number; tables: { table: string; rows: number }[] }>('/api/system/db') });

  const act = useMutation({
    mutationFn: (input: { path: string }) => api.post<{ ok: boolean; message: string; detail?: string }>(input.path, {}),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message, detail: r.detail });
      void refetch();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (statusError) return <div className="page"><ErrorState message="Could not load sync status" detail={statusError instanceof Error ? statusError.message : 'The request failed. Retry or check the logs.'} /></div>;
  if (!status) return <div className="page"><Spinner /></div>;
  const progress = status.current_run && status.current_run.resources_total > 0 ? status.current_run.resources_done / status.current_run.resources_total : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title"><Database size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Sync Health</h1>
          <p className="page-subtitle">
            State: <strong>{STATE_LABELS[status.state] ?? status.state}</strong> · last success <RelativeTime iso={status.last_success} /> · {isFetching ? 'refreshing…' : 'auto-refresh 5s'}
          </p>
        </div>
        <div className="flex wrap">
          <button className="btn primary" onClick={() => act.mutate({ path: '/api/sync/incremental' })} disabled={status.running}>
            <RefreshCw size={13} /> Sync now
          </button>
          <button className="btn" onClick={() => act.mutate({ path: '/api/sync/initial' })} disabled={status.running}>
            <Play size={13} /> Initial sync
          </button>
          <button className="btn" onClick={() => act.mutate({ path: '/api/sync/reconcile' })} disabled={status.running}>
            <Scale size={13} /> Full reconciliation
          </button>
          <button className="btn" onClick={() => act.mutate({ path: '/api/sync/rebuild-search-index' })}>
            <ListRestart size={13} /> Rebuild search index
          </button>
          <button className="btn" onClick={() => act.mutate({ path: '/api/sync/rebuild-embeddings' })}>
            Rebuild embeddings
          </button>
        </div>
      </div>

      {progress != null ? (
        <div className="card mb-16">
          <div className="flex-between mb-8">
            <strong>{status.current_run?.kind} sync in progress</strong>
            <span className="text-xs muted">{status.current_run?.resources_done}/{status.current_run?.resources_total} resources · {status.current_run?.records_processed} records</span>
          </div>
          <ProgressBar value={progress} />
          <button className="btn small mt-8" onClick={() => api.post('/api/sync/cancel').then(() => pushToast({ kind: 'info', message: 'Cancellation requested.' })).catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Cancel failed.' }))}>Cancel after current resource</button>
        </div>
      ) : null}

      <div className="health-grid mb-16">
        <div className="card">
          <h3 className="card-title">Help Scout</h3>
          <KV k="Mode" v={health?.helpscout.demo_mode ? <span className="badge warn">demo (simulated)</span> : <span className="badge ok">live OAuth</span>} />
          <KV k="Connected" v={health?.helpscout.connected ? <span className="badge ok">reachable</span> : <span className="badge err">unreachable</span>} />
          <KV k="Authenticated" v={health?.helpscout.oauth.authenticated ? 'yes' : 'no'} />
          <KV k="Rate limit" v={status.rate_limit ? `${status.rate_limit.remaining ?? '?'}/${status.rate_limit.limitPerMinute} remaining` : 'n/a (demo)'} />
          {status.rate_limit ? <KV k="Requests in window" v={status.rate_limit.inFlightWindow} /> : null}
          {status.api_queue ? <KV k="API queue" v={`${status.api_queue.queued} queued · ${status.api_queue.active} active`} /> : null}
        </div>
        <div className="card">
          <h3 className="card-title">LM Studio (local AI)</h3>
          <KV k="Connected" v={health?.lmstudio.connected ? <span className="badge ok">connected</span> : <span className="badge err">offline</span>} />
          <KV k="Base URL" v={<span className="mono text-xs">{health?.lmstudio.base_url}</span>} />
          <KV k="Chat model" v={health?.lmstudio.models[0] ?? 'not configured'} />
          <KV k="Embedding model" v={health?.lmstudio.embedding_model ?? 'not configured'} />
          {health?.lmstudio.last_inference ? <KV k="Last inference" v={<>{health.lmstudio.last_inference.latencyMs}ms · <RelativeTime iso={health.lmstudio.last_inference.at} /></>} /> : null}
        </div>
        <div className="card">
          <h3 className="card-title">Qdrant (vector store)</h3>
          <KV k="Connected" v={health?.qdrant.connected ? <span className="badge ok">connected</span> : <span className="badge">offline (FTS fallback active)</span>} />
          <KV k="URL" v={<span className="mono text-xs">{health?.qdrant.url}</span>} />
          <KV k="Collections" v={health?.qdrant.collections.join(', ') || '—'} />
          <KV k="Indexed chunks" v={health?.qdrant.indexed.chunks_indexed ?? 0} />
        </div>
        <div className="card">
          <h3 className="card-title">Database (SQLite)</h3>
          <KV k="Path" v={<span className="mono text-xs">{db?.path}</span>} />
          <KV k="Size" v={`${((db?.size_bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`} />
          <KV k="Migrations applied" v={db?.migrations ?? 0} />
          <KV k="WAL mode" v={<span className="badge ok">enabled</span>} />
          <KV k="Workers" v={health?.workers.running ? 'running' : 'stopped'} />
        </div>
        <div className="card">
          <h3 className="card-title"><Webhook size={13} /> Webhooks (optional)</h3>
          <KV k="Events received" v={status.webhook.events.total} />
          <KV k="Processed" v={status.webhook.events.processed} />
          <KV k="Duplicates (deduped)" v={status.webhook.events.duplicates} />
          <KV k="Pending/failed" v={`${status.webhook.events.pending}/${status.webhook.events.failed}`} />
          <KV k="Secret" v={status.webhook.secret_configured ? 'configured' : 'not configured'} />
          {status.webhook.configured.length > 0 ? <KV k="Remote configs" v={status.webhook.configured.map((w) => w.url).join(', ')} /> : null}
          <p className="text-xs muted mt-8">A localhost app cannot receive webhooks directly - a network-accessible relay is required. Polling remains the primary sync mechanism either way.</p>
        </div>
        <div className="card">
          <h3 className="card-title">Jobs</h3>
          <KV k="Queued" v={health?.sync.queued_jobs ?? 0} />
          <KV k="Failed" v={(health?.sync.failed_jobs ?? 0) > 0 ? <span className="badge err">{health?.sync.failed_jobs}</span> : 0} />
          <button className="btn small mt-8" onClick={() => act.mutate({ path: '/api/queue/clear-completed' })}>Clear completed jobs</button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Resource checkpoints</h3>
        <table className="table">
          <thead><tr><th>Resource</th><th>Status</th><th>Records</th><th>Failed</th><th>Retries</th><th>Last success</th><th>Last error</th></tr></thead>
          <tbody>
            {status.checkpoints.map((c) => (
              <tr key={c.resource}>
                <td className="mono">{c.resource}</td>
                <td><span className={`badge ${c.status === 'ok' ? 'ok' : c.status === 'error' ? 'err' : c.status === 'running' ? 'warn' : ''}`}>{c.status}</span></td>
                <td>{c.records_processed}</td>
                <td>{c.records_failed > 0 ? <span className="badge err">{c.records_failed}</span> : 0}</td>
                <td>{c.retry_count}</td>
                <td><RelativeTime iso={c.last_success_at} /></td>
                <td className="text-xs">{c.last_error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card mt-16">
        <h3 className="card-title">Recent sync runs</h3>
        <table className="table">
          <thead><tr><th>#</th><th>Kind</th><th>State</th><th>Started</th><th>Finished</th><th>Records</th><th>Errors</th></tr></thead>
          <tbody>
            {status.recent_runs.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>{r.kind}</td>
                <td><span className={`badge ${r.state === 'LIVE' ? 'ok' : r.state === 'ERROR' ? 'err' : ''}`}>{r.state}</span></td>
                <td><RelativeTime iso={r.started_at} /></td>
                <td><RelativeTime iso={r.finished_at} /></td>
                <td>{r.records_processed}</td>
                <td>{r.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="card-title">Recent webhook events</h3>
          {status.webhook.recent.length === 0 ? <span className="muted text-sm">No webhook events received.</span> : null}
          {status.webhook.recent.map((e) => (
            <KV key={e.id} k={e.event_type} v={<><span className={`badge ${e.processing_state === 'processed' ? 'ok' : e.processing_state === 'failed' ? 'err' : 'warn'}`}>{e.processing_state}</span> <RelativeTime iso={e.received_at} /></>} />
          ))}
        </div>
        <div className="card">
          <h3 className="card-title"><Trash2 size={13} /> Attachment storage</h3>
          <KV k="Attachment metadata" v={db?.tables.find((t) => t.table === 'attachments')?.rows ?? 0} />
          <KV k="Download location" v={<span className="mono text-xs">./data/attachments</span>} />
          <p className="text-xs muted mt-8">Attachments are never executed; previews are served inline only for text/image types with nosniff headers.</p>
        </div>
      </div>
    </div>
  );
}
