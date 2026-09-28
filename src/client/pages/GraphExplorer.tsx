import { type ReactNode, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { Spinner, EmptyState } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';
import { GRAPH_NODE_KINDS, GRAPH_NODE_KIND_LABELS, GRAPH_HUMAN_RELATIONS, GRAPH_HUMAN_RELATION_LABELS, type GraphNodeKind, type GraphStats, type GraphNeighbors, type GraphSearchResult, type GraphHumanEdge } from '../../shared/graph.js';

/**
 * Support Graph explorer (v2.2.0, plan Phase 34): a bounded, read-mostly
 * explorer over the relationship layer. Derived edges are computed live from
 * the local mirror (zero drift); only human-asserted edges are stored, and
 * the explorer is where they get created and removed.
 */
const ORIGIN_CLASS: Record<string, string> = {
  helpscout_mirror: 'badge',
  deterministic_local: 'badge',
  ai_derived: 'badge ai',
  human_local: 'badge ok'
};

/** Route links for node kinds that have a dedicated page. */
function nodeHref(kind: GraphNodeKind, localId: number): string | null {
  switch (kind) {
    case 'conversation': return `/inbox/conversation/${localId}`;
    case 'customer': return `/customers/${localId}`;
    case 'organization': return `/organizations/${localId}`;
    case 'incident': return `/incidents/${localId}`;
    default: return null;
  }
}

export function GraphExplorerPage(): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ kind: GraphNodeKind; local_id: number } | null>(null);
  const [edgeFormOpen, setEdgeFormOpen] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ['graph-stats'],
    queryFn: () => api.get<GraphStats>('/api/graph/stats')
  });

  const { data: searchResults, isFetching: searching } = useQuery({
    queryKey: ['graph-search', query],
    queryFn: () => api.get<{ results: GraphSearchResult[] }>(`/api/graph/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2
  });

  const { data: neighbors, isLoading: loadingNode } = useQuery({
    queryKey: ['graph-neighbors', selected?.kind, selected?.local_id],
    queryFn: () => api.get<GraphNeighbors>(`/api/graph/neighbors/${selected?.kind}/${selected?.local_id}`),
    enabled: selected != null
  });

  const { data: humanEdges } = useQuery({
    queryKey: ['graph-human-edges'],
    queryFn: () => api.get<{ edges: GraphHumanEdge[]; total: number }>('/api/graph/edges?limit=50')
  });

  const removeEdge = useMutation({
    mutationFn: (edgeId: number) => api.delete<{ ok: boolean }>(`/api/graph/edges/${edgeId}`),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Human edge removed.' });
      void queryClient.invalidateQueries({ queryKey: ['graph-human-edges'] });
      if (selected != null) void queryClient.invalidateQueries({ queryKey: ['graph-neighbors', selected.kind, selected.local_id] });
      void queryClient.invalidateQueries({ queryKey: ['graph-stats'] });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  const center = (kind: GraphNodeKind, localId: number): void => setSelected({ kind, local_id: localId });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Support Graph</h1>
        <p className="muted text-sm">The relationship layer between customers, organizations, conversations, issues, incidents, knowledge, agents, campaigns, products, custom objects and connector rows. Derived edges are computed live from the local mirror - they can never drift. Only human-asserted edges are stored.</p>
      </div>

      {stats ? (
        <div className="card mb-12">
          <div className="card-title">Live counts</div>
          <div className="graph-stat-chips wrap">
            {stats.nodes.map((n) => (
              <button key={n.kind} className="chip" title={`${n.count} ${n.label} nodes`}>
                {n.label}: <strong>{n.count}</strong>
              </button>
            ))}
          </div>
          <div className="graph-stat-chips wrap mt-8">
            {stats.edges.map((e, i) => (
              <span key={`${e.relation}-${i}`} className={`chip ${e.origin === 'human_local' ? 'chip-human' : e.origin === 'ai_derived' ? 'chip-ai' : ''}`} title={`${e.origin} · ${e.count}`}>
                {e.relation}: <strong>{e.count}</strong>
              </span>
            ))}
          </div>
          <div className="alert info text-xs mt-8">{stats.notes.join(' ')}</div>
        </div>
      ) : <Spinner />}

      <div className="card mb-12">
        <div className="card-title">Explore</div>
        <div className="flex gap-8 wrap">
          <input
            className="input"
            style={{ flex: '1 1 240px' }}
            placeholder="Search nodes (customer, org, conversation #, incident, product, campaign…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Graph search"
          />
        </div>
        {searching ? <Spinner /> : null}
        {searchResults && searchResults.results.length > 0 ? (
          <div className="graph-search-results mt-8">
            {searchResults.results.map((r) => (
              <button key={`${r.kind}-${r.local_id}`} className="graph-search-hit" onClick={() => { center(r.kind, r.local_id); setQuery(''); }}>
                <span className="badge">{GRAPH_NODE_KIND_LABELS[r.kind]}</span>
                <span className="text-sm">{r.label}</span>
                {r.sublabel ? <span className="muted text-xs">{r.sublabel}</span> : null}
              </button>
            ))}
          </div>
        ) : query.trim().length >= 2 && searchResults ? (
          <div className="muted text-xs mt-8">No matching nodes.</div>
        ) : null}
      </div>

      {selected != null ? (
        <div className="card mb-12">
          {loadingNode || !neighbors ? <Spinner /> : (
            <>
              <div className="flex between align-center">
                <div className="card-title">
                  <span className="badge">{GRAPH_NODE_KIND_LABELS[neighbors.node.kind]}</span> {neighbors.node.label}
                  {neighbors.node.sublabel ? <span className="muted text-xs"> · {neighbors.node.sublabel}</span> : null}
                  {neighbors.node.deleted ? <span className="badge err">deleted</span> : null}
                </div>
                <div className="flex gap-8">
                  {nodeHref(neighbors.node.kind, neighbors.node.local_id) ? (
                    <Link className="btn ghost small" to={nodeHref(neighbors.node.kind, neighbors.node.local_id)!}>Open page</Link>
                  ) : null}
                  <button className="btn ghost small" onClick={() => setSelected(null)}>Close</button>
                </div>
              </div>
              <div className="muted text-xs mt-4">
                {neighbors.total_edges} edge(s){neighbors.truncated ? ` (bounded to ${neighbors.edges.length} - expand from a specific neighbor)` : ''}
              </div>
              {neighbors.edges.length === 0 ? (
                <EmptyState title="No relationships" hint="Nothing links to this node yet. Derived edges appear automatically as data links up; human edges can be asserted below." />
              ) : (
                <div className="graph-edge-list mt-8">
                  {Object.entries(
                    neighbors.edges.reduce<Record<string, typeof neighbors.edges>>((acc, e) => {
                      (acc[e.relation] ??= []).push(e);
                      return acc;
                    }, {})
                  ).map(([relation, edges]) => (
                    <div key={relation} className="graph-edge-group">
                      <div className="text-xs muted">{relation.replaceAll('_', ' ')} ({edges.length})</div>
                      {edges.map((e, i) => {
                        const far = e.source.kind === neighbors.node.kind && e.source.local_id === neighbors.node.local_id ? e.target : e.source;
                        const outgoing = far === e.target;
                        const href = nodeHref(far.kind, far.local_id);
                        return (
                          <div key={`${relation}-${i}`} className="graph-edge-row">
                            <span className="muted">{outgoing ? '→' : '←'}</span>
                            <button className="btn ghost small" onClick={() => center(far.kind, far.local_id)} title="Re-center on this node">
                              <span className="badge">{GRAPH_NODE_KIND_LABELS[far.kind]}</span> {far.label}
                              {far.deleted ? <span className="badge err">deleted</span> : null}
                            </button>
                            {href ? <Link className="btn ghost small" to={href}>open</Link> : null}
                            <span className={`badge ${ORIGIN_CLASS[e.origin] ?? ''}`}>{e.origin.replace('_', ' ')}</span>
                            {e.note ? <span className="muted text-xs">{e.note.slice(0, 120)}</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              <div className="alert info text-xs mt-8">{neighbors.notes.join(' ')}</div>
            </>
          )}
        </div>
      ) : null}

      <div className="card">
        <div className="flex between align-center">
          <div className="card-title">Human-asserted edges ({humanEdges?.total ?? 0})</div>
          <button className="btn small" onClick={() => setEdgeFormOpen((v) => !v)}>{edgeFormOpen ? 'Cancel' : 'Assert an edge'}</button>
        </div>
        {edgeFormOpen ? <HumanEdgeForm onCreated={() => { void queryClient.invalidateQueries({ queryKey: ['graph-human-edges'] }); void queryClient.invalidateQueries({ queryKey: ['graph-stats'] }); if (selected != null) void queryClient.invalidateQueries({ queryKey: ['graph-neighbors', selected.kind, selected.local_id] }); }} /> : null}
        {humanEdges ? (
          humanEdges.edges.length === 0 ? (
            <div className="muted text-xs mt-8">No human edges yet. Derived relationships need none - assert one when PEOPLE know something the data does not (e.g. "this incident blocks that release").</div>
          ) : (
            <div className="mt-8 flex col gap-8">
              {humanEdges.edges.map((e) => (
                <div key={e.id} className="graph-edge-row">
                  <span className="badge ok">{GRAPH_HUMAN_RELATION_LABELS[e.relation] ?? e.relation}</span>
                  <button className="btn ghost small" onClick={() => center(e.source.kind, e.source.local_id)}>
                    <span className="badge">{GRAPH_NODE_KIND_LABELS[e.source.kind]}</span> {e.source.label}
                  </button>
                  <span className="muted">→</span>
                  <button className="btn ghost small" onClick={() => center(e.target.kind, e.target.local_id)}>
                    <span className="badge">{GRAPH_NODE_KIND_LABELS[e.target.kind]}</span> {e.target.label}
                  </button>
                  {e.note ? <span className="muted text-xs">{e.note.slice(0, 120)}</span> : null}
                  <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => removeEdge.mutate(e.id)} title="Remove this human edge">Remove</button>
                </div>
              ))}
            </div>
          )
        ) : <Spinner />}
      </div>
    </div>
  );
}

function HumanEdgeForm({ onCreated }: { onCreated: () => void }): ReactNode {
  const pushToast = useUiStore((s) => s.pushToast);
  const [sourceKind, setSourceKind] = useState<GraphNodeKind>('incident');
  const [sourceId, setSourceId] = useState('');
  const [targetKind, setTargetKind] = useState<GraphNodeKind>('campaign');
  const [targetId, setTargetId] = useState('');
  const [relation, setRelation] = useState<(typeof GRAPH_HUMAN_RELATIONS)[number]>('related_to');
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; edge: GraphHumanEdge }>('/api/graph/edges', {
        source_kind: sourceKind,
        source_local_id: Number(sourceId),
        target_kind: targetKind,
        target_local_id: Number(targetId),
        relation,
        note: note || null
      }),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Human edge asserted.' });
      setSourceId('');
      setTargetId('');
      setNote('');
      onCreated();
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <div className="graph-edge-form mt-8">
      <div className="flex gap-8 wrap">
        <select className="input" style={{ width: 170 }} value={sourceKind} onChange={(e) => setSourceKind(e.target.value as GraphNodeKind)} aria-label="Source kind">
          {GRAPH_NODE_KINDS.map((k) => <option key={k} value={k}>{GRAPH_NODE_KIND_LABELS[k]}</option>)}
        </select>
        <input className="input" style={{ width: 110 }} placeholder="local id" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source local id" />
        <span className="muted" style={{ alignSelf: 'center' }}>→</span>
        <select className="input" style={{ width: 170 }} value={relation} onChange={(e) => setRelation(e.target.value as (typeof GRAPH_HUMAN_RELATIONS)[number])} aria-label="Relation">
          {GRAPH_HUMAN_RELATIONS.map((r) => <option key={r} value={r}>{GRAPH_HUMAN_RELATION_LABELS[r]}</option>)}
        </select>
        <span className="muted" style={{ alignSelf: 'center' }}>→</span>
        <select className="input" style={{ width: 170 }} value={targetKind} onChange={(e) => setTargetKind(e.target.value as GraphNodeKind)} aria-label="Target kind">
          {GRAPH_NODE_KINDS.map((k) => <option key={k} value={k}>{GRAPH_NODE_KIND_LABELS[k]}</option>)}
        </select>
        <input className="input" style={{ width: 110 }} placeholder="local id" value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Target local id" />
      </div>
      <div className="flex gap-8 wrap mt-8">
        <input className="input" style={{ flex: '1 1 240px' }} placeholder="Note (why this relationship is known - optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-label="Edge note" />
        <button className="btn small primary" disabled={!Number.isInteger(Number(sourceId)) || Number(sourceId) <= 0 || !Number.isInteger(Number(targetId)) || Number(targetId) <= 0 || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Asserting…' : 'Assert edge'}
        </button>
      </div>
      <p className="muted text-xs mt-4">Both nodes must exist. Find local ids with the search above (each hit centers the node - its kind and id show in the panel title).</p>
    </div>
  );
}
