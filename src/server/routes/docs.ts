import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import type { DocsSearchResponse, DocsSearchHit } from '../../shared/types.js';
import { mergeDocHits, cosineSimilarity, type FtsDocHit, type SemanticDocHit } from '../search/docsSemantic.js';

/**
 * Docs routes (v1.3.0): read-only access to the local Docs API mirror
 * (collections, categories, articles + FTS search). The mirror is synced by
 * the SyncCoordinator ('docs_collections' / 'docs_articles' resources) using
 * the separate Docs API key; without that key the mirror stays empty and
 * these endpoints return empty lists (honest capability, no errors).
 *
 * v1.4.0 adds hybrid search: FTS5 + semantic retrieval fused with RRF.
 * Semantic vectors come from Qdrant when available, with a local cosine
 * fallback over stored embeddings so the feature degrades honestly:
 * - no embedding model configured  -> FTS only, semantic_available=false
 * - model configured, Qdrant down   -> local cosine scan, semantic works
 * - model configured, no embeddings yet -> FTS only, honest note
 */
export async function registerDocsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const docs = ctx.docsRepo;

  app.get('/api/docs/collections', async () => {
    return { collections: docs.listCollections(), docs_sync_available: ctx.provider.kind === 'fake' || ctx.realProvider?.docs !== undefined };
  });

  app.get('/api/docs/stats', async () => docs.stats());

  app.get('/api/docs/search', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const query = (q.q ?? '').trim();
    const semanticRequested = q.semantic == null || q.semantic === '' || q.semantic === '1' || q.semantic === 'true';
    const limit = q.limit ? Number(q.limit) : 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'limit must be 1-100.' });
      return;
    }
    if (!query) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'q is required.' });
      return;
    }

    // --- Retriever 1: FTS5 (always available) ---
    const ftsHits: (FtsDocHit & { snippet: string | null })[] = docs.ftsDocRanks(query);
    const fts = ftsHits.map((h) => ({ articleId: h.articleId, rank: h.rank }));
    const snippets = new Map(ftsHits.map((h) => [h.articleId, h.snippet]));

    // --- Retriever 2: semantic (embedding model + embeddings required; toggleable) ---
    const settings = ctx.settingsRepo.getLmStudio();
    const stats = docs.docsEmbeddingStats();
    let semantic: SemanticDocHit[] = [];
    let usedSemantic = false;
    let modeNote = 'Keyword search (FTS5).';
    const matchedChunks = new Map<number, string>();

    if (!semanticRequested) {
      modeNote = 'Keyword search (FTS5) - semantic retrieval disabled for this query.';
    } else if (!settings.embedding_model) {
      modeNote = 'Keyword search (FTS5). Semantic search needs an embedding model: Settings → LM Studio → embedding model, then the docs embedding job runs on the next sync.';
    } else if (stats.indexed === 0) {
      modeNote = 'Keyword search (FTS5). An embedding model is configured but no docs chunks are embedded yet - run a sync so the embedding job can process the mirror.';
    } else {
      try {
        const queryVector = (await ctx.aiProvider.embed([query]))[0];
        if (queryVector && queryVector.length > 0) {
          // Qdrant first (ANN, same vectors)
          const qdrantHits = await ctx.qdrant.search(queryVector, 20);
          const docsPoints = qdrantHits.filter((h) => h.payload.entity_type === 'docs_chunk');
          if (docsPoints.length > 0) {
            semantic = docsPoints.map((h) => ({ articleId: Number(h.payload.entity_id), score: h.score }));
            modeNote = 'Hybrid search: FTS5 + semantic vectors via Qdrant, fused with Reciprocal Rank Fusion.';
          } else {
            // Local cosine fallback over stored embeddings (works without Qdrant)
            const chunks = docs.listDocChunksWithEmbedding();
            const best = new Map<number, number>();
            for (const c of chunks) {
              const stored = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4);
              const sim = cosineSimilarity(queryVector, stored);
              const prev = best.get(c.article_id);
              if (prev == null || sim > prev) {
                best.set(c.article_id, sim);
                matchedChunks.set(c.article_id, c.content.slice(0, 220));
              }
            }
            semantic = [...best.entries()]
              .map(([articleId, score]) => ({ articleId, score }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 20);
            modeNote = 'Hybrid search: FTS5 + semantic vectors (local cosine scan - Qdrant not reachable), fused with Reciprocal Rank Fusion.';
          }
          usedSemantic = semantic.length > 0;
        }
      } catch {
        modeNote = 'Keyword search (FTS5). Semantic retrieval failed this request (embedding provider unreachable) - retried automatically next search.';
      }
    }

    const merged = mergeDocHits(fts, semantic, limit);
    const articles = docs.getArticlesByIds(merged.map((m) => m.articleId));
    const byArticle = new Map(articles.map((a) => [a.id, a]));
    const hits: DocsSearchHit[] = [];
    for (const m of merged) {
      const article = byArticle.get(m.articleId);
      if (!article) continue;
      hits.push({
        article,
        score: m.score,
        why: m.why,
        snippet: snippets.get(m.articleId) ?? article.preview,
        matched_chunk: matchedChunks.get(m.articleId) ?? null
      });
    }

    const response: DocsSearchResponse = {
      query,
      hits,
      total: hits.length,
      used_semantic: usedSemantic,
      semantic_available: Boolean(settings.embedding_model) && stats.indexed > 0,
      mode_note: modeNote
    };
    return response;
  });

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
