import type { DB } from '../database/connection.js';
import { htmlToText } from '../../shared/utils.js';
import { isClosingAcknowledgment } from './interaction/engine.js';
import type { FrictionEvidence, FrictionFinding, FrictionKind, FrictionOverview } from '../../shared/quality.js';
import { FRICTION_KINDS, FRICTION_KIND_LABELS } from '../../shared/quality.js';

/**
 * Conversation friction analyzer (v2.1.0, plan Phase 29).
 *
 * Six deterministic detections over the local mirror, each pinned to exact
 * thread evidence (message ids + excerpts) so no finding can exist without
 * conversation evidence. All detections are text-shape heuristics over
 * observable content - they describe PATTERNS in the conversation, never
 * judgments about people, and every finding's detail says how it was
 * detected.
 *
 * 1. repeated_customer_explanations: a >= 6-word normalized span appearing
 *    in two or more separate customer messages.
 * 2. repeated_agent_questions: the same normalized question sentence asked
 *    by the agent in two or more replies.
 * 3. troubleshooting_loop: the customer restates the problem (issue-shaped
 *    language) after an agent reply, twice or more.
 * 4. repeated_handoffs: three or more assignment changes in the local event
 *    history (pre-sync history is unknown and the finding says so).
 * 5. repeated_unresolved_interactions: the same customer returns with three
 *    or more conversations sharing a tag (customer-level pattern, attached
 *    to the most recent conversation with the others listed as evidence).
 * 6. duplicated_information_requests: the agent asks for information whose
 *    key entities (emails, order-style ids, error codes, dates) the customer
 *    already supplied earlier, OR the customer says so directly.
 */

interface ThreadRow {
  id: number;
  type: string | null;
  body_html: string | null;
  body_text: string | null;
  remote_created_at: string | null;
}

interface ConversationRow {
  id: number;
  number: number;
  customer_local_id: number | null;
  status: string;
  closed_at: string | null;
}

const MIN_REPEAT_WORDS = 6;
const LOOP_PROBLEM_RE = /still (not|doesn'?t|no)|same (issue|problem|error)|happens again|again (the|it)|persist|not fixed|didn'?t (work|help|fix)|problem (is|persists|continues)|error (persists|continues|still)/i;
const DIRECT_COMPLAINT_RE = /(as|per) i (already |previously )?(said|mentioned|sent|wrote|provided|explained)|i already (sent|gave|provided|mentioned|told)|re-?sending|again[:,] |already (shared|attached)/i;

function normalizeSpan(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Repeated >= 6-word spans across separate messages of one author. */
function repeatedSpans(messages: { text: string; threadId: number }[], spanWords = MIN_REPEAT_WORDS): { span: string; threadIds: number[] }[] {
  const out: { span: string; threadIds: number[] }[] = [];
  const seen = new Set<string>();
  // Pre-normalize once per message (the containment check needs strings).
  const normalized = messages.map((m) => normalizeSpan(m.text).join(' '));
  for (let i = 0; i < messages.length; i++) {
    const words = normalizeSpan(messages[i]!.text);
    for (let j = 0; j + spanWords <= words.length; j++) {
      const span = words.slice(j, j + spanWords).join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      const threadIds = [messages[i]!.threadId];
      for (let k = i + 1; k < messages.length; k++) {
        if (normalized[k]!.includes(span)) threadIds.push(messages[k]!.threadId);
      }
      if (threadIds.length >= 2) out.push({ span, threadIds });
    }
  }
  return out;
}

function excerptOf(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}...`;
}

export class FrictionAnalyzer {
  constructor(private db: DB) {}

  /** Analyze ONE conversation -> findings (also persisted via upsert). */
  analyzeConversation(conversationId: number): FrictionFinding[] {
    const conv = this.db
      .prepare('SELECT id, number, customer_local_id, status, closed_at FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as ConversationRow | undefined;
    if (!conv) return [];
    const threads = (this.db
      .prepare("SELECT id, type, body_html, body_text, remote_created_at FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC")
      .all(conversationId) as ThreadRow[]);
    const customer = threads.filter((t) => t.type === 'customer').map((t) => ({ threadId: t.id, text: htmlToText(t.body_html ?? t.body_text ?? ''), at: t.remote_created_at }));
    const agents = threads.filter((t) => t.type === 'reply').map((t) => ({ threadId: t.id, text: htmlToText(t.body_html ?? t.body_text ?? ''), at: t.remote_created_at }));

    const findings: FrictionFinding[] = [];

    // 1. repeated_customer_explanations
    const customerRepeats = repeatedSpans(customer.map((m) => ({ text: m.text, threadId: m.threadId })));
    if (customerRepeats.length > 0) {
      const best = customerRepeats.sort((a, b) => b.threadIds.length - a.threadIds.length)[0]!;
      const byId = new Map(customer.map((m) => [m.threadId, m]));
      findings.push({
        conversation_id: conversationId,
        conversation_number: conv.number,
        customer_local_id: conv.customer_local_id,
        kind: 'repeated_customer_explanations',
        severity: best.threadIds.length >= 3 ? 'high' : 'moderate',
        evidence: best.threadIds
          .map((tid) => byId.get(tid))
          .filter((m): m is { threadId: number; text: string; at: string | null } => m != null)
          .map((m) => ({ thread_id: m.threadId, author_type: 'customer' as const, excerpt: excerptOf(m.text), at: m.at })),
        detail: `The customer re-stated the same ${MIN_REPEAT_WORDS}+ word span across ${best.threadIds.length} messages ("${excerptOf(best.span, 80)}"). Detected by repeated-span matching across customer messages; a heuristic, not a judgment.`,
        computed_at: new Date().toISOString()
      });
    }

    // 2. repeated_agent_questions
    const agentQuestions = agents
      .flatMap((m) =>
        m.text
          .split(/(?<=[?])\s+/)
          .map((q) => ({ threadId: m.threadId, at: m.at, q: q.trim() }))
          .filter((p) => p.q.endsWith('?') && normalizeSpan(p.q).length >= 4)
      );
    const questionGroups = new Map<string, { threadId: number; at: string | null; q: string }[]>();
    for (const q of agentQuestions) {
      const key = normalizeSpan(q.q).join(' ');
      const list = questionGroups.get(key) ?? [];
      if (!list.some((l) => l.threadId === q.threadId)) list.push({ threadId: q.threadId, at: q.at, q: q.q });
      questionGroups.set(key, list);
    }
    const repeatedAgentQ = [...questionGroups.values()].find((l) => l.length >= 2);
    if (repeatedAgentQ) {
      findings.push({
        conversation_id: conversationId,
        conversation_number: conv.number,
        customer_local_id: conv.customer_local_id,
        kind: 'repeated_agent_questions',
        severity: repeatedAgentQ.length >= 3 ? 'high' : 'moderate',
        evidence: repeatedAgentQ.map((q) => ({ thread_id: q.threadId, author_type: 'agent' as const, excerpt: excerptOf(q.q), at: q.at })),
        detail: `The agent asked the same question in ${repeatedAgentQ.length} replies ("${excerptOf(repeatedAgentQ[0]!.q, 80)}"). Detected by normalized question-sentence matching; a heuristic.`,
        computed_at: new Date().toISOString()
      });
    }

    // 3. troubleshooting_loop: customer restates the problem after agent replies
    let sawAgentReply = false;
    const loopRestatements: { threadId: number; text: string; at: string | null }[] = [];
    for (const t of threads) {
      const text = htmlToText(t.body_html ?? t.body_text ?? '');
      if (t.type === 'reply') sawAgentReply = true;
      else if (t.type === 'customer' && sawAgentReply && LOOP_PROBLEM_RE.test(text) && !isClosingAcknowledgment(text)) {
        loopRestatements.push({ threadId: t.id, text, at: t.remote_created_at });
      }
    }
    if (loopRestatements.length >= 2) {
      findings.push({
        conversation_id: conversationId,
        conversation_number: conv.number,
        customer_local_id: conv.customer_local_id,
        kind: 'troubleshooting_loop',
        severity: loopRestatements.length >= 3 ? 'high' : 'moderate',
        evidence: loopRestatements.map((m) => ({ thread_id: m.threadId, author_type: 'customer' as const, excerpt: excerptOf(m.text), at: m.at })),
        detail: `After agent replies, the customer restated the unresolved problem ${loopRestatements.length} times (issue-shaped language after an agent reply). Detected by problem-restatement patterns; a heuristic.`,
        computed_at: new Date().toISOString()
      });
    }

    // 4. repeated_handoffs (from the M1 event engine's local event history)
    const handoffs = (this.db
      .prepare("SELECT occurred_at, metadata FROM conversation_events WHERE conversation_id = ? AND event_type = 'assignment_changed' ORDER BY occurred_at ASC")
      .all(conversationId) as { occurred_at: string | null; metadata: string | null }[]);
    const historyComplete = (this.db
      .prepare('SELECT activity_history_complete FROM conversations WHERE id = ?')
      .get(conversationId) as { activity_history_complete: number } | undefined)?.activity_history_complete === 1;
    if (handoffs.length >= 3) {
      findings.push({
        conversation_id: conversationId,
        conversation_number: conv.number,
        customer_local_id: conv.customer_local_id,
        kind: 'repeated_handoffs',
        severity: handoffs.length >= 4 ? 'high' : 'moderate',
        evidence: handoffs.slice(0, 6).map((h) => ({ thread_id: 0, author_type: 'agent' as const, excerpt: `Assignment change${h.metadata ? `: ${excerptOf(h.metadata, 100)}` : ''}`, at: h.occurred_at })),
        detail: `${handoffs.length} assignment changes observed in the local event history${historyComplete ? '' : ' (pre-sync history is unknown - Help Scout exposes no historical event log)'}. Detected deterministically from recorded conversation events.`,
        computed_at: new Date().toISOString()
      });
    }

    // 5. repeated_unresolved_interactions (customer-level pattern)
    if (conv.customer_local_id != null) {
      const related = (this.db
        .prepare(
          `SELECT c2.id, c2.number, c2.subject, c2.status, c2.remote_created_at
           FROM conversations c2
           WHERE c2.customer_local_id = ? AND c2.deleted_at IS NULL AND c2.id <> ?
             AND c2.remote_created_at >= datetime('now', '-90 days')
             AND EXISTS (SELECT 1 FROM conversation_tags ct1 JOIN conversation_tags ct2 ON ct2.conversation_id = c2.id
                         JOIN tags tg ON tg.id = ct1.tag_local_id AND tg.id = ct2.tag_local_id
                         WHERE ct1.conversation_id = ?)
           ORDER BY c2.remote_created_at DESC LIMIT 10`
        )
        .all(conv.customer_local_id, conversationId, conversationId) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null }[]);
      if (related.length >= 2) {
        const sharedTag = (this.db
          .prepare(
            `SELECT tg.name FROM conversation_tags ct1 JOIN conversation_tags ct2 ON ct2.conversation_id = ? JOIN tags tg ON tg.id = ct1.tag_local_id AND tg.id = ct2.tag_local_id WHERE ct1.conversation_id = ? LIMIT 1`
          )
          .get(conversationId, conversationId) as { name: string } | undefined)?.name;
        findings.push({
          conversation_id: conversationId,
          conversation_number: conv.number,
          customer_local_id: conv.customer_local_id,
          kind: 'repeated_unresolved_interactions',
          severity: related.length >= 3 ? 'high' : 'moderate',
          evidence: related.slice(0, 4).map((r) => ({ thread_id: 0, author_type: 'customer' as const, excerpt: `Conversation #${r.number}: ${r.subject ?? '(no subject)'} (${r.status})`, at: r.remote_created_at })),
          detail: `The customer opened ${related.length + 1} conversations in the last 90 days sharing the tag${sharedTag ? ` "${sharedTag}"` : ''} - the same problem keeps returning. Customer-level pattern detected from the local mirror; association, not causation.`,
          computed_at: new Date().toISOString()
        });
      }
    }

    // 6. duplicated_information_requests: the agent asks for a CATEGORY of
    // information (order/invoice/account number, email, error details) that
    // the customer already supplied earlier in the thread - detected by
    // request-pattern + entity-shape matching (deterministic heuristic), or
    // the customer says it directly ("as I already sent...").
    const dupRequests: { threadId: number; text: string; at: string | null }[] = [];
    const supplied = { digits: false, email: false, error: false };
    const digitsRe = /\b\d{4,}\b/;
    const emailRe = /[\w.+-]+@[\w-]+\.[\w.]+/;
    const errorRe = /error|fail|exception|crash/i;
    for (const t of threads) {
      const text = htmlToText(t.body_html ?? t.body_text ?? '');
      if (t.type === 'customer') {
        if (digitsRe.test(text)) supplied.digits = true;
        if (emailRe.test(text)) supplied.email = true;
        if (errorRe.test(text)) supplied.error = true;
      } else if (t.type === 'reply') {
        const asksCategory =
          /\?|could you (send|share|provide|confirm)|please (send|share|provide|confirm)/i.test(text) &&
          (/\border\b|\binvoice\b|account\s*(id|number)?|reference\b|ticket number/i.test(text)
            ? supplied.digits
            : /email/i.test(text)
              ? supplied.email
              : /error|log|trace|screenshot/i.test(text)
                ? supplied.error
                : false);
        if (asksCategory) dupRequests.push({ threadId: t.id, text, at: t.remote_created_at });
      }
    }
    const directComplaints = customer.filter((m) => DIRECT_COMPLAINT_RE.test(m.text));
    if (dupRequests.length > 0 || directComplaints.length > 0) {
      const evidence: FrictionEvidence[] = [];
      for (const d of dupRequests.slice(0, 3)) evidence.push({ thread_id: d.threadId, author_type: 'agent', excerpt: excerptOf(d.text), at: d.at });
      for (const c of directComplaints.slice(0, 3)) evidence.push({ thread_id: c.threadId, author_type: 'customer', excerpt: excerptOf(c.text), at: c.at });
      findings.push({
        conversation_id: conversationId,
        conversation_number: conv.number,
        customer_local_id: conv.customer_local_id,
        kind: 'duplicated_information_requests',
        severity: dupRequests.length + directComplaints.length >= 3 ? 'high' : 'low',
        evidence,
        detail: `The agent asked for information (order-style ids, emails, dates, error codes) the customer had already supplied,${directComplaints.length > 0 ? ` and/or the customer said they were re-sending it (${directComplaints.length} direct mentions)` : ''}. Detected by entity-overlap and direct-phrase matching; a heuristic.`,
        computed_at: new Date().toISOString()
      });
    }

    // Persist (upsert by conversation+kind; kinds no longer detected are removed).
    const upsert = this.db.prepare(`
      INSERT INTO friction_findings (conversation_id, customer_local_id, kind, severity, evidence, detail, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (conversation_id, kind) DO UPDATE SET
        customer_local_id = excluded.customer_local_id,
        severity = excluded.severity,
        evidence = excluded.evidence,
        detail = excluded.detail,
        computed_at = datetime('now')
    `);
    for (const f of findings) {
      upsert.run(f.conversation_id, f.customer_local_id, f.kind, f.severity, JSON.stringify(f.evidence), f.detail);
    }
    if (findings.length > 0) {
      const keep = findings.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM friction_findings WHERE conversation_id = ? AND kind NOT IN (${keep})`).run(conversationId, ...findings.map((f) => f.kind));
    } else {
      this.db.prepare('DELETE FROM friction_findings WHERE conversation_id = ?').run(conversationId);
    }
    return findings;
  }

  /** Rebuild findings for every conversation with a customer message (idempotent). */
  rebuild(): { conversations: number; findings: number } {
    const ids = (this.db
      .prepare("SELECT DISTINCT c.id FROM conversations c JOIN threads t ON t.conversation_id = c.id AND t.type = 'customer' WHERE c.deleted_at IS NULL")
      .all() as { id: number }[]).map((r) => r.id);
    let findings = 0;
    for (const id of ids) findings += this.analyzeConversation(id).length;
    return { conversations: ids.length, findings };
  }

  findingsFor(conversationId: number): FrictionFinding[] {
    const rows = (this.db
      .prepare(
        `SELECT f.conversation_id, c.number AS conversation_number, f.customer_local_id, f.kind, f.severity, f.evidence, f.detail, f.computed_at
         FROM friction_findings f JOIN conversations c ON c.id = f.conversation_id
         WHERE f.conversation_id = ? ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END`
      )
      .all(conversationId) as { conversation_id: number; conversation_number: number; customer_local_id: number | null; kind: string; severity: string; evidence: string; detail: string; computed_at: string }[]);
    return rows.map((r) => ({
      conversation_id: r.conversation_id,
      conversation_number: r.conversation_number,
      customer_local_id: r.customer_local_id,
      kind: r.kind as FrictionKind,
      severity: r.severity as 'low' | 'moderate' | 'high',
      evidence: JSON.parse(r.evidence) as FrictionEvidence[],
      detail: r.detail,
      computed_at: r.computed_at
    }));
  }

  /** Cross-customer friction report over the last N days. */
  overview(days = 30): FrictionOverview {
    const notes: string[] = [];
    const kinds = FRICTION_KINDS.map((kind) => {
      const rows = (this.db
        .prepare(
          `SELECT f.*, c.number AS conversation_number FROM friction_findings f JOIN conversations c ON c.id = f.conversation_id
           WHERE f.kind = ? AND COALESCE(julianday(c.remote_created_at), julianday(f.computed_at)) >= julianday('now', ?)
           ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END, f.computed_at DESC LIMIT 500`
        )
        .all(kind, `-${Math.max(1, days)} days`) as (FrictionFinding & { conversation_number: number })[]);
      const mapped = rows.map((r) => ({ ...r, evidence: (typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence) as FrictionEvidence[] }));
      return {
        kind,
        label: FRICTION_KIND_LABELS[kind],
        conversations: mapped.length,
        high_severity: mapped.filter((f) => f.severity === 'high').length,
        sample: mapped.slice(0, 10)
      };
    });
    const customers = (this.db
      .prepare(
        `SELECT f.customer_local_id, COUNT(*) AS findings, SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END) AS high,
                c2.first_name, c2.last_name
         FROM friction_findings f JOIN customers c2 ON c2.id = f.customer_local_id
         WHERE f.customer_local_id IS NOT NULL AND julianday(f.computed_at) >= julianday('now', ?)
         GROUP BY f.customer_local_id ORDER BY findings DESC, high DESC LIMIT 10`
      )
      .all(`-${Math.max(1, days)} days`) as { customer_local_id: number; findings: number; high: number; first_name: string | null; last_name: string | null }[])
      .map((r) => ({ customer_local_id: r.customer_local_id, first_name: r.first_name, last_name: r.last_name, findings: r.findings, high: r.high }));
    notes.push('Findings are deterministic text-shape heuristics over the local mirror - patterns, not judgments about people.');
    notes.push('Findings only exist for conversations analyzed after v2.1.0; run a rebuild to cover older history.');
    return { generated_at: new Date().toISOString(), days, kinds, customers_most_affected: customers, notes };
  }
}
