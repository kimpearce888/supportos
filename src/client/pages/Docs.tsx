import { type ReactNode, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookMarked, Search as SearchIcon, Eye, MessageCircle, Mail, FileText, Sparkles } from 'lucide-react';
import { useDocsStats, useDocsCollections, useDocsArticles, useDocsArticle, useDocsSearch } from '../api/hooks.js';
import { Spinner, EmptyState, ErrorState, RelativeTime } from '../components/common/ui.js';
import { Modal } from '../components/common/overlays.js';

/**
 * Docs page (v1.3.0): the local mirror of the Help Scout Docs API
 * (docsapi.helpscout.net). Searchable offline with FTS5; article stats
 * (views, status, last updated) surface what customers actually read.
 * Deep link: /docs?article=N opens the reader.
 */
export function DocsPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const articleParam = searchParams.get('article');
  const [reading, setReading] = useState<number | null>(articleParam != null && Number.isFinite(Number(articleParam)) ? Number(articleParam) : null);
  useEffect(() => {
    if (articleParam != null && Number.isFinite(Number(articleParam))) setReading(Number(articleParam));
  }, [articleParam]);
  const openArticle = (id: number): void => {
    setReading(id);
    const next = new URLSearchParams(searchParams);
    next.set('article', String(id));
    setSearchParams(next, { replace: true });
  };
  const closeArticle = (): void => {
    setReading(null);
    const next = new URLSearchParams(searchParams);
    next.delete('article');
    setSearchParams(next, { replace: true });
  };

  const collectionParam = searchParams.get('collection');
  const collectionId = collectionParam != null && Number.isFinite(Number(collectionParam)) ? Number(collectionParam) : null;
  const [q, setQ] = useState(searchParams.get('q') ?? '');
  const [status, setStatus] = useState<string | null>(searchParams.get('status'));
  // v1.4.0: hybrid search - semantic layer toggled on by default when available.
  const [semantic, setSemantic] = useState(searchParams.get('semantic') !== '0');

  const { data: stats, error: statsError } = useDocsStats();
  const { data: collections } = useDocsCollections();
  const { data: list, isLoading, error } = useDocsArticles(collectionId, q, status);
  const { data: search, isFetching: searching } = useDocsSearch(q, semantic);
  const { data: detail } = useDocsArticle(reading);

  if (statsError) return <div className="page"><ErrorState message="Could not load docs stats" detail={statsError instanceof Error ? statsError.message : 'The request failed.'} /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title"><BookMarked size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Docs</h1>
          <p className="page-subtitle">Your Help Scout Docs, mirrored locally from docsapi.helpscout.net · searchable offline · read-only</p>
        </div>
        <div className="flex" role="group" aria-label="Docs stats">
          <span className="badge">{stats?.collections ?? 0} collections</span>
          <span className="badge ok">{stats?.published ?? 0} published</span>
          <span className="badge">{stats?.drafts ?? 0} drafts</span>
          <span className="badge">{stats?.internal ?? 0} internal</span>
          <span className="badge">{(stats?.total_views ?? 0).toLocaleString()} views</span>
        </div>
      </div>

      {stats && stats.articles === 0 ? (
        <EmptyState
          icon="knowledge"
          title="No Docs mirrored yet"
          hint="Live mode: set HELPSCOUT_DOCS_API_KEY (Help Scout Docs uses a separate API key) and run a sync. Demo mode: complete the initial sync to load the sample Docs."
        />
      ) : null}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex wrap" style={{ gap: 8, alignItems: 'center' }}>
          <div className="flex" style={{ gap: 6, alignItems: 'center', flex: 1, minWidth: 260 }}>
            <SearchIcon size={14} className="muted" />
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="Search articles (hybrid: keywords + semantic when embeddings exist)"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                const next = new URLSearchParams(searchParams);
                if (e.target.value) next.set('q', e.target.value);
                else next.delete('q');
                setSearchParams(next, { replace: true });
              }}
            />
          </div>
          <button
            className={`btn small ${semantic ? 'primary' : ''}`}
            aria-pressed={semantic}
            onClick={() => {
              setSemantic(!semantic);
              const next = new URLSearchParams(searchParams);
              next.set('semantic', semantic ? '0' : '1');
              setSearchParams(next, { replace: true });
            }}
            title="Semantic retrieval adds vector similarity to keyword search"
          >
            <Sparkles size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} /> Semantic {search?.semantic_available ? '' : '(needs setup)'}
          </button>
          <div className="flex" role="group" aria-label="Status filter">
            <button className={`btn small ${status == null ? 'primary' : ''}`} onClick={() => setStatus(null)}>All</button>
            <button className={`btn small ${status === 'published' ? 'primary' : ''}`} onClick={() => setStatus('published')}>Published</button>
            <button className={`btn small ${status === 'draft' ? 'primary' : ''}`} onClick={() => setStatus('draft')}>Draft</button>
            <button className={`btn small ${status === 'internal' ? 'primary' : ''}`} onClick={() => setStatus('internal')}>Internal</button>
          </div>
        </div>
        {q.trim() && search ? (
          <div className="text-xs muted mt-8">
            {search.mode_note}{' '}
            {search.hits.length > 0 ? `· ${search.hits.length} result(s)` : ''}
            {searching ? ' · searching…' : ''}
          </div>
        ) : null}
        {q.trim() && stats && stats.docs_chunks ? (
          <div className="text-xs muted mt-8" style={{ opacity: 0.8 }}>
            Embeddings: {stats.docs_chunks_indexed ?? 0}/{stats.docs_chunks} chunks indexed
            {(stats.docs_chunks_pending ?? 0) > 0 ? ` · ${stats.docs_chunks_pending} pending` : ''}
            {(stats.docs_chunks_failed ?? 0) > 0 ? ` · ${stats.docs_chunks_failed} failed` : ''}
          </div>
        ) : null}
        <div className="flex wrap mt-8" style={{ gap: 6 }}>
          <button
            className={`btn small ${collectionId == null ? 'primary' : ''}`}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('collection');
              setSearchParams(next, { replace: true });
            }}
          >
            All collections
          </button>
          {(collections?.collections ?? []).map((c) => (
            <button
              key={c.id}
              className={`btn small ${collectionId === c.id ? 'primary' : ''}`}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set('collection', String(c.id));
                setSearchParams(next, { replace: true });
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorState message="Could not load articles" detail={error instanceof Error ? error.message : 'The request failed.'} /> : null}
      {isLoading && !q ? <Spinner label="Loading articles" /> : null}
      {!isLoading && !q && (list?.articles.length ?? 0) === 0 ? <EmptyState title="No articles" hint="Adjust the filters or run a sync with a Docs API key configured." /> : null}

      {q.trim() && search ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr><th>Article</th><th>Collection</th><th>Matched by</th><th>Score</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {search.hits.map((h) => (
                <tr key={h.article.id} className="clickable" onClick={() => openArticle(h.article.id)}>
                  <td>
                    <strong>{h.article.name}</strong>
                    {(h.matched_chunk ?? h.snippet) ? <div className="text-xs muted">{(h.matched_chunk ?? h.snippet)!.slice(0, 130)}…</div> : null}
                  </td>
                  <td>{h.article.collection_name ?? '—'}</td>
                  <td>
                    {h.why.map((w) => (
                      <span key={w} className={`badge ${w === 'semantic' ? 'ai' : 'ok'}`} style={{ marginRight: 4 }}>{w === 'semantic' ? 'semantic' : 'keyword'}</span>
                    ))}
                  </td>
                  <td className="text-xs">{h.score.toFixed(3)}</td>
                  <td><RelativeTime iso={h.article.remote_updated_at ?? h.article.remote_created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {search.hits.length === 0 ? <div style={{ padding: 14 }}><EmptyState title={`No articles match "${q}"`} hint="Keyword search covers titles and full text; semantic search adds meaning-based matches once embeddings exist." /></div> : null}
        </div>
      ) : !q ? (
      <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr><th>Article</th><th>Collection</th><th>Status</th><th>Views</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {(list?.articles ?? []).map((a) => (
                <tr key={a.id} className="clickable" onClick={() => openArticle(a.id)}>
                  <td>
                    <strong>{a.name}</strong>
                    {a.preview ? <div className="text-xs muted">{a.preview.slice(0, 110)}…</div> : null}
                  </td>
                  <td>{a.collection_name ?? '—'}{a.category_name ? <div className="text-xs muted">{a.category_name}</div> : null}</td>
                  <td>
                    <span className={`badge ${a.status === 'published' ? 'ok' : a.status === 'internal' ? 'warn' : ''}`}>{a.status ?? '—'}</span>
                  </td>
                  <td>{a.views != null ? a.views.toLocaleString() : '—'}</td>
                  <td><RelativeTime iso={a.remote_updated_at ?? a.remote_created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {stats && stats.articles > 0 ? (
        <div className="grid-2 mt-16">
          <div className="card">
            <h3 className="card-title">Channel mix (local mirror)</h3>
            <div className="flex-between" style={{ padding: '4px 0' }}>
              <span className="flex" style={{ gap: 6, alignItems: 'center' }}><Mail size={14} /> Email conversations</span>
              <span className="badge">{stats.email_conversations}</span>
            </div>
            <div className="flex-between" style={{ padding: '4px 0' }}>
              <span className="flex" style={{ gap: 6, alignItems: 'center' }}><MessageCircle size={14} /> Beacon chat sessions</span>
              <span className="badge ok">{stats.chat_sessions}</span>
            </div>
            <p className="text-xs muted mt-8">Chat sessions are mirrored as type=chat conversations with source via=beacon; the Inbox channel filter and Dashboard channel analytics use the same data.</p>
          </div>
          <div className="card">
            <h3 className="card-title">Collections</h3>
            {(collections?.collections ?? []).map((c) => (
              <div key={c.id} className="flex-between" style={{ padding: '4px 0' }}>
                <span>{c.name}</span>
                <span className="badge">{c.article_count ?? 0} articles</span>
              </div>
            ))}
            {(collections?.collections ?? []).length === 0 ? <span className="muted text-sm">No collections yet</span> : null}
            {stats.last_synced_at ? <p className="text-xs muted mt-8">Last docs sync: <RelativeTime iso={stats.last_synced_at} /></p> : null}
          </div>
        </div>
      ) : null}

      {reading != null && detail ? (
        <Modal title={detail.article.name} onClose={closeArticle} wide>
          <div className="flex wrap" style={{ gap: 6, marginBottom: 12 }}>
            <span className={`badge ${detail.article.status === 'published' ? 'ok' : detail.article.status === 'internal' ? 'warn' : ''}`}>{detail.article.status ?? '—'}</span>
            <span className="badge">{detail.article.collection_name ?? '—'}</span>
            {detail.article.category_name ? <span className="badge">{detail.article.category_name}</span> : null}
            {detail.article.views != null ? <span className="badge"><Eye size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {detail.article.views.toLocaleString()} views</span> : null}
            {detail.article.remote_updated_at ? <span className="badge">updated <RelativeTime iso={detail.article.remote_updated_at} /></span> : null}
          </div>
          <div className="text-sm" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {detail.article.text ?? <span className="muted">No text stored for this article.</span>}
          </div>
          <p className="text-xs muted mt-16"><FileText size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> Mirrored read-only from Help Scout Docs; edits happen in Help Scout and arrive on the next sync.</p>
        </Modal>
      ) : null}
    </div>
  );
}
