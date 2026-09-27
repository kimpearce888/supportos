import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';

/**
 * Docs routes (v1.3.0): read-only access to the local Docs API mirror
 * (collections, categories, articles + FTS search). The mirror is synced by
 * the SyncCoordinator ('docs_collections' / 'docs_articles' resources) using
 * the separate Docs API key; without that key the mirror stays empty and
 * these endpoints return empty lists (honest capability, no errors).
 */
export async function registerDocsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const docs = ctx.docsRepo;

  app.get('/api/docs/collections', async () => {
    return { collections: docs.listCollections(), docs_sync_available: ctx.provider.kind === 'fake' || ctx.realProvider?.docs !== undefined };
  });

  app.get('/api/docs/stats', async () => docs.stats());

  app.get('/api/docs/articles', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 25;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'page must be >= 1 and pageSize must be 1-100.' });
      return;
    }
    const collectionId = q.collectionId != null && q.collectionId !== '' ? Number(q.collectionId) : null;
    if (collectionId != null && (!Number.isInteger(collectionId) || collectionId <= 0)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'collectionId must be a positive integer.' });
      return;
    }
    const status = q.status ?? null;
    if (status && !['published', 'draft', 'internal'].includes(status)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: "status must be one of 'published', 'draft', 'internal'." });
      return;
    }
    const result = docs.listArticles({
      collectionId,
      q: q.q ?? null,
      status,
      page,
      pageSize
    });
    return { articles: result.articles, total: result.total, page, page_size: pageSize };
  });

  app.get('/api/docs/articles/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Article id must be a positive integer.' });
      return;
    }
    const article = docs.getArticle(id);
    if (!article) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Article not found in the local docs mirror. Run a sync with a Docs API key configured.' });
      return;
    }
    return { article };
  });
}
