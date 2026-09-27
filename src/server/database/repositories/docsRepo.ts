import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { HsDocCollection, HsDocCategory, HsDocArticle } from '../../integrations/helpscout/provider.js';
import type { DocsCollectionInfo, DocsArticleSummary, DocsArticleDetail, DocsStats } from '../../../shared/types.js';

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
    this.db
      .prepare(
        `INSERT INTO docs_articles (remote_id, collection_local_id, category_local_id, number, slug, name, status, preview, text, views, words, remote_created_at, remote_updated_at, last_synced_at)
         VALUES (@rid, @collection, @category, @number, @slug, @name, @status, @preview, @text, @views, @words, @rc, @ru, @synced)
         ON CONFLICT(remote_id) DO UPDATE SET
           collection_local_id=excluded.collection_local_id, category_local_id=excluded.category_local_id,
           number=excluded.number, slug=excluded.slug, name=excluded.name, status=excluded.status,
           preview=excluded.preview, text=excluded.text, views=excluded.views, words=excluded.words,
           remote_created_at=excluded.remote_created_at, remote_updated_at=excluded.remote_updated_at,
           last_synced_at=excluded.last_synced_at`
      )
      .run({ rid: a.remoteId, collection: collectionLocalId, category: categoryLocal, number: a.number, slug: a.slug, name: a.name, status: a.status, preview, text: a.text, views: a.views, words, rc: a.createdAt, ru: a.updatedAt, synced: nowIso() });
    const id = (this.db.prepare('SELECT id FROM docs_articles WHERE remote_id = ?').get(a.remoteId) as { id: number }).id;
    this.reindexArticleFts(id, a.name, a.text);
    return id;
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
    return {
      ...s,
      chat_sessions: byChannel.get('chat') ?? 0,
      email_conversations: byChannel.get('email') ?? 0
    };
  }
}
