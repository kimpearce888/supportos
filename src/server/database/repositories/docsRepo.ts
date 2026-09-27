import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { HsDocCollection, HsDocCategory, HsDocArticle } from '../../integrations/helpscout/provider.js';
import type { DocsCollectionInfo, DocsArticleSummary, DocsArticleDetail, DocsStats } from '../../../shared/types.js';
import { chunkText } from '../../../shared/utils.js';
import type { BusinessHoursConfig, SlaTargets } from '../../analytics/businessHours.js';
import crypto from 'node:crypto';

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

/**
 * Docs repository (v1.3.0): local mirror of the Help Scout Docs API
 * (docsapi.helpscout.net). Collections, categories and articles are synced
 * by the SyncCoordinator ('docs_collections' / 'docs_articles' resources)
 * and searched via the docs_fts index. The mirror is read-only: SupportOS
 * never writes back to Docs.
 */
export class DocsRepository {
  constructor(private db: DB) {}

  // ---------------- Upserts (sync) ----------------

  upsertCollection(c: HsDocCollection): number {
    this.db
      .prepare(
        `INSERT INTO docs_collections (remote_id, name, slug, description, visibility, article_count, last_synced_at)
         VALUES (@rid, @name, @slug, @description, @visibility, @count, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET
           name=excluded.name, slug=excluded.slug, description=excluded.description,
           visibility=excluded.visibility, article_count=excluded.article_count, last_synced_at=excluded.last_synced_at`
      )
      .run({ rid: c.remoteId, name: c.name, slug: c.slug, description: c.description, visibility: c.visibility, count: c.articleCount, synced: nowIso() });
    return (this.db.prepare('SELECT id FROM docs_collections WHERE remote_id = ?').get(c.remoteId) as { id: number }).id;
  }

  upsertCategories(collectionLocalId: number, categories: HsDocCategory[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO docs_categories (remote_id, collection_local_id, name, slug, sort_order, last_synced_at)
       VALUES (@rid, @collection, @name, @slug, @order, @synced)
       ON CONFLICT(remote_id) DO UPDATE SET
         collection_local_id=excluded.collection_local_id, name=excluded.name, slug=excluded.slug,
         sort_order=excluded.sort_order, last_synced_at=excluded.last_synced_at`
    );
    const tx = this.db.transaction(() => {
      for (const c of categories) {
        upsert.run({ rid: c.remoteId, collection: collectionLocalId, name: c.name, slug: c.slug, order: c.order, synced: nowIso() });
      }
    });
    tx();
  }

  upsertArticle(a: HsDocArticle, collectionLocalId: number): number {
    const categoryLocal = a.categoryId
      ? (this.db.prepare('SELECT id FROM docs_categories WHERE remote_id = ?').get(a.categoryId) as { id: number } | undefined)?.id ?? null
      : null;
    const preview = a.preview ?? (a.text ? a.text.replace(/\s+/g, ' ').slice(0, 220) : null);
    const words = a.text ? a.text.split(/\s+/).filter(Boolean).length : null;
    // v1.6.0 audit fix (HIGH - embedding churn): re-chunking used to run on
    // EVERY upsert, which happens on every incremental sync. That DELETEd all
    // docs_chunks rows and reset them to 'not_indexed', destroying every stored
    // embedding even when the article text was byte-identical - the whole corpus
    // re-embedded (and re-upserted to Qdrant) on each 5-minute tick. Gate both
    // rechunkArticle and reindexArticle on a content hash now; metadata columns
    // (views, collection, category...) still update every pass.
    const chunkSource = a.text ? `${a.name}\n\n${a.text}` : a.name;
    const contentHash = crypto.createHash('sha256').update(chunkSource).digest('hex');
    const existing = this.db.prepare('SELECT id, content_hash FROM docs_articles WHERE remote_id = ?').get(a.remoteId) as { id: number; content_hash: string | null } | undefined;
    const contentChanged = !existing || existing.content_hash !== contentHash;
    this.db
      .prepare(
        `INSERT INTO docs_articles (remote_id, collection_local_id, category_local_id, number, slug, name, status, preview, text, views, words, remote_created_at, remote_updated_at, last_synced_at, content_hash)
         VALUES (@rid, @collection, @category, @number, @slug, @name, @status, @preview, @text, @views, @words, @rc, @ru, @synced, @hash)
         ON CONFLICT(remote_id) DO UPDATE SET
           collection_local_id=excluded.collection_local_id, category_local_id=excluded.category_local_id,
           number=excluded.number, slug=excluded.slug, name=excluded.name, status=excluded.status,
           preview=excluded.preview, text=excluded.text, views=excluded.views, words=excluded.words,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           last_synced_at=excluded.last_synced_at, content_hash=excluded.content_hash`
      )
      .run({ rid: a.remoteId, collection: collectionLocalId, category: categoryLocal, number: a.number, slug: a.slug, name: a.name, status: a.status, preview, text: a.text, views: a.views, words, rc: a.createdAt, ru: a.updatedAt, synced: nowIso(), hash: contentHash });
    const id = existing?.id ?? (this.db.prepare('SELECT id FROM docs_articles WHERE remote_id = ?').get(a.remoteId) as { id: number }).id;
    if (contentChanged) {
      this.reindexArticleFts(id, a.name, a.text);
      this.rechunkArticle(id, a.name, a.text);
    }
    return id;
  }

  /**
   * v1.4.0: (re)chunk an article for semantic search. Delete+insert in a
   * transaction, resetting embedding state - content changes invalidate
   * previous embeddings, mirroring the knowledge_chunks lifecycle.
   */
  private rechunkArticle(articleId: number, title: string, text: string | null): void {
    const chunks = text ? chunkText(`${title}\n\n${text}`, 1200, 150) : [];
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM docs_chunks WHERE article_id = ?').run(articleId);
      const ins = this.db.prepare('INSERT INTO docs_chunks (article_id, chunk_index, content, chunk_version) VALUES (?, ?, ?, 2)');
      chunks.forEach((c, i) => ins.run(articleId, i, c));
    });
    tx();
  }

  /** delete+insert pattern, consistent with the other FTS tables. */
  private reindexArticleFts(articleId: number, name: string, text: string | null): void {
    this.db.prepare('DELETE FROM docs_fts WHERE article_id = ?').run(articleId);
    this.db.prepare('INSERT INTO docs_fts (name, text, article_id) VALUES (?, ?, ?)').run(name, text ?? '', articleId);
  }

  // ---------------- Reads ----------------

  listCollections(): DocsCollectionInfo[] {
    return this.db
      .prepare('SELECT id, remote_id, name, slug, description, visibility, article_count, last_synced_at FROM docs_collections ORDER BY name')
      .all() as DocsCollectionInfo[];
  }

  /** Paged article list with optional collection filter, FTS search and status filter. */
  listArticles(params: { collectionId?: number | null; q?: string | null; status?: string | null; page?: number; pageSize?: number }): { articles: DocsArticleSummary[]; total: number } {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (params.collectionId) {
      where.push('a.collection_local_id = @collection');
      args.collection = params.collectionId;
    }
    if (params.status) {
      where.push('a.status = @status');
      args.status = params.status;
    }
    let ids: number[] | null = null;
    if (params.q) {
      const tokens = params.q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 6).map((t) => `"${t}"*`).join(' ');
      if (tokens) {
        const hits = this.db.prepare(`SELECT article_id FROM docs_fts WHERE docs_fts MATCH ?`).all(tokens) as { article_id: number }[];
        ids = hits.map((h) => h.article_id);
        where.push(ids.length > 0 ? `a.id IN (${ids.join(',')})` : '0');
      }
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM docs_articles a ${whereSql}`).get(args) as { n: number }).n;
    const articles = this.db
      .prepare(
        `SELECT a.id, a.remote_id, a.collection_local_id AS collection_id, c.name AS collection_name,
           a.category_local_id AS category_id, cat.name AS category_name, a.number, a.slug, a.name, a.status,
           a.preview, a.words, a.views, a.remote_created_at, a.remote_updated_at
         FROM docs_articles a
         LEFT JOIN docs_collections c ON c.id = a.collection_local_id
         LEFT JOIN docs_categories cat ON cat.id = a.category_local_id
         ${whereSql}
         ORDER BY COALESCE(a.remote_updated_at, a.remote_created_at) DESC, a.id DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...args, limit: pageSize, offset: (page - 1) * pageSize }) as DocsArticleSummary[];
    return { articles, total };
  }

  getArticle(id: number): DocsArticleDetail | null {
    const row = this.db
      .prepare(
        `SELECT a.id, a.remote_id, a.collection_local_id AS collection_id, c.name AS collection_name,
           a.category_local_id AS category_id, cat.name AS category_name, a.number, a.slug, a.name, a.status,
           a.preview, a.words, a.views, a.remote_created_at, a.remote_updated_at, a.text
         FROM docs_articles a
         LEFT JOIN docs_collections c ON c.id = a.collection_local_id
         LEFT JOIN docs_categories cat ON cat.id = a.category_local_id
         WHERE a.id = ?`
      )
      .get(id) as DocsArticleDetail | undefined;
    return row ?? null;
  }

  stats(): DocsStats {
    const s = (this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM docs_collections) AS collections,
           (SELECT COUNT(*) FROM docs_articles) AS articles,
           (SELECT COUNT(*) FROM docs_articles WHERE status='published') AS published,
           (SELECT COUNT(*) FROM docs_articles WHERE status='draft') AS drafts,
           (SELECT COUNT(*) FROM docs_articles WHERE status='internal') AS internal,
           (SELECT COALESCE(SUM(views), 0) FROM docs_articles) AS total_views,
           (SELECT MAX(last_synced_at) FROM docs_articles) AS last_synced_at`
      )
      .get() as DocsStats & { chat_sessions?: number; email_conversations?: number }) ?? { collections: 0, articles: 0, published: 0, drafts: 0, internal: 0, total_views: 0, last_synced_at: null };
    const channels = this.db
      .prepare(`SELECT COALESCE(type, 'unknown') AS channel, COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL GROUP BY type`)
      .all() as { channel: string; n: number }[];
    const byChannel = new Map(channels.map((c) => [c.channel, c.n]));
    const embedding = this.docsEmbeddingStats();
    return {
      ...s,
      chat_sessions: byChannel.get('chat') ?? 0,
      email_conversations: byChannel.get('email') ?? 0,
      docs_chunks: embedding.chunks,
      docs_chunks_indexed: embedding.indexed,
      docs_chunks_pending: embedding.pending,
      docs_chunks_failed: embedding.failed
    } as DocsStats & { docs_chunks?: number };
  }

  // ---------------- Semantic search support (v1.4.0) ----------------

  docsEmbeddingStats(): { chunks: number; indexed: number; pending: number; failed: number } {
    const r = (this.db
      .prepare(
        `SELECT COUNT(*) AS chunks,
           SUM(CASE WHEN embedding_state='indexed' THEN 1 ELSE 0 END) AS indexed,
           SUM(CASE WHEN embedding_state IN ('not_indexed','queued') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN embedding_state='failed' THEN 1 ELSE 0 END) AS failed
         FROM docs_chunks`
      )
      .get() as { chunks: number; indexed: number | null; pending: number | null; failed: number | null }) ?? { chunks: 0, indexed: null, pending: null, failed: null };
    return { chunks: r.chunks ?? 0, indexed: r.indexed ?? 0, pending: r.pending ?? 0, failed: r.failed ?? 0 };
  }

  listDocChunksNeedingEmbedding(limit = 60): { id: number; article_id: number; content: string; title: string; visibility: 'customer_safe' | 'internal_only' }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.article_id, c.content, a.name AS title,
           CASE WHEN a.status = 'published' THEN 'customer_safe' ELSE 'internal_only' END AS visibility
         FROM docs_chunks c JOIN docs_articles a ON a.id = c.article_id
         WHERE (c.embedding_state = 'not_indexed' OR c.embedding_state = 'failed') AND c.embedding_attempts < 5 LIMIT ?`
      )
      .all(limit) as { id: number; article_id: number; content: string; title: string; visibility: 'customer_safe' | 'internal_only' }[];
  }

  setDocChunkEmbeddingState(chunkId: number, state: string, model?: string | null): void {
    this.db.prepare('UPDATE docs_chunks SET embedding_state = ?, embedding_model = COALESCE(?, embedding_model) WHERE id = ?').run(state, model ?? null, chunkId);
  }

  // v1.6.0 audit fix: failed chunks count attempts; after 5 failures a chunk is
  // left alone (excluded from listing) until its content changes and re-chunks.
  markDocChunkFailed(chunkId: number): void {
    this.db.prepare("UPDATE docs_chunks SET embedding_state = 'failed', embedding_attempts = embedding_attempts + 1 WHERE id = ?").run(chunkId);
  }

  updateDocChunkEmbedding(chunkId: number, model: string | null, embedding: Float32Array | null, state: string): void {
    this.db.prepare('UPDATE docs_chunks SET embedding = ?, embedding_model = ?, embedding_state = ? WHERE id = ?').run(embedding ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null, model, state, chunkId);
  }

  /** All chunks with a stored local embedding (the no-Qdrant fallback scan). */
  listDocChunksWithEmbedding(limit = 2000): { id: number; article_id: number; content: string; embedding: Buffer; title: string }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.article_id, c.content, c.embedding, a.name AS title
         FROM docs_chunks c JOIN docs_articles a ON a.id = c.article_id
         WHERE c.embedding IS NOT NULL AND c.embedding_state = 'indexed' LIMIT ?`
      )
      .all(limit) as { id: number; article_id: number; content: string; embedding: Buffer; title: string }[];
  }

  /** FTS hits as (articleId -> best rank position + snippet) over docs_fts. */
  ftsDocRanks(q: string): { articleId: number; rank: number; snippet: string | null }[] {
    const tokens = q.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 8).map((t) => `"${t}"*`).join(' ');
    if (!tokens) return [];
    // fts5 auxiliary functions (snippet) cannot be combined with GROUP BY, so
    // rows stream in rank order and the FIRST row per article wins in JS.
    const rows = this.db
      .prepare(
        `SELECT article_id, snippet(docs_fts, 1, '[', ']', '…', 14) AS s
         FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT 400`
      )
      .all(tokens) as { article_id: number; s: string }[];
    const out: { articleId: number; rank: number; snippet: string | null }[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.article_id)) continue;
      seen.add(r.article_id);
      out.push({ articleId: r.article_id, rank: out.length, snippet: r.s });
    }
    return out;
  }

  /** Articles by ids, summary shape, ordered as given. */
  getArticlesByIds(ids: number[]): DocsArticleSummary[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT a.id, a.remote_id, a.collection_local_id AS collection_id, c.name AS collection_name,
           a.category_local_id AS category_id, cat.name AS category_name, a.number, a.slug, a.name, a.status,
           a.preview, a.words, a.views, a.remote_created_at, a.remote_updated_at
         FROM docs_articles a
         LEFT JOIN docs_collections c ON c.id = a.collection_local_id
         LEFT JOIN docs_categories cat ON cat.id = a.category_local_id
         WHERE a.id IN (${placeholders})`
      )
      .all(...ids) as DocsArticleSummary[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is DocsArticleSummary => r != null);
  }

  // ---------------- Business hours (v1.4.0 SLA) ----------------

  getBusinessHours(mailboxLocalId: number): (BusinessHoursConfig & SlaTargets) | null {
    const row = this.db.prepare('SELECT * FROM mailbox_business_hours WHERE mailbox_local_id = ?').get(mailboxLocalId) as
      | { mailbox_local_id: number; timezone: string; days: string; start_minute: number; end_minute: number; first_response_target_min: number | null; resolution_target_min: number | null }
      | undefined;
    if (!row) return null;
    let days = DEFAULT_DAYS;
    try {
      const parsed = JSON.parse(row.days) as number[];
      if (Array.isArray(parsed)) days = parsed;
    } catch {
      /* malformed JSON falls back to Mon-Fri */
    }
    return {
      timezone: row.timezone,
      days,
      startMinute: row.start_minute,
      endMinute: row.end_minute,
      firstResponseTargetMin: row.first_response_target_min,
      resolutionTargetMin: row.resolution_target_min
    };
  }

  listBusinessHours(): { mailbox_local_id: number; timezone: string; days: string; start_minute: number; end_minute: number; first_response_target_min: number | null; resolution_target_min: number | null }[] {
    return this.db.prepare('SELECT * FROM mailbox_business_hours ORDER BY mailbox_local_id').all() as { mailbox_local_id: number; timezone: string; days: string; start_minute: number; end_minute: number; first_response_target_min: number | null; resolution_target_min: number | null }[];
  }

  setBusinessHours(mailboxLocalId: number, cfg: BusinessHoursConfig & SlaTargets): void {
    this.db
      .prepare(
        `INSERT INTO mailbox_business_hours (mailbox_local_id, timezone, days, start_minute, end_minute, first_response_target_min, resolution_target_min, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mailbox_local_id) DO UPDATE SET
           timezone=excluded.timezone, days=excluded.days, start_minute=excluded.start_minute,
           end_minute=excluded.end_minute, first_response_target_min=excluded.first_response_target_min,
           resolution_target_min=excluded.resolution_target_min, updated_at=excluded.updated_at`
      )
      .run(mailboxLocalId, cfg.timezone, JSON.stringify(cfg.days), cfg.startMinute, cfg.endMinute, cfg.firstResponseTargetMin, cfg.resolutionTargetMin, nowIso());
  }

  clearBusinessHours(mailboxLocalId: number): void {
    this.db.prepare('DELETE FROM mailbox_business_hours WHERE mailbox_local_id = ?').run(mailboxLocalId);
  }
}
