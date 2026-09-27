import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { clampDaysParam } from './helpers.js';
import { z } from 'zod';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// v1.6.0 audit fix: ?days=abc used to reach `new Date(NaN).toISOString()` ->
// RangeError 500. All days params clamp through the shared helper now.
function daysParam(q: Record<string, string>, fallback: number): number {
  return clampDaysParam(q.days, fallback, 1, 3650);
}

export async function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/analytics/dashboard', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const days = daysParam(q, 30);
    // Multi-mailbox scope: comma-separated LOCAL mailbox ids ("mailboxIds=1,2").
    // Invalid tokens are a client error -> 422 (consistent with body validation).
    let mailboxIds: number[] | null = null;
    if (q.mailboxIds != null && q.mailboxIds !== '') {
      const tokens = q.mailboxIds.split(',').map((t) => t.trim()).filter(Boolean);
      mailboxIds = tokens.map((t) => Number(t));
      if (mailboxIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'mailboxIds must be a comma-separated list of positive integers.' });
        return;
      }
    }
    // Channel scope: 'email' or 'chat' (Beacon); anything else is rejected.
    let channel: 'email' | 'chat' | null = null;
    if (q.channel != null && q.channel !== '') {
      if (q.channel !== 'email' && q.channel !== 'chat') {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: "channel must be 'email' or 'chat'." });
        return;
      }
      channel = q.channel;
    }
    return ctx.analytics.dashboard(q.from ?? isoDaysAgo(days), q.to ?? new Date().toISOString(), { mailboxLocalIds: mailboxIds, channel });
  });

  app.get('/api/analytics/ai', async () => ctx.analytics.aiAnalytics());

  // v1.4.0: SLA + business-hours report (per mailbox, business minutes)
  app.get('/api/reports/sla', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const days = daysParam(q, 30);
    let mailboxIds: number[] | null = null;
    if (q.mailboxIds != null && q.mailboxIds !== '') {
      mailboxIds = q.mailboxIds.split(',').map((t) => Number(t.trim()));
      if (mailboxIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'mailboxIds must be a comma-separated list of positive integers.' });
        return;
      }
    }
    const from = q.from ?? isoDaysAgo(days);
    const to = q.to ?? new Date().toISOString();
    return ctx.sla.slaReport(from, to, mailboxIds);
  });

  // Support intelligence reports (spec #49)
  app.get('/api/reports/why-contacting', async (request) => {
    const q = request.query as Record<string, string>;
    return { categories: ctx.analytics.whyCustomersContact(daysParam(q, 30)), source: 'ai-derived' };
  });

  app.get('/api/reports/top-questions', async (request) => {
    const q = request.query as Record<string, string>;
    return { questions: ctx.analytics.topQuestions(daysParam(q, 30)) };
  });

  app.get('/api/reports/doc-gaps', async (request) => {
    const q = request.query as Record<string, string>;
    return { gaps: ctx.analytics.docGaps(daysParam(q, 90)) };
  });

  app.get('/api/reports/answer-reuse', async (request) => {
    const q = request.query as Record<string, string>;
    return { candidates: ctx.analytics.answerReuse(daysParam(q, 90)) };
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
    const days = daysParam(q, 30);
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
    // v1.6.0 audit fix: missing body crashed on `.reportName` deref; zod now.
    const body = z
      .object({ reportName: z.string().min(1).max(200), facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) })
      .parse(request.body ?? {});
    try {
      const narrative = await ctx.aiPipeline.reportNarrative(body.reportName, body.facts);
      return { ok: true, narrative, ai_generated: true, note: 'This narrative was AI-generated locally from the computed facts above.' };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
