import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';

export async function registerIssueRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/issues/clusters', async () => ({ clusters: ctx.issueRepo.listClusters() }));

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
    const body = request.body as {
      title: string;
      symptoms?: string;
      product?: string | null;
      feature?: string | null;
      known_cause?: string | null;
      workaround?: string | null;
      customer_safe_explanation?: string | null;
      internal_explanation?: string | null;
      status?: string;
      conversation_ids?: number[];
      provenance?: 'human_local' | 'ai_generated';
    };
    if (!body.title) return { ok: false, message: 'A title is required.' };
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
    const raw = request.body as Record<string, unknown>;
    const patch: Partial<{ title: string; symptoms: string; product: string | null; feature: string | null; known_cause: string | null; workaround: string | null; customer_safe_explanation: string | null; internal_explanation: string | null; status: string }> = {};
    for (const key of ['title', 'symptoms', 'product', 'feature', 'known_cause', 'workaround', 'customer_safe_explanation', 'internal_explanation', 'status']) {
      if (key in raw) {
        const v = raw[key];
        (patch as Record<string, unknown>)[key] = typeof v === 'string' ? v : v == null ? null : String(v);
      }
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
    const body = request.body as { system: string; reference_id: string; url?: string; title?: string; status?: string; notes?: string };
    if (!body.system || !body.reference_id) return { ok: false, message: 'system and reference_id are required.' };
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
