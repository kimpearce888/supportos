import type { DB } from '../database/connection.js';
import {
  GRAPH_NODE_KINDS, GRAPH_NODE_KIND_LABELS, GRAPH_HUMAN_RELATIONS,
  GRAPH_MAX_NEIGHBOR_EDGES, GRAPH_MAX_SUBGRAPH_NODES, GRAPH_MAX_SUBGRAPH_DEPTH, GRAPH_MAX_SEARCH_PER_KIND,
  type GraphNodeKind, type GraphEdge, type GraphEdgeOrigin, type GraphNodeRef, type GraphNeighbors,
  type GraphStats, type GraphSubgraph, type GraphSearchResult, type GraphHumanEdge, type GraphHumanRelation
} from '../../shared/graph.js';

/**
 * Support graph service (v2.2.0 / M6, plan Phase 34).
 *
 * The graph is a read-time RELATIONSHIP LAYER: derived edges are computed
 * from the existing mirror/link tables (zero drift - there is no second copy
 * of any relationship to go stale), and only HUMAN-asserted edges are
 * persisted. Node kinds form a closed union, so every SQL branch below is a
 * constant string; the only bound parameter is the node id. Every branch is
 * bounded (LIMIT) and resolves node labels in the SAME query, so neighbors()
 * never degrades into N+1 label lookups (plan Phase 41).
 *
 * Honesty rules embedded in the data:
 * - Connector rows have NO derived links (their rows carry only row_key);
 *   humans may link them explicitly and stats() says so.
 * - about_product edges from conversations are AI-derived evidence (labeled
 *   with the attribute layer's confidence), never silent.
 * - link origins carry the link table's own provenance (human vs AI vs
 *   deterministic), never a guess.
 */

interface EdgeRow {
  relation: string;
  origin: GraphEdgeOrigin;
  note: string | null;
  at: string | null;
  // endpoint columns (the non-fixed side of the branch)
  kind: GraphNodeKind;
  local_id: number;
  label: string;
  sublabel: string | null;
  deleted: number;
}

interface Branch {
  relation: string;
  sourceKind: GraphNodeKind;
  targetKind: GraphNodeKind;
  /** Parameter binds the SOURCE node id; selects target refs. */
  fromSql: string;
  /** Parameter binds the TARGET node id; selects source refs. */
  toSql: string;
}

// ---- label expression fragments (shared across branches) ----
const L = {
  customer: (a = 'cu') => `COALESCE(NULLIF(TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, '')), ''), 'Customer #' || ${a}.id)`,
  user: (a = 'u') => `COALESCE(NULLIF(TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, '')), ''), 'User #' || ${a}.id)`,
  conversation: (a = 'c') => `'#' || ${a}.number || ' ' || COALESCE(SUBSTR(${a}.subject, 1, 100), '(no subject)')`,
  incident: (a = 'i') => `${a}.code || ' ' || ${a}.title`
};

const BRANCH_LIMIT = GRAPH_MAX_NEIGHBOR_EDGES;

/**
 * Derived edge branches. Column contract for BOTH directions:
 *   relation, origin, note, at, kind, local_id, label, sublabel, deleted
 * where kind/local_id/... describe the OPPOSITE endpoint of the bound node.
 */
const BRANCHES: Branch[] = [
  // customer -> organization (mirror)
  {
    relation: 'belongs_to', sourceKind: 'customer', targetKind: 'organization',
    fromSql: `SELECT 'belongs_to' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'organization' kind, o.id local_id, o.name label, o.domains sublabel, (o.deleted_at IS NOT NULL) deleted
      FROM customers cu JOIN organizations o ON o.id = cu.organization_id
      WHERE cu.id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'belongs_to' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'customer' kind, cu.id local_id, ${L.customer()} label, NULL sublabel, (cu.deleted_at IS NOT NULL) deleted
      FROM customers cu WHERE cu.organization_id = ? AND cu.deleted_at IS NULL LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> customer (mirror)
  {
    relation: 'involves', sourceKind: 'conversation', targetKind: 'customer',
    fromSql: `SELECT 'involves' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'customer' kind, cu.id local_id, ${L.customer()} label, o.name sublabel, (cu.deleted_at IS NOT NULL) deleted
      FROM conversations c JOIN customers cu ON cu.id = c.customer_local_id
        LEFT JOIN organizations o ON o.id = cu.organization_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND c.customer_local_id IS NOT NULL LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'involves' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM conversations c WHERE c.customer_local_id = ? AND c.deleted_at IS NULL LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> agent assignee (mirror)
  {
    relation: 'assigned_to', sourceKind: 'conversation', targetKind: 'agent',
    fromSql: `SELECT 'assigned_to' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'agent' kind, u.id local_id, ${L.user()} label, u.email sublabel, (u.deleted_at IS NOT NULL) deleted
      FROM conversations c JOIN users u ON u.id = c.assignee_local_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND c.assignee_local_id IS NOT NULL LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'assigned_to' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM conversations c WHERE c.assignee_local_id = ? AND c.deleted_at IS NULL LIMIT ${BRANCH_LIMIT}`
  },
  // agent -> incident owner (mirror)
  {
    relation: 'owns', sourceKind: 'agent', targetKind: 'incident',
    fromSql: `SELECT 'owns' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incidents i WHERE i.owner_user_local_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'owns' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'agent' kind, u.id local_id, ${L.user()} label, u.email sublabel, (u.deleted_at IS NOT NULL) deleted
      FROM incidents i JOIN users u ON u.id = i.owner_user_local_id
      WHERE i.id = ? AND i.owner_user_local_id IS NOT NULL LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> known issue (link table; origin from its own provenance)
  {
    relation: 'linked_to_issue', sourceKind: 'conversation', targetKind: 'known_issue',
    fromSql: `SELECT 'linked_to_issue' relation,
        CASE WHEN kic.source = 'human' THEN 'human_local' ELSE 'ai_derived' END origin,
        NULL note, kic.linked_at at,
        'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
      FROM known_issue_conversations kic JOIN known_issues ki ON ki.id = kic.known_issue_id
      WHERE kic.conversation_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to_issue' relation,
        CASE WHEN kic.source = 'human' THEN 'human_local' ELSE 'ai_derived' END origin,
        NULL note, kic.linked_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM known_issue_conversations kic JOIN conversations c ON c.id = kic.conversation_id
      WHERE kic.known_issue_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> issue cluster (derived)
  {
    relation: 'clustered_into', sourceKind: 'conversation', targetKind: 'issue_cluster',
    fromSql: `SELECT 'clustered_into' relation, 'deterministic_local' origin, NULL note, icc.assigned_at at,
        'issue_cluster' kind, ic.id local_id, ic.title label, 'cluster' sublabel, 0 deleted
      FROM issue_cluster_conversations icc JOIN issue_clusters ic ON ic.id = icc.cluster_id
      WHERE icc.conversation_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'clustered_into' relation, 'deterministic_local' origin, NULL note, icc.assigned_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id
      WHERE icc.cluster_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // issue cluster -> known issue (mirror field)
  {
    relation: 'promoted_to_issue', sourceKind: 'issue_cluster', targetKind: 'known_issue',
    fromSql: `SELECT 'promoted_to_issue' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
      FROM issue_clusters ic JOIN known_issues ki ON ki.id = ic.known_issue_id
      WHERE ic.id = ? AND ic.known_issue_id IS NOT NULL LIMIT 1`,
    toSql: `SELECT 'promoted_to_issue' relation, 'helpscout_mirror' origin, NULL note, NULL at,
        'issue_cluster' kind, ic.id local_id, ic.title label, 'cluster' sublabel, 0 deleted
      FROM issue_clusters ic WHERE ic.known_issue_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> incident (link table; origin from linked_by)
  {
    relation: 'affected_by', sourceKind: 'conversation', targetKind: 'incident',
    fromSql: `SELECT 'affected_by' relation,
        CASE WHEN iconv.linked_by = 'human' THEN 'human_local' ELSE 'deterministic_local' END origin,
        NULL note, iconv.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incident_conversations iconv JOIN incidents i ON i.id = iconv.incident_id
      WHERE iconv.conversation_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'affected_by' relation,
        CASE WHEN iconv.linked_by = 'human' THEN 'human_local' ELSE 'deterministic_local' END origin,
        NULL note, iconv.linked_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM incident_conversations iconv JOIN conversations c ON c.id = iconv.conversation_id
      WHERE iconv.incident_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // customer -> incident (derived: affected via their conversations)
  {
    relation: 'affected_by', sourceKind: 'customer', targetKind: 'incident',
    fromSql: `SELECT 'affected_by' relation, 'deterministic_local' origin,
        'via conversation #' || c.number note, iconv.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM customers cu
        JOIN conversations c ON c.customer_local_id = cu.id AND c.deleted_at IS NULL
        JOIN incident_conversations iconv ON iconv.conversation_id = c.id
        JOIN incidents i ON i.id = iconv.incident_id
      WHERE cu.id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'affected_by' relation, 'deterministic_local' origin,
        'via conversation #' || c.number note, iconv.linked_at at,
        'customer' kind, cu.id local_id, ${L.customer()} label, NULL sublabel, (cu.deleted_at IS NOT NULL) deleted
      FROM incident_conversations iconv
        JOIN conversations c ON c.id = iconv.conversation_id AND c.deleted_at IS NULL
        JOIN customers cu ON cu.id = c.customer_local_id
      WHERE iconv.incident_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // organization -> incident (derived: via member customers' conversations)
  {
    relation: 'affected_by', sourceKind: 'organization', targetKind: 'incident',
    fromSql: `SELECT 'affected_by' relation, 'deterministic_local' origin,
        'via customer ' || TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) note, iconv.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM organizations o
        JOIN customers cu ON cu.organization_id = o.id
        JOIN conversations c ON c.customer_local_id = cu.id AND c.deleted_at IS NULL
        JOIN incident_conversations iconv ON iconv.conversation_id = c.id
        JOIN incidents i ON i.id = iconv.incident_id
      WHERE o.id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'affected_by' relation, 'deterministic_local' origin,
        'via customer ' || TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) note, iconv.linked_at at,
        'organization' kind, o.id local_id, o.name label, o.domains sublabel, (o.deleted_at IS NOT NULL) deleted
      FROM incident_conversations iconv
        JOIN conversations c ON c.id = iconv.conversation_id AND c.deleted_at IS NULL
        JOIN customers cu ON cu.id = c.customer_local_id
        JOIN organizations o ON o.id = cu.organization_id
      WHERE iconv.incident_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // incident -> known_issue | knowledge_document | campaign | custom_object (human)
  {
    relation: 'related_to', sourceKind: 'incident', targetKind: 'known_issue',
    fromSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
      FROM incident_related irel JOIN known_issues ki ON ki.id = irel.target_local_id
      WHERE irel.incident_id = ? AND irel.target_kind = 'known_issue' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incident_related irel JOIN incidents i ON i.id = irel.incident_id
      WHERE irel.target_kind = 'known_issue' AND irel.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'related_to', sourceKind: 'incident', targetKind: 'knowledge_document',
    fromSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'knowledge_document' kind, kd.id local_id, kd.title label, kd.visibility sublabel, 0 deleted
      FROM incident_related irel JOIN knowledge_documents kd ON kd.id = irel.target_local_id
      WHERE irel.incident_id = ? AND irel.target_kind = 'knowledge_doc' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incident_related irel JOIN incidents i ON i.id = irel.incident_id
      WHERE irel.target_kind = 'knowledge_doc' AND irel.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'related_to', sourceKind: 'incident', targetKind: 'campaign',
    fromSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'campaign' kind, oc.id local_id, oc.name label, oc.status sublabel, 0 deleted
      FROM incident_related irel JOIN outreach_campaigns oc ON oc.id = irel.target_local_id
      WHERE irel.incident_id = ? AND irel.target_kind = 'campaign' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incident_related irel JOIN incidents i ON i.id = irel.incident_id
      WHERE irel.target_kind = 'campaign' AND irel.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'related_to', sourceKind: 'incident', targetKind: 'custom_object',
    fromSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM incident_related irel
        JOIN custom_objects co ON co.id = irel.target_local_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE irel.incident_id = ? AND irel.target_kind = 'custom_object' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'related_to' relation, 'human_local' origin, irel.note note, irel.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incident_related irel JOIN incidents i ON i.id = irel.incident_id
      WHERE irel.target_kind = 'custom_object' AND irel.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // custom object -> customer | organization | conversation | known_issue | incident | campaign (human)
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'customer',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'customer' kind, cu.id local_id, ${L.customer()} label, NULL sublabel, (cu.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col JOIN customers cu ON cu.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'customer' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'customer' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'organization',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'organization' kind, o.id local_id, o.name label, o.domains sublabel, (o.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col JOIN organizations o ON o.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'organization' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'organization' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'conversation',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col JOIN conversations c ON c.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'conversation' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'conversation' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'known_issue',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
      FROM custom_object_links col JOIN known_issues ki ON ki.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'known_issue' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'known_issue' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'incident',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM custom_object_links col JOIN incidents i ON i.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'incident' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'incident' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  {
    relation: 'linked_to', sourceKind: 'custom_object', targetKind: 'campaign',
    fromSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'campaign' kind, oc.id local_id, oc.name label, oc.status sublabel, 0 deleted
      FROM custom_object_links col JOIN outreach_campaigns oc ON oc.id = col.target_local_id
      WHERE col.object_id = ? AND col.target_kind = 'campaign' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'linked_to' relation, 'human_local' origin, col.note note, col.linked_at at,
        'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
      FROM custom_object_links col
        JOIN custom_objects co ON co.id = col.object_id
        JOIN custom_object_types cot ON cot.id = co.type_id
      WHERE col.target_kind = 'campaign' AND col.target_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // campaign -> customer (outreach recipients, mirror)
  {
    relation: 'sent_to', sourceKind: 'campaign', targetKind: 'customer',
    fromSql: `SELECT 'sent_to' relation, 'helpscout_mirror' origin, ore.state note, ore.sent_at at,
        'customer' kind, cu.id local_id, ${L.customer()} label, NULL sublabel, (cu.deleted_at IS NOT NULL) deleted
      FROM outreach_campaigns oc JOIN outreach_recipients ore ON ore.campaign_id = oc.id
        JOIN customers cu ON cu.id = ore.customer_local_id
      WHERE oc.id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'sent_to' relation, 'helpscout_mirror' origin, ore.state note, ore.sent_at at,
        'campaign' kind, oc.id local_id, oc.name label, oc.status sublabel, 0 deleted
      FROM outreach_recipients ore JOIN outreach_campaigns oc ON oc.id = ore.campaign_id
      WHERE ore.customer_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // campaign -> conversation it generated (mirror; only rows with a HS conversation)
  {
    relation: 'generated_conversation', sourceKind: 'campaign', targetKind: 'conversation',
    fromSql: `SELECT 'generated_conversation' relation, 'helpscout_mirror' origin, NULL note, ore.sent_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM outreach_campaigns oc
        JOIN outreach_recipients ore ON ore.campaign_id = oc.id AND ore.hs_conversation_remote_id IS NOT NULL
        JOIN conversations c ON c.remote_id = ore.hs_conversation_remote_id
      WHERE oc.id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'generated_conversation' relation, 'helpscout_mirror' origin, oc.name note, ore.sent_at at,
        'campaign' kind, oc.id local_id, oc.name label, oc.status sublabel, 0 deleted
      FROM conversations c
        JOIN outreach_recipients ore ON ore.hs_conversation_remote_id = c.remote_id
        JOIN outreach_campaigns oc ON oc.id = ore.campaign_id
      WHERE c.id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> knowledge document (AI evidence sources)
  {
    relation: 'cites', sourceKind: 'conversation', targetKind: 'knowledge_document',
    fromSql: `SELECT 'cites' relation, 'ai_derived' origin, asrc.title note, asrc.timestamp at,
        'knowledge_document' kind, kd.id local_id, kd.title label, kd.visibility sublabel, 0 deleted
      FROM ai_runs ar
        JOIN ai_sources asrc ON asrc.run_id = ar.id AND asrc.source_type = 'knowledge_document'
        JOIN knowledge_documents kd ON kd.id = asrc.source_id
      WHERE ar.conversation_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'cites' relation, 'ai_derived' origin, asrc.title note, asrc.timestamp at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM ai_sources asrc
        JOIN ai_runs ar ON ar.id = asrc.run_id
        JOIN conversations c ON c.id = ar.conversation_id
      WHERE asrc.source_type = 'knowledge_document' AND asrc.source_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> agent (side thread participants, human)
  {
    relation: 'collaborated_on', sourceKind: 'conversation', targetKind: 'agent',
    fromSql: `SELECT 'collaborated_on' relation, 'human_local' origin, st.title note, st.created_at at,
        'agent' kind, u.id local_id, ${L.user()} label, u.email sublabel, (u.deleted_at IS NOT NULL) deleted
      FROM side_threads st
        JOIN side_thread_participants stp ON stp.side_thread_id = st.id
        JOIN users u ON u.id = stp.user_local_id
      WHERE st.conversation_id = ? LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'collaborated_on' relation, 'human_local' origin, st.title note, st.created_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM side_thread_participants stp
        JOIN side_threads st ON st.id = stp.side_thread_id
        JOIN conversations c ON c.id = st.conversation_id
      WHERE stp.user_local_id = ? LIMIT ${BRANCH_LIMIT}`
  },
  // incident -> product (registry match)
  {
    relation: 'about_product', sourceKind: 'incident', targetKind: 'product',
    fromSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'product' kind, p.id local_id, p.name label, p.description sublabel, 0 deleted
      FROM incidents i JOIN products p ON p.name COLLATE NOCASE = TRIM(i.product)
      WHERE i.id = ? AND i.product IS NOT NULL AND TRIM(i.product) != '' LIMIT 1`,
    toSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
      FROM incidents i JOIN products p ON p.name COLLATE NOCASE = TRIM(i.product)
      WHERE p.id = ? AND i.product IS NOT NULL AND TRIM(i.product) != '' LIMIT ${BRANCH_LIMIT}`
  },
  // known issue -> product
  {
    relation: 'about_product', sourceKind: 'known_issue', targetKind: 'product',
    fromSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'product' kind, p.id local_id, p.name label, p.description sublabel, 0 deleted
      FROM known_issues ki JOIN products p ON p.name COLLATE NOCASE = TRIM(ki.product)
      WHERE ki.id = ? AND ki.product IS NOT NULL AND TRIM(ki.product) != '' LIMIT 1`,
    toSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
      FROM known_issues ki JOIN products p ON p.name COLLATE NOCASE = TRIM(ki.product)
      WHERE p.id = ? AND ki.product IS NOT NULL AND TRIM(ki.product) != '' LIMIT ${BRANCH_LIMIT}`
  },
  // issue cluster -> product
  {
    relation: 'about_product', sourceKind: 'issue_cluster', targetKind: 'product',
    fromSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'product' kind, p.id local_id, p.name label, p.description sublabel, 0 deleted
      FROM issue_clusters ic JOIN products p ON p.name COLLATE NOCASE = TRIM(ic.product)
      WHERE ic.id = ? AND ic.product IS NOT NULL AND TRIM(ic.product) != '' LIMIT 1`,
    toSql: `SELECT 'about_product' relation, 'deterministic_local' origin, NULL note, NULL at,
        'issue_cluster' kind, ic.id local_id, ic.title label, 'cluster' sublabel, 0 deleted
      FROM issue_clusters ic JOIN products p ON p.name COLLATE NOCASE = TRIM(ic.product)
      WHERE p.id = ? AND ic.product IS NOT NULL AND TRIM(ic.product) != '' LIMIT ${BRANCH_LIMIT}`
  },
  // conversation -> product (AI attribute evidence, honestly labeled)
  {
    relation: 'about_product', sourceKind: 'conversation', targetKind: 'product',
    fromSql: `SELECT 'about_product' relation, 'ai_derived' origin,
        'AI attribute: confidence ' || aat.confidence note, aat.computed_at at,
        'product' kind, p.id local_id, p.name label, p.description sublabel, 0 deleted
      FROM ai_attributes aat JOIN products p ON p.name COLLATE NOCASE = TRIM(aat.value)
      WHERE aat.conversation_id = ? AND aat.attribute = 'product' AND aat.superseded_at IS NULL
        AND aat.value_type = 'text' LIMIT ${BRANCH_LIMIT}`,
    toSql: `SELECT 'about_product' relation, 'ai_derived' origin,
        'AI attribute: confidence ' || aat.confidence note, aat.computed_at at,
        'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
      FROM ai_attributes aat
        JOIN conversations c ON c.id = aat.conversation_id
      WHERE aat.attribute = 'product' AND aat.superseded_at IS NULL AND aat.value_type = 'text'
        AND TRIM(aat.value) COLLATE NOCASE = (SELECT name FROM products WHERE id = ?) LIMIT ${BRANCH_LIMIT}`
  }
];

const NODE_EXISTS_SQL: Record<GraphNodeKind, string> = {
  customer: 'SELECT 1 AS x FROM customers WHERE id = ?',
  organization: 'SELECT 1 AS x FROM organizations WHERE id = ?',
  conversation: 'SELECT 1 AS x FROM conversations WHERE id = ?',
  known_issue: 'SELECT 1 AS x FROM known_issues WHERE id = ?',
  issue_cluster: 'SELECT 1 AS x FROM issue_clusters WHERE id = ?',
  incident: 'SELECT 1 AS x FROM incidents WHERE id = ?',
  knowledge_document: 'SELECT 1 AS x FROM knowledge_documents WHERE id = ?',
  agent: 'SELECT 1 AS x FROM users WHERE id = ?',
  campaign: 'SELECT 1 AS x FROM outreach_campaigns WHERE id = ?',
  product: 'SELECT 1 AS x FROM products WHERE id = ?',
  custom_object: 'SELECT 1 AS x FROM custom_objects WHERE id = ?',
  connector_data: 'SELECT 1 AS x FROM connector_rows WHERE id = ?'
};

const NODE_LABEL_SQL: Record<GraphNodeKind, string> = {
  customer: `SELECT 'customer' kind, cu.id local_id, ${L.customer()} label, o.name sublabel, (cu.deleted_at IS NOT NULL) deleted FROM customers cu LEFT JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = ?`,
  organization: `SELECT 'organization' kind, o.id local_id, o.name label, o.domains sublabel, (o.deleted_at IS NOT NULL) deleted FROM organizations o WHERE o.id = ?`,
  conversation: `SELECT 'conversation' kind, c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted FROM conversations c WHERE c.id = ?`,
  known_issue: `SELECT 'known_issue' kind, ki.id local_id, ki.title label, ki.status sublabel, 0 deleted FROM known_issues ki WHERE ki.id = ?`,
  issue_cluster: `SELECT 'issue_cluster' kind, ic.id local_id, ic.title label, 'cluster' sublabel, 0 deleted FROM issue_clusters ic WHERE ic.id = ?`,
  incident: `SELECT 'incident' kind, i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted FROM incidents i WHERE i.id = ?`,
  knowledge_document: `SELECT 'knowledge_document' kind, kd.id local_id, kd.title label, kd.visibility sublabel, 0 deleted FROM knowledge_documents kd WHERE kd.id = ?`,
  agent: `SELECT 'agent' kind, u.id local_id, ${L.user()} label, u.email sublabel, (u.deleted_at IS NOT NULL) deleted FROM users u WHERE u.id = ?`,
  campaign: `SELECT 'campaign' kind, oc.id local_id, oc.name label, oc.status sublabel, 0 deleted FROM outreach_campaigns oc WHERE oc.id = ?`,
  product: `SELECT 'product' kind, p.id local_id, p.name label, p.description sublabel, 0 deleted FROM products p WHERE p.id = ?`,
  custom_object: `SELECT 'custom_object' kind, co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted FROM custom_objects co JOIN custom_object_types cot ON cot.id = co.type_id WHERE co.id = ?`,
  connector_data: `SELECT 'connector_data' kind, cr.id local_id, 'row ' || cr.row_key label, cn.name sublabel, 0 deleted FROM connector_rows cr JOIN connectors cn ON cn.id = cr.connector_id WHERE cr.id = ?`
};

export class GraphService {
  constructor(private db: DB) {}

  /** Deterministic INSERT-OR-IGNORE product registry refresh (never overwrites). */
  refreshProducts(): { added: number } {
    const before = (this.db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    this.db.exec(`
      INSERT OR IGNORE INTO products (name, source, first_seen_at, last_seen_at, provenance)
      SELECT DISTINCT TRIM(p.product), 'derived', datetime('now'), datetime('now'), 'deterministic_local'
        FROM (
          SELECT product FROM incidents WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM known_issues WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM issue_clusters WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
          UNION ALL
          SELECT product FROM support_cases WHERE product IS NOT NULL AND TRIM(product) != '' AND LENGTH(TRIM(product)) <= 120
        ) AS p
      WHERE TRIM(p.product) != '';
    `);
    const after = (this.db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    return { added: after - before };
  }

  nodeExists(kind: GraphNodeKind, id: number): boolean {
    if (!GRAPH_NODE_KINDS.includes(kind)) return false;
    return this.db.prepare(NODE_EXISTS_SQL[kind]).get(id) != null;
  }

  node(kind: GraphNodeKind, id: number): GraphNodeRef | null {
    if (!GRAPH_NODE_KINDS.includes(kind) || !Number.isInteger(id) || id <= 0) return null;
    const row = this.db.prepare(NODE_LABEL_SQL[kind]).get(id) as
      | { kind: string; local_id: number; label: string; sublabel: string | null; deleted: number }
      | undefined;
    if (!row) return null;
    return { kind, local_id: row.local_id, label: row.label, sublabel: row.sublabel, deleted: row.deleted === 1 };
  }

  /**
   * All edges touching a node (both directions): derived branches + human
   * edges + gap-evidence links, labels resolved in-branch (no N+1).
   */
  neighbors(kind: GraphNodeKind, id: number, opts: { direction?: 'out' | 'in' | 'both'; limit?: number } = {}): GraphNeighbors | null {
    const center = this.node(kind, id);
    if (!center) return null;
    const limit = Math.min(GRAPH_MAX_NEIGHBOR_EDGES, Math.max(1, opts.limit ?? GRAPH_MAX_NEIGHBOR_EDGES));
    const direction = opts.direction ?? 'both';
    const edges: GraphEdge[] = [];
    let raw = 0;

    const pushRow = (row: EdgeRow, rowIsTarget: boolean): void => {
      raw++;
      const endpoint: GraphNodeRef = {
        kind: row.kind,
        local_id: row.local_id,
        label: row.label ?? '',
        sublabel: row.sublabel,
        deleted: row.deleted === 1
      };
      edges.push({
        relation: row.relation as GraphEdge['relation'],
        origin: row.origin,
        source: rowIsTarget ? endpoint : center,
        target: rowIsTarget ? center : endpoint,
        note: row.note,
        at: row.at
      });
    };

    for (const branch of BRANCHES) {
      if (branch.sourceKind === kind && direction !== 'in') {
        const rows = this.db.prepare(branch.fromSql).all(id) as EdgeRow[];
        for (const row of rows) pushRow(row, false);
      }
      if (branch.targetKind === kind && direction !== 'out') {
        const rows = this.db.prepare(branch.toSql).all(id) as EdgeRow[];
        for (const row of rows) pushRow(row, true);
      }
    }

    // gap-evidence edges: conversations <-> knowledge documents connected by
    // knowledge-gap candidates (JSON evidence arrays - parsed, bounded).
    if (kind === 'conversation' && direction !== 'in') {
      const rows = this.db
        .prepare(`SELECT related_document_ids FROM knowledge_candidates
                   WHERE related_document_ids NOT IN ('[]', '') AND evidence_conversation_ids LIKE ?
                   LIMIT 50`)
        .all(`%"${id}"%`) as { related_document_ids: string }[];
      const docIds = new Set<number>();
      for (const r of rows) {
        try {
          for (const docId of JSON.parse(r.related_document_ids) as number[]) {
            if (Number.isInteger(docId)) docIds.add(docId);
          }
        } catch { /* malformed JSON in one row never breaks the graph */ }
      }
      for (const docId of docIds) {
        const doc = this.node('knowledge_document', docId);
        if (doc) {
          raw++;
          edges.push({ relation: 'gap_evidence', origin: 'deterministic_local', source: center, target: doc, note: 'knowledge gap candidate evidence', at: null });
        }
      }
    }

    // human-asserted edges, both directions.
    const humanRef = (rowKind: GraphNodeKind, rowId: number): GraphNodeRef => {
      const resolved = this.node(rowKind, rowId);
      return resolved ?? { kind: rowKind, local_id: rowId, label: `#${rowId} (removed)`, sublabel: null, deleted: true };
    };
    if (direction !== 'in') {
      const humanFrom = this.db
        .prepare(`SELECT e.relation, e.note, e.created_at at, e.target_kind kind, e.target_local_id local_id
                    FROM support_graph_edges e WHERE e.source_kind = ? AND e.source_local_id = ?
                    LIMIT ${BRANCH_LIMIT}`)
        .all(kind, id) as { relation: GraphHumanRelation; note: string | null; at: string | null; kind: GraphNodeKind; local_id: number }[];
      for (const row of humanFrom) {
        raw++;
        edges.push({ relation: row.relation, origin: 'human_local', source: center, target: humanRef(row.kind, row.local_id), note: row.note, at: row.at });
      }
    }
    if (direction !== 'out') {
      const humanTo = this.db
        .prepare(`SELECT e.relation, e.note, e.created_at at, e.source_kind kind, e.source_local_id local_id
                    FROM support_graph_edges e WHERE e.target_kind = ? AND e.target_local_id = ?
                    LIMIT ${BRANCH_LIMIT}`)
        .all(kind, id) as { relation: GraphHumanRelation; note: string | null; at: string | null; kind: GraphNodeKind; local_id: number }[];
      for (const row of humanTo) {
        raw++;
        edges.push({ relation: row.relation, origin: 'human_local', source: humanRef(row.kind, row.local_id), target: center, note: row.note, at: row.at });
      }
    }

    edges.sort((a, b) => a.relation.localeCompare(b.relation) || a.target.label.localeCompare(b.target.label));
    const truncated = raw > limit;
    const notes = [
      'Derived edges are computed live from the local mirror - they can never drift from the data they describe.',
      'about_product edges from conversations carry AI-attribute provenance; everything deterministic is labeled as such.',
      'Connector rows have no derived links by design - only human-asserted edges can connect them.'
    ];
    if (truncated) notes.push(`Bounded to the first ${limit} of ${raw} edges (deep hubs: expand from a specific neighbor).`);
    return { node: center, edges: edges.slice(0, limit), total_edges: raw, truncated, notes };
  }

  /** Bounded BFS expansion around a seed node (depth <= 2, nodes <= cap). */
  subgraph(kind: GraphNodeKind, id: number, opts: { depth?: number; maxNodes?: number } = {}): GraphSubgraph | null {
    const seed = this.node(kind, id);
    if (!seed) return null;
    const depth = Math.min(GRAPH_MAX_SUBGRAPH_DEPTH, Math.max(1, opts.depth ?? 1));
    const maxNodes = Math.min(GRAPH_MAX_SUBGRAPH_NODES, Math.max(10, opts.maxNodes ?? 120));

    const nodeKey = (n: GraphNodeRef): string => `${n.kind}:${n.local_id}`;
    const nodes = new Map<string, GraphNodeRef>([[nodeKey(seed), seed]]);
    const edges: GraphEdge[] = [];
    let frontier: GraphNodeRef[] = [seed];
    let depthReached = 0;

    for (let d = 0; d < depth && nodes.size < maxNodes; d++) {
      const next: GraphNodeRef[] = [];
      for (const f of frontier) {
        if (nodes.size >= maxNodes) break;
        const nb = this.neighbors(f.kind, f.local_id, { limit: 40 });
        if (!nb) continue;
        for (const edge of nb.edges) {
          edges.push(edge);
          const far = nodeKey(edge.source) === nodeKey(f) ? edge.target : edge.source;
          if (!nodes.has(nodeKey(far))) {
            if (nodes.size >= maxNodes) break;
            nodes.set(nodeKey(far), far);
            next.push(far);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
      depthReached = d + 1;
    }

    const truncated = nodes.size >= maxNodes;
    return {
      seeds: [seed],
      nodes: [...nodes.values()],
      edges: edges.slice(0, maxNodes * 3),
      truncated,
      depth_reached: depthReached,
      notes: [
        `Bounded exploration: at most ${depth} hop(s) and ${maxNodes} nodes.`,
        truncated ? 'Node cap reached - expand from a specific neighbor instead of deepening blindly.' : 'Full expansion within bounds.'
      ]
    };
  }

  stats(): GraphStats {
    const count = (sql: string): number => (this.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get() as { n: number }).n;
    const nodes = [
      { kind: 'customer' as const, sql: 'SELECT id FROM customers WHERE deleted_at IS NULL' },
      { kind: 'organization' as const, sql: 'SELECT id FROM organizations WHERE deleted_at IS NULL' },
      { kind: 'conversation' as const, sql: 'SELECT id FROM conversations WHERE deleted_at IS NULL' },
      { kind: 'known_issue' as const, sql: 'SELECT id FROM known_issues' },
      { kind: 'issue_cluster' as const, sql: 'SELECT id FROM issue_clusters' },
      { kind: 'incident' as const, sql: 'SELECT id FROM incidents' },
      { kind: 'knowledge_document' as const, sql: 'SELECT id FROM knowledge_documents' },
      { kind: 'agent' as const, sql: 'SELECT id FROM users WHERE deleted_at IS NULL' },
      { kind: 'campaign' as const, sql: 'SELECT id FROM outreach_campaigns' },
      { kind: 'product' as const, sql: 'SELECT id FROM products' },
      { kind: 'custom_object' as const, sql: 'SELECT id FROM custom_objects WHERE deleted_at IS NULL' },
      { kind: 'connector_data' as const, sql: 'SELECT id FROM connector_rows' }
    ].map((n) => ({ kind: n.kind, label: GRAPH_NODE_KIND_LABELS[n.kind], count: count(n.sql) }));

    const edges = [
      { relation: 'belongs_to', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM customers cu JOIN organizations o ON o.id = cu.organization_id' },
      { relation: 'involves', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM conversations c WHERE c.customer_local_id IS NOT NULL AND c.deleted_at IS NULL' },
      { relation: 'assigned_to', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM conversations c WHERE c.assignee_local_id IS NOT NULL AND c.deleted_at IS NULL' },
      { relation: 'owns', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM incidents i WHERE i.owner_user_local_id IS NOT NULL' },
      { relation: 'linked_to_issue', origin: 'ai_derived' as const, sql: 'SELECT 1 FROM known_issue_conversations' },
      { relation: 'clustered_into', origin: 'deterministic_local' as const, sql: 'SELECT 1 FROM issue_cluster_conversations' },
      { relation: 'promoted_to_issue', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM issue_clusters WHERE known_issue_id IS NOT NULL' },
      { relation: 'affected_by', origin: 'deterministic_local' as const, sql: 'SELECT 1 FROM incident_conversations' },
      { relation: 'related_to', origin: 'human_local' as const, sql: 'SELECT 1 FROM incident_related' },
      { relation: 'linked_to', origin: 'human_local' as const, sql: 'SELECT 1 FROM custom_object_links' },
      { relation: 'sent_to', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM outreach_recipients' },
      { relation: 'generated_conversation', origin: 'helpscout_mirror' as const, sql: 'SELECT 1 FROM outreach_recipients WHERE hs_conversation_remote_id IS NOT NULL' },
      { relation: 'cites', origin: 'ai_derived' as const, sql: "SELECT 1 FROM ai_sources s JOIN ai_runs r ON r.id = s.run_id WHERE s.source_type = 'knowledge_document' AND r.conversation_id IS NOT NULL" },
      { relation: 'collaborated_on', origin: 'human_local' as const, sql: 'SELECT 1 FROM side_thread_participants stp JOIN side_threads st ON st.id = stp.side_thread_id' },
      { relation: 'about_product', origin: 'deterministic_local' as const, sql: `SELECT 1 FROM (
        SELECT 1 FROM incidents WHERE product IS NOT NULL AND TRIM(product) != ''
        UNION ALL SELECT 1 FROM known_issues WHERE product IS NOT NULL AND TRIM(product) != ''
        UNION ALL SELECT 1 FROM issue_clusters WHERE product IS NOT NULL AND TRIM(product) != '')` },
      { relation: 'about_product', origin: 'ai_derived' as const, sql: "SELECT 1 FROM ai_attributes WHERE attribute = 'product' AND superseded_at IS NULL AND value_type = 'text'" },
      { relation: 'gap_evidence', origin: 'deterministic_local' as const, sql: "SELECT 1 FROM knowledge_candidates WHERE related_document_ids NOT IN ('[]', '')" },
      { relation: 'human_edge', origin: 'human_local' as const, sql: 'SELECT 1 FROM support_graph_edges' }
    ].map((e) => ({ relation: e.relation, origin: e.origin, count: count(e.sql) }));

    return {
      generated_at: new Date().toISOString(),
      nodes,
      edges,
      human_edges: (this.db.prepare('SELECT COUNT(*) AS n FROM support_graph_edges').get() as { n: number }).n,
      notes: [
        'Counts are live counts over the local mirror - no denormalized totals that could go stale.',
        'Connector rows carry no derived edges by design (rows are keyed only by row_key); humans can link them explicitly.',
        'linked_to_issue edges aggregate the human and AI link provenance stored per row.'
      ]
    };
  }

  /** LIKE-escaped bounded search across node labels (graph explorer picker). */
  search(query: string, kinds?: GraphNodeKind[]): GraphSearchResult[] {
    const q = query.trim().slice(0, 120);
    if (!q) return [];
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    const wanted = (kinds ?? GRAPH_NODE_KINDS).filter((k) => GRAPH_NODE_KINDS.includes(k));
    const perKind = GRAPH_MAX_SEARCH_PER_KIND;
    const results: GraphSearchResult[] = [];
    const two = [like, like];

    const SEARCH_SQL: Record<GraphNodeKind, { sql: string; params?: unknown[] }> = {
      conversation: {
        sql: `SELECT c.id local_id, ${L.conversation()} label, c.status sublabel, (c.deleted_at IS NOT NULL) deleted
              FROM conversations c WHERE (c.number = ? OR c.subject LIKE ? ESCAPE '\\') AND c.deleted_at IS NULL LIMIT ${perKind}`,
        params: [Number.isInteger(Number(q)) ? Number(q) : -1, like]
      },
      customer: {
        sql: `SELECT cu.id local_id, ${L.customer()} label, NULL sublabel, (cu.deleted_at IS NOT NULL) deleted
              FROM customers cu WHERE (${L.customer()} LIKE ? ESCAPE '\\' OR cu.last_name LIKE ? ESCAPE '\\') AND cu.deleted_at IS NULL LIMIT ${perKind}`,
        params: two
      },
      organization: {
        sql: `SELECT o.id local_id, o.name label, o.domains sublabel, (o.deleted_at IS NOT NULL) deleted
              FROM organizations o WHERE o.name LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      known_issue: {
        sql: `SELECT ki.id local_id, ki.title label, ki.status sublabel, 0 deleted
              FROM known_issues ki WHERE ki.title LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      issue_cluster: {
        sql: `SELECT ic.id local_id, ic.title label, 'cluster' sublabel, 0 deleted
              FROM issue_clusters ic WHERE ic.title LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      incident: {
        sql: `SELECT i.id local_id, ${L.incident()} label, i.status sublabel, 0 deleted
              FROM incidents i WHERE (i.title LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\') LIMIT ${perKind}`,
        params: two
      },
      knowledge_document: {
        sql: `SELECT kd.id local_id, kd.title label, kd.visibility sublabel, 0 deleted
              FROM knowledge_documents kd WHERE kd.title LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      agent: {
        sql: `SELECT u.id local_id, ${L.user()} label, u.email sublabel, (u.deleted_at IS NOT NULL) deleted
              FROM users u WHERE (${L.user()} LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\') LIMIT ${perKind}`,
        params: two
      },
      campaign: {
        sql: `SELECT oc.id local_id, oc.name label, oc.status sublabel, 0 deleted
              FROM outreach_campaigns oc WHERE oc.name LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      product: {
        sql: `SELECT p.id local_id, p.name label, p.description sublabel, 0 deleted
              FROM products p WHERE p.name LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      },
      custom_object: {
        sql: `SELECT co.id local_id, co.title label, cot.name sublabel, (co.deleted_at IS NOT NULL) deleted
              FROM custom_objects co JOIN custom_object_types cot ON cot.id = co.type_id
              WHERE co.title LIKE ? ESCAPE '\\' AND co.deleted_at IS NULL LIMIT ${perKind}`,
        params: [like]
      },
      connector_data: {
        sql: `SELECT cr.id local_id, 'row ' || cr.row_key label, cn.name sublabel, 0 deleted
              FROM connector_rows cr JOIN connectors cn ON cn.id = cr.connector_id
              WHERE cr.row_key LIKE ? ESCAPE '\\' LIMIT ${perKind}`,
        params: [like]
      }
    };

    for (const kind of wanted) {
      if (results.length >= 80) break;
      const spec = SEARCH_SQL[kind];
      const rows = this.db.prepare(spec.sql).all(...(spec.params ?? [like])) as
        { local_id: number; label: string; sublabel: string | null; deleted: number }[];
      for (const row of rows) {
        results.push({ kind, local_id: row.local_id, label: row.label, sublabel: row.sublabel, deleted: row.deleted === 1 });
      }
    }
    return results;
  }

  // ---------------- human-asserted edges ----------------

  linkHumanEdge(input: {
    source_kind: GraphNodeKind; source_local_id: number;
    target_kind: GraphNodeKind; target_local_id: number;
    relation: GraphHumanRelation; note: string | null;
    user_local_id: number | null;
  }): { ok: true; edge: GraphHumanEdge } | { ok: false; code: 'source_not_found' | 'target_not_found' | 'duplicate' | 'self_edge' } {
    if (input.source_kind === input.target_kind && input.source_local_id === input.target_local_id) {
      return { ok: false, code: 'self_edge' };
    }
    if (!this.nodeExists(input.source_kind, input.source_local_id)) return { ok: false, code: 'source_not_found' };
    if (!this.nodeExists(input.target_kind, input.target_local_id)) return { ok: false, code: 'target_not_found' };
    const duplicate = this.db
      .prepare('SELECT 1 AS x FROM support_graph_edges WHERE source_kind = ? AND source_local_id = ? AND target_kind = ? AND target_local_id = ? AND relation = ?')
      .get(input.source_kind, input.source_local_id, input.target_kind, input.target_local_id, input.relation);
    if (duplicate) return { ok: false, code: 'duplicate' };
    const info = this.db
      .prepare(`INSERT INTO support_graph_edges (source_kind, source_local_id, target_kind, target_local_id, relation, note, created_by_user_local_id, created_at, provenance)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'human_local')`)
      .run(input.source_kind, input.source_local_id, input.target_kind, input.target_local_id, input.relation, input.note, input.user_local_id);
    const edge = this.getHumanEdge(Number(info.lastInsertRowid));
    if (!edge) return { ok: false, code: 'duplicate' };
    return { ok: true, edge };
  }

  unlinkHumanEdge(id: number): boolean {
    return this.db.prepare('DELETE FROM support_graph_edges WHERE id = ?').run(id).changes > 0;
  }

  getHumanEdge(id: number): GraphHumanEdge | null {
    const row = this.db
      .prepare(`SELECT e.id, e.source_kind, e.source_local_id, e.target_kind, e.target_local_id, e.relation, e.note, e.created_at,
                   COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), 'User #' || u.id) AS created_by
                FROM support_graph_edges e LEFT JOIN users u ON u.id = e.created_by_user_local_id
                WHERE e.id = ?`)
      .get(id) as
      | { id: number; source_kind: GraphNodeKind; source_local_id: number; target_kind: GraphNodeKind; target_local_id: number; relation: GraphHumanRelation; note: string | null; created_at: string; created_by: string | null }
      | undefined;
    if (!row) return null;
    const fallback = (kind: GraphNodeKind, localId: number): GraphNodeRef => this.node(kind, localId) ?? { kind, local_id: localId, label: `#${localId} (removed)`, sublabel: null, deleted: true };
    return {
      id: row.id,
      source: fallback(row.source_kind, row.source_local_id),
      target: fallback(row.target_kind, row.target_local_id),
      relation: row.relation,
      note: row.note,
      created_at: row.created_at,
      created_by: row.created_by
    };
  }

  listHumanEdges(limit: number, offset: number): { edges: GraphHumanEdge[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM support_graph_edges').get() as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT id FROM support_graph_edges ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(Math.min(200, Math.max(1, limit)), Math.max(0, offset)) as { id: number }[];
    return { edges: rows.map((r) => this.getHumanEdge(r.id)).filter((e): e is GraphHumanEdge => e != null), total };
  }
}

export { GRAPH_HUMAN_RELATIONS };
