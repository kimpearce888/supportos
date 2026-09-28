import { type ReactNode, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { Spinner, EmptyState, ConfidenceBadge } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { CustomerMemoryProfile, MemoryEntry } from '../../../shared/memory.js';

/**
 * Customer memory panel (v2.2.0, plan Phase 36) - collapsed panel in the
 * conversation detail. Composed live from the local mirror; human entries
 * are the only persisted rows and can be added/removed here. Quarantined
 * entries (psychological/personality pattern matches) are shown separately,
 * never as usable memory.
 */
const SOURCE_CLASS: Record<string, string> = {
  helpscout_mirror: 'badge',
  deterministic_local: 'badge',
  ai_derived: 'badge ai',
  human_local: 'badge ok'
};

const FRESHNESS_CLASS: Record<string, string> = { fresh: 'ok', aging: 'warn', stale: 'err', unknown: '' };

export function MemoryPanel({ customerId, conversationId }: { customerId: number | null; conversationId: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newKind, setNewKind] = useState('fact');

  const { data, isLoading } = useQuery({
    queryKey: ['customer-memory', customerId],
    queryFn: () => api.get<CustomerMemoryProfile>(`/api/memory/${customerId}`),
    enabled: open && customerId != null
  });

  const addEntry = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; entry_id: number }>(`/api/memory/${customerId}/entries`, {
        key: newKey,
        value: newValue || null,
        kind: newKind,
        conversation_id: conversationId
      }),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Memory entry saved (human-written).' });
      setNewKey('');
      setNewValue('');
      void queryClient.invalidateQueries({ queryKey: ['customer-memory', customerId] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const removeEntry = useMutation({
    mutationFn: (entryId: number) => api.delete<{ ok: boolean }>(`/api/memory/${customerId}/entries/${entryId}`),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Memory entry removed.' });
      void queryClient.invalidateQueries({ queryKey: ['customer-memory', customerId] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  if (customerId == null) {
    return (
      <section className="card memory-panel">
        <button className="card-title collapsible" onClick={() => setOpen((v) => !v)}>
          Customer memory {open ? '▾' : '▸'}
        </button>
        {open ? <EmptyState title="No customer on this conversation" hint="Memory composes per customer; this conversation has none linked." /> : null}
      </section>
    );
  }

  return (
    <section className="card memory-panel">
      <button className="card-title collapsible" onClick={() => setOpen((v) => !v)}>
        Customer memory {data ? `(${data.sections.reduce((n, s) => n + s.entries.length, 0)} entries)` : ''} {open ? '▾' : '▸'}
      </button>
      {open ? (
        <>
          <p className="muted text-xs mb-8">
            Composed live from the local mirror - issue history, resolutions, preferences, patterns, campaigns and account facts. Human-written entries are the only stored rows.
          </p>
          {isLoading ? <Spinner /> : null}

          {data?.sections.filter((s) => s.entries.length > 0 || s.section === 'human_entries').map((s) => (
            <div key={s.section} className="memory-section">
              <h4 className="card-title">{s.label} <span className="muted text-xs">({s.entries.length})</span></h4>
              {s.entries.length === 0 ? <div className="muted text-xs">Nothing on record (honest unknown).</div> : null}
              {s.entries.map((e, i) => (
                <MemoryEntryRow key={e.entry_id ?? `${s.section}-${i}`} entry={e} onDelete={e.editable && e.entry_id != null ? () => removeEntry.mutate(e.entry_id!) : undefined} />
              ))}
            </div>
          ))}

          {data && data.quarantined.length > 0 ? (
            <div className="alert error text-xs mt-8">
              <strong>Quarantined entries ({data.quarantined.length}) - never used as memory:</strong>
              {data.quarantined.map((q) => (
                <div key={q.entry_id} className="flex between align-center mt-4">
                  <span>“{q.key}” - {q.reason}</span>
                  <button className="btn ghost small" onClick={() => removeEntry.mutate(q.entry_id)} title="Purge this quarantined entry">Purge</button>
                </div>
              ))}
            </div>
          ) : null}

          {data ? (
            <div className="memory-add mt-12">
              <h4 className="card-title">Add a human memory entry</h4>
              <div className="flex gap-8 wrap">
                <input className="input" style={{ flex: '1 1 160px' }} placeholder="Key (e.g. Escalation contact)" value={newKey} onChange={(e) => setNewKey(e.target.value)} maxLength={120} aria-label="Memory key" />
                <select className="input" style={{ width: 130 }} value={newKind} onChange={(e) => setNewKind(e.target.value)} aria-label="Memory kind">
                  <option value="fact">Fact</option>
                  <option value="account">Account</option>
                  <option value="preference">Preference</option>
                  <option value="issue_history">Issue history</option>
                  <option value="context">Context</option>
                </select>
              </div>
              <textarea className="input mt-8" rows={2} placeholder="Value (observable facts only - psychological/personality judgments are refused by policy)" value={newValue} onChange={(e) => setNewValue(e.target.value)} maxLength={2000} aria-label="Memory value" />
              <button className="btn small primary mt-8" disabled={!newKey.trim() || addEntry.isPending} onClick={() => addEntry.mutate()}>
                {addEntry.isPending ? 'Saving…' : 'Save entry'}
              </button>
            </div>
          ) : null}

          {data ? (
            <div className="alert info text-xs mt-12">
              {data.notes.map((n, i) => <div key={i}>{n}</div>)}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function MemoryEntryRow({ entry, onDelete }: { entry: MemoryEntry; onDelete?: () => void }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="memory-entry">
      <div className="flex between align-center gap-8">
        <div className="text-sm" style={{ minWidth: 0 }}>
          <strong>{entry.title}</strong>
          {entry.value ? <div className="muted text-xs" style={{ whiteSpace: 'pre-wrap' }}>{entry.value.slice(0, expanded ? 2000 : 160)}{entry.value.length > 160 && !expanded ? '…' : ''}</div> : null}
        </div>
        <div className="flex gap-4 wrap" style={{ flexShrink: 0 }}>
          <span className={SOURCE_CLASS[entry.source] ?? 'badge'}>{entry.source.replace('_', ' ')}</span>
          <ConfidenceBadge level={entry.confidence} />
          <span className={`badge ${FRESHNESS_CLASS[entry.freshness] ?? ''}`}>{entry.freshness}</span>
        </div>
      </div>
      <div className="flex gap-8 align-center mt-4">
        {entry.evidence.length > 0 ? (
          <button className="btn ghost small" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide evidence' : `Evidence (${entry.evidence.length})`}
          </button>
        ) : <span className="muted text-xs">no evidence links</span>}
        <span className="muted text-xs">{entry.last_seen_at ? `last seen ${entry.last_seen_at.slice(0, 10)}` : entry.first_seen_at ? `since ${entry.first_seen_at.slice(0, 10)}` : 'no timestamp'}</span>
        {onDelete ? <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onDelete}>Delete</button> : null}
      </div>
      {expanded && entry.evidence.length > 0 ? (
        <div className="mt-4 flex col gap-4">
          {entry.evidence.map((e, i) => (
            <div key={i} className="mono text-xs">{e.description}{e.conversation_number != null ? ` (#${e.conversation_number})` : ''}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
