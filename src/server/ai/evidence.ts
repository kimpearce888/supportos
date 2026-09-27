import type { DB } from '../database/connection.js';
import { SearchEngine } from '../search/searchEngine.js';
import type { EvidenceContext } from './prompts.js';
import type { AiSourceRef } from '../../shared/types.js';
import { htmlToText } from '../../shared/utils.js';

export interface SimilarConversation {
  conversation_id: number;
  number: number;
  subject: string;
  resolution: string;
  date: string | null;
  status: string;
  score: number;
  why: string[];
}

/**
 * Evidence package construction (spec #33) + hybrid similar-conversation
 * retrieval (spec #39): semantic + keyword + tag/field + recency, never
 * vector similarity alone.
 */
export class EvidenceBuilder {
  private search: SearchEngine;
  constructor(private db: DB) {
    this.search = new SearchEngine(db);
  }

  /** Build the bounded evidence context for a conversation (spec #128: context budget). */
  build(conversationLocalId: number, opts: { includeInternal: boolean }): EvidenceContext | null {
    const conv = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationLocalId) as
      | { id: number; number: number; subject: string | null; preview: string | null; customer_local_id: number | null; remote_created_at: string | null }
      | undefined;
    if (!conv) return null;
    const customer = conv.customer_local_id
      ? (this.db.prepare('SELECT first_name, last_name FROM customers WHERE id = ?').get(conv.customer_local_id) as { first_name: string | null; last_name: string | null } | undefined)
      : undefined;
    const threads = (this.db
      .prepare("SELECT type, from_name, body_html, body_text, remote_created_at, created_by_user_id FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state != 'draft' ORDER BY remote_created_at ASC, id ASC")
      .all(conversationLocalId) as { type: string | null; from_name: string | null; body_html: string | null; body_text: string | null; remote_created_at: string | null; created_by_user_id: number | null }[]).map((t) => ({
      author: t.from_name ?? (t.created_by_user_id ? 'Agent' : 'Customer'),
      type: t.type ?? 'customer',
      date: (t.remote_created_at ?? '').slice(0, 10),
      text: htmlToText(t.body_html ?? t.body_text ?? '').slice(0, 1500)
    }));

    // Customer history (previous conversations)
    const history = conv.customer_local_id
      ? (this.db
          .prepare(
            `SELECT cv.number, cv.subject, cv.preview, cv.status, cv.remote_created_at,
               (SELECT COALESCE((SELECT t2.body_text FROM threads t2 WHERE t2.conversation_id = cv.id AND t2.type='reply' ORDER BY t2.remote_created_at DESC LIMIT 1), '')) AS last_reply
             FROM conversations cv WHERE cv.customer_local_id = @cid AND cv.id != @self AND cv.deleted_at IS NULL
             ORDER BY cv.remote_created_at DESC LIMIT 5`
          )
          .all({ cid: conv.customer_local_id, self: conversationLocalId }) as { number: number; subject: string | null; preview: string | null; status: string; remote_created_at: string | null; last_reply: string | null }[]).map((h) => ({
          number: h.number,
          subject: h.subject ?? '(no subject)',
          summary: (h.last_reply || h.preview || '').slice(0, 200),
          daysAgo: h.remote_created_at ? Math.max(0, Math.round((Date.now() - new Date(h.remote_created_at).getTime()) / 86400000)) : 0
        }))
      : [];

    // Similar conversations (hybrid)
    const similar = this.findSimilar(conversationLocalId, 5).map((s) => ({
      number: s.number,
      subject: s.subject,
      resolution: s.resolution.slice(0, 300),
      date: (s.date ?? '').slice(0, 10),
      visibility: 'internal_only' as const
    }));

    // Known issues matching subject/preview
    const knownIssues = this.search.searchKnownIssues(`${conv.subject ?? ''} ${conv.preview ?? ''}`).slice(0, 3).map((k) => {
      const ki = this.db.prepare('SELECT title, symptoms, customer_safe_explanation, workaround FROM known_issues WHERE id = ?').get(k.id) as { title: string; symptoms: string | null; customer_safe_explanation: string | null; workaround: string | null } | undefined;
      return ki
        ? { title: ki.title, symptoms: ki.symptoms ?? '', customerSafeExplanation: ki.customer_safe_explanation, workaround: ki.workaround }
        : { title: k.title, symptoms: k.snippet, customerSafeExplanation: null, workaround: null };
    });

    // Knowledge (respect visibility)
    const knowledge = this.search
      .searchKnowledgeRaw(`${conv.subject ?? ''} ${conv.preview ?? ''}`, opts.includeInternal ? undefined : 'customer_safe', 4, 'or')
      .slice(0, 4)
      .map((k) => {
        const doc = this.db.prepare('SELECT title, content FROM knowledge_documents WHERE id = ?').get(k.document_id) as { title: string; content: string | null } | undefined;
        return { title: doc?.title ?? k.title, text: (doc?.content ?? k.snippet).slice(0, 1200), visibility: (k.visibility === 'customer_safe' ? 'customer_safe' : 'internal_only') as 'customer_safe' | 'internal_only' };
      });

    // Saved replies matching the subject
    const savedReplies = this.search.searchSavedReplies(`${conv.subject ?? ''} ${conv.preview ?? ''}`).slice(0, 3).map((r) => {
      const sr = this.db.prepare('SELECT name, text, preview FROM saved_replies WHERE id = ?').get(r.id) as { name: string; text: string | null; preview: string | null } | undefined;
      return { name: sr?.name ?? r.title, text: (sr?.text ?? sr?.preview ?? r.snippet).slice(0, 800) };
    });

    return {
      conversationNumber: conv.number,
      subject: conv.subject ?? '(no subject)',
      customerName: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') : 'Unknown customer',
      customerHistory: history,
      threads,
      similarCases: similar,
      knownIssues,
      knowledge,
      savedReplies
    };
  }

  /** Hybrid relevance: semantic (when available) + keyword + tags/custom fields + recency (spec #39). */
  findSimilar(conversationLocalId: number, limit = 5, semanticHits: { conversation_id: number; score: number }[] = []): SimilarConversation[] {
    const me = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.preview, c.status, c.customer_local_id, c.remote_created_at, c.mailbox_local_id,
           (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
         FROM conversations c WHERE c.id = ?`
      )
      .get(conversationLocalId) as
      | { id: number; number: number; subject: string | null; preview: string | null; status: string; customer_local_id: number | null; remote_created_at: string | null; mailbox_local_id: number | null; tags: string | null }
      | undefined;
    if (!me) return [];

    const myTags = new Set((me.tags ?? '').split(',').filter(Boolean));
    const keywords = this.search.ftsQueryOr(`${me.subject ?? ''} ${me.preview ?? ''}`);
    const ftsRows = keywords !== '""'
      ? (this.db
          .prepare(
            `SELECT c.id, c.number, c.subject, c.preview, c.status, c.customer_local_id, c.remote_created_at,
               (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags,
               MIN(rank) AS rank
             FROM (
               SELECT conversation_id, rank FROM fts_conversations WHERE fts_conversations MATCH ?
               UNION ALL
               SELECT f.conversation_id, rank FROM fts_threads f WHERE fts_threads MATCH ?
             ) m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE c.id != ? AND c.deleted_at IS NULL
             GROUP BY c.id ORDER BY rank LIMIT 25`
          )
          .all(keywords, keywords, conversationLocalId) as { id: number; number: number; subject: string | null; preview: string | null; status: string; customer_local_id: number | null; remote_created_at: string | null; tags: string | null; rank: number }[])
      : [];

    const candidates = new Map<number, { row: (typeof ftsRows)[number] | { id: number; number: number; subject: string | null; preview: string | null; status: string; customer_local_id: number | null; remote_created_at: string | null; tags: string | null; rank: number }; score: number; why: string[] }>();
    for (const row of ftsRows) {
      candidates.set(row.id, { row, score: 0.4, why: ['keyword match'] });
    }
    for (const s of semanticHits) {
      if (s.conversation_id === conversationLocalId) continue;
      const existing = candidates.get(s.conversation_id);
      if (existing) {
        existing.score += s.score * 0.5;
        existing.why.push('semantic match');
      } else {
        const row = this.db
          .prepare(
            `SELECT c.id, c.number, c.subject, c.preview, c.status, c.customer_local_id, c.remote_created_at,
               (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags, 0 AS rank
             FROM conversations c WHERE c.id = ? AND c.deleted_at IS NULL`
          )
          .get(s.conversation_id) as (typeof ftsRows)[number] | undefined;
        if (row) candidates.set(row.id, { row, score: s.score * 0.5, why: ['semantic match'] });
      }
    }
    // same customer boost + tags + recency + same mailbox
    const now = Date.now();
    const scored: SimilarConversation[] = [];
    for (const c of candidates.values()) {
      let score = c.score;
      const why = [...c.why];
      if (c.row.customer_local_id && c.row.customer_local_id === me.customer_local_id) {
        score += 0.15;
        why.push('same customer');
      }
      const theirTags = new Set((c.row.tags ?? '').split(',').filter(Boolean));
      const sharedTags = [...myTags].filter((t) => theirTags.has(t));
      if (sharedTags.length > 0) {
        score += Math.min(0.25, sharedTags.length * 0.08);
        why.push(`shared tags: ${sharedTags.join(', ')}`);
      }
      const ageDays = c.row.remote_created_at ? (now - new Date(c.row.remote_created_at).getTime()) / 86400000 : 999;
      if (ageDays < 90) {
        score += 0.1;
        why.push('recent');
      }
      const lastReply = (this.db.prepare("SELECT body_text FROM threads WHERE conversation_id = ? AND type='reply' ORDER BY remote_created_at DESC LIMIT 1").get(c.row.id) as { body_text: string | null } | undefined)?.body_text ?? '';
      const resolution = lastReply ? lastReply.slice(0, 400) : c.row.preview ?? '';
      scored.push({
        conversation_id: c.row.id,
        number: c.row.number,
        subject: c.row.subject ?? '(no subject)',
        resolution,
        date: c.row.remote_created_at,
        status: c.row.status,
        score: Math.round(score * 100) / 100,
        why
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Sources for provenance labeling (spec #121): every source carries type/id/visibility. */
  sourcesFor(ctx: EvidenceContext): AiSourceRef[] {
    const sources: AiSourceRef[] = [];
    for (const h of ctx.customerHistory) {
      const conv = this.db.prepare('SELECT id FROM conversations WHERE number = ?').get(h.number) as { id: number } | undefined;
      if (conv) sources.push({ source_type: 'conversation', source_id: conv.id, title: `#${h.number} ${h.subject}`, relevance: 0.5, visibility: 'internal_only', timestamp: null });
    }
    for (const s of ctx.similarCases) {
      const conv = this.db.prepare('SELECT id FROM conversations WHERE number = ?').get(s.number) as { id: number } | undefined;
      if (conv) sources.push({ source_type: 'conversation', source_id: conv.id, title: `#${s.number} ${s.subject}`, relevance: 0.7, visibility: s.visibility, timestamp: null });
    }
    for (const k of ctx.knowledge) {
      const doc = this.db.prepare('SELECT id FROM knowledge_documents WHERE title = ?').get(k.title) as { id: number } | undefined;
      if (doc) sources.push({ source_type: 'knowledge_document', source_id: doc.id, title: k.title, relevance: 0.8, visibility: k.visibility, timestamp: null });
    }
    for (const k of ctx.knownIssues) {
      const ki = this.db.prepare('SELECT id FROM known_issues WHERE title = ?').get(k.title) as { id: number } | undefined;
      if (ki) sources.push({ source_type: 'known_issue', source_id: ki.id, title: k.title, relevance: 0.8, visibility: 'uncertain', timestamp: null });
    }
    for (const s of ctx.savedReplies) {
      const sr = this.db.prepare('SELECT id FROM saved_replies WHERE name = ?').get(s.name) as { id: number } | undefined;
      if (sr) sources.push({ source_type: 'saved_reply', source_id: sr.id, title: s.name, relevance: 0.6, visibility: 'customer_safe', timestamp: null });
    }
    return sources;
  }
}
