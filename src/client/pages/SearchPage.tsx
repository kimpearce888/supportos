import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Filter } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, EmptyState, ErrorState } from '../components/common/ui.js';
import type { SearchResponse, SearchScope } from '../../shared/types.js';

/** Escape untrusted snippet text, then apply FTS highlight markers ([ ] -> <mark>). */
function escapeSnippet(snippet: string): string {
  const escaped = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return escaped.replace(/\[|\]/g, (m) => (m === '[' ? '<mark>' : '</mark>'));
}

const SCOPES: { key: SearchScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'customers', label: 'Customers' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'issues', label: 'Issues' },
  { key: 'saved_replies', label: 'Saved Replies' },
  { key: 'ai', label: 'AI' }
];

export function SearchPage(): ReactNode {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [submitted, setSubmitted] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<{ status: string; tag: string; mailbox: string; sinceDays: string }>({ status: '', tag: '', mailbox: '', sinceDays: '' });
  const navigate = useNavigate();

  // v1.6.0 audit fix: the POST-based search query had no error state - a failed
  // search silently blanked the page (a 429 from the mutation rate limit is
  // realistic mid-session).
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search', submitted, scope, filters],
    queryFn: () =>
      api.post<SearchResponse>('/api/search', {
        query: submitted,
        scope,
        filters: {
          status: filters.status || undefined,
          tag: filters.tag || undefined,
          mailbox_id: filters.mailbox ? Number(filters.mailbox) : undefined,
          since_days: filters.sinceDays ? Number(filters.sinceDays) : undefined
        }
      }),
    enabled: submitted.length > 0
  });

  const { data: mailboxes } = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/mailboxes') });

  const examples = ['Chile timezone', 'invitation email', 'card declined', 'Slack integration', 'viewer permissions'];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Search</h1>
          <p className="page-subtitle">Full-text across tickets, threads, customers, knowledge, known issues, saved replies and AI analyses</p>
        </div>
      </div>
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query);
        }}
        role="search"
      >
        <input className="input" style={{ fontSize: 15, padding: 10 }} placeholder="Search… (exact conversation numbers also work)" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Search query" />
        <button className="btn primary" type="submit">
          <SearchIcon size={13} /> Search
        </button>
        <button className="btn" type="button" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          <Filter size={13} /> Filters
        </button>
      </form>
      {showFilters ? (
        <div className="card mb-16" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="field" htmlFor="f-status">Status</label>
            <select id="f-status" className="input" style={{ width: 130 }} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
              <option value="spam">Spam</option>
            </select>
          </div>
          <div>
            <label className="field" htmlFor="f-mailbox">Inbox</label>
            <select id="f-mailbox" className="input" style={{ width: 150 }} value={filters.mailbox} onChange={(e) => setFilters((f) => ({ ...f, mailbox: e.target.value }))}>
              <option value="">Any</option>
              {(mailboxes ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field" htmlFor="f-tag">Tag</label>
            <input id="f-tag" className="input" style={{ width: 140 }} placeholder="e.g. timezone" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} />
          </div>
          <div>
            <label className="field" htmlFor="f-since">Since</label>
            <select id="f-since" className="input" style={{ width: 130 }} value={filters.sinceDays} onChange={(e) => setFilters((f) => ({ ...f, sinceDays: e.target.value }))}>
              <option value="">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
            </select>
          </div>
        </div>
      ) : null}
      <div className="tabs">
        {SCOPES.map((s) => (
          <button key={s.key} className={`tab ${scope === s.key ? 'active' : ''}`} onClick={() => setScope(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      {!submitted ? (
        <EmptyState
          icon="search"
          title="Search your local support archive"
          hint={
            <span>
              Try:{' '}
              {examples.map((ex) => (
                <button key={ex} className="btn ghost small" style={{ marginRight: 4 }} onClick={() => { setQuery(ex); setSubmitted(ex); }}>
                  {ex}
                </button>
              ))}
            </span> as unknown as string
          }
        />
      ) : null}
      {isFetching ? <Spinner label="Searching" /> : null}
      {isError ? <ErrorState message="Search failed." detail={error instanceof Error ? error.message : undefined} /> : null}
      {data?.used_semantic === false && data?.semantic_available === true ? <div className="alert info">Semantic search unavailable right now - showing keyword (FTS) results.</div> : null}
      {data && !data.semantic_available && submitted ? <div className="alert info">Keyword search (FTS5). Enable Qdrant + an embedding model for semantic matching.</div> : null}
      {(data?.hits ?? []).map((hit) => (
        <div key={`${hit.scope}-${hit.id}`} className="search-hit" onClick={() => navigate(hit.href)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(hit.href)}>
          <div className="flex-between">
            <span className="hit-title">
              <span className="badge" style={{ marginRight: 6 }}>{hit.scope}</span>
              {hit.title}
            </span>
            <span className="text-xs muted">{hit.subtitle}</span>
          </div>
          {hit.snippet ? (
            <div
              className="hit-snippet"
              dangerouslySetInnerHTML={{
                __html: escapeSnippet(hit.snippet)
              }}
            />
          ) : null}
          <div className="hit-why">
            {hit.why.map((w) => (
              <span key={w} className="badge">{w}</span>
            ))}
          </div>
        </div>
      ))}
      {data && data.hits.length === 0 && submitted && !isFetching && !isError ? <EmptyState icon="search" title={`No results for “${submitted}”`} hint="Try fewer words, another scope, or check the filters." /> : null}
      {data && data.hits.length > 0 ? (
        <p className="text-xs muted">
          {data.total} results · {data.used_semantic ? 'hybrid (keyword + semantic)' : 'keyword (FTS5)'} · <Link to="/inbox">back to inbox</Link>
        </p>
      ) : null}
    </div>
  );
}
