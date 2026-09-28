import type { DB } from '../database/connection.js';
import type { SettingsRepository } from '../database/repositories/settingsRepo.js';
import type { KnowledgeFreshnessRow, KnowledgeFreshnessFlags } from '../../shared/workspace.js';

/**
 * Knowledge freshness (plan Phase 25). Extends the existing knowledge base
 * with lifecycle observability:
 * - created / updated / last reviewed / last verified / source / version /
 *   usage / associated issues / associated support questions - all read
 * from existing columns plus the two new human-stamped timestamps.
 * - Detection: stale content, conflict candidates, low usage, articles
 *   followed by support tickets, articles that fail to answer recurring
 *   questions. Every flag is DETERMINISTIC and worded as association; the
 *   service never edits or publishes anything - review/verify only stamp
 *   timestamps, and only humans trigger them.
 *
 * Honesty rules:
 * - "followed by tickets" counts conversations that STARTED within 14 days
 *   after the document's last update AND match its title terms - a
 *   temporal/topic association, never proof the article failed.
 * - "fails common questions" marks documents associated with REPEATED
 *   questions (>= 2 analyzed tickets) where coverage is partial or
 *   ambiguous - the question keeps coming back, that is all.
 * - A missing usage row simply means zero local search hits so far.
 */
interface DocRow {
  document_id: number;
  title: string;
  source_name: string | null;
  visibility: 'customer_safe' | 'internal_only';
  version: number;
  created_at: string | null;
  updated_at: string | null;
  last_reviewed_at: string | null;
  last_verified_at: string | null;
  search_hits: number;
  last_hit_at: string | null;
}

export class KnowledgeFreshnessService {
  constructor(private db: DB, private settings: SettingsRepository) {}

  private staleDays(): number {
    const raw = Number(this.settings.get('knowledge_stale_days', 180));
    return Number.isFinite(raw) ? Math.min(3650, Math.max(30, raw)) : 180;
  }

  private daysSince(stamp: string | null): number | null {
    if (!stamp) return null;
    const r = this.db.prepare("SELECT (julianday('now') - julianday(?)) AS d").get(stamp) as { d: number | null };
    return r.d == null ? null : Math.max(0, Number(r.d));
  }

  private ftsTokens(text: string): string {
    return text
      .toLowerCase()
      .replace(/["*()]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
      .slice(0, 8)
      .map((t) => `"${t}"*`)
      .join(' ') || '""';
  }

  /** Full freshness report over all documents (bounded to 500 docs). */
  report(): KnowledgeFreshnessRow[] {
    const staleDays = this.staleDays();
    const docs = this.db
      .prepare(
        `SELECT d.id AS document_id, d.title, d.visibility, d.version, d.created_at, d.updated_at, d.last_reviewed_at, d.last_verified_at,
           (SELECT s.name FROM knowledge_sources s WHERE s.id = d.source_id) AS source_name,
           (SELECT u.search_hits FROM knowledge_doc_usage u WHERE u.document_id = d.id) AS search_hits,
           (SELECT u.last_hit_at FROM knowledge_doc_usage u WHERE u.document_id = d.id) AS last_hit_at
         FROM knowledge_documents d
         ORDER BY d.updated_at DESC
         LIMIT 500`
      )
      .all() as DocRow[];
    if (docs.length === 0) return [];

    // Conflict candidates: significant title-token overlap between docs.
    const tokenMap = new Map<string, number[]>();
    const titleTokens = new Map<number, Set<string>>();
    for (const d of docs) {
      const tokens = new Set(
        d.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
      );
      titleTokens.set(d.document_id, tokens);
      for (const t of tokens) {
        if (!tokenMap.has(t)) tokenMap.set(t, []);
        tokenMap.get(t)!.push(d.document_id);
      }
    }

    // Recurring questions (>= 2 analyzed tickets) + the docs FTS-matching them.
    const questions = this.db
      .prepare(
        `SELECT json_extract(a.output, '$.primary_question') AS question, COUNT(*) AS n
         FROM ai_runs a
         WHERE a.type = 'ticket_analysis' AND a.status = 'completed'
           AND json_extract(a.output, '$.primary_question') IS NOT NULL
           AND julianday(a.created_at) >= julianday('now', '-90 days')
         GROUP BY question HAVING n >= 2 ORDER BY n DESC LIMIT 40`
      )
      .all() as { question: string; n: number }[];
    const questionDocHits = new Map<number, { question: string; conversation_count: number; coverage: string }[]>();
    const questionMatchCounts = new Map<string, number>();
    for (const q of questions) {
      const tokens = this.ftsTokens(String(q.question));
      const matched = this.db
        .prepare(
          `SELECT f.document_id AS document_id FROM fts_knowledge f WHERE fts_knowledge MATCH ? LIMIT 5`
        )
        .all(tokens) as { document_id: number }[];
      questionMatchCounts.set(String(q.question), matched.length);
      for (const m of matched) {
        if (!questionDocHits.has(m.document_id)) questionDocHits.set(m.document_id, []);
        const coverage = matched.length > 1 ? 'ambiguous' : 'partial';
        questionDocHits.get(m.document_id)!.push({ question: String(q.question), conversation_count: Number(q.n), coverage });
      }
    }

    const out: KnowledgeFreshnessRow[] = [];
    for (const d of docs) {
      const daysSinceUpdate = this.daysSince(d.updated_at);
      const daysSinceReview = this.daysSince(d.last_reviewed_at);
      const stale = daysSinceUpdate != null && daysSinceUpdate > staleDays;
      const unreviewedLong =
        (d.last_reviewed_at == null && daysSinceUpdate != null && daysSinceUpdate > Math.min(90, staleDays)) ||
        (daysSinceReview != null && daysSinceReview > staleDays * 2);

      // Conflict candidates: >= 3 shared title tokens (or identical titles).
      const conflicts: { document_id: number; title: string }[] = [];
      const shared = new Map<number, number>();
      for (const t of titleTokens.get(d.document_id) ?? []) {
        for (const other of tokenMap.get(t) ?? []) {
          if (other === d.document_id) continue;
          shared.set(other, (shared.get(other) ?? 0) + 1);
        }
      }
      const titleById = new Map(docs.map((x) => [x.document_id, x.title]));
      for (const [otherId, n] of shared) {
        if (n >= 3) conflicts.push({ document_id: otherId, title: String(titleById.get(otherId) ?? `#${otherId}`) });
      }
      conflicts.sort((a, b) => a.title.localeCompare(b.title));

      const ageDays = daysSinceUpdate ?? this.daysSince(d.created_at) ?? 0;
      const lowUsage = Number(d.search_hits ?? 0) === 0 && ageDays > 30;

      // Followed by tickets: conversations started within 14 days after the
      // doc's last update that match its title terms (temporal association).
      let followed = 0;
      if (d.updated_at) {
        const tokens = this.ftsTokens(d.title);
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM fts_conversations f
             JOIN conversations c ON c.id = f.conversation_id
             WHERE fts_conversations MATCH ?
               AND c.deleted_at IS NULL
               AND julianday(c.remote_created_at) >= julianday(?)
               AND julianday(c.remote_created_at) <= julianday(?, '+14 days')`
          )
          .get(tokens, d.updated_at, d.updated_at) as { n: number };
        followed = Number(r.n ?? 0);
      }

      const associated = (questionDocHits.get(d.document_id) ?? []).slice(0, 5);
      const failsQuestions = associated.some((q) => q.coverage === 'partial' || q.coverage === 'ambiguous') && associated.some((q) => q.conversation_count >= 3);

      const flags: KnowledgeFreshnessFlags = {
        stale,
        unreviewed_long: unreviewedLong,
        conflict_candidate: conflicts.length > 0,
        low_usage: lowUsage,
        followed_by_tickets: followed >= 3,
        fails_common_questions: failsQuestions
      };

      out.push({
        document_id: d.document_id,
        title: d.title,
        source_name: d.source_name,
        visibility: d.visibility,
        version: Number(d.version ?? 1),
        created_at: d.created_at,
        updated_at: d.updated_at,
        last_reviewed_at: d.last_reviewed_at,
        last_verified_at: d.last_verified_at,
        days_since_update: daysSinceUpdate,
        days_since_review: daysSinceReview,
        search_hits: Number(d.search_hits ?? 0),
        last_hit_at: d.last_hit_at,
        flags,
        conflict_candidates: conflicts.slice(0, 5),
        followed_by_ticket_count: followed,
        associated_questions: associated,
        note: 'Flags are deterministic associations (age, token overlap, search usage, topic-temporal correlation, recurring questions). Nothing is edited or published automatically.'
      });
    }
    return out;
  }

  /** Human-only review stamp. Returns false when the doc does not exist. */
  markReviewed(documentId: number): boolean {
    const exists = this.db.prepare('SELECT 1 FROM knowledge_documents WHERE id = ?').get(documentId);
    if (!exists) return false;
    this.db.prepare("UPDATE knowledge_documents SET last_reviewed_at = datetime('now') WHERE id = ?").run(documentId);
    return true;
  }

  /** Human-only verification stamp. */
  markVerified(documentId: number): boolean {
    const exists = this.db.prepare('SELECT 1 FROM knowledge_documents WHERE id = ?').get(documentId);
    if (!exists) return false;
    this.db.prepare("UPDATE knowledge_documents SET last_verified_at = datetime('now') WHERE id = ?").run(documentId);
    return true;
  }

  /** Bump usage counters for search results (idempotent per search call). */
  recordUsage(documentIds: number[]): void {
    if (documentIds.length === 0) return;
    const tx = this.db.transaction(() => {
      const upsert = this.db
        .prepare(
          `INSERT INTO knowledge_doc_usage (document_id, search_hits, last_hit_at)
           VALUES (?, 1, datetime('now'))
           ON CONFLICT (document_id) DO UPDATE SET search_hits = search_hits + 1, last_hit_at = datetime('now')`
        );
      for (const id of documentIds) upsert.run(id);
    });
    tx();
  }
}
