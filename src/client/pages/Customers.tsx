import { type ReactNode, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { Spinner, EmptyState, StatusBadge, RelativeTime, KV } from '../components/common/ui.js';
import type { CustomerSummary } from '../../shared/types.js';

export function CustomersPage(): ReactNode {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['customers', q, page],
    queryFn: () => api.get<{ customers: CustomerSummary[]; total: number }>(`/api/customers${qs({ q, page })}`)
  });
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Customers</h1>
          <p className="page-subtitle">{data?.total ?? '…'} customers in the local mirror</p>
        </div>
        <form className="searchbar" style={{ marginBottom: 0, width: 340 }} onSubmit={(e) => { e.preventDefault(); setPage(1); }}>
          <input className="input" placeholder="Search name or email…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search customers" />
          <button className="btn" type="submit"><Search size={13} /></button>
        </form>
      </div>
      {isLoading ? <Spinner /> : null}
      {data && data.customers.length === 0 ? <EmptyState icon="search" title="No customers found" /> : null}
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Email</th>
              <th>Organization</th>
              <th>Conversations</th>
              <th>Open</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {(data?.customers ?? []).map((c) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/customers/${c.id}`)}>
                <td>
                  <Link to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
                    {c.first_name} {c.last_name}
                  </Link>
                  {c.job_title ? <div className="text-xs muted">{c.job_title}</div> : null}
                </td>
                <td className="text-sm">{c.emails[0] ?? '—'}</td>
                <td className="text-sm">{c.organization_name ?? '—'}</td>
                <td><span className="badge">{c.conversation_count}</span></td>
                <td>{c.open_conversation_count > 0 ? <span className="badge active">{c.open_conversation_count}</span> : <span className="muted">0</span>}</td>
                <td><RelativeTime iso={c.last_activity_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 50 ? (
        <div className="flex mt-16" style={{ justifyContent: 'center', gap: 8 }}>
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="text-xs muted" style={{ alignSelf: 'center' }}>page {page}</span>
          <button className="btn small" disabled={data.customers.length < 50} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      ) : null}
    </div>
  );
}

interface CustomerDetailData {
  customer: CustomerSummary & { open_conversation_count: number };
  conversations: { id: number; number: number; subject: string | null; status: string; preview: string | null; remote_created_at: string | null; closed_at: string | null; assignee: string | null }[];
  ratings: { rating: string; comments: string | null; created_at: string | null; conversation_id: number | null }[];
  memories: { id: number; key: string; value: string; source: string; confidence: string; last_seen_at: string | null }[];
  properties: { name: string; value: string | null }[];
  websites: string[];
  social_profiles: { type: string | null; value: string | null }[];
  address: string | null;
  topics: { number: number; topic: string }[];
  resolutions: { number: number; subject: string | null; resolution: string | null; closed_at: string | null }[];
}

export function CustomerDetailPage(): ReactNode {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<CustomerDetailData>(`/api/customers/${id}`) });
  if (isLoading || !data) return <div className="page"><Spinner /></div>;
  const c = data.customer;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{c.first_name} {c.last_name}</h1>
          <p className="page-subtitle">
            {c.conversation_count} conversations · {c.open_conversation_count} open
            {c.organization_name ? ` · ${c.organization_name}` : ''}
            {c.average_rating != null ? ` · avg rating ${c.average_rating.toFixed(1)}` : ''}
          </p>
        </div>
        <Link to="/customers" className="btn">← All customers</Link>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">Contact</h3>
          {c.emails.map((e) => (
            <KV key={e} k="Email" v={<a href={`mailto:${e}`}>{e}</a>} />
          ))}
          {c.phones.map((p) => (
            <KV key={p} k="Phone" v={p} />
          ))}
          {data.address ? <KV k="Address" v={data.address} /> : null}
          {data.websites.map((w) => (
            <KV key={w} k="Website" v={<a href={w} target="_blank" rel="noopener noreferrer">{w}</a>} />
          ))}
          {data.social_profiles.map((s) => (
            <KV key={String(s.value)} k={s.type ?? 'Social'} v={s.value} />
          ))}
          {data.properties.map((p) => (
            <KV key={p.name} k={p.name} v={p.value ?? '—'} />
          ))}
        </div>
        <div className="card">
          <h3 className="card-title">AI customer memory</h3>
          <p className="text-xs muted" style={{ marginTop: 0 }}>AI-derived entries are clearly marked; they are not Help Scout data.</p>
          {data.memories.length === 0 ? <EmptyState icon="ai" title="No memories yet" hint="Memories are extracted by the local AI when analyzing this customer's tickets." /> : null}
          {data.memories.map((m) => (
            <div key={m.id} className="mb-8">
              <div className="flex-between">
                <strong className="text-sm">{m.key}</strong>
                <span className={`badge ${m.source === 'ai' ? 'ai' : 'ok'}`}>{m.source === 'ai' ? `AI-derived · confidence ${m.confidence}` : 'human-entered'}</span>
              </div>
              <div className="text-sm">{m.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card mt-16">
        <h3 className="card-title">Conversations</h3>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>Created</th>
              <th>Closed</th>
            </tr>
          </thead>
          <tbody>
            {data.conversations.map((conv) => (
              <tr key={conv.id} className="clickable" onClick={() => navigate(`/inbox/conversation/${conv.id}`)}>
                <td className="mono">{conv.number}</td>
                <td><Link to={`/inbox/conversation/${conv.id}`} onClick={(e) => e.stopPropagation()}>{conv.subject}</Link></td>
                <td><StatusBadge status={conv.status} /></td>
                <td className="text-sm">{conv.assignee ?? '—'}</td>
                <td><RelativeTime iso={conv.remote_created_at} /></td>
                <td><RelativeTime iso={conv.closed_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="card-title">Previous resolutions</h3>
          {data.resolutions.length === 0 ? <span className="muted text-sm">No closed conversations with replies yet.</span> : null}
          {data.resolutions.map((r) => (
            <div key={r.number} className="mb-8">
              <div className="flex-between">
                <strong className="text-sm">#{r.number} {r.subject}</strong>
                <RelativeTime iso={r.closed_at} />
              </div>
              <div className="text-xs muted">{(r.resolution ?? '').slice(0, 220)}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-title">Ratings received</h3>
          {data.ratings.length === 0 ? <span className="muted text-sm">No ratings synced.</span> : null}
          {data.ratings.map((r, i) => (
            <div key={i} className="flex" style={{ gap: 8, padding: '4px 0' }}>
              <span className={`badge ${r.rating === 'great' ? 'ok' : r.rating === 'okay' ? 'warn' : 'err'}`}>{r.rating}</span>
              <span className="text-sm grow">{r.comments ?? ''}</span>
              {r.conversation_id ? <Link to={`/inbox/conversation/${r.conversation_id}`} className="text-xs">#{r.conversation_id}</Link> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
