import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

export async function registerAiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const pipeline = () => ctx.aiPipeline;

  app.get('/api/ai/status', async () => {
    const settings = ctx.settingsRepo.getLmStudio();
    const models = await ctx.lmStudio
      .listModels()
      .then((m) => ({ connected: true, models: m.data.map((x) => x.id), error: null as string | null }))
      .catch((e: unknown) => ({ connected: false, models: [] as string[], error: e instanceof LmStudioError ? e.message : String(e) }));
    const aiSettings = ctx.settingsRepo.getAllSettings();
    const jobs = ctx.jobsRepo.queueStats();
    return {
      ai_enabled: aiSettings.ai_enabled,
      settings,
      lmstudio: models,
      last_inference: ctx.lmStudio.getLastInference(),
      provider: ctx.aiProvider.kind,
      queued_ai_jobs: jobs.queued + jobs.running,
      failed_ai_jobs: jobs.failed,
      index: ctx.knowledgeRepo.countIndexed()
    };
  });

  // Trigger/refresh ticket analysis
  app.post('/api/ai/analyze/:conversationId', async (request, reply) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    const body = (request.body ?? {}) as { force?: boolean };
    try {
      const result = await pipeline().analyzeTicket(conversationId, { force: body.force });
      return { ok: true, ...result };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Generate a customer-safe draft (+ verification)
  app.post('/api/ai/draft/:conversationId', async (request, reply) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    const body = (request.body ?? {}) as { mode?: 'verified_answer' | 'standard'; force?: boolean };
    try {
      const result = await pipeline().generateDraft(conversationId, { mode: body.mode ?? 'verified_answer', force: body.force });
      return { ok: true, ...result };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Rewrite a draft (never touches the user's composer)
  app.post('/api/ai/draft/:draftId/rewrite', async (request, reply) => {
    const draftId = Number((request.params as { draftId: string }).draftId);
    const body = request.body as { instruction: 'shorten' | 'expand' | 'warmer' | 'more_direct' };
    try {
      const text = await pipeline().rewriteDraft(draftId, body.instruction);
      return { ok: true, text };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Verify a draft again
  app.post('/api/ai/draft/:draftId/verify', async (request, reply) => {
    const draftId = Number((request.params as { draftId: string }).draftId);
    const draft = ctx.aiRepo.getDraft(draftId);
    if (!draft) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Draft not found.' });
      return;
    }
    const analysis = ctx.aiRepo.getLatestAnalysis(draft.conversation_id)?.analysis ?? null;
    try {
      const verification = await pipeline().verifyDraftInternal(draft.conversation_id, draft.content, analysis);
      ctx.db
        .prepare('UPDATE ai_drafts SET verification = ? WHERE id = ?')
        .run(JSON.stringify(verification), draftId);
      return { ok: true, verification };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Draft accept/reject feedback (human review, spec #123)
  app.post('/api/ai/draft/:draftId/feedback', async (request) => {
    const draftId = Number((request.params as { draftId: string }).draftId);
    const body = request.body as { action: 'accept' | 'reject' | 'edit'; finalText?: string };
    const draft = ctx.aiRepo.getDraft(draftId);
    if (!draft) return { ok: false, message: 'Draft not found.' };
    if (body.action === 'accept') ctx.aiRepo.setDraftState(draftId, 'accepted');
    else if (body.action === 'reject') ctx.aiRepo.setDraftState(draftId, 'rejected');
    else if (body.action === 'edit' && body.finalText !== undefined) {
      ctx.aiRepo.setDraftState(draftId, 'edited');
      ctx.aiRepo.recordFeedback(draftId, draft.content, body.finalText, false);
    }
    ctx.jobsRepo.audit({ actor: 'user', action: `ai_draft_${body.action}`, ai_involvement: true, conversation_id: draft.conversation_id });
    return { ok: true, message: `Draft marked as ${body.action === 'edit' ? 'edited' : body.action}ed.` };
  });

  // Similar conversations (hybrid relevance)
  app.get('/api/ai/similar/:conversationId', async (request) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    return { similar: ctx.evidenceBuilder.findSimilar(conversationId, 5) };
  });

  // Customer memories
  app.get('/api/ai/memory/:customerId', async (request) => {
    const customerId = Number((request.params as { customerId: string }).customerId);
    return { memories: ctx.aiRepo.getMemories(customerId) };
  });
  app.post('/api/ai/memory/:customerId', async (request) => {
    const customerId = Number((request.params as { customerId: string }).customerId);
    const body = request.body as { key: string; value: string };
    ctx.aiRepo.upsertMemory(customerId, body.key, body.value, { source: 'human', origin: 'manual', confidence: 'high' });
    ctx.jobsRepo.audit({ actor: 'user', action: 'memory_added', ai_involvement: false });
    return { ok: true, message: 'Memory saved (human-entered).' };
  });

  // Clustering
  app.post('/api/ai/cluster-issues', async (request, reply) => {
    const body = (request.body ?? {}) as { days?: number };
    try {
      const result = await pipeline().clusterIssues(body.days ?? 60);
      return { ok: true, ...result };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // AI jobs list + evaluation data
  app.get('/api/ai/jobs', async (request) => {
    const q = request.query as Record<string, string>;
    return { jobs: ctx.aiRepo.listJobs(q.limit ? Number(q.limit) : 100) };
  });

  app.get('/api/ai/analytics', async () => ctx.analytics.aiAnalytics());

  // Golden test set: run an offline evaluation of the pipeline on seeded scenarios (spec #78, #79)
  app.get('/api/ai/evaluation', async () => {
    const tests = [
      { name: 'simple question', category: 'simple', payload: { subject: 'What time do you close?', body: 'Hi, what are your support hours?' } },
      { name: 'multi-question ticket', category: 'multi', payload: { subject: 'Two things: export + timezone', body: 'How do I export data? Also how do I change the timezone for scheduled reports?' } },
      { name: 'ambiguous ticket', category: 'ambiguous', payload: { subject: 'It does not work', body: 'The thing keeps failing sometimes. Not sure what is wrong.' } },
      { name: 'known issue', category: 'known_issue', payload: { subject: 'Meeting reminders one hour late', body: 'Since the DST change our reminders are all one hour late.' } },
      { name: 'customer history', category: 'history', payload: { subject: 'Follow-up on the export issue', body: 'The export you helped me with last month broke again.' } },
      { name: 'timezone issue', category: 'timezone', payload: { subject: 'Santiago timezone wrong', body: 'Scheduled report sends at 3 AM instead of 8 AM Chile time.' } },
      { name: 'integration issue', category: 'integration', payload: { subject: 'Slack integration broken', body: 'The Slack integration stopped posting updates to our channel.' } },
      { name: 'billing question', category: 'billing', payload: { subject: 'Card declined', body: 'My payment failed but the card works everywhere else.' } },
      { name: 'internal escalation', category: 'escalation', payload: { subject: 'URGENT outage for key account', body: 'Our production access is down, we need this escalated now.' } }
    ];
    return { tests, evaluation_mode: ctx.settingsRepo.getAllSettings().ai_evaluation_mode };
  });
}
