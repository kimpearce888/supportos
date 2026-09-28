import type { DB } from '../database/connection.js';
import type { KnowledgeCandidate, KnowledgeGapKind, KnowledgeGapReport, KnowledgeCandidateDraft, KnowledgeCandidateStatus } from '../../shared/quality.js';
import { KNOWLEDGE_GAP_KINDS, KNOWLEDGE_GAP_KIND_LABELS } from '../../shared/quality.js';

/**
 * Knowledge gap engine (v2.1.0, plan Phase 26).
 *
 * Extends the v1.x documentation-gap detection into a persisted candidate
 * pipeline with human approval. Five deterministic detections:
 *
 * 1. repeated_question_uncovered - a question asked by >= 2 conversations
 *    with ZERO knowledge hits (the docGaps 'missing' shape, promoted to a
 *    candidate with stable identity).
 * 2. repeated_question_unsolved - a repeated question whose conversations
 *    still show clarification/follow-up friction AFTER answers exist -
 *    observable evidence that existing articles did not solve it.
 * 3. conflicting_knowledge - document pairs sharing >= 3 title tokens (the
 *    same shape as the freshness report's conflict candidates).
 * 4. missing_troubleshooting_steps - a troubleshooting-shaped question
 *    whose closest document has no step structure (no numbered steps /
 *    step words). Heuristic, and the candidate says so.
 * 5. new_issue_undocumented - an issue cluster with >= 3 conversations and
 *    no knowledge hits for its title.
 *
 * Candidates carry stable dedup keys (kind + normalized question) so
 * rebuilds update evidence instead of duplicating. Human decisions
 * (approved/rejected) survive rebuilds untouched. NOTHING auto-publishes
 * into knowledge_documents - drafting is a human action; the draft endpoint
 * returns a suggested title/outline for a person to take away.
 */

const TROUBLESHOOTING_RE = /\b(error|fail(ed|ing)?|broken|not working|crash|issue|bug|fix|doesn'?t work|stopped working)\b/i;
const STEP_STRUCTURE_RE = /(\n\s*\d+[.)]\s|\bstep\s*\d|\bfirst\b.*\bthen\b|\n\s*[-*]\s)/i;

interface QuestionRow {
  question: string;
  conversation_ids: number[];
  count: number;
  created?: string[];
}

interface CandidateRow {
  id: number;
  kind: string;
  question: string;
  occurrence_count: number;
  evidence_conversation_ids: string;
  related_document_ids: string;
  detail: string | null;
  status: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export class KnowledgeGapService {
  constructor(private db: DB) {}

  /** Full deterministic rebuild (idempotent; decisions preserved). */
  rebuild(days = 90): { candidates: number; new: number } {
    let created = 0;
    const upsert = this.db.prepare(`
      INSERT INTO knowledge_candidates (dedup_key, kind, question, occurrence_count, evidence_conversation_ids, related_document_ids, detail, status, provenance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 'deterministic_local', datetime('now'), datetime('now'))
      ON CONFLICT (dedup_key) DO UPDATE SET
        occurrence_count = excluded.occurrence_count,
        evidence_conversation_ids = excluded.evidence_conversation_ids,
        related_document_ids = excluded.related_document_ids,
        detail = excluded.detail,
        updated_at = datetime('now')
    `);
    const insertCandidate = (kind: KnowledgeGapKind, question: string, count: number, conversationIds: number[], documentIds: number[], detail: Record<string, unknown>): void => {
      const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 300);
      const existing = this.db.prepare('SELECT id, status FROM knowledge_candidates WHERE dedup_key = ?').get(`${kind}:${normalized}`) as { id: number; status: string } | undefined;
      upsert.run(`${kind}:${normalized}`, kind, normalized, count, JSON.stringify(conversationIds.slice(0, 50)), JSON.stringify(documentIds.slice(0, 20)), JSON.stringify(detail));
      if (!existing) created += 1;
    };

    // ---- 1 + 2: repeated questions vs knowledge coverage ----
    const questions = this.repeatedQuestions(days);
    for (const q of questions) {
      const hits = this.knowledgeHits(q.question);
      if (hits === 0) {
        insertCandidate('repeated_question_uncovered', q.question, q.count, q.conversation_ids, [], {
          explanation: `"${q.question.slice(0, 120)}" was asked in ${q.count} conversations and produced zero knowledge-base hits.`,
          method: 'Repeated primary questions (latest ticket_analysis runs) matched against the local FTS knowledge index; 0 hits.',
          first_seen: this.firstSeen(q.conversation_ids),
          last_seen: this.lastSeen(q.conversation_ids)
        });
        continue;
      }
      // 2: covered but conversations still showed clarification/follow-up friction.
      const frictionCount = this.frictionAmong(q.conversation_ids);
      if (frictionCount >= Math.max(1, Math.ceil(q.count / 2))) {
        insertCandidate('repeated_question_unsolved', q.question, q.count, q.conversation_ids, [], {
          explanation: `"${q.question.slice(0, 120)}" has ${hits} knowledge hit(s), yet ${frictionCount} of ${q.count} asking conversations still showed clarification or follow-up friction - the existing answer did not resolve it.`,
          method: 'Cross of repeated questions with the interaction engine clarification/follow-up counts over the same conversations; association, not causation.',
          first_seen: this.firstSeen(q.conversation_ids),
          last_seen: this.lastSeen(q.conversation_ids)
        });
      }
    }

    // ---- 3: conflicting knowledge (title-token overlap pairs) ----
    const docs = (this.db
      .prepare('SELECT id, title FROM knowledge_documents')
      .all() as { id: number; title: string }[]);
    const tokens = (title: string) => new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
    const reportedPairs = new Set<string>();
    for (let i = 0; i < docs.length && i < 500; i++) {
      for (let j = i + 1; j < docs.length && j < 500; j++) {
        const a = docs[i]!;
        const b = docs[j]!;
        const ta = tokens(a.title);
        const shared = [...tokens(b.title)].filter((t) => ta.has(t));
        if (shared.length >= 3) {
          const pairKey = [a.id, b.id].sort((x, y) => x - y).join(':');
          if (reportedPairs.has(pairKey)) continue;
          reportedPairs.add(pairKey);
          insertCandidate('conflicting_knowledge', `${a.title} / ${b.title}`, shared.length, [], [a.id, b.id], {
            explanation: `Two documents share ${shared.length} title tokens ("${shared.join(' ')}") and may cover overlapping or conflicting guidance.`,
            conflicting_titles: [a.title, b.title],
            method: 'Deterministic title-token overlap (>= 3 shared tokens) over local documents - the same shape as the freshness report. Overlap does not prove contradiction; a human review decides.'
          });
        }
      }
    }

    // ---- 4: missing troubleshooting steps ----
    for (const q of questions) {
      if (!TROUBLESHOOTING_RE.test(q.question)) continue;
      const closest = this.closestDocument(q.question);
      if (closest && !STEP_STRUCTURE_RE.test(closest.content)) {
        insertCandidate('missing_troubleshooting_steps', q.question, q.count, q.conversation_ids, [closest.id], {
          explanation: `"${q.question.slice(0, 120)}" is troubleshooting-shaped, and the closest document ("${closest.title}") contains no step structure (no numbered steps, no step markers).`,
          closest_document_title: closest.title,
          method: 'Troubleshooting-shaped question detection + step-structure regex over the closest FTS-matching document. A heuristic; the document may simply use prose.',
          first_seen: this.firstSeen(q.conversation_ids),
          last_seen: this.lastSeen(q.conversation_ids)
        });
      }
    }

    // ---- 5: new issue with no documentation ----
    const clusters = (this.db
      .prepare("SELECT id, title, conversation_count FROM issue_clusters WHERE conversation_count >= 3 ORDER BY conversation_count DESC LIMIT 30")
      .all() as { id: number; title: string; conversation_count: number }[]);
    for (const c of clusters) {
      const hits = this.knowledgeHits(c.title);
      if (hits === 0) {
        const convIds = (this.db
          .prepare('SELECT conversation_id FROM issue_cluster_conversations WHERE cluster_id = ? ORDER BY assigned_at DESC LIMIT 50')
          .all(c.id) as { conversation_id: number }[]).map((r) => r.conversation_id);
        insertCandidate('new_issue_undocumented', c.title, c.conversation_count, convIds, [], {
          explanation: `Issue "${c.title.slice(0, 120)}" groups ${c.conversation_count} conversations and has no covering documentation.`,
          issue_label: c.title,
          method: 'Issue clusters (>= 3 conversations) matched against the local FTS knowledge index; 0 hits.',
          first_seen: this.firstSeen(convIds),
          last_seen: this.lastSeen(convIds)
        });
      }
    }

    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_candidates').get() as { n: number }).n;
    return { candidates: total, new: created };
  }

  /** Grouped report of all candidates. */
  report(): KnowledgeGapReport {
    // v2.2.0 perf (plan Phase 41): bounded to the 500 most relevant rows;
    // totals remain exact via dedicated COUNT queries.
    const rows = (this.db
      .prepare(`SELECT * FROM knowledge_candidates
                 ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, occurrence_count DESC, updated_at DESC
                 LIMIT 500`)
      .all() as CandidateRow[])
      .map((r) => this.mapRow(r));
    const exactTotals = (this.db
      .prepare(`SELECT
        (SELECT COUNT(*) FROM knowledge_candidates WHERE status = 'candidate') AS candidates,
        (SELECT COUNT(*) FROM knowledge_candidates WHERE status = 'approved') AS approved,
        (SELECT COUNT(*) FROM knowledge_candidates WHERE status = 'rejected') AS rejected`)
      .get() as { candidates: number; approved: number; rejected: number });
    const kinds = KNOWLEDGE_GAP_KINDS.map((kind) => ({
      kind,
      label: KNOWLEDGE_GAP_KIND_LABELS[kind],
      candidates: rows.filter((r) => r.kind === kind)
    }));
    return {
      generated_at: new Date().toISOString(),
      kinds,
      totals: {
        candidates: exactTotals.candidates,
        approved: exactTotals.approved,
        rejected: exactTotals.rejected
      },
      notes: [
        'Candidates are deterministic detections; a human decides. Approving marks the candidate only - nothing is published automatically.',
        'Run a rebuild after new syncs or analyses to refresh evidence; approve/reject decisions survive rebuilds.'
      ]
    };
  }

  /** Human decision on a candidate. */
  decide(candidateId: number, decision: 'approved' | 'rejected', note: string | null, userLocalId: number | null): KnowledgeCandidate | null {
    const res = this.db
      .prepare(
        `UPDATE knowledge_candidates SET status = ?, decided_at = datetime('now'), decision_note = ?, decided_by_user_local_id = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'candidate'`
      )
      .run(decision, note, userLocalId, candidateId);
    if (res.changes === 0) return null;
    return this.byId(candidateId);
  }

  /** Suggested draft (title + outline) for a human writer - nothing is created. */
  draft(candidateId: number): KnowledgeCandidateDraft | null {
    const c = this.byId(candidateId);
    if (!c) return null;
    const evidence = c.evidence_conversation_ids.length > 0
      ? (this.db
          .prepare(`SELECT c.id AS conversation_local_id, c.number, c.subject FROM conversations c WHERE c.id IN (${c.evidence_conversation_ids.map(() => '?').join(',')}) AND c.deleted_at IS NULL LIMIT 10`)
          .all(...c.evidence_conversation_ids) as { conversation_local_id: number; number: number; subject: string | null }[])
      : [];
    const suggestedTitle = this.titleCase(c.question.replace(/^(how|what|why|when|where)\s+(do|does|is|are|can|to)\s+/i, '').slice(0, 80) || c.question.slice(0, 80));
    const outline: string[] = [
      'Problem - the question as customers actually ask it (see evidence conversations below)',
      'Answer - one clear paragraph answering the question directly',
      'Steps - numbered steps where applicable',
      'Related - link related documents and known issues'
    ];
    if (c.kind === 'missing_troubleshooting_steps') outline.splice(2, 1, 'Steps - numbered troubleshooting steps (the current document lacks them)');
    if (c.kind === 'conflicting_knowledge') outline.splice(0, 1, 'Problem - these documents overlap; decide the single source of truth and redirect the other');
    return {
      candidate_id: c.id,
      kind: c.kind,
      suggested_title: suggestedTitle,
      suggested_outline: outline,
      evidence_conversations: evidence,
      note: 'A starting point for a human author. SupportOS never writes or publishes knowledge documents automatically.'
    };
  }

  byId(id: number): KnowledgeCandidate | null {
    const row = this.db.prepare('SELECT * FROM knowledge_candidates WHERE id = ?').get(id) as CandidateRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  // ---------------- detection helpers ----------------

  private repeatedQuestions(days: number): QuestionRow[] {
    const rows = (this.db
      .prepare(
        `SELECT json_extract(a.output, '$.primary_question') AS question, a.conversation_id, a.created_at
         FROM ai_runs a
         WHERE a.type='ticket_analysis' AND a.status='completed' AND a.conversation_id IS NOT NULL
           AND a.id IN (SELECT MAX(id) FROM ai_runs WHERE type='ticket_analysis' AND status='completed' GROUP BY conversation_id)
           AND json_extract(a.output, '$.primary_question') IS NOT NULL
           AND a.created_at >= datetime('now', '-' || ? || ' days')`
      )
      .all(Math.max(1, Math.min(3650, days))) as { question: string; conversation_id: number; created_at: string }[]);
    const byQ = new Map<string, { ids: number[]; created: string[] }>();
    for (const r of rows) {
      const q = String(r.question).toLowerCase().trim().replace(/\s+/g, ' ');
      if (!q) continue;
      const g = byQ.get(q) ?? { ids: [], created: [] };
      g.ids.push(r.conversation_id);
      g.created.push(r.created_at);
      byQ.set(q, g);
    }
    return [...byQ.entries()]
      .filter(([, g]) => g.ids.length >= 2)
      .map(([question, g]) => ({ question, conversation_ids: g.ids, count: g.ids.length, created: g.created }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }

  private knowledgeHits(question: string): number {
    const tokens = question
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 6)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!tokens) return 0;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM fts_knowledge WHERE fts_knowledge MATCH ?').all(tokens) as { n: number }[])[0]?.n ?? 0;
  }

  private closestDocument(question: string): { id: number; title: string; content: string } | null {
    const tokens = question
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 6)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!tokens) return null;
    const row = this.db
      .prepare(
        `SELECT k.document_id AS id, d.title, d.content
         FROM fts_knowledge k JOIN knowledge_documents d ON d.id = k.document_id
         WHERE fts_knowledge MATCH ? ORDER BY rank LIMIT 1`
      )
      .get(tokens) as { id: number; title: string; content: string } | undefined;
    return row ?? null;
  }

  private frictionAmong(conversationIds: number[]): number {
    if (conversationIds.length === 0) return 0;
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM client_support_outcomes WHERE conversation_id IN (${conversationIds.map(() => '?').join(',')}) AND (clarification_count > 0 OR follow_up_count > 0)`
      )
      .get(...conversationIds) as { n: number }).n;
  }

  private firstSeen(conversationIds: number[]): string | null {
    if (conversationIds.length === 0) return null;
    return (this.db.prepare(`SELECT MIN(remote_created_at) AS v FROM conversations WHERE id IN (${conversationIds.map(() => '?').join(',')})`).get(...conversationIds) as { v: string | null }).v;
  }

  private lastSeen(conversationIds: number[]): string | null {
    if (conversationIds.length === 0) return null;
    return (this.db.prepare(`SELECT MAX(remote_created_at) AS v FROM conversations WHERE id IN (${conversationIds.map(() => '?').join(',')})`).get(...conversationIds) as { v: string | null }).v;
  }

  private titleCase(s: string): string {
    return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  private mapRow(r: CandidateRow): KnowledgeCandidate {
    let detail: KnowledgeCandidate['detail'] = { explanation: '', method: '' };
    try {
      detail = r.detail ? { ...detail, ...(JSON.parse(r.detail) as Record<string, unknown>) } : detail;
    } catch {
      // malformed detail falls back to the empty shell - honest over crash
    }
    return {
      id: r.id,
      kind: r.kind as KnowledgeGapKind,
      question: r.question,
      occurrence_count: r.occurrence_count,
      evidence_conversation_ids: JSON.parse(r.evidence_conversation_ids) as number[],
      related_document_ids: JSON.parse(r.related_document_ids) as number[],
      detail,
      status: r.status as KnowledgeCandidateStatus,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }
}
