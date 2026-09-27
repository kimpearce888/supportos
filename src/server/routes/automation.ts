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

  app.patch('/api/automation/rules/:id', async (request) => {
    ctx.automation.updateRule(Number((request.params as { id: string }).id), request.body as Record<string, unknown>);
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
