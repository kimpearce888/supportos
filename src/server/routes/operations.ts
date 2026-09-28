import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { CapacityModelUpdateSchema, type CapacityModel } from '../../shared/collaboration.js';
import { clampListParam } from './helpers.js';

/**
 * Operations Center + workload routes (v1.8.0, plan Phases 10-11).
 *
 * All read-only aggregations except the two explicit configuration endpoints
 * (capacity model, waiting threshold). The suggested assignee is a
 * RECOMMENDATION only - assignment itself goes through the existing
 * POST /api/conversations/:id/assign write path when a human clicks.
 */
export async function registerOperationsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/operations/center', async (request) => {
    // Duplicate query params (?mailboxes=1&mailboxes=2) arrive as arrays -
    // normalize to a single comma string before parsing (never a 500).
    const raw = (request.query as Record<string, string | string[] | undefined>).mailboxes;
    const rawStr = Array.isArray(raw) ? raw.join(',') : raw;
    // Scope: ?mailboxes=1,2 (local ids); omitted/empty/"all" = all inboxes.
    let mailboxIds: number[] | null = null;
    if (rawStr != null && rawStr !== '' && rawStr !== 'all') {
      mailboxIds = rawStr
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0)
        .slice(0, 50);
    }
    return ctx.operationsCenter.snapshot(mailboxIds);
  });

  app.get('/api/operations/workload', async () => ctx.workload.snapshot());

  app.put('/api/operations/capacity', async (request, reply) => {
    const parsed = CapacityModelUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: parsed.error.issues[0]?.message ?? 'Invalid capacity model.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const model: CapacityModel = {
      default_max_open: parsed.data.default_max_open,
      per_user_max: parsed.data.per_user_max,
      weights: parsed.data.weights
    };
    ctx.workload.setCapacityModel(model);
    return { saved: true, capacity_model: ctx.workload.getCapacityModel() };
  });

  app.put('/api/operations/waiting-threshold', async (request, reply) => {
    const body = request.body as { minutes?: unknown } | null;
    const minutes = Number(body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 20160) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'minutes must be a number between 1 and 20160 (14 days).' });
      return;
    }
    ctx.operationsCenter.setWaitingThresholdMinutes(Math.trunc(minutes));
    return { saved: true, waiting_threshold_minutes: ctx.operationsCenter.waitingThresholdMinutes() };
  });

  app.get('/api/operations/suggested-assignees', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = clampListParam(q.limit, 10, 1, 50);
    return { suggestions: ctx.workload.suggestedAssignees(limit) };
  });
}
