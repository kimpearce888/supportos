import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { clampListParam } from './helpers.js';
import { incidentCreateSchema, incidentPatchSchema, incidentNoteSchema, incidentRefSchema, incidentReleaseSchema, incidentRelatedSchema, INCIDENT_STATUSES, INCIDENT_SEVERITIES, INCIDENT_RELATED_KINDS } from '../../shared/workspace.js';

/**
 * Incident / master-issue workspace routes (plan Phase 18-19). Incidents are
 * local-only; every mutation is audited and appends an idempotent timeline
 * event. Affected customers/organizations are derived reads - there is no
 * stored copy to drift. Impact is computed on demand (Phase 19) for both
 * incidents and known issues through the ONE shared service.
 */
export async function registerIncidentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = () => ctx.incidents;

  app.get('/api/incidents', async (request) => {
    const q = request.query as Record<string, string>;
    const status = q.status && INCIDENT_STATUSES.includes(q.status as never) ? q.status : undefined;
    const severity = q.severity && INCIDENT_SEVERITIES.includes(q.severity as never) ? q.severity : undefined;
    const result = repo().list({
      status,
      severity,
      open: q.open === 'true' || q.open === '1',
      query: (q.q ?? '').slice(0, 120),
      limit: clampListParam(q.pageSize, 50, 1, 200),
      offset: (clampListParam(q.page, 1, 1, 100000) - 1) * clampListParam(q.pageSize, 50, 1, 200)
    });
    return { incidents: result.incidents, total: result.total };
  });

  app.post('/api/incidents', async (request, reply) => {
    const parsed = incidentCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    // Conversation ids are validated against the mirror before insert.
    const convIds: number[] = [];
    const convStmt = ctx.db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL');
    for (const id of parsed.data.conversationIds) {
      if (convStmt.get(id)) convIds.push(id);
    }
    try {
      const incident = ctx.incidentService.create({
        title: parsed.data.title,
        status: parsed.data.status,
        severity: parsed.data.severity,
        ownerUserId: parsed.data.ownerUserId,
        product: parsed.data.product,
        feature: parsed.data.feature,
        description: parsed.data.description,
        internalExplanation: parsed.data.internalExplanation,
        customerSafeExplanation: parsed.data.customerSafeExplanation,
        knownCause: parsed.data.knownCause,
        workaround: parsed.data.workaround,
        resolution: parsed.data.resolution,
        startedAt: parsed.data.startedAt,
        source: 'manual',
        conversationIds: convIds,
        actorUserId: null
      });
      ctx.jobsRepo.audit({ actor: 'user', action: 'incident_created', after_state: { id: incident.id, code: incident.code, title: incident.title } });
      return { ok: true, incident };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: `Could not create incident: ${(e as Error).message}` };
    }
  });

  app.get('/api/incidents/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const incident = repo().get(id);
    if (!incident) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const impact = ctx.issueImpact.forIncident(id);
    return {
      incident,
      impact,
      conversations: repo().listConversations(id),
      affected_customers: repo().affectedCustomers(id),
      affected_organizations: repo().affectedOrganizations(id),
      related: repo().listRelated(id),
      refs: repo().listRefs(id),
      releases: repo().listReleases(id),
      notes: repo().listNotes(id),
      timeline: repo().listEvents(id)
    };
  });

  app.patch('/api/incidents/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = incidentPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    const d = parsed.data;
    const changes: Record<string, unknown> = {};
    if (d.title !== undefined) changes.title = d.title;
    if (d.status !== undefined) changes.status = d.status;
    if (d.severity !== undefined) changes.severity = d.severity;
    if (d.ownerUserId !== undefined) changes.owner_user_local_id = d.ownerUserId;
    if (d.product !== undefined) changes.product = d.product;
    if (d.feature !== undefined) changes.feature = d.feature;
    if (d.description !== undefined) changes.description = d.description;
    if (d.internalExplanation !== undefined) changes.internal_explanation = d.internalExplanation;
    if (d.customerSafeExplanation !== undefined) changes.customer_safe_explanation = d.customerSafeExplanation;
    if (d.knownCause !== undefined) changes.known_cause = d.knownCause;
    if (d.workaround !== undefined) changes.workaround = d.workaround;
    if (d.resolution !== undefined) changes.resolution = d.resolution;
    if (d.startedAt !== undefined) changes.started_at = d.startedAt;
    const updated = ctx.incidentService.patch(id, changes, null);
    if (!updated) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'incident_updated', after_state: { id, changes: Object.keys(changes) } });
    return { ok: true, incident: updated };
  });

  app.delete('/api/incidents/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const deleted = repo().delete(id);
    if (!deleted) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'incident_deleted', before_state: { id } });
    return { ok: true, message: 'Incident deleted.' };
  });

  app.post('/api/incidents/:id/conversations/:conversationId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    if (!Number.isInteger(id) || !Number.isInteger(conversationId)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Incident and conversation ids must be integers.' });
      return;
    }
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const conv = ctx.db.prepare('SELECT id, number FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId) as { id: number; number: number } | undefined;
    if (!conv) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Conversation not found.' });
      return;
    }
    const created = ctx.incidentService.linkConversation(id, conversationId, conv.number, null);
    return { ok: true, linked: created, message: created ? 'Conversation linked.' : 'Conversation was already linked.' };
  });

  app.delete('/api/incidents/:id/conversations/:conversationId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const conversationId = Number((request.params as { conversationId: string }).conversationId);
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const removed = ctx.incidentService.unlinkConversation(id, conversationId, null);
    return { ok: true, removed, message: removed ? 'Conversation unlinked.' : 'Conversation was not linked.' };
  });

  app.post('/api/incidents/:id/notes', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = incidentNoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'A non-empty note body is required.' });
      return;
    }
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const note = repo().addNote(id, parsed.data.body, null);
    return { ok: true, note };
  });

  app.post('/api/incidents/:id/refs', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = incidentRefSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const refId = repo().addRef(id, parsed.data);
    return { ok: true, ref_id: refId };
  });

  app.delete('/api/incidents/:id/refs/:refId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const refId = Number((request.params as { refId: string }).refId);
    const removed = repo().deleteRef(id, refId);
    if (!removed) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Reference not found on this incident.' });
      return;
    }
    return { ok: true, message: 'Reference removed.' };
  });

  app.post('/api/incidents/:id/releases', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = incidentReleaseSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const releaseId = repo().addRelease(id, parsed.data);
    return { ok: true, release_id: releaseId };
  });

  app.delete('/api/incidents/:id/releases/:releaseId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const releaseId = Number((request.params as { releaseId: string }).releaseId);
    const removed = repo().deleteRelease(id, releaseId);
    if (!removed) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Release not found on this incident.' });
      return;
    }
    return { ok: true, message: 'Release removed.' };
  });

  app.post('/api/incidents/:id/related', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = incidentRelatedSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    if (!repo().get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    const { targetKind, targetLocalId, note } = parsed.data;
    // Existence check BEFORE insert (422, never an FK 500 - the v1.8.0 rule).
    const table = { known_issue: 'known_issues', knowledge_doc: 'knowledge_documents', campaign: 'outreach_campaigns', custom_object: 'custom_objects' }[targetKind];
    const exists = ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(targetLocalId);
    if (!exists) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: `${targetKind} #${targetLocalId} does not exist.` });
      return;
    }
    const linked = repo().addRelated(id, targetKind, targetLocalId, note, null);
    return { ok: true, linked };
  });

  app.delete('/api/incidents/:id/related/:targetKind/:targetLocalId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const params = request.params as { targetKind: string; targetLocalId: string };
    if (!INCIDENT_RELATED_KINDS.includes(params.targetKind as never)) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'Unknown related target kind.' });
      return;
    }
    const targetLocalId = Number(params.targetLocalId);
    const removed = repo().removeRelated(id, params.targetKind, targetLocalId, null);
    return { ok: true, removed };
  });

  app.get('/api/incidents/:id/impact', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const impact = ctx.issueImpact.forIncident(id);
    if (!impact) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Incident not found.' });
      return;
    }
    return { impact };
  });

  app.get('/api/issues/known/:id/impact', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const impact = ctx.issueImpact.forKnownIssue(id);
    if (!impact) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Known issue not found.' });
      return;
    }
    return { impact };
  });

  // Declare an incident FROM an existing issue cluster: pre-fills the
  // workspace and links every member conversation in one action.
  app.post('/api/incidents/from-cluster/:clusterId', async (request, reply) => {
    const clusterId = Number((request.params as { clusterId: string }).clusterId);
    const cluster = ctx.issueRepo.getCluster(clusterId);
    if (!cluster) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Issue cluster not found.' });
      return;
    }
    const body = incidentCreateSchema.safeParse(request.body ?? {});
    const overrides = body.success ? body.data : null;
    const incident = ctx.incidentService.create({
      title: overrides?.title ?? `Issue cluster: ${cluster.title}`,
      severity: overrides?.severity ?? 'sev3',
      status: overrides?.status ?? 'investigating',
      product: overrides?.product ?? cluster.product ?? null,
      feature: overrides?.feature ?? cluster.feature ?? null,
      description: overrides?.description ?? (cluster.summary ? `Declared from issue cluster "${cluster.title}". ${cluster.summary}` : `Declared from issue cluster "${cluster.title}".`),
      knownCause: overrides?.knownCause ?? null,
      workaround: overrides?.workaround ?? null,
      internalExplanation: overrides?.internalExplanation ?? null,
      customerSafeExplanation: overrides?.customerSafeExplanation ?? null,
      resolution: overrides?.resolution ?? null,
      startedAt: overrides?.startedAt ?? null,
      source: 'cluster',
      conversationIds: cluster.conversation_ids,
      actorUserId: null
    });
    ctx.jobsRepo.audit({ actor: 'user', action: 'incident_created_from_cluster', after_state: { id: incident.id, code: incident.code, cluster_id: clusterId } });
    return { ok: true, incident, linked_conversations: cluster.conversation_ids.length };
  });

  // Declare an incident FROM a known issue: carries the explanations over
  // and links the known issue's conversations.
  app.post('/api/incidents/from-known-issue/:knownIssueId', async (request, reply) => {
    const knownIssueId = Number((request.params as { knownIssueId: string }).knownIssueId);
    const ki = ctx.issueRepo.getKnownIssue(knownIssueId);
    if (!ki) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Known issue not found.' });
      return;
    }
    const convRows = ctx.db.prepare('SELECT conversation_id FROM known_issue_conversations WHERE known_issue_id = ?').all(knownIssueId) as { conversation_id: number }[];
    const body = incidentCreateSchema.safeParse(request.body ?? {});
    const overrides = body.success ? body.data : null;
    const incident = ctx.incidentService.create({
      title: overrides?.title ?? `Known issue: ${ki.title}`,
      severity: overrides?.severity ?? 'sev3',
      status: overrides?.status ?? 'investigating',
      product: overrides?.product ?? ki.product ?? null,
      feature: overrides?.feature ?? ki.feature ?? null,
      description: overrides?.description ?? (ki.symptoms ? `Declared from known issue "${ki.title}". ${ki.symptoms}` : `Declared from known issue "${ki.title}".`),
      internalExplanation: overrides?.internalExplanation ?? ki.internal_explanation ?? null,
      customerSafeExplanation: overrides?.customerSafeExplanation ?? ki.customer_safe_explanation ?? null,
      knownCause: overrides?.knownCause ?? ki.known_cause ?? null,
      workaround: overrides?.workaround ?? ki.workaround ?? null,
      resolution: overrides?.resolution ?? null,
      startedAt: overrides?.startedAt ?? null,
      source: 'known_issue',
      conversationIds: convRows.map((r) => r.conversation_id),
      actorUserId: null
    });
    repo().addRelated(incident.id, 'known_issue', knownIssueId, 'Declared from this known issue', null);
    ctx.jobsRepo.audit({ actor: 'user', action: 'incident_created_from_known_issue', after_state: { id: incident.id, code: incident.code, known_issue_id: knownIssueId } });
    return { ok: true, incident, linked_conversations: convRows.length };
  });
}
