import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { searchRequestSchema } from '../../shared/schemas.js';
import { mergeDocHits, cosineSimilarity } from '../search/docsSemantic.js';
import type { SearchHit } from '../../shared/types.js';

/**
 * Hybrid search (v1.5.0): keyword FTS + semantic vectors for TICKETS.
 *
 * Design (mirrors the v1.4.0 docs search):
 * - Retriever 1 is always FTS5 (works with zero configuration).
 * - Retriever 2 uses the query embedding against conversation_chunks. Qdrant
 *   serves ANN when connected; otherwise a LOCAL cosine scan over the stored
 *   Float32 embeddings - semantic ticket search is not hostage to a vector db.
 * - Fusion is Reciprocal Rank Fusion: FTS ranks and cosine scores live on
 *   incommensurable scales, so only RANKS are fused (raw score mixing would
 *   let one retriever silently dominate). Provenance is preserved per hit:
 *   'keyword', 'semantic' or both.
 * - Semantic is skipped honestly when no embedding model is configured or no
 *   chunks are indexed yet - the response says which mode produced the hits.
 */
export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/search', async (request) => {
    const body = searchRequestSchema.parse(request.body);
    const fts = ctx.search.search(body.query, body.scope, { ...body.filters, status: body.filters.status as 'all' | 'active' | 'pending' | 'closed' | 'spam' | undefined });
    const settings = ctx.settingsRepo.getLmStudio();
    const qdrantEnabled = ctx.settingsRepo.getQdrant().enabled;

    // ---- Hybrid ticket retrieval (RRF over FTS + semantic) ----
    if (body.query.trim() && (!body.scope || body.scope === 'all' || body.scope === 'tickets')) {
      const stats = ctx.conversationRepo.conversationChunkStats();
      if (settings.embedding_model && stats.indexed > 0) {
        try {
          const queryVector = (await ctx.aiProvider.embed([body.query]))[0];
          if (queryVector && queryVector.length > 0) {
            // Semantic retriever: Qdrant ANN first, local cosine fallback
            const semanticByConversation = new Map<number, { rank: number; snippet: string | null }>();
            let modeNote = 'Hybrid ticket search: FTS5 + semantic vectors via Qdrant, fused with Reciprocal Rank Fusion.';
            if (qdrantEnabled) {
              const hits = await ctx.qdrant.search(queryVector, 24);
              const chunkHits = hits.filter((h) => h.payload.entity_type === 'conversation_chunk');
              if (chunkHits.length > 0) {
                let rank = 0;
                for (const h of chunkHits) {
                  const convId = Number(h.payload.entity_id);
                  if (!semanticByConversation.has(convId)) {
                    semanticByConversation.set(convId, { rank: rank++, snippet: h.payload.text.slice(0, 200) });
                  }
                }
              }
            }
            if (semanticByConversation.size === 0) {
              // Local cosine scan over stored embeddings (no Qdrant needed)
              const chunks = ctx.conversationRepo.listConversationChunksWithEmbedding();
              const best = new Map<number, number>();
              const bestChunk = new Map<number, string>();
              for (const c of chunks) {
                const stored = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4);
                const sim = cosineSimilarity(queryVector, stored);
                const prev = best.get(c.conversation_id);
                if (prev == null || sim > prev) {
                  best.set(c.conversation_id, sim);
                  bestChunk.set(c.conversation_id, c.content.slice(0, 200));
                }
              }
              const ordered = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
              ordered.forEach(([convId], i) => {
                semanticByConversation.set(convId, { rank: i, snippet: bestChunk.get(convId) ?? null });
              });
              modeNote = qdrantEnabled
                ? 'Hybrid ticket search: FTS5 + semantic vectors (local cosine scan - Qdrant not reachable), fused with Reciprocal Rank Fusion.'
                : 'Hybrid ticket search: FTS5 + local semantic vectors, fused with Reciprocal Rank Fusion.';
            }

            // FTS tickets hits as rank input (order in the array = relevance)
            const ftsTickets = fts.hits.filter((h) => h.scope === 'tickets');
            const ftsRanks = ftsTickets.map((h, i) => ({ articleId: h.id, rank: i }));
            const semanticRanks = [...semanticByConversation.entries()].map(([convId, v]) => ({ articleId: convId, rank: v.rank, score: 1 / (1 + v.rank) }));
            const merged = mergeDocHits(ftsRanks, semanticRanks, 40);

            // Rebuild the tickets hit list: FTS hits keep their snippets; semantic-only
            // hits get chunk snippets; every hit records WHY it surfaced.
            const ftsById = new Map<number, SearchHit>(ftsTickets.map((h) => [h.id, h]));
            const rebuilt: SearchHit[] = [];
            for (const m of merged) {
              const existing = ftsById.get(m.articleId);
              if (existing) {
                rebuilt.push({ ...existing, score: m.score, why: m.why.includes('semantic') ? [...existing.why, 'semantic match'] : existing.why });
                continue;
              }
              const conv = ctx.conversationRepo.getConversationByLocalId(m.articleId);
              if (!conv) continue;
              const sem = semanticByConversation.get(m.articleId);
              rebuilt.push({
                scope: 'tickets',
                id: conv.id,
                title: `#${conv.number} ${conv.subject ?? '(no subject)'}`,
                subtitle: 'semantic match',
                snippet: sem?.snippet ?? '',
                score: m.score,
                href: `/inbox/conversation/${conv.id}`,
                why: ['semantic match']
              });
            }
            fts.hits = [...rebuilt, ...fts.hits.filter((h) => h.scope !== 'tickets')];
            fts.total = fts.hits.length;
            fts.used_semantic = true;
            fts.semantic_available = true;
            fts.mode_note = modeNote;
          }
        } catch {
          // Qdrant/LM Studio unavailable: keyword search remains fully functional
          fts.semantic_available = false;
        }
      } else if (settings.embedding_model && stats.indexed === 0) {
        fts.mode_note = 'Keyword search (FTS5). An embedding model is configured but no ticket chunks are embedded yet - run a sync so the embedding job can process the mirror.';
      } else if (!settings.embedding_model) {
        fts.mode_note = 'Keyword search (FTS5). Semantic ticket search needs an embedding model: Settings → LM Studio → embedding model, then the ticket embedding job runs on the next sync.';
      }
      // Knowledge + docs semantic layers (kept from v1.3/v1.4)
      if (settings.embedding_model && qdrantEnabled) {
        try {
          const vector = (await ctx.aiProvider.embed([body.query]))[0];
          if (vector) {
            const hits = await ctx.qdrant.search(vector, 8);
            for (const hit of hits) {
              if (hit.payload.entity_type === 'knowledge_chunk') {
                if (!fts.hits.some((h) => h.scope === 'knowledge' && h.id === hit.payload.entity_id)) {
                  fts.hits.push({
                    scope: 'knowledge',
                    id: hit.payload.entity_id,
                    title: hit.payload.title,
                    subtitle: `Knowledge · ${hit.payload.visibility === 'customer_safe' ? 'customer-safe' : 'internal'}`,
                    snippet: hit.payload.text.slice(0, 200),
                    score: hit.score,
                    href: `/knowledge/${hit.payload.entity_id}`,
                    why: ['semantic match']
                  });
                }
              }
            }
            fts.total = fts.hits.length;
          }
        } catch {
          // keyword search remains fully functional
        }
      }
    }
    return fts;
  });
}
