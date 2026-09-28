import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';
import { MEMORY_ENTRY_KINDS, MEMORY_SECTIONS, MEMORY_SECTION_LABELS } from '../../shared/memory.js';

/**
 * M6 customer memory routes (v2.2.0, plan Phase 36). GET composes the
 * read-time profile; only human-written entries are persisted, and the
 * red-line quarantine refuses psychological/personality judgments on write.
 */
const kindSchema = z.enum(MEMORY_ENTRY_KINDS);

export async function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/memory/meta', async () => ({
    sections: MEMORY_SECTIONS,
    section_labels: MEMORY_SECTION_LABELS,
    entry_kinds: MEMORY_ENTRY_KINDS,
    notes: [
      'Memory is composed live from the local mirror; human-written entries are the only persisted rows.',
      'Entries matching the psychological/personality quarantine list are never returned as usable memory.'
    ]
  }));

  app.get('/api/memory/:customerId', async (request, reply) => {
    const id = Number((request.params as { customerId: string }).customerId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Customer id must be a positive integer.' });
      return;
    }
    const profile = ctx.customerMemory.profile(id);
    if (!profile) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    return profile;
  });

  app.post('/api/memory/:customerId/entries', async (request, reply) => {
    const id = Number((request.params as { customerId: string }).customerId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Customer id must be a positive integer.' });
      return;
    }
    const body = z
      .object({
        key: z.string().min(1).max(120),
        value: z.string().max(2000).nullable().optional(),
        kind: kindSchema.default('fact'),
        conversation_id: z.number().int().min(1).nullable().optional()
      })
      .parse(request.body ?? {});
    const result = ctx.customerMemory.upsertHumanEntry(id, {
      key: body.key.trim(),
      value: body.value?.trim() ? body.value : body.value ?? null,
      kind: body.kind,
      conversation_id: body.conversation_id ?? null
    });
    if (!result.ok) {
      if (result.code === 'quarantine') {
        reply.code(422).send({
          statusCode: 422,
          error: 'ValidationError',
          message: 'SupportOS policy: psychological/personality judgments are never stored as customer memory. Rephrase as an observable fact.'
        });
        return;
      }
      const code = result.code === 'customer_not_found' ? 404 : 422;
      reply.code(code).send({
        statusCode: code,
        error: code === 404 ? 'NotFound' : 'ValidationError',
        message: result.code === 'customer_not_found' ? 'Customer not found.' : 'Linked conversation not found.'
      });
      return;
    }
    return { ok: true, entry_id: result.entry_id };
  });

  app.delete('/api/memory/:customerId/entries/:entryId', async (request, reply) => {
    const params = request.params as { customerId: string; entryId: string };
    const customerId = Number(params.customerId);
    const entryId = Number(params.entryId);
    if (!Number.isInteger(customerId) || customerId <= 0 || !Number.isInteger(entryId) || entryId <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Customer id and entry id must be positive integers.' });
      return;
    }
    const result = ctx.customerMemory.deleteEntry(customerId, entryId);
    if (!result.ok) {
      if (result.code === 'ai_immutable') {
        reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'AI-extracted memories are immutable by design (they re-derive from conversations). Only human-written entries - and quarantined entries - can be deleted.'
        });
        return;
      }
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Memory entry not found for this customer.' });
      return;
    }
    return { ok: true };
  });
}
