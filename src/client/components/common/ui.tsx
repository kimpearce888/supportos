import { type ReactNode } from 'react';
import { AlertTriangle, Inbox, Search, BookOpen, Bot, Sparkles, Megaphone, Shield, Users, Clock, Flame, Boxes, Plug, Bell, AtSign, MessageSquare } from 'lucide-react';

export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <div className="loading-block" role="status" aria-label={label ?? 'Loading'}>
      <span className="spinner" />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }): ReactNode {
  const icons: Record<string, ReactNode> = {
    inbox: <Inbox />,
    search: <Search />,
    knowledge: <BookOpen />,
    ai: <Bot />,
    sparkles: <Sparkles />,
    // v1.6.0 audit fix: these were referenced by Outreach/DNC/segments empty
    // states but missing from the map - the icons silently rendered as nothing.
    megaphone: <Megaphone />,
    shield: <Shield />,
    users: <Users />,
    // v2.2.1 audit fix: same class of bug - bot/clock/flame/boxes/plug/bell/
    // at/messages were referenced by AiCenter, Knowledge, WorkspaceSections,
    // Incidents, CustomObjects, Connectors, NotificationCenter and SideThreads
    // but were never in the map, so those empty states rendered without icons.
    bot: <Bot />,
    clock: <Clock />,
    flame: <Flame />,
    boxes: <Boxes />,
    plug: <Plug />,
    bell: <Bell />,
    at: <AtSign />,
    messages: <MessageSquare />
  };
  return (
    <div className="empty-state">
      {icons[icon ?? 'inbox']}
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
      {action ? <div className="mt-16">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, detail }: { message: string; detail?: string }): ReactNode {
  return (
    <div className="alert error" role="alert">
      <div className="flex" style={{ gap: 6 }}>
        <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          <div>{message}</div>
          {detail ? (
            <details style={{ marginTop: 6 }}>
              <summary className="text-xs muted" style={{ cursor: 'pointer' }}>
                Technical details
              </summary>
              <div className="mono" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                {detail}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// v1.6.0 audit fix: external URLs from API data must be scheme-checked before
// becoming hrefs (a javascript: value from a compromised upstream would render
// as a clickable script link). Only http/https/mailto pass; others -> undefined.
export function safeExternalHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const cls = status === 'active' ? 'active' : status === 'pending' ? 'pending' : status === 'spam' ? 'spam' : 'closed';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function TagChips({ tags, onRemove }: { tags: string[]; onRemove?: (t: string) => void }): ReactNode {
  if (tags.length === 0) return <span className="muted text-xs">no tags</span>;
  return (
    <span className="flex wrap" style={{ gap: 4 }}>
      {tags.map((t) => (
        <span key={t} className="badge tag">
          {t}
          {onRemove ? (
            <button className="btn ghost small" style={{ padding: '0 2px' }} aria-label={`Remove tag ${t}`} onClick={() => onRemove(t)}>
              ×
            </button>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function ConfidenceBadge({ level }: { level: string | null }): ReactNode {
  const map: Record<string, string> = { high: 'ok', medium: 'warn', low: 'warn', unknown: '' };
  return <span className={`badge ${map[level ?? 'unknown'] ?? ''}`} title="Operational confidence based on evidence quality - not a probability">confidence: {level ?? 'unknown'}</span>;
}

export function VerifiedBadge({ verified }: { verified: boolean | null }): ReactNode {
  if (verified === null) return <span className="badge">unverified</span>;
  return verified ? <span className="badge ok">verified</span> : <span className="badge err">verification failed</span>;
}

export function RelativeTime({ iso, prefix }: { iso: string | null | undefined; prefix?: string }): ReactNode {
  if (!iso) return <span className="muted">—</span>;
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  const abs = Math.abs(mins);
  let label: string;
  if (abs < 1) label = 'just now';
  else if (abs < 60) label = `${abs}m`;
  else if (abs < 1440) label = `${Math.round(abs / 60)}h`;
  else if (abs < 43200) label = `${Math.round(abs / 1440)}d`;
  else label = d.toLocaleDateString();
  if (mins < 0 && abs >= 1) label = `in ${label}`;
  return (
    <time dateTime={iso} title={d.toLocaleString()} className="muted text-xs">
      {prefix}
      {label}
    </time>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }): ReactNode {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span>{v}</span>
    </div>
  );
}

export function ProgressBar({ value }: { value: number }): ReactNode {
  return (
    <div className="progressbar" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div className="fill" style={{ width: `${Math.min(100, Math.round(value * 100))}%` }} />
    </div>
  );
}
