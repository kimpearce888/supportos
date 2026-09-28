import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { z } from 'zod';

export async function registerIssueRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/issues/clusters', async () => ({ clusters: ctx.issueRepo.listClusters() }));

  // v1.5.0: business-hours-aware SLA alerts for the Issue Radar
  app.get('/api/issues/sla-alerts', async () => ctx.sla.slaAlerts());

  app.get('/api/issues/clusters/:id', async (request, reply) => {
    const cluster = ctx.issueRepo.getCluster(Number((request.params as { id: string }).id));
    if (!cluster) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Cluster not found.' });
      return;
    }
    const conversations = ctx.db
      .prepare('SELECT id, number, subject, status, remote_created_at FROM conversations WHERE id IN (' + (cluster.conversation_ids.length ? cluster.conversation_ids.map(() => '?').join(',') : 'NULL') + ')')
      .all(...cluster.conversation_ids) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null }[];
    return { cluster, conversations };
  });

  app.delete('/api/issues/clusters/:id', async (request) => {
    ctx.issueRepo.deleteCluster(Number((request.params as { id: string }).id));
    return { ok: true, message: 'Cluster deleted (conversations are untouched).' };
  });

  app.get('/api/issues/known', async () => ({ known_issues: ctx.issueRepo.listKnownIssues() }));

  app.post('/api/issues/known', async (request) => {
    // v1.6.0 audit fix: the loose cast let numeric/garbage fields through (a
    // numeric title was stored verbatim) and a missing body crashed. zod now.
    const body = z
      .object({
        title: z.string().min(1).max(300),
        symptoms: z.string().max(5000).optional(),
        product: z.string().max(200).nullable().optional(),
        feature: z.string().max(200).nullable().optional(),
        known_cause: z.string().max(10000).nullable().optional(),
        workaround: z.string().max(10000).nullable().optional(),
        customer_safe_explanation: z.string().max(10000).nullable().optional(),
        internal_explanation: z.string().max(20000).nullable().optional(),
        status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved']).optional(),
        conversation_ids: z.array(z.number().int().positive()).optional(),
        provenance: z.enum(['human_local', 'ai_generated']).optional()
      })
      .parse(request.body ?? {});
    const id = ctx.issueRepo.createKnownIssue(body);
    ctx.jobsRepo.audit({ actor: 'user', action: 'known_issue_created', after_state: { id, title: body.title } });
    return { ok: true, message: 'Known issue created.', id };
  });

  app.get('/api/issues/known/:id', async (request, reply) => {
    const ki = ctx.issueRepo.getKnownIssue(Number((request.params as { id: string }).id));
    if (!ki) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Known issue not found.' });
      return;
    }
    const conversations = ctx.db
      .prepare('SELECT id, number, subject, status FROM conversations WHERE id IN (' + (ki.conversation_ids.length ? ki.conversation_ids.map(() => '?').join(',') : 'NULL') + ')')
      .all(...ki.conversation_ids) as { id: number; number: number; subject: string | null; status: string }[];
    return { known_issue: ki, conversations };
  });

  app.patch('/api/issues/known/:id', async (request) => {
    // v2.2.1 audit fix: this route used a loose cast + String(v) coercion, so
    // {"status": 123} was stored as "123" and the closed status vocabulary
    // could be silently corrupted. Same zod schema family as POST, partial.
    const body = z
      .object({
        title: z.string().min(1).max(300).optional(),
        symptoms: z.string().max(5000).optional(),
        product: z.string().max(200).nullable().optional(),
        feature: z.string().max(200).nullable().optional(),
        known_cause: z.string().max(10000).nullable().optional(),
        workaround: z.string().max(10000).nullable().optional(),
        customer_safe_explanation: z.string().max(10000).nullable().optional(),
        internal_explanation: z.string().max(20000).nullable().optional(),
        status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved']).optional()
      })
      .parse(request.body ?? {});
    const patch: Partial<{ title: string; symptoms: string; product: string | null; feature: string | null; known_cause: string | null; workaround: string | null; customer_safe_explanation: string | null; internal_explanation: string | null; status: string }> = {};
    for (const [key, v] of Object.entries(body)) {
      if (v !== undefined) (patch as Record<string, unknown>)[key] = v;
    }
    ctx.issueRepo.updateKnownIssue(Number((request.params as { id: string }).id), patch);
    ctx.jobsRepo.audit({ actor: 'user', action: 'known_issue_updated', before_state: { id: Number((request.params as { id: string }).id) } });
    return { ok: true, message: 'Known issue updated.' };
  });

  app.delete('/api/issues/known/:id', async (request) => {
    ctx.issueRepo.deleteKnownIssue(Number((request.params as { id: string }).id));
    return { ok: true, message: 'Known issue deleted.' };
  });

  app.post('/api/issues/known/:id/link/:conversationId', async (request) => {
    const p = request.params as { id: string; conversationId: string };
    ctx.issueRepo.linkConversation(Number(p.id), Number(p.conversationId), 'human');
    ctx.jobsRepo.audit({ actor: 'user', action: 'known_issue_linked', conversation_id: Number(p.conversationId), after_state: { known_issue_id: Number(p.id) } });
    return { ok: true, message: 'Conversation linked to known issue.' };
  });

  app.delete('/api/issues/known/:id/link/:conversationId', async (request) => {
    const p = request.params as { id: string; conversationId: string };
    ctx.issueRepo.unlinkConversation(Number(p.id), Number(p.conversationId));
    return { ok: true, message: 'Conversation unlinked.' };
  });

  app.post('/api/issues/known/:id/refs', async (request) => {
    const body = z
      .object({ system: z.string().min(1).max(100), reference_id: z.string().min(1).max(200), url: z.string().max(2000).optional(), title: z.string().max(500).optional(), status: z.string().max(100).optional(), notes: z.string().max(5000).optional() })
      .parse(request.body ?? {});
    ctx.issueRepo.addEngineeringRef(Number((request.params as { id: string }).id), body);
    return { ok: true, message: 'Engineering reference added.' };
  });

  // Support cases (historical resolutions used by AI retrieval)
  app.get('/api/issues/cases', async () => ({ cases: ctx.issueRepo.listSupportCases() }));

  app.post('/api/issues/cases/from-conversation/:conversationId', async (request) => {
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    const conv = ctx.conversationRepo.getConversationByLocalId(conversationId);
    if (!conv) return { ok: false, message: 'Conversation not found.' };
    const analysis = ctx.aiRepo.getLatestAnalysis(conversationId)?.analysis ?? null;
    const lastReply = (ctx.db
      .prepare("SELECT body_text FROM threads WHERE conversation_id = ? AND type='reply' AND state='published' ORDER BY remote_created_at DESC LIMIT 1")
      .get(conversationId) as { body_text: string | null } | undefined)?.body_text ?? null;
    const tags = ctx.db
      .prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?')
      .all(conversationId) as { name: string }[];
    const rating = (ctx.db.prepare('SELECT rating FROM ratings WHERE conversation_id = ? LIMIT 1').get(conversationId) as { rating: string | null } | undefined)?.rating ?? null;
    const n2u = (v: string | null | undefined): string | undefined => (v == null ? undefined : v);
    ctx.issueRepo.upsertSupportCase({
      conversation_id: conversationId,
      customer_id: conv.customer_local_id,
      problem: analysis?.customer_goal ?? n2u(conv.subject),
      root_question: n2u(analysis?.primary_question),
      resolution: n2u(lastReply ? lastReply.slice(0, 2000) : null),
      answer: n2u(lastReply ? lastReply.slice(0, 2000) : null),
      product: analysis?.product ?? null,
      feature: analysis?.feature ?? null,
      tags: tags.map((t) => t.name),
      agent_user_id: conv.assignee_local_id,
      rating
    });
    return { ok: true, message: 'Support case captured from this conversation.' };
  });
}
