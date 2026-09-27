import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { automationRuleSchema } from '../../shared/schemas.js';

export async function registerAutomationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/automation/rules', async () => ({
    rules: ctx.automation.listRules(),
    runs: ctx.automation.listRuns(50),
    risk_tiers: {
      read: ['analyze_ticket', 'search_similar', 'check_known_issues'],
      non_destructive: ['create_ai_note', 'create_ai_draft', 'add_tag', 'manual_review_queue'],
      higher_risk: ['set_status', 'assign'],
      note: 'Higher-risk actions always require explicit approval. Help Scout workflows are a separate system (Automation screen shows both).'
    },
    automation_enabled: ctx.settingsRepo.getAllSettings().automation_enabled
  }));

  app.post('/api/automation/rules', async (request, reply) => {
    const parsed = automationRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Invalid automation rule.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const id = ctx.automation.createRule(parsed.data);
    ctx.jobsRepo.audit({ actor: 'user', action: 'automation_rule_created', after_state: { id, name: parsed.data.name } });
    return { ok: true, message: 'Automation rule created (disabled by default - enable it when ready).', id };
  });

  app.patch('/api/automation/rules/:id', async (request, reply) => {
    // v1.6.0 audit fix: previously the PATCH accepted a fully unvalidated body
    // (its sibling POST validates with automationRuleSchema) and a missing body
    // could crash. The patch shape is validated now; full rule replacements go
    // through the same schema the POST uses.
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const allowed: string[] = ['name', 'enabled', 'trigger', 'conditions', 'actions', 'priority', 'requires_approval'];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in raw) patch[key] = raw[key];
    }
    if (Object.keys(patch).length === 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'No valid fields to update (name, enabled, trigger, conditions, actions, priority, requires_approval).' });
      return;
    }
    // Full trigger/conditions/actions replacements must satisfy the create schema.
    if (patch.conditions !== undefined || patch.actions !== undefined || patch.trigger !== undefined) {
      const existing = ctx.automation.listRules().find((r) => r.id === Number((request.params as { id: string }).id));
      if (!existing) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Rule not found.' });
        return;
      }
      const candidate = automationRuleSchema.parse({
        name: (patch.name as string | undefined) ?? existing.name,
        trigger: (patch.trigger as string | undefined) ?? existing.trigger,
        conditions: (patch.conditions as unknown[] | undefined) ?? existing.conditions,
        actions: (patch.actions as unknown[] | undefined) ?? existing.actions,
        priority: (patch.priority as number | undefined) ?? existing.priority,
        requires_approval: (patch.requires_approval as boolean | number | undefined) ?? existing.requires_approval === 1
      });
      patch.conditions = candidate.conditions;
      patch.actions = candidate.actions;
      patch.trigger = candidate.trigger;
      patch.name = candidate.name;
      patch.priority = candidate.priority;
      patch.requires_approval = candidate.requires_approval;
    } else if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.trim().length === 0 || patch.name.length > 200)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'name must be a non-empty string (max 200 chars).' });
      return;
    } else if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'enabled must be a boolean.' });
      return;
    }
    ctx.automation.updateRule(Number((request.params as { id: string }).id), patch);
    return { ok: true, message: 'Rule updated.' };
  });

  app.delete('/api/automation/rules/:id', async (request) => {
    ctx.automation.deleteRule(Number((request.params as { id: string }).id));
    return { ok: true, message: 'Rule deleted.' };
  });

  // Manual trigger for testing
  app.post('/api/automation/rules/:id/trigger/:conversationId', async (request) => {
    const p = request.params as { id: string; conversationId: string };
    const rule = ctx.automation.listRules().find((r) => r.id === Number(p.id));
    if (!rule) return { ok: false, message: 'Rule not found.' };
    const runs = await ctx.automation.fireTrigger(rule.trigger, Number(p.conversationId));
    return { ok: true, message: `Trigger fired (${runs.length} runs recorded).`, runs };
  });
}
