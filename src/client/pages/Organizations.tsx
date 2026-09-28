import { type ReactNode, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { Spinner, EmptyState, ErrorState, StatusBadge, RelativeTime, KV } from '../components/common/ui.js';
import { CustomerTimelineSection, SupportHealthSection } from '../components/common/WorkspaceSections.js';
import type { OrganizationSummary } from '../../shared/types.js';

export function OrganizationsPage(): ReactNode {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['organizations', q],
    queryFn: () => api.get<{ organizations: OrganizationSummary[]; total: number }>(`/api/organizations${qs({ q })}`)
  });
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Organizations</h1>
          <p className="page-subtitle">{data?.total ?? '…'} organizations</p>
        </div>
        <form className="searchbar" style={{ marginBottom: 0, width: 300 }} onSubmit={(e) => e.preventDefault()}>
          <input className="input" placeholder="Search organizations…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search organizations" />
          <button className="btn" type="submit"><Search size={13} /></button>
        </form>
      </div>
      {isLoading ? <Spinner /> : null}
      {error ? <ErrorState message="Could not load organizations" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} /> : null}
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Domains</th>
              <th>Customers</th>
              <th>Conversations</th>
            </tr>
          </thead>
          <tbody>
            {(data?.organizations ?? []).map((o) => (
              <tr key={o.id} className="clickable" onClick={() => navigate(`/organizations/${o.id}`)}>
                <td><Link to={`/organizations/${o.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>{o.name}</Link></td>
                <td className="text-sm">{o.domains.join(', ') || '—'}</td>
                <td><span className="badge">{o.customer_count}</span></td>
                <td><span className="badge">{o.conversation_count}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.organizations.length === 0 && !isLoading ? <EmptyState title="No organizations found" /> : null}
    </div>
  );
}

interface OrgDetail {
  organization: OrganizationSummary;
  customers: { id: number; first_name: string | null; last_name: string | null; emails: string[]; conversation_count: number; open_conversation_count: number }[];
  conversations: { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; customer: string }[];
  properties: { name: string; value: string | null }[];
}

export function OrganizationDetailPage(): ReactNode {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['organization', id], queryFn: () => api.get<OrgDetail>(`/api/organizations/${id}`) });
  if (error) return <div className="page"><ErrorState message="Could not load organization" detail={error instanceof Error ? error.message : 'The request failed. Retry or check the logs.'} /></div>;
  if (isLoading || !data) return <div className="page"><Spinner /></div>;
  const o = data.organization;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{o.name}</h1>
          <p className="page-subtitle">{o.customer_count} customers · {o.conversation_count} conversations {o.domains.length ? `· ${o.domains.join(', ')}` : ''}</p>
        </div>
        <Link to="/organizations" className="btn">← All organizations</Link>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">Customers</h3>
          {data.customers.map((c) => (
            <div key={c.id} className="flex-between" style={{ padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
              <Link to={`/customers/${c.id}`} style={{ fontWeight: 600 }}>{c.first_name} {c.last_name}</Link>
              <span className="text-xs muted">{c.emails[0] ?? ''} · {c.open_conversation_count} open / {c.conversation_count}</span>
            </div>
          ))}
          {data.customers.length === 0 ? <span className="muted text-sm">No linked customers.</span> : null}
        </div>
        <div className="card">
          <h3 className="card-title">Properties</h3>
          {data.properties.map((p) => (
            <KV key={p.name} k={p.name} v={p.value ?? '—'} />
          ))}
          {data.properties.length === 0 ? <span className="muted text-sm">No organization properties defined.</span> : null}
        </div>
      </div>
      <div className="card mt-16">
        <h3 className="card-title">Related conversations (drill-down: org → customer → conversation)</h3>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Subject</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.conversations.map((conv) => (
              <tr key={conv.id} className="clickable" onClick={() => navigate(`/inbox/conversation/${conv.id}`)}>
                <td className="mono">{conv.number}</td>
                <td><Link to={`/inbox/conversation/${conv.id}`} onClick={(e) => e.stopPropagation()}>{conv.subject}</Link></td>
                <td className="text-sm">{conv.customer}</td>
                <td><StatusBadge status={conv.status} /></td>
                <td><RelativeTime iso={conv.remote_created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.conversations.length === 0 ? <EmptyState title="No conversations for this organization" /> : null}
      </div>
      {/* v2.0.0 (M4): operational support health + the org-wide event timeline */}
      <SupportHealthSection subjectKind="organization" subjectId={Number(id)} />
      <CustomerTimelineSection subjectKind="organization" subjectId={Number(id)} />
    </div>
  );
}
