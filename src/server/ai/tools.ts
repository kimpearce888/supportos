import type { DB } from '../database/connection.js';
import { SearchEngine } from '../search/searchEngine.js';
import { EvidenceBuilder } from './evidence.js';
import { redactText } from '../security/redaction.js';
import type { ChatTool } from '../integrations/lmstudio/lmStudioClient.js';
import { htmlToText } from '../../shared/utils.js';

/**
 * Controlled AI read tools (spec #29). The AI never gets arbitrary SQL access;
 * every tool is an allowlisted, parameter-validated, read-only operation.
 *
 * v1.9.0 (M3, plan Phase 15): the registry grew from the original six search
 * tools into the full Local Copilot retrieval surface - current conversation
 * context, customer history, similar conversations, issue clusters, AI
 * analyses, SupportOS ticket metadata and the AI attribute layer. Everything
 * stays read-only by construction, bounded, and redacted before it reaches
 * the model.
 *
 * v2.0.0 (M4, plan Phases 18-23): incident workspace search, custom object
 * search, customer event timeline and connector data search join the
 * surface. The connector tool is gated by the EXPLICIT allowed_ai flag on
 * each connector (plan Phase 22: "The AI must only access explicitly allowed
 * connector data") - anything not explicitly allowed returns a refusal, and
 * custom object search only exposes LOCAL objects, never Help Scout mirror
 * data beyond what other tools already provide.
 */
export class AiToolRegistry {
  private search: SearchEngine;
  private evidence: EvidenceBuilder;
  constructor(private db: DB) {
    this.search = new SearchEngine(db);
    this.evidence = new EvidenceBuilder(db);
  }

  definitions(): ChatTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'search_conversations',
          description: 'Search the local conversation archive by keyword. Returns matching tickets with subject and preview.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Keywords to search for' }, limit: { type: 'number', description: 'Max results (default 5, max 10)' } },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_knowledge',
          description: 'Search local knowledge documents.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_known_issues',
          description: 'Search known issues by keywords.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_saved_replies',
          description: 'Search saved replies by keywords.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_conversation',
          description: 'Get a conversation summary by conversation number.',
          parameters: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_support_metrics',
          description: 'Get local support volume metrics for the last N days.',
          parameters: { type: 'object', properties: { days: { type: 'number', description: 'Look-back window in days (default 30)' } } }
        }
      },
      // ---------------- v1.9.0 (M3, plan Phase 15): Local Copilot tools ----------------
      {
        type: 'function',
        function: {
          name: 'get_conversation_context',
          description: 'Get the full context of one conversation by number: subject, status, mailbox, tags, participants, the thread messages (customer + agent, bounded), and derived activity facts (response state, ages). Use this for "what is this customer asking" / "what already provided" style questions.',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Conversation number' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_history',
          description: 'Get a customer\'s previous tickets, resolved from a conversation number of theirs. Returns past conversations with status, dates, subjects and resolution notes when available. Use for "what happened in their previous tickets" / "what changed since the last interaction".',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Any conversation number belonging to the customer' }, limit: { type: 'number', description: 'Max tickets (default 5, max 10)' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_similar_conversations',
          description: 'Get conversations similar to a given conversation (relevance-ranked from local evidence). Use for "have we seen this issue before" / "what solved previous cases".',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Conversation number' }, limit: { type: 'number', description: 'Max results (default 5, max 10)' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_issue_clusters',
          description: 'List local issue clusters (grouped recurring issues) with sizes and member conversation numbers, optionally filtered by keyword.',
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional keyword filter on cluster title/summary' }, limit: { type: 'number', description: 'Max clusters (default 5, max 10)' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_ai_analysis',
          description: 'Get the latest local AI analysis for a conversation: intent, questions, urgency, sentiment, missing information, confidence, plus the latest draft verification outcome. Use for "why is this urgent" style questions.',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Conversation number' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_supportos_metadata',
          description: 'Get SupportOS-local ticket metadata by conversation number: priority, custom ticket state, response state, waiting/first-response ages, assignee, mailbox, SLA status. These are locally derived fields, not Help Scout fields.',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Conversation number' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_ai_attributes',
          description: 'Get the current local AI attribute snapshot for a conversation: intent, urgency, frustration cues, technical familiarity, question count, risk, escalation signal, known issue link etc., each with confidence and evidence excerpts. Attributes without values are listed as unknown.',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Conversation number' } }, required: ['number'] }
        }
      },
      // ---------------- v2.0.0 (M4): workspace tools ----------------
      {
        type: 'function',
        function: {
          name: 'search_incidents',
          description: 'List local incidents (master issues) with status, severity and affected counts, optionally filtered by keyword. Use for "is there an ongoing incident" / "why are customers writing in about X" questions.',
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional keyword filter on code/title' }, limit: { type: 'number', description: 'Max incidents (default 5, max 10)' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_custom_objects',
          description: 'Search local custom objects (user-defined records like accounts, subscriptions, deployments) by keyword, optionally narrowed to a type slug (e.g. "account"). Returns titles, types and property values. These are locally defined records, not Help Scout data.',
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for' }, type: { type: 'string', description: 'Optional type slug (e.g. account, deployment)' }, limit: { type: 'number', description: 'Max results (default 5, max 10)' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_timeline',
          description: 'Get the recent local event timeline for the customer of a conversation: signups, support conversations, first messages, campaign sends/replies, ratings, incident exposure and custom object events. Use for "what happened with this customer over time".',
          parameters: { type: 'object', properties: { number: { type: 'number', description: 'Any conversation number belonging to the customer' }, limit: { type: 'number', description: 'Max events (default 10, max 20)' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_connector_data',
          description: 'Search rows from an APPROVED local data connector. Only connectors explicitly marked AI-visible are searchable - data that is not explicitly allowed stays private. Use for account/deployment/release data the operator has connected and approved.',
          parameters: { type: 'object', properties: { connector: { type: 'string', description: 'Connector name' }, query: { type: 'string', description: 'Keyword filter on row contents' }, limit: { type: 'number', description: 'Max rows (default 5, max 10)' } }, required: ['connector'] }
        }
      },
      // ---------------- v2.1.0 (M5): quality tools ----------------
      {
        type: 'function',
        function: {
          name: 'get_knowledge_gaps',
          description: 'List local knowledge-gap candidates: repeated questions without coverage, questions existing docs did not solve, conflicting documents, missing troubleshooting steps, undocumented issues. Candidates await human approval - nothing auto-publishes.',
          parameters: { type: 'object', properties: { kind: { type: 'string', description: 'Optional gap kind filter (repeated_question_uncovered, repeated_question_unsolved, conflicting_knowledge, missing_troubleshooting_steps, new_issue_undocumented)' }, limit: { type: 'number', description: 'Max candidates (default 5, max 10)' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_friction_report',
          description: 'Local conversation-friction summary: how often customers repeat explanations, agents re-ask questions, troubleshooting loops, repeated handoffs, duplicated information requests occur. Deterministic heuristics over the local mirror - patterns, not judgments about people.',
          parameters: { type: 'object', properties: { days: { type: 'number', description: 'Lookback window in days (default 30, max 365)' } } }
        }
      }
    ];
  }

  /** Server-side permission validation + execution. Read-only, bounded results. */
  async execute(name: string, argsJson: string): Promise<unknown> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson || '{}');
    } catch {
      return { error: 'Invalid tool arguments' };
    }
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    switch (name) {
      case 'search_conversations': {
        const q = String(args.query ?? '').slice(0, 200);
        const hits = this.search.searchConversations(q, {}, limit);
        return hits.map((h) => ({ number: parseInt(h.title.split(' ')[0]?.replace('#', '') || '0', 10) || h.id, title: h.title, snippet: h.snippet.slice(0, 300) }));
      }
      case 'search_knowledge': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchKnowledge(q).slice(0, limit);
      }
      case 'search_known_issues': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchKnownIssues(q).slice(0, limit);
      }
      case 'search_saved_replies': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchSavedReplies(q).slice(0, limit);
      }
      case 'get_conversation': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const row = this.db.prepare('SELECT id, number, subject, preview, status, remote_created_at FROM conversations WHERE number = ?').get(num) as Record<string, unknown> | undefined;
        if (!row) return { error: 'Conversation not found' };
        const threads = this.db.prepare("SELECT type, body_text, remote_created_at FROM threads WHERE conversation_id = ? ORDER BY remote_created_at DESC LIMIT 3").all(row.id as number) as Record<string, unknown>[];
        return { ...row, recent_threads: threads.map((t) => ({ type: t.type, text: String(t.body_text ?? '').slice(0, 400), date: t.remote_created_at })) };
      }
      case 'get_support_metrics': {
        const days = Math.min(365, Math.max(1, Number(args.days) || 30));
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS conversations,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed
             FROM conversations WHERE deleted_at IS NULL AND julianday(remote_created_at) >= julianday('now', '-' || ? || ' days')`
          )
          .get(days) as Record<string, number>;
        return { window_days: days, ...r };
      }
      // ---------------- v1.9.0: Copilot tools ----------------
      case 'get_conversation_context': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const conv = this.db
          .prepare(
            `SELECT c.id, c.number, c.subject, c.status, c.type, c.remote_created_at, c.remote_updated_at,
               (SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id) AS mailbox,
               (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags,
               (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu WHERE cu.id = c.customer_local_id) AS customer
             FROM conversations c WHERE c.number = ? AND c.deleted_at IS NULL`
          )
          .get(num) as Record<string, unknown> | undefined;
        if (!conv) return { error: 'Conversation not found' };
        const threads = (this.db
          .prepare(
            "SELECT type, from_name, body_html, body_text, remote_created_at FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC LIMIT 30"
          )
          .all(conv.id as number) as Record<string, unknown>[])
          .map((t) => ({ author: String(t.from_name ?? t.type ?? 'unknown'), type: String(t.type ?? ''), date: t.remote_created_at, text: this.red(String(htmlToText(String(t.body_html ?? t.body_text ?? '')).slice(0, 700))) }));
        const participants = [...new Set(threads.map((t) => `${t.author} (${t.type})`))].slice(0, 8);
        return { ...conv, tags: conv.tags ?? null, participants, messages: threads };
      }
      case 'get_customer_history': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const customer = (this.db
          .prepare('SELECT c.customer_local_id FROM conversations c WHERE c.number = ? AND c.deleted_at IS NULL')
          .get(num) as { customer_local_id: number | null } | undefined)?.customer_local_id;
        if (!customer) return { error: 'Conversation not found or has no customer' };
        const rows = this.db
          .prepare(
            `SELECT c.id, c.number, c.subject, c.status, c.remote_created_at, c.remote_updated_at, c.closed_at,
               (SELECT t.body_text FROM threads t WHERE t.conversation_id = c.id AND t.deleted_at IS NULL AND t.state='published' ORDER BY t.remote_created_at ASC LIMIT 1) AS first_message,
               (SELECT t.body_text FROM threads t WHERE t.conversation_id = c.id AND t.deleted_at IS NULL AND t.state='published' AND t.type='lineitem' ORDER BY t.remote_created_at DESC LIMIT 1) AS last_reply
             FROM conversations c WHERE c.customer_local_id = ? AND c.deleted_at IS NULL AND c.id != (SELECT id FROM conversations WHERE number = ?)
             ORDER BY c.remote_created_at DESC LIMIT ${Math.min(10, Math.max(1, limit))}`
          )
          .all(customer, num) as Record<string, unknown>[];
        return {
          total_previous_tickets: rows.length,
          tickets: rows.map((r) => ({
            number: r.number,
            subject: r.subject,
            status: r.status,
            created: r.remote_created_at,
            closed: r.closed_at ?? null,
            first_message: this.red(String(r.first_message ?? '').slice(0, 300)),
            last_reply: this.red(String(r.last_reply ?? '').slice(0, 300))
          }))
        };
      }
      case 'get_similar_conversations': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const conv = this.db.prepare('SELECT id FROM conversations WHERE number = ? AND deleted_at IS NULL').get(num) as { id: number } | undefined;
        if (!conv) return { error: 'Conversation not found' };
        const similar = this.evidence.findSimilar(conv.id, Math.min(10, Math.max(1, limit)));
        return similar.map((s) => ({ conversation_id: s.conversation_id, number: s.number, subject: s.subject, resolution: this.red(String(s.resolution ?? '').slice(0, 400)) }));
      }
      case 'get_issue_clusters': {
        const q = args.query == null ? '' : String(args.query).slice(0, 200).toLowerCase();
        const rows = (this.db
          .prepare(
            `SELECT ic.id, ic.title, ic.summary, ic.category, ic.product, ic.feature, ic.ai_generated,
               (SELECT GROUP_CONCAT(c.number) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ic.id ORDER BY c.number DESC) AS numbers
             FROM issue_clusters ic ORDER BY ic.id DESC`
          )
          .all() as Record<string, unknown>[])
          .filter((c) => !q || `${c.title} ${c.summary} ${c.category ?? ''}`.toLowerCase().includes(q))
          .slice(0, Math.min(10, Math.max(1, limit)));
        return rows.map((c) => ({ title: c.title, summary: this.red(String(c.summary ?? '').slice(0, 400)), category: c.category ?? null, product: c.product ?? null, feature: c.feature ?? null, conversation_numbers: String(c.numbers ?? '').split(',').filter(Boolean).map(Number).slice(0, 15), ai_generated: Number(c.ai_generated) === 1 }));
      }
      case 'get_ai_analysis': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const conv = this.db.prepare('SELECT id FROM conversations WHERE number = ?').get(num) as { id: number } | undefined;
        if (!conv) return { error: 'Conversation not found' };
        const run = this.db
          .prepare("SELECT output, model, latency_ms, created_at FROM ai_runs WHERE conversation_id = ? AND type = 'ticket_analysis' AND status = 'completed' ORDER BY id DESC LIMIT 1")
          .get(conv.id) as { output: string; model: string | null; latency_ms: number | null; created_at: string } | undefined;
        if (!run) return { analysis: null, note: 'No AI analysis has been run for this conversation yet.' };
        let analysis: unknown;
        try {
          analysis = JSON.parse(run.output);
        } catch {
          analysis = null;
        }
        const verification = this.db
          .prepare('SELECT verification FROM ai_drafts WHERE conversation_id = ? AND verification IS NOT NULL ORDER BY id DESC LIMIT 1')
          .get(conv.id) as { verification: string } | undefined;
        let verificationSummary: unknown = null;
        if (verification) {
          try {
            const v = JSON.parse(verification.verification) as { verified?: boolean; warnings?: string[] };
            verificationSummary = { verified: v.verified === true, warnings: (v.warnings ?? []).slice(0, 5) };
          } catch {
            verificationSummary = null;
          }
        }
        return { analysis, model: run.model, analyzed_at: run.created_at, latest_draft_verification: verificationSummary };
      }
      case 'get_supportos_metadata': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const row = this.db
          .prepare(
            `SELECT c.id, c.number, c.supportos_priority, c.supportos_state_id,
               (SELECT ts.name FROM ticket_states ts WHERE ts.id = c.supportos_state_id) AS state_name,
               (SELECT u2.first_name || ' ' || u2.last_name FROM users u2 WHERE u2.id = c.assignee_local_id) AS assignee,
               (SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id) AS mailbox,
               c.closed_at, c.first_customer_message_at, c.first_response_at,
               c.last_customer_reply_at, c.last_human_agent_response_at, c.customer_waiting_since,
               (SELECT kic.known_issue_id FROM known_issue_conversations kic WHERE kic.conversation_id = c.id LIMIT 1) AS known_issue_id
             FROM conversations c WHERE c.number = ? AND c.deleted_at IS NULL`
          )
          .get(num) as Record<string, unknown> | undefined;
        if (!row) return { error: 'Conversation not found' };
        return {
          number: row.number,
          supportos_priority: row.supportos_priority ?? null,
          ticket_state: row.state_name ?? null,
          assignee: row.assignee ?? null,
          mailbox: row.mailbox ?? null,
          closed_at: row.closed_at ?? null,
          first_customer_message_at: row.first_customer_message_at ?? null,
          first_response_at: row.first_response_at ?? null,
          last_customer_reply_at: row.last_customer_reply_at ?? null,
          last_human_agent_response_at: row.last_human_agent_response_at ?? null,
          customer_waiting_since: row.customer_waiting_since ?? null,
          known_issue_linked: row.known_issue_id != null,
          note: 'SLA state is computed live against mailbox business hours; customer_waiting_since is the local waiting marker.'
        };
      }
      case 'get_ai_attributes': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const conv = this.db.prepare('SELECT id FROM conversations WHERE number = ? AND deleted_at IS NULL').get(num) as { id: number } | undefined;
        if (!conv) return { error: 'Conversation not found' };
        const rows = this.db
          .prepare('SELECT attribute, value, value_type, confidence, source, evidence, computed_at FROM ai_attributes WHERE conversation_id = ? AND superseded_at IS NULL')
          .all(conv.id) as Record<string, unknown>[];
        const attributes = rows.map((r) => {
          let evidence: { excerpt: string }[] = [];
          try {
            evidence = (JSON.parse(String(r.evidence ?? '[]')) as { excerpt: string }[]).slice(0, 2);
          } catch {
            evidence = [];
          }
          return { attribute: r.attribute, value: r.value, confidence: r.confidence, source: r.source, computed_at: r.computed_at, evidence: evidence.map((e) => ({ excerpt: this.red(e.excerpt.slice(0, 200)) })) };
        });
        return { attributes, note: 'Attributes absent from this list are unknown (not yet computed or no evidence).' };
      }
      // ---------------- v2.0.0 (M4): workspace tools ----------------
      case 'search_incidents': {
        const q = args.query == null ? '' : String(args.query).slice(0, 200).toLowerCase();
        const rows = this.db
          .prepare(
            `SELECT i.id, i.code, i.title, i.status, i.severity, i.product, i.feature,
               (SELECT COUNT(*) FROM incident_conversations ic WHERE ic.incident_id = i.id) AS conversation_count,
               (SELECT COUNT(DISTINCT c.customer_local_id) FROM incident_conversations ic
                  JOIN conversations c ON c.id = ic.conversation_id
                  WHERE ic.incident_id = i.id AND c.customer_local_id IS NOT NULL AND c.deleted_at IS NULL) AS customer_count
             FROM incidents i ORDER BY CASE i.status WHEN 'resolved' THEN 1 ELSE 0 END, i.updated_at DESC LIMIT 20`
          )
          .all() as Record<string, unknown>[];
        const filtered = rows
          .filter((r) => !q || `${r.code} ${r.title} ${r.product ?? ''}`.toLowerCase().includes(q))
          .slice(0, Math.min(10, Math.max(1, limit)));
        return filtered.map((r) => ({
          code: r.code, title: this.red(String(r.title ?? '').slice(0, 200)), status: r.status, severity: r.severity,
          product: r.product ?? null, feature: r.feature ?? null,
          affected_conversations: Number(r.conversation_count ?? 0), affected_customers: Number(r.customer_count ?? 0),
          note: 'Affected customers are distinct customers, never ticket counts.'
        }));
      }
      case 'search_custom_objects': {
        const q = String(args.query ?? '').slice(0, 200);
        const typeSlug = args.type == null ? null : String(args.type).slice(0, 60);
        const typeIdRow = typeSlug ? this.db.prepare('SELECT id FROM custom_object_types WHERE slug = ? AND deleted_at IS NULL').get(typeSlug) as { id: number } | undefined : undefined;
        const tokens = q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 6).map((t) => `"${t}"*`).join(' ');
        if (!tokens) return [];
        const sql = `SELECT o.id, o.title, o.properties, t.name AS type_name, t.slug AS type_slug,
            snippet(fts_custom_objects, 1, '[', ']', '...', 12) AS snippet
          FROM fts_custom_objects f
          JOIN custom_objects o ON o.id = f.object_id AND o.deleted_at IS NULL
          JOIN custom_object_types t ON t.id = o.type_id
          WHERE fts_custom_objects MATCH ? ${typeIdRow ? 'AND o.type_id = ?' : ''}
          ORDER BY rank LIMIT ${Math.min(10, Math.max(1, limit))}`;
        const rows = (typeIdRow
          ? this.db.prepare(sql).all(tokens, typeIdRow.id)
          : this.db.prepare(sql).all(tokens)) as { id: number; title: string; properties: string; type_name: string; type_slug: string; snippet: string }[];
        return rows.map((r) => {
          let properties: Record<string, unknown> = {};
          try { properties = JSON.parse(r.properties) as Record<string, unknown>; } catch { properties = {}; }
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(properties).slice(0, 12)) {
            clean[k] = typeof v === 'string' ? this.red(v.slice(0, 200)) : v;
          }
          return { type: r.type_name, title: this.red(r.title.slice(0, 200)), properties: clean };
        });
      }
      case 'get_customer_timeline': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const customer = (this.db
          .prepare('SELECT c.customer_local_id FROM conversations c WHERE c.number = ? AND c.deleted_at IS NULL')
          .get(num) as { customer_local_id: number | null } | undefined)?.customer_local_id;
        if (!customer) return { error: 'Conversation not found or has no customer' };
        const rows = this.db
          .prepare(
            `SELECT event_kind, occurred_at, title, detail, source FROM customer_events
             WHERE customer_local_id = ? ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC LIMIT ${Math.min(20, Math.max(1, limit))}`
          )
          .all(customer) as { event_kind: string; occurred_at: string | null; title: string; detail: string | null; source: string }[];
        return {
          events: rows.map((r) => ({
            kind: r.event_kind, at: r.occurred_at,
            title: this.red(String(r.title ?? '').slice(0, 160)), source: r.source
          }))
        };
      }
      case 'search_connector_data': {
        const connectorName = String(args.connector ?? '').slice(0, 80);
        if (!connectorName) return { error: 'Invalid connector name' };
        const q = String(args.query ?? '').slice(0, 200);
        const row = this.db.prepare('SELECT id, name, allowed_ai, enabled FROM connectors WHERE name = ?').get(connectorName) as { id: number; name: string; allowed_ai: number; enabled: number } | undefined;
        if (!row) {
          const available = (this.db.prepare('SELECT name FROM connectors WHERE allowed_ai = 1 AND enabled = 1 LIMIT 10').all() as { name: string }[]).map((r) => r.name);
          return { error: 'Connector not found', ai_visible_connectors: available };
        }
        if (row.allowed_ai !== 1) return { error: `Connector "${row.name}" is not marked as AI-visible. Its data stays private to the UI.` };
        if (row.enabled !== 1) return { error: `Connector "${row.name}" is disabled.` };
        const dataRows = this.db
          .prepare(`SELECT data FROM connector_rows WHERE connector_id = ? ORDER BY id DESC LIMIT 100`)
          .all(row.id) as { data: string }[];
        const qLower = q.toLowerCase();
        const results = dataRows
          .map((r) => { try { return JSON.parse(r.data) as Record<string, unknown>; } catch { return {}; } })
          .filter((d) => !qLower || JSON.stringify(d).toLowerCase().includes(qLower))
          .slice(0, Math.min(10, Math.max(1, limit)))
          .map((d) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(d).slice(0, 15)) {
              out[k] = typeof v === 'string' ? this.red(v.slice(0, 300)) : v;
            }
            return out;
          });
        return { connector: row.name, results };
      }
      // ---------------- v2.1.0 (M5): quality tools ----------------
      case 'get_knowledge_gaps': {
        const kindFilter = args.kind == null ? null : String(args.kind).slice(0, 60);
        const rows = (this.db
          .prepare(`SELECT id, kind, question, occurrence_count, status, detail FROM knowledge_candidates ORDER BY CASE status WHEN 'candidate' THEN 0 ELSE 1 END, occurrence_count DESC LIMIT 50`)
          .all() as { id: number; kind: string; question: string; occurrence_count: number; status: string; detail: string | null }[])
          .filter((r) => !kindFilter || r.kind === kindFilter)
          .slice(0, Math.min(10, Math.max(1, limit)));
        return rows.map((r) => {
          let explanation = '';
          try {
            explanation = String((JSON.parse(r.detail ?? '{}') as Record<string, unknown>).explanation ?? '');
          } catch {
            explanation = '';
          }
          return {
            id: r.id, kind: r.kind, question: this.red(r.question.slice(0, 200)), occurrences: r.occurrence_count, status: r.status,
            explanation: this.red(explanation.slice(0, 300)),
            note: 'Candidates are deterministic detections awaiting human approval; approving never publishes automatically.'
          };
        });
      }
      case 'get_friction_report': {
        const days = Math.min(365, Math.max(1, Number(args.days) || 30));
        const rows = (this.db
          .prepare(`SELECT kind, COUNT(*) AS conversations, SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) AS high
                    FROM friction_findings f JOIN conversations c ON c.id = f.conversation_id
                    WHERE COALESCE(julianday(c.remote_created_at), julianday(f.computed_at)) >= julianday('now', ?)
                    GROUP BY kind ORDER BY conversations DESC`)
          .all(`-${days} days`) as { kind: string; conversations: number; high: number }[]);
        return {
          window_days: days,
          kinds: rows.map((r) => ({ kind: r.kind, conversations: r.conversations, high_severity: r.high })),
          note: 'Deterministic text-shape heuristics over the local mirror - patterns, not judgments about people. Findings exist only for analyzed conversations.'
        };
      }
      default:
        return { error: `Unknown tool ${name} - allowed tools are read-only search tools` };
    }
  }

  /** Redact secrets in text that will be shown to the model. */
  private red(text: string): string {
    const redactionEnabled = this.db
      .prepare("SELECT value FROM application_settings WHERE key = 'redaction_enabled'")
      .get() as { value: unknown } | undefined;
    const enabled = redactionEnabled == null ? true : Number(redactionEnabled.value) !== 0 && redactionEnabled.value !== 'false';
    try {
      return redactText(text, enabled).text;
    } catch {
      return text;
    }
  }
}
