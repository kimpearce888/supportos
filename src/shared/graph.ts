/**
 * M6 shared contracts (v2.2.0): the Support Graph (plan Phase 34).
 *
 * Design decisions:
 * - The graph is a RELATIONSHIP LAYER over relational tables, not a graph
 *   database (plan: "Use relational tables/edges initially"). Derived edges
 *   are computed at read time from the existing mirror/link tables, so they
 *   can never drift from the data they describe. Only HUMAN edges are
 *   persisted (support_graph_edges) because a human judgment is information
 *   the database does not already contain.
 * - Node kinds form a CLOSED union. Every kind resolves to exactly one local
 *   table; identifiers are whitelisted per kind (never interpolated).
 * - Products are a deterministic registry: names are INSERT-OR-IGNORE'd from
 *   the product strings already stored on incidents, known issues, issue
 *   clusters and support cases. The registry never overwrites; a product
 *   disappears only when nothing references it and a human has not pinned it.
 * - Connector data has NO derived links by design (rows carry only row_key);
 *   humans may link rows explicitly, and the graph says so honestly.
 */

// ---------------- Phase 34: support graph ----------------

export const GRAPH_NODE_KINDS = [
  'customer',
  'organization',
  'conversation',
  'known_issue',
  'issue_cluster',
  'incident',
  'knowledge_document',
  'agent',
  'campaign',
  'product',
  'custom_object',
  'connector_data'
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_NODE_KIND_LABELS: Record<GraphNodeKind, string> = {
  customer: 'Customer',
  organization: 'Organization',
  conversation: 'Conversation',
  known_issue: 'Known issue',
  issue_cluster: 'Issue cluster',
  incident: 'Incident',
  knowledge_document: 'Knowledge document',
  agent: 'Agent',
  campaign: 'Campaign',
  product: 'Product',
  custom_object: 'Custom object',
  connector_data: 'Connector row'
};

/** Derived relation kinds (closed union; each maps to a concrete SQL branch). */
export const GRAPH_RELATIONS = [
  'belongs_to', // customer -> organization (mirror)
  'involves', // conversation -> customer (mirror)
  'assigned_to', // conversation -> agent (mirror)
  'owns', // agent -> incident (mirror)
  'linked_to_issue', // conversation <-> known_issue (human/ai link tables)
  'clustered_into', // conversation -> issue_cluster (derived)
  'promoted_to_issue', // issue_cluster -> known_issue (mirror field)
  'affected_by', // conversation <-> incident (link table)
  'related_to', // incident / human edge -> other nodes
  'linked_to', // custom object -> its six linkable kinds
  'sent_to', // campaign -> customer (outreach recipients)
  'generated_conversation', // campaign -> conversation (outreach sends)
  'cites', // conversation -> knowledge document (AI evidence sources)
  'gap_evidence', // conversation <-> knowledge document (gap candidates)
  'collaborated_on', // conversation -> agent (side thread participants)
  'about_product' // conversation/incident/known_issue/issue_cluster -> product
] as const;
export type GraphRelation = (typeof GRAPH_RELATIONS)[number];

/** Relations a HUMAN may assert explicitly (closed union). */
export const GRAPH_HUMAN_RELATIONS = ['related_to', 'depends_on', 'blocks', 'mentions', 'duplicate_of'] as const;
export type GraphHumanRelation = (typeof GRAPH_HUMAN_RELATIONS)[number];

export const GRAPH_HUMAN_RELATION_LABELS: Record<GraphHumanRelation, string> = {
  related_to: 'Related to',
  depends_on: 'Depends on',
  blocks: 'Blocks',
  mentions: 'Mentions',
  duplicate_of: 'Duplicate of'
};

/** Where an edge comes from - the graph never hides its own provenance. */
export type GraphEdgeOrigin = 'helpscout_mirror' | 'human_local' | 'ai_derived' | 'deterministic_local';

export interface GraphNodeRef {
  kind: GraphNodeKind;
  local_id: number;
  /** Human label (name, subject, code...) resolved in the same query batch. */
  label: string;
  /** Secondary label (organization, mailbox, status...) when useful. */
  sublabel: string | null;
  deleted: boolean;
}

export interface GraphEdge {
  relation: GraphRelation | GraphHumanRelation;
  origin: GraphEdgeOrigin;
  source: GraphNodeRef;
  target: GraphNodeRef;
  note: string | null;
  /** When the relationship was recorded (linked_at / created_at), ISO-ish. */
  at: string | null;
}

export interface GraphNeighbors {
  node: GraphNodeRef;
  edges: GraphEdge[];
  total_edges: number;
  truncated: boolean;
  notes: string[];
}

export interface GraphStats {
  generated_at: string;
  nodes: { kind: GraphNodeKind; label: string; count: number }[];
  edges: { relation: string; origin: GraphEdgeOrigin; count: number }[];
  human_edges: number;
  notes: string[];
}

export interface GraphSubgraph {
  seeds: GraphNodeRef[];
  nodes: GraphNodeRef[];
  edges: GraphEdge[];
  truncated: boolean;
  depth_reached: number;
  notes: string[];
}

export interface GraphSearchResult {
  kind: GraphNodeKind;
  local_id: number;
  label: string;
  sublabel: string | null;
  deleted: boolean;
}

export interface GraphHumanEdge {
  id: number;
  source: GraphNodeRef;
  target: GraphNodeRef;
  relation: GraphHumanRelation;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

/** Hard bounds shared by service + routes (plan Phase 41: bounded queries). */
export const GRAPH_MAX_NEIGHBOR_EDGES = 200;
export const GRAPH_MAX_SUBGRAPH_NODES = 250;
export const GRAPH_MAX_SUBGRAPH_DEPTH = 2;
export const GRAPH_MAX_SEARCH_PER_KIND = 10;
export const GRAPH_MAX_NODE_BATCH = 250;
