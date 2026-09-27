import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { searchRequestSchema } from '../../shared/schemas.js';

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/search', async (request) => {
    const body = searchRequestSchema.parse(request.body);
    const fts = ctx.search.search(body.query, body.scope, { ...body.filters, status: body.filters.status as 'all' | 'active' | 'pending' | 'closed' | 'spam' | undefined });
    // Hybrid: merge semantic results when Qdrant + embedding model are available
    const settings = ctx.settingsRepo.getLmStudio();
    const qdrantEnabled = ctx.settingsRepo.getQdrant().enabled;
    if (settings.embedding_model && qdrantEnabled && body.query.trim()) {
      try {
        const vector = (await ctx.aiProvider.embed([body.query]))[0];
        if (vector) {
          const hits = await ctx.qdrant.search(vector, 8);
          const semanticIds = new Set(hits.map((h) => h.payload.entity_id));
          for (const hit of hits) {
            if (hit.payload.entity_type === 'conversation') {
              const conv = ctx.conversationRepo.getConversationByLocalId(hit.payload.entity_id);
              if (conv && !fts.hits.some((h) => h.scope === 'tickets' && h.id === conv.id)) {
                fts.hits.push({
                  scope: 'tickets',
                  id: conv.id,
                  title: `#${conv.number} ${conv.subject ?? '(no subject)'}`,
                  subtitle: 'semantic match',
                  snippet: hit.payload.text.slice(0, 200),
                  score: hit.score,
                  href: `/inbox/conversation/${conv.id}`,
                  why: ['semantic match']
                });
              }
            } else if (hit.payload.entity_type === 'knowledge_chunk') {
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
          fts.used_semantic = semanticIds.size > 0;
          fts.semantic_available = true;
          fts.total = fts.hits.length;
        }
      } catch {
        // Qdrant/LM Studio unavailable: keyword search remains fully functional (spec #26)
        fts.semantic_available = false;
      }
    }
    return fts;
  });
}
