import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, Plus, CheckCircle2, RotateCcw, Send, Users } from 'lucide-react';
import { api } from '../../api/client.js';
import { useSideThreads, useMentionDirectory } from '../../api/hooks.js';
import { Spinner, ErrorState, EmptyState, RelativeTime } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import { MentionTextarea } from './MentionTextarea.js';
import type { SideThreadDetail } from '../../../shared/collaboration.js';

/**
 * Side collaboration threads (v1.8.0, plan Phase 14) - the panel inside the
 * conversation detail.
 *
 * Hard properties, visible in the UI copy:
 * - INTERNAL ONLY: side threads never leave the local database; they are not
 *   synced to Help Scout and can never be seen by the customer.
 * - Participants are explicit; @mentioning someone auto-joins them.
 * - Every action is audited (same audit trail as customer-facing writes).
 */
export function SideThreadsPanel({ conversationId }: { conversationId: number }): ReactNode {
  const { data, isLoading, isError, error } = useSideThreads(conversationId);
  const [creating, setCreating] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);

  if (isLoading) return <Spinner label="Loading side threads" />;
  if (isError) return <ErrorState message="Could not load side threads." detail={(error as Error | null)?.message} />;
  const threads = data?.side_threads ?? [];

  return (
    <div className="side-threads-panel">
      <div className="flex-between" style={{ padding: '8px 16px' }}>
        <h3 className="card-title" style={{ margin: 0 }}>
          <MessagesSquare size={14} /> Side threads
          <span className="badge tag" title="Internal only — never synced to Help Scout, never customer-visible">internal only</span>
        </h3>
        <button className="btn small" onClick={() => { setCreating(!creating); setOpenThreadId(null); }}>
          <Plus size={11} /> New side thread
        </button>
      </div>
      {threads.length === 0 && !creating ? (
        <div style={{ padding: '0 16px 10px' }}>
          <EmptyState
            icon="messages"
            title="No side threads yet"
            hint="Spin up an internal discussion attached to this conversation — e.g. Support, Engineering, Billing — without touching the customer-visible thread."
          />
        </div>
      ) : null}
      {creating ? <CreateThreadForm conversationId={conversationId} onDone={() => setCreating(false)} /> : null}
      {threads.length > 0 ? (
        <div className="side-thread-list">
          {threads.map((t) => (
            <button key={t.id} className={`side-thread-row ${openThreadId === t.id ? 'active' : ''}`} onClick={() => setOpenThreadId(openThreadId === t.id ? null : t.id)}>
              <span className={`dot ${t.status === 'open' ? 'dot-active' : 'dot-unknown'}`} title={t.status} />
              <strong style={{ fontSize: 12.5 }}>{t.title}</strong>
              {t.team_name ? <span className="badge tag">{t.team_name}</span> : null}
              {t.status === 'resolved' ? <span className="badge ok">resolved</span> : null}
              <span className="text-xs muted">{t.message_count} msg</span>
              <RelativeTime iso={t.last_message_at ?? t.updated_at} />
            </button>
          ))}
        </div>
      ) : null}
      {openThreadId != null ? <SideThreadDetail threadId={openThreadId} /> : null}
    </div>
  );
}

function CreateThreadForm({ conversationId, onDone }: { conversationId: number; onDone: () => void }): ReactNode {
  const { data: directory } = useMentionDirectory();
  const [title, setTitle] = useState('');
  const [team, setTeam] = useState('');
  const [participants, setParticipants] = useState<number[]>([]);
  const [firstMessage, setFirstMessage] = useState('');
  const pushToast = useUiStore((s) => s.pushToast);
  const qc = useQueryClient();

  const create = (): void => {
    api.post<{ side_thread: SideThreadDetail }>(`/api/conversations/${conversationId}/side-threads`, {
      title: title.trim(),
      team_local_id: team ? Number(team) : null,
      participant_user_ids: participants,
      first_message: firstMessage.trim() || undefined
    })
      .then(() => {
        pushToast({ kind: 'success', message: 'Side thread created (internal only).' });
        void qc.invalidateQueries({ queryKey: ['side-threads', conversationId] });
        onDone();
      })
      .catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not create side thread.' }));
  };

  return (
    <div className="card" style={{ margin: '6px 16px' }}>
      <div className="flex wrap" style={{ gap: 8 }}>
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Thread title (e.g. Engineering escalation)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        <select className="input" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Anchor team (optional)">
          <option value="">No team</option>
          {(directory?.teams ?? []).map((t) => <option key={t.team_local_id} value={t.team_local_id}>{t.name}</option>)}
        </select>
      </div>
      <div className="flex wrap mt-8" style={{ gap: 6 }}>
        <span className="text-xs muted"><Users size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> participants:</span>
        {(directory?.users ?? []).map((u) => (
          <label key={u.user_local_id} className="text-xs" style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={participants.includes(u.user_local_id)}
              onChange={(e) => setParticipants((prev) => (e.target.checked ? [...prev, u.user_local_id] : prev.filter((p) => p !== u.user_local_id)))}
            />
            {u.display_name}
          </label>
        ))}
      </div>
      <MentionTextarea
        value={firstMessage}
        onChange={setFirstMessage}
        placeholder="First message (optional) — @mention teammates to pull them in"
        rows={3}
        style={{ marginTop: 8 }}
      />
      <div className="flex mt-8" style={{ gap: 6 }}>
        <button className="btn primary small" onClick={create} disabled={!title.trim()}>Create</button>
        <button className="btn small" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function SideThreadDetail({ threadId }: { threadId: number }): ReactNode {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [body, setBody] = useState('');
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['side-thread', threadId],
    queryFn: () => api.get<{ side_thread: SideThreadDetail }>(`/api/side-threads/${threadId}`)
  });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['side-thread', threadId] });
    void qc.invalidateQueries({ queryKey: ['side-threads'] });
  };

  const sendMessage = (): void => {
    const text = body.trim();
    if (!text) return;
    api.post<{ side_thread: SideThreadDetail }>(`/api/side-threads/${threadId}/messages`, { body: text })
      .then(() => {
        setBody('');
        refresh();
      })
      .catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Could not send message.' }));
  };

  const setStatus = (status: 'resolved' | 'open'): void => {
    api.post(`/api/side-threads/${threadId}/${status === 'resolved' ? 'resolve' : 'reopen'}`)
      .then(() => {
        pushToast({ kind: 'success', message: `Side thread ${status}.` });
        refresh();
      })
      .catch((e: unknown) => pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Status change failed.' }));
  };

  if (isLoading) return <Spinner label="Loading thread" />;
  if (isError || !data) return <ErrorState message="Could not load this side thread." detail={(error as Error | null)?.message} />;
  const t = data.side_thread;

  return (
    <div className="side-thread-detail">
      <div className="flex-between wrap" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <div className="flex wrap" style={{ gap: 6, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>{t.title}</strong>
          {t.team_name ? <span className="badge tag">{t.team_name}</span> : null}
          <span className={`badge ${t.status === 'open' ? 'warn' : 'ok'}`}>{t.status}</span>
          <button className="btn ghost small" onClick={() => setParticipantsOpen(!participantsOpen)}>
            <Users size={11} /> {t.participants.length}
          </button>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          {t.status === 'open' ? (
            <button className="btn small" onClick={() => setStatus('resolved')}><CheckCircle2 size={11} /> Resolve</button>
          ) : (
            <button className="btn small" onClick={() => setStatus('open')}><RotateCcw size={11} /> Reopen</button>
          )}
        </div>
      </div>
      {participantsOpen ? (
        <div className="flex wrap" style={{ padding: '6px 12px', gap: 6, borderBottom: '1px solid var(--border)' }}>
          {t.participants.map((p) => (
            <span key={p.user_local_id} className="badge tag" title={`added ${p.added_at}`}>
              {[p.first_name, p.last_name].filter(Boolean).join(' ')}
              {p.mention ? ` (@${p.mention})` : ''}
            </span>
          ))}
        </div>
      ) : null}
      <div className="side-thread-messages">
        {t.messages.map((m) => (
          <div key={m.id} className="side-thread-message">
            <div className="thread-head">
              <span className="thread-author">{[m.author_first_name, m.author_last_name].filter(Boolean).join(' ') || 'Unknown'}</span>
              <RelativeTime iso={m.created_at} />
            </div>
            <MentionBody body={m.body} />
          </div>
        ))}
        {t.messages.length === 0 ? <EmptyState title="No messages yet" /> : null}
      </div>
      {t.status === 'open' ? (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
          <MentionTextarea
            value={body}
            onChange={setBody}
            placeholder="Write to the team — @mentions notify instantly"
            rows={2}
            onSubmit={sendMessage}
          />
          <button className="btn primary small mt-8" onClick={sendMessage} disabled={!body.trim()}>
            <Send size={11} /> Send
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Plain-text body with @mention tokens highlighted (no HTML involved). */
export function MentionBody({ body }: { body: string }): ReactNode {
  const { data: directory } = useMentionDirectory();
  const known = new Set<string>();
  for (const u of directory?.users ?? []) {
    if (u.mention) known.add(u.mention.toLowerCase());
    const parts = u.display_name.toLowerCase().split(' ');
    if (parts[0]) known.add(parts[0]);
    known.add(u.display_name.toLowerCase().replace(/\s+/g, ''));
  }
  for (const t of directory?.teams ?? []) known.add(t.name.toLowerCase());
  const segments = body.split(/(@[A-Za-z0-9._-]+)/g);
  return (
    <div className="side-thread-body">
      {segments.map((s, i) =>
        s.startsWith('@') && known.has(s.slice(1).toLowerCase()) ? (
          <span key={i} className="mention-token">{s}</span>
        ) : (
          <span key={i}>{s}</span>
        )
      )}
    </div>
  );
}
