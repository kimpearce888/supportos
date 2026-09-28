import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { clampListParam } from './helpers.js';

export async function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/customers', async (request) => {
    const q = request.query as Record<string, string>;
    // v1.6.0 audit fix: bare Number() let ?page=abc reach SQLite as NaN -> 500.
    const page = clampListParam(q.page, 1, 1, 100000);
    const result = ctx.peopleRepo.listCustomers(page, clampListParam(q.pageSize, 50, 1, 200), q.q ?? '');
    return { customers: result.customers, total: result.total, page };
  });

  app.get('/api/customers/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const customer = ctx.peopleRepo.getCustomerByLocalId(id);
    if (!customer) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    const conversations = ctx.db
      .prepare(
        `SELECT cv.id, cv.number, cv.subject, cv.status, cv.preview, cv.remote_created_at, cv.closed_at, cv.assignee_local_id,
           (SELECT TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) FROM users u WHERE u.id = cv.assignee_local_id) AS assignee
         FROM conversations cv WHERE cv.customer_local_id = ? AND cv.deleted_at IS NULL ORDER BY cv.remote_created_at DESC LIMIT 50`
      )
      .all(id) as { id: number; number: number; subject: string | null; status: string; preview: string | null; remote_created_at: string | null; closed_at: string | null; assignee_local_id: number | null; assignee: string | null }[];
    const openCount = conversations.filter((c) => c.status === 'active' || c.status === 'pending').length;
    const ratings = ctx.peopleRepo.getRatingsForCustomer(id);
    const memories = ctx.aiRepo.getMemories(id);
    const properties = ctx.peopleRepo.getCustomerProperties(id);
    const websites = ctx.peopleRepo.getCustomerWebsites(id);
    const social = ctx.peopleRepo.getCustomerSocialProfiles(id);
    const address = ctx.peopleRepo.getAddress(id);
    // Recent topics: subjects of recent conversations
    const topics = conversations.slice(0, 10).map((c) => ({ number: c.number, topic: c.subject ?? '' }));
    // Previous resolutions: last agent reply per closed conversation
    const resolutions = ctx.db
      .prepare(
        `SELECT cv.number, cv.subject, (SELECT t.body_text FROM threads t WHERE t.conversation_id = cv.id AND t.type='reply' AND t.state='published' ORDER BY t.remote_created_at DESC LIMIT 1) AS resolution, cv.closed_at
         FROM conversations cv WHERE cv.customer_local_id = ? AND cv.status='closed' AND cv.deleted_at IS NULL ORDER BY cv.closed_at DESC LIMIT 5`
      )
      .all(id) as { number: number; subject: string | null; resolution: string | null; closed_at: string | null }[];
    return {
      customer: { ...customer, open_conversation_count: openCount },
      conversations,
      ratings,
      memories,
      properties,
      websites,
      social_profiles: social,
      address,
      topics,
      resolutions: resolutions.map((r) => ({ ...r, resolution: (r.resolution ?? '').slice(0, 400) }))
    };
  });

  app.get('/api/organizations', async (request) => {
    const q = request.query as Record<string, string>;
    const result = ctx.peopleRepo.listOrganizations(clampListParam(q.page, 1, 1, 100000), clampListParam(q.pageSize, 50, 1, 200), q.q ?? '');
    return { organizations: result.organizations, total: result.total };
  });

  app.get('/api/organizations/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const org = ctx.peopleRepo.getOrganizationDetail(id);
    if (!org) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Organization not found.' });
      return;
    }
    const customers = ctx.peopleRepo.getOrganizationCustomers(id);
    const conversations = ctx.db
      .prepare(
        `SELECT cv.id, cv.number, cv.subject, cv.status, cv.remote_created_at,
           TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) AS customer
         FROM conversations cv JOIN customers cu ON cu.id = cv.customer_local_id
         WHERE cu.organization_id = ? AND cv.deleted_at IS NULL ORDER BY cv.remote_created_at DESC LIMIT 50`
      )
      .all(id) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; customer: string }[];
    const properties = ctx.peopleRepo.getOrganizationProperties(id);
    return { organization: org, customers, conversations, properties };
  });

  // ---------------- v2.0.0 (M4, plan Phase 23-24): timeline + support health ----------------

  app.get('/api/customers/:id/timeline', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const customer = ctx.peopleRepo.getCustomerByLocalId(id);
    if (!customer) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    const q = request.query as Record<string, string>;
    const result = ctx.customerEvents.listForCustomer(id, (q.kind ?? '').slice(0, 40) || null, clampListParam(q.pageSize, 100, 1, 200), (clampListParam(q.page, 1, 1, 100000) - 1) * clampListParam(q.pageSize, 100, 1, 200));
    return { events: result.events, total: result.total, kind_counts: ctx.customerEvents.kindCounts(id) };
  });

  app.get('/api/customers/:id/support-health', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const report = ctx.supportHealth.forCustomer(id);
    if (!report) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found.' });
      return;
    }
    return { report };
  });

  app.get('/api/organizations/:id/timeline', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const org = ctx.peopleRepo.getOrganizationDetail(id);
    if (!org) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Organization not found.' });
      return;
    }
    const q = request.query as Record<string, string>;
    const result = ctx.customerEvents.listForOrganization(id, (q.kind ?? '').slice(0, 40) || null, clampListParam(q.pageSize, 100, 1, 200), (clampListParam(q.page, 1, 1, 100000) - 1) * clampListParam(q.pageSize, 100, 1, 200));
    return { events: result.events, total: result.total };
  });

  app.get('/api/organizations/:id/support-health', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const report = ctx.supportHealth.forOrganization(id);
    if (!report) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Organization not found.' });
      return;
    }
    return { report };
  });

  /** Full timeline re-derivation (maintenance path; idempotent by dedup keys). */
  app.post('/api/timeline/rebuild', async () => {
    const result = ctx.customerEventSweep.rebuild();
    ctx.jobsRepo.audit({ actor: 'user', action: 'customer_events_rebuilt', after_state: { created: result.created } });
    return { ok: true, created: result.created, message: `Timeline rebuilt; ${result.created} new event(s) derived.` };
  });
}
