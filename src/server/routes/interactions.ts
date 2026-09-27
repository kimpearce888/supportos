import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { interactionOverrideSchema } from '../../shared/schemas.js';

/**
 * Client Interaction Intelligence API (interaction spec #25, #26, #22, #45, #57).
 * Every response is derived data, clearly labeled heuristic / ai_generated.
 */
export async function registerInteractionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const engine = () => ctx.aiPipeline.interactionEngine();

  // Ticket-scoped interaction card (spec #26, #62)
  app.get('/api/interaction/:conversationId', async (request, reply) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isFinite(conversationId)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid conversation id.' });
      return;
    }
    const card = engine().buildCard(conversationId);
    if (!card) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    return { card, labels: { featureTitle: 'Client Interaction Profile', note: 'Observable support-communication behavior only — never a psychological assessment.' } };
  });

  // Refresh: recompute deterministic signals + optional two-stage AI enrichment
  app.post('/api/interaction/:conversationId/refresh', async (request, reply) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isFinite(conversationId)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid conversation id.' });
      return;
    }
    try {
      const result = await ctx.aiPipeline.analyzeInteraction(conversationId);
      const card = engine().buildCard(conversationId);
      return { ok: true, ai_enriched: result.ai_enriched, error: result.error ?? null, card };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('not found')) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
        return;
      }
      reply.code(503);
      return { ok: false, error: message };
    }
  });

  // Evidence for a signal: the source thread excerpt (spec #8, #57)
  app.get('/api/interaction/:conversationId/evidence', async (request, reply) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isFinite(conversationId)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid conversation id.' });
      return;
    }
    const customerId = engine().conversationCustomer(conversationId);
    if (!customerId) {
      return { observations: [] };
    }
    const observations = engine().repo.getObservationsForCustomer(customerId).filter((o) => o.conversation_id === conversationId || o.conversation_id === null);
    return {
      observations: observations.map((o) => ({
        dimension: o.dimension,
        value: o.value,
        confidence: o.confidence,
        evidence_excerpt: o.evidence_excerpt,
        conversation_local_id: o.conversation_id,
        thread_local_id: o.thread_local_id,
        observed_at: o.observed_at,
        provenance: o.source === 'ai' ? 'ai_generated' : 'heuristic'
      }))
    };
  });

  // Customer-scoped profile (spec #25): timeline, preferences, outcomes, playbook, overrides
  app.get('/api/interaction/profile/:customerId', async (request, reply) => {
    const customerId = Number((request.params as { customerId: string }).customerId);
    if (!Number.isFinite(customerId)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid customer id.' });
      return;
    }
    const profile = engine().buildProfile(customerId);
    if (!profile) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found or no interaction data.' });
      return;
    }
    return { profile };
  });

  // Human override (spec #22, #45, #56): takes precedence over AI inference.
  // Only the response preference is overridable — it is the only dimension the
  // engine and draft pipeline consume; other fields would be dead data.
  app.post('/api/interaction/profile/:customerId/override', async (request, reply) => {
    const customerId = Number((request.params as { customerId: string }).customerId);
    if (!Number.isFinite(customerId) || !ctx.peopleRepo.getCustomerByLocalId(customerId)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    const parsed = interactionOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Invalid override payload: field must be response_preference and value must be a known preference (concise, detailed, step_by_step, technical, conversational, outcome_focused).' });
      return;
    }
    const { value, reason } = parsed.data;
    const effective = engine().repo.getPreferences(customerId).find((p) => p.origin === 'human_entered')?.preference ?? null;
    engine().repo.setHumanOverride(customerId, value, effective, reason ?? null);
    ctx.jobsRepo.audit({ actor: 'user', action: 'interaction_override_set:response_preference', ai_involvement: false, after_state: { value } });
    return { ok: true, message: 'Human preference saved. It takes precedence over AI-inferred preferences.' };
  });

  // Clear the override: fall back to AI-inferred observations
  app.delete('/api/interaction/profile/:customerId/override/:field', async (request, reply) => {
    const customerId = Number((request.params as { customerId: string }).customerId);
    const field = (request.params as { field: string }).field;
    if (!Number.isFinite(customerId) || !ctx.peopleRepo.getCustomerByLocalId(customerId)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    if (field !== 'response_preference') {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Only response_preference overrides exist.' });
      return;
    }
    engine().repo.clearHumanOverride(customerId);
    ctx.jobsRepo.audit({ actor: 'user', action: 'interaction_override_cleared:response_preference', ai_involvement: false });
    return { ok: true, message: 'Override removed. AI-inferred preferences (if any) apply again.' };
  });
}
