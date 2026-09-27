import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

export async function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/analytics/dashboard', async (request) => {
    const q = request.query as Record<string, string>;
    const days = q.days ? Number(q.days) : 30;
    return ctx.analytics.dashboard(q.from ?? isoDaysAgo(days), q.to ?? new Date().toISOString());
  });

  app.get('/api/analytics/ai', async () => ctx.analytics.aiAnalytics());

  // Support intelligence reports (spec #49)
  app.get('/api/reports/why-contacting', async (request) => {
    const q = request.query as Record<string, string>;
    return { categories: ctx.analytics.whyCustomersContact(q.days ? Number(q.days) : 30), source: 'ai-derived' };
  });

  app.get('/api/reports/top-questions', async (request) => {
    const q = request.query as Record<string, string>;
    return { questions: ctx.analytics.topQuestions(q.days ? Number(q.days) : 30) };
  });

  app.get('/api/reports/doc-gaps', async (request) => {
    const q = request.query as Record<string, string>;
    return { gaps: ctx.analytics.docGaps(q.days ? Number(q.days) : 90) };
  });

  app.get('/api/reports/answer-reuse', async (request) => {
    const q = request.query as Record<string, string>;
    return { candidates: ctx.analytics.answerReuse(q.days ? Number(q.days) : 90) };
  });

  app.get('/api/reports/issue-radar', async () => ({ alerts: ctx.analytics.issueRadar() }));

  app.get('/api/reports/metric-definitions', async () => ({ definitions: ctx.analytics.metricDefinitions() }));

  app.get('/api/reports/release-correlation', async () => {
    const data = ctx.analyticsRepo.releaseCorrelation();
    return {
      releases: data,
      note: 'Conversations before/after each release window. Timing overlap is described as "potentially related" - never as proven causation.',
      source: 'local'
    };
  });

  app.post('/api/reports/release-events', async (request) => {
    const body = request.body as { name: string; version: string; occurredAt: string; notes?: string };
    if (!body.name || !body.occurredAt) return { ok: false, message: 'name and occurredAt are required.' };
    ctx.analyticsRepo.addReleaseEvent(body.name, body.version ?? '', body.occurredAt, body.notes);
    return { ok: true, message: 'Release event recorded.' };
  });

  // Help Scout native report import (labeled as Help Scout source, spec #46)
  app.get('/api/reports/helpscout/:reportKey', async (request, reply) => {
    const key = (request.params as { reportKey: string }).reportKey;
    const q = request.query as Record<string, string>;
    const days = q.days ? Number(q.days) : 30;
    const start = (q.from ?? isoDaysAgo(days)).slice(0, 10);
    const end = (q.to ?? new Date().toISOString()).slice(0, 10);
    let row = null;
    try {
      switch (key) {
        case 'company':
          row = await ctx.provider.getCompanyOverallReport(start, end);
          break;
        case 'conversations':
          row = await ctx.provider.getConversationsOverallReport(start, end);
          break;
        case 'happiness':
          row = await ctx.provider.getHappinessRatingsReport(start, end);
          break;
        case 'productivity':
          row = await ctx.provider.getProductivityOverallReport(start, end);
          break;
        default:
          reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Unknown report. Available: company, conversations, happiness, productivity.' });
          return;
      }
    } catch (e) {
      return { ok: false, message: `Help Scout report request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, report: row, source: 'helpscout', note: 'Numbers come from Help Scout native reporting and use Help Scout definitions.' };
  });

  // AI-written narrative (clearly labeled AI-generated, spec #105)
  app.post('/api/reports/narrative', async (request, reply) => {
    const body = request.body as { reportName: string; facts: Record<string, unknown> };
    try {
      const narrative = await ctx.aiPipeline.reportNarrative(body.reportName, body.facts);
      return { ok: true, narrative, ai_generated: true, note: 'This narrative was AI-generated locally from the computed facts above.' };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
