import type { DB } from '../database/connection.js';
import type { SearchHit, SearchFilters, SearchResponse, SearchScope } from '../../shared/types.js';

/**
 * Local search engine on SQLite FTS5 (spec #25).
 * Keyword/full-text search across conversations, threads, customers, knowledge,
 * known issues, saved replies and AI analyses. Works WITHOUT Qdrant; semantic
 * results are merged in by the hybrid layer when Qdrant is available.
 */
export class SearchEngine {
  constructor(private db: DB) {}

  ftsQuery(q: string): string {
    const tokens = q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
    if (tokens.length === 0) return '""';
    return tokens.map((t) => `"${t}"*`).join(' ');
  }

  /** OR semantics: matches documents containing ANY token - used for similarity/evidence retrieval. */
  ftsQueryOr(q: string, maxTokens = 10): string {
    const tokens = q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 2).slice(0, maxTokens);
    if (tokens.length === 0) return '""';
    return tokens.map((t) => `"${t}"*`).join(' OR ');
  }

  searchConversations(query: string, filters: SearchFilters, limit = 40): SearchHit[] {
    const fts = this.ftsQuery(query);
    if (fts === '""' && !this.hasFilters(filters)) {
      // No query, no filters: return recent conversations
      return this.recentConversations(limit);
    }
    const where: string[] = ['c.deleted_at IS NULL', 'c.merged_into_conversation_id IS NULL'];
    const args: Record<string, unknown> = {};
    if (filters.status && filters.status !== 'all') {
      where.push('c.status = @status');
      args.status = filters.status;
    }
    if (filters.mailbox_id) {
      where.push('c.mailbox_local_id = @mailbox');
      args.mailbox = filters.mailbox_id;
    }
    if (filters.tag) {
      where.push('EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND t.name = @tag COLLATE NOCASE)');
      args.tag = filters.tag;
    }
    if (filters.since_days) {
      where.push("c.remote_created_at >= datetime('now', '-' || @days || ' days')");
      args.days = filters.since_days;
    }
    if (filters.assignee_id) {
      where.push('c.assignee_local_id = @assignee');
      args.assignee = filters.assignee_id;
    }
    // Exact conversation number match wins
    const num = parseInt(query.replace(/\D/g, ''), 10);
    if (query.trim().match(/^\d+$/) && !isNaN(num)) {
      where.push('c.number = @number');
      args.number = num;
    }
    let joinFts = '';
    if (fts !== '""') {
      joinFts = `JOIN (
        SELECT conversation_id, MIN(rank) AS r FROM (
          SELECT conversation_id, rank FROM fts_conversations WHERE fts_conversations MATCH @fts
          UNION ALL
          SELECT f.conversation_id, rank FROM fts_threads f WHERE fts_threads MATCH @fts
          UNION ALL
          SELECT c2.id, rank FROM fts_ai_analyses a JOIN conversations c2 ON c2.id = a.conversation_id WHERE fts_ai_analyses MATCH @fts
        ) GROUP BY conversation_id
      ) m ON m.conversation_id = c.id`;
      args.fts = fts;
    }
    const rows = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.preview, c.status, c.remote_created_at,
           TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) AS customer,
           COALESCE((SELECT ce.value FROM customer_emails ce WHERE ce.customer_id = cu.id LIMIT 1), '') AS customer_email,
           ${joinFts ? 'COALESCE(m.r, 999999)' : '0'} AS rank
         FROM conversations c
         LEFT JOIN customers cu ON cu.id = c.customer_local_id
         ${joinFts}
         WHERE ${where.join(' AND ')}
         ORDER BY rank ASC, c.remote_created_at DESC
         LIMIT @limit`
      )
      .all({ ...args, limit }) as { id: number; number: number; subject: string | null; preview: string | null; status: string; remote_created_at: string | null; customer: string; customer_email: string }[];
    return rows.map((r) => ({
      scope: 'tickets' as const,
      id: r.id,
      title: `#${r.number} ${r.subject ?? '(no subject)'}`,
      subtitle: [r.customer, r.customer_email, r.status].filter(Boolean).join(' · '),
      snippet: r.preview ?? '',
      score: 1,
      href: `/inbox/conversation/${r.id}`,
      why: ['keyword match']
    }));
  }

  private recentConversations(limit: number): SearchHit[] {
    const rows = this.db
      .prepare(`SELECT id, number, subject, preview, status FROM conversations WHERE deleted_at IS NULL AND merged_into_conversation_id IS NULL ORDER BY last_activity_at DESC LIMIT ?`)
      .all(limit) as { id: number; number: number; subject: string | null; preview: string | null; status: string }[];
    return rows.map((r) => ({
      scope: 'tickets',
      id: r.id,
      title: `#${r.number} ${r.subject ?? '(no subject)'}`,
      subtitle: r.status,
      snippet: r.preview ?? '',
      score: 0.5,
      href: `/inbox/conversation/${r.id}`,
      why: ['recent']
    }));
  }

  private hasFilters(f: SearchFilters): boolean {
    return !!(f.status && f.status !== 'all') || !!f.mailbox_id || !!f.tag || !!f.since_days || !!f.assignee_id;
  }

  searchCustomers(query: string, limit = 15): SearchHit[] {
    if (!query.trim()) return [];
    const like = `%${query.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.first_name, c.last_name,
           (SELECT ce.value FROM customer_emails ce WHERE ce.customer_id = c.id LIMIT 1) AS email,
           o.name AS org,
           (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id) AS conv_count
         FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id
         WHERE c.deleted_at IS NULL AND (
           c.first_name LIKE ? ESCAPE '\\' OR c.last_name LIKE ? ESCAPE '\\' OR
           EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.id AND ce.value LIKE ? ESCAPE '\\')
         )
         ORDER BY c.last_name LIMIT ?`
      )
      .all(like, like, like, limit) as { id: number; first_name: string | null; last_name: string | null; email: string | null; org: string | null; conv_count: number }[];
    return rows.map((r) => ({
      scope: 'customers',
      id: r.id,
      title: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
      subtitle: r.email ?? '',
      snippet: `${r.org ? r.org + ' · ' : ''}${r.conv_count} conversations`,
      score: 1,
      href: `/customers/${r.id}`,
      why: ['name/email match']
    }));
  }

  /** Raw knowledge hits with document id + visibility (used by evidence builder + knowledge search API). */
  searchKnowledgeRaw(query: string, visibility?: 'customer_safe', limit = 10, mode: 'and' | 'or' = 'and'): { document_id: number; title: string; snippet: string; visibility: string }[] {
    if (!query.trim()) return [];
    const fts = mode === 'or' ? this.ftsQueryOr(query) : this.ftsQuery(query);
    const vis = visibility ? 'AND f.visibility = ?' : '';
    return this.db
      .prepare(
        `SELECT f.document_id, f.title, snippet(fts_knowledge, 1, '[', ']', '…', 14) AS snippet, f.visibility
         FROM fts_knowledge f WHERE fts_knowledge MATCH ? ${vis} ORDER BY rank LIMIT ?`
      )
      .all(...(visibility ? [fts, visibility, limit] : [fts, limit])) as { document_id: number; title: string; snippet: string; visibility: string }[];
  }

  searchKnowledge(query: string, visibility?: 'customer_safe', limit = 10): SearchHit[] {
    return this.searchKnowledgeRaw(query, visibility, limit).map((r) => ({
      scope: 'knowledge' as const,
      id: r.document_id,
      title: r.title,
      subtitle: `Knowledge · ${r.visibility === 'customer_safe' ? 'customer-safe' : 'internal'}`,
      snippet: r.snippet,
      score: 1,
      href: `/knowledge/${r.document_id}`,
      why: ['knowledge match']
    }));
  }

  searchKnownIssues(query: string, limit = 10): SearchHit[] {
    if (!query.trim()) return [];
    const fts = this.ftsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT ki.id, ki.title, snippet(fts_known_issues, 0, '[', ']', '…', 14) AS snippet
         FROM fts_known_issues f JOIN known_issues ki ON ki.id = f.known_issue_id
         WHERE fts_known_issues MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(fts, limit) as { id: number; title: string; snippet: string }[];
    return rows.map((r) => ({
      scope: 'issues',
      id: r.id,
      title: r.title,
      subtitle: 'Known issue',
      snippet: r.snippet,
      score: 1,
      href: `/issues/known/${r.id}`,
      why: ['known issue match']
    }));
  }

  searchSavedReplies(query: string, limit = 10): SearchHit[] {
    if (!query.trim()) return [];
    const fts = this.ftsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT sr.id, sr.name, snippet(fts_saved_replies, 1, '[', ']', '…', 14) AS snippet
         FROM fts_saved_replies f JOIN saved_replies sr ON sr.id = f.saved_reply_id
         WHERE fts_saved_replies MATCH ? AND sr.deleted_at IS NULL ORDER BY rank LIMIT ?`
      )
      .all(fts, limit) as { id: number; name: string; snippet: string }[];
    return rows.map((r) => ({
      scope: 'saved_replies',
      id: r.id,
      title: r.name,
      subtitle: 'Saved reply',
      snippet: r.snippet,
      score: 1,
      href: `/saved-replies`,
      why: ['saved reply match']
    }));
  }

  searchAiAnalyses(query: string, limit = 10): SearchHit[] {
    if (!query.trim()) return [];
    const fts = this.ftsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT a.conversation_id, c.number, snippet(fts_ai_analyses, 0, '[', ']', '…', 14) AS snippet, c.subject
         FROM fts_ai_analyses a JOIN conversations c ON c.id = a.conversation_id
         WHERE fts_ai_analyses MATCH ? AND c.deleted_at IS NULL ORDER BY rank LIMIT ?`
      )
      .all(fts, limit) as { conversation_id: number; number: number; snippet: string; subject: string | null }[];
    return rows.map((r) => ({
      scope: 'ai',
      id: r.conversation_id,
      title: `AI analysis · #${r.number} ${r.subject ?? ''}`,
      subtitle: 'AI-derived (marked as AI-generated)',
      snippet: r.snippet,
      score: 1,
      href: `/inbox/conversation/${r.conversation_id}`,
      why: ['AI analysis match']
    }));
  }

  search(query: string, scope: SearchScope = 'all', filters: SearchFilters = {}): SearchResponse {
    const hits: SearchHit[] = [];
    if (scope === 'all' || scope === 'tickets') hits.push(...this.searchConversations(query, filters));
    if (scope === 'all' || scope === 'customers') hits.push(...this.searchCustomers(query));
    if (scope === 'all' || scope === 'knowledge') hits.push(...this.searchKnowledge(query));
    if (scope === 'all' || scope === 'issues') hits.push(...this.searchKnownIssues(query));
    if (scope === 'all' || scope === 'saved_replies') hits.push(...this.searchSavedReplies(query));
    if (scope === 'all' || scope === 'ai') hits.push(...this.searchAiAnalyses(query));
    return { query, hits, total: hits.length, used_semantic: false, semantic_available: false };
  }
}
