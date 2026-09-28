import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import type { SegmentDefinition, RecipientWhyTicket } from '../../shared/segmentation.js';
import { OPERATORS_BY_TYPE } from '../../shared/segmentation.js';
import { z } from 'zod';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * Outreach API (v1.5.0) - Client Segmentation & Outreach.
 *
 * Route map:
 * - GET  /api/outreach/meta               property defs + tags + mailboxes (drives the builder UI)
 * - POST /api/outreach/segments/preview   evaluate a condition tree (count + why-selected rows)
 * - CRUD /api/outreach/segments           saved reusable rules (dynamic; spec #16)
 * - POST /api/outreach/campaigns          create campaign with a STATIC recipient snapshot (spec #17)
 * - GET  /api/outreach/campaigns          list with live totals
 * - GET  /api/outreach/campaigns/:id      detail + recipients + why-selected evidence
 * - POST /api/outreach/campaigns/:id/queue|pause|resume|cancel|retry|reconcile
 * - GET  /api/outreach/campaigns/:id/validate   pre-send checks (spec #27)
 * - POST /api/outreach/campaigns/:id/preview    render personalized message for one recipient (spec #26)
 * - GET  /api/outreach/campaigns/:id/report     outcome metrics + replies (spec #52)
 * - CRUD /api/outreach/dnc                Do-Not-Contact list (spec #19)
 */
export async function registerOutreachRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * v1.5.0 audit fix: condition trees are untrusted input. A deeply nested
   * group tree would recurse without bound in the engine (and even inside
   * JSON.parse/JSON.stringify on both sides). Trees are validated with an
   * explicit DEPTH budget BEFORE evaluation; deeper trees are a clean 422.
   */
  const MAX_TREE_DEPTH = 10;
  const MAX_NODE_COUNT = 200;

  const parseTree = (body: unknown): SegmentDefinition | null => {
    if (body == null || typeof body !== 'object') return null;
    const b = body as { combinator?: unknown; conditions?: unknown; exclude?: unknown };
    const combinator = b.combinator === 'any' ? 'any' : 'all';
    if (!Array.isArray(b.conditions) || !Array.isArray(b.exclude)) return null;
    if (b.conditions.length > 50 || b.exclude.length > 50) return null;
    let nodes = 0;
    let tooDeep = false;
    const walk = (n: unknown, depth: number): void => {
      if (n == null || typeof n !== 'object' || tooDeep) return;
      nodes++;
      if (nodes > MAX_NODE_COUNT || depth > MAX_TREE_DEPTH) {
        tooDeep = true;
        return;
      }
      const group = n as { kind?: unknown; children?: unknown };
      if (group.kind === 'group' && Array.isArray(group.children)) {
        for (const child of group.children) walk(child, depth + 1);
      }
    };
    for (const n of b.conditions) walk(n, 1);
    for (const n of b.exclude) walk(n, 1);
    if (tooDeep) return null;
    return { combinator, conditions: b.conditions as SegmentDefinition['conditions'], exclude: b.exclude as SegmentDefinition['exclude'] };
  };

  app.get('/api/outreach/meta', async () => {
    const defs = ctx.db.prepare('SELECT id, remote_id, name, slug, type, sort_order FROM customer_property_definitions ORDER BY sort_order, name').all() as {
      id: number;
      remote_id: number;
      name: string;
      slug: string | null;
      type: string | null;
      sort_order: number;
    }[];
    const stats = new Map(ctx.peopleRepo.propertyDefinitionStats().map((s) => [s.definition_id, s]));
    const propertyDefinitions = defs.map((d) => {
      const type = (['text', 'number', 'date', 'dropdown', 'url'].includes(d.type ?? '') ? d.type : 'text') as 'text' | 'number' | 'date' | 'dropdown' | 'url';
      const s = stats.get(d.id);
      return { id: d.id, remote_id: d.remote_id, name: d.name, slug: d.slug, type, observed_values: s?.observed_values ?? [], populated: s?.populated ?? 0 };
    });
    const tags = (ctx.db.prepare('SELECT name FROM tags WHERE deleted_at IS NULL ORDER BY name').all() as { name: string }[]).map((t) => t.name);
    const mailboxes = (ctx.db.prepare('SELECT id, name, email FROM mailboxes WHERE deleted_at IS NULL ORDER BY name').all() as { id: number; name: string; email: string | null }[]).map((m) => ({ local_id: m.id, name: m.name, email: m.email }));
    const assignees = (ctx.db.prepare("SELECT id, first_name, last_name FROM users WHERE deleted_at IS NULL AND type = 'user' ORDER BY last_name").all() as { id: number; first_name: string | null; last_name: string | null }[]).map((u) => ({ local_id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') }));
    // v2.1.0 (M5, plan Phase 31): advanced condition catalogs.
    const orgDefs = (ctx.db.prepare('SELECT id, remote_id, name, slug, type, sort_order FROM organization_property_definitions ORDER BY sort_order, name').all() as {
      id: number; remote_id: number; name: string; slug: string | null; type: string | null; sort_order: number;
    }[]).map((d) => {
      const type = (['text', 'number', 'date', 'dropdown', 'url'].includes(d.type ?? '') ? d.type : 'text') as 'text' | 'number' | 'date' | 'dropdown' | 'url';
      const observed = (ctx.db.prepare("SELECT DISTINCT value FROM organization_properties WHERE definition_id = ? AND value IS NOT NULL AND value <> '' ORDER BY value LIMIT 20").all(d.id) as { value: string }[]).map((r) => r.value);
      const populated = (ctx.db.prepare("SELECT COUNT(DISTINCT organization_id) AS n FROM organization_properties WHERE definition_id = ? AND value IS NOT NULL AND value <> ''").get(d.id) as { n: number }).n;
      return { id: d.id, remote_id: d.remote_id, name: d.name, slug: d.slug, type, observed_values: observed, populated };
    });
    const ticketCustomFields = (ctx.db.prepare('SELECT id, name, type FROM inbox_fields WHERE deleted_at IS NULL ORDER BY sort_order, name').all() as { id: number; name: string; type: string | null }[]).map((f) => ({ local_id: f.id, name: f.name, type: f.type }));
    const channels = (ctx.db.prepare("SELECT DISTINCT source_type FROM conversations WHERE source_type IS NOT NULL AND source_type <> '' AND deleted_at IS NULL ORDER BY source_type").all() as { source_type: string }[]).map((r) => r.source_type);
    const clusters = (ctx.db.prepare('SELECT id, title FROM issue_clusters ORDER BY conversation_count DESC LIMIT 50').all() as { id: number; title: string }[]).map((c) => ({ id: c.id, kind: 'cluster' as const, label: c.title }));
    const knownIssues = (ctx.db.prepare('SELECT id, title FROM known_issues ORDER BY conversation_count DESC LIMIT 50').all() as { id: number; title: string }[]).map((k) => ({ id: k.id, kind: 'known_issue' as const, label: k.title }));
    const incidents = (ctx.db.prepare('SELECT id, code, title, status FROM incidents ORDER BY updated_at DESC LIMIT 50').all() as { id: number; code: string; title: string; status: string }[]).map((i) => ({ id: i.id, code: i.code, title: i.title, status: i.status }));
    const campaigns = (ctx.db.prepare('SELECT id, name, status FROM outreach_campaigns ORDER BY updated_at DESC LIMIT 50').all() as { id: number; name: string; status: string }[]).map((c) => ({ id: c.id, name: c.name, status: c.status }));
    const customObjectTypes = (ctx.db.prepare('SELECT id, name, slug FROM custom_object_types WHERE deleted_at IS NULL ORDER BY name').all() as { id: number; name: string; slug: string }[]).map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
    return {
      property_definitions: propertyDefinitions,
      tags,
      mailboxes,
      assignees,
      contact_fields: ['name', 'email', 'email_domain', 'organization', 'job_title', 'location', 'background', 'has_email', 'has_phone', 'has_multiple_emails'],
      ticket_statuses: ['active', 'pending', 'closed', 'spam'],
      operators_by_type: OPERATORS_BY_TYPE,
      personalization_variables: ['first_name', 'last_name', 'company', 'organization', 'last_ticket_number', 'last_ticket_subject'],
      organization_fields: ['name', 'domains'] as ('name' | 'domains')[],
      organization_property_definitions: orgDefs,
      ticket_custom_fields: ticketCustomFields,
      channels,
      issues: [...knownIssues, ...clusters],
      incidents,
      campaigns,
      custom_object_types: customObjectTypes,
      customer_event_kinds: ['signup', 'support_conversation', 'customer_message', 'campaign', 'campaign_reply', 'rating', 'incident_exposure', 'custom_object_event'],
      support_health_metrics: ['avg_rating', 'avg_effort_score', 'first_response_resolution_rate', 'high_friction_rate'] as ('avg_rating' | 'avg_effort_score' | 'first_response_resolution_rate' | 'high_friction_rate')[]
    };
  });

  // ---------------- Segment preview + saved segments ----------------

  app.post('/api/outreach/segments/preview', async (request, reply) => {
    const tree = parseTree(request.body);
    if (!tree) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'Body must be { combinator, conditions[], exclude[] }.' });
      return;
    }
    const page = Math.max(1, Number((request.body as { page?: number }).page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number((request.body as { pageSize?: number }).pageSize) || 25));
    const result = ctx.segmentEngine.preview(tree, page, pageSize);
    return { ...result, page, page_size: pageSize };
  });

  app.post('/api/outreach/segments/estimate', async (request) => {
    const tree = parseTree(request.body);
    if (!tree) return { matched: 0 };
    return { matched: ctx.segmentEngine.count(tree) };
  });

  // v2.1.0 (M5, plan Phase 31): natural-language -> segment DEFINITION
  // suggestion. The local model only proposes a condition tree; the
  // deterministic engine immediately evaluates it and THAT preview is what
  // the user sees. Nothing is saved - saving stays an explicit human action.
  app.post('/api/outreach/segments/suggest', async (request, reply) => {
    const body = z.object({ request: z.string().min(3).max(500) }).parse(request.body ?? {});
    if (ctx.settingsRepo.get('ai_enabled', true) !== true) {
      reply.code(503).send({
        statusCode: 503,
        error: 'ServiceUnavailable',
        message: 'AI is disabled in Settings. The natural-language suggestion needs the local model; you can build the segment manually.'
      });
      return;
    }
    try {
      const suggestion = await ctx.segmentSuggest.suggest(body.request);
      // The deterministic engine executes the actual selection (never the model).
      const preview = ctx.segmentEngine.preview(suggestion.definition, 1, 25);
      return {
        ok: true,
        definition: suggestion.definition,
        model: suggestion.model,
        preview,
        notes: [...suggestion.notes, 'The model proposed the DEFINITION only; the deterministic segment engine selected the recipients. Nothing was saved - review and save explicitly.']
      };
    } catch (e) {
      if (e instanceof LmStudioError) {
        reply.code(503).send({ statusCode: 503, error: 'ServiceUnavailable', message: e.message });
        return;
      }
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: e instanceof Error ? e.message : 'The suggestion failed.' });
    }
  });

  app.get('/api/outreach/segments', async () => ({ segments: ctx.outreachRepo.listSegments() }));

  app.post('/api/outreach/segments', async (request, reply) => {
    // v1.6.0 audit fix: numeric name hit `.trim()` -> 500; zod now.
    const body = z
      .object({ id: z.number().int().positive().optional(), name: z.string().min(1).max(200), description: z.string().max(2000).nullable().optional(), definition: z.unknown().optional() })
      .parse(request.body ?? {});
    const tree = parseTree(body.definition ?? { combinator: 'all', conditions: [], exclude: [] });
    if (!tree) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'definition must be { combinator, conditions[], exclude[] }.' });
      return;
    }
    const id = ctx.outreachRepo.saveSegment({ id: body.id, name: body.name.trim(), description: body.description ?? null, definition: tree });
    ctx.jobsRepo.audit({ actor: 'user', action: body.id ? 'segment_updated' : 'segment_created', after_state: { id, name: body.name } });
    return { ok: true, id, message: body.id ? 'Segment updated (version incremented).' : 'Segment saved. Saved segments are reusable rules; campaigns always snapshot their recipients at creation.' };
  });

  app.delete('/api/outreach/segments/:id', async (request) => {
    const ok = ctx.outreachRepo.deleteSegment(Number((request.params as { id: string }).id));
    return { ok, message: ok ? 'Segment deleted. Existing campaigns keep their recipient snapshots.' : 'Segment not found.' };
  });

  // ---------------- Campaigns ----------------

  app.post('/api/outreach/campaigns', async (request, reply) => {
    // v1.6.0 audit fix: the loose cast meant numeric name/subject/body hit
    // `.trim()` and crashed with 500s. The wire shape is zod-validated now.
    const body = z
      .object({
        name: z.string().min(1).max(200),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(200000),
        mailbox_local_id: z.number().int().positive(),
        tags: z.array(z.string().max(100)).max(20).optional(),
        segment_id: z.number().int().positive().nullable().optional(),
        definition: z.unknown().optional(),
        customer_ids: z.array(z.number().int().positive()).optional()
      })
      .parse(request.body ?? {});
    const mailbox = ctx.db.prepare('SELECT id, remote_id FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(Number(body.mailbox_local_id)) as { id: number; remote_id: number } | undefined;
    if (!mailbox) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'A valid sending mailbox is required.' });
      return;
    }

    // Recipients: EITHER explicit selection of preview rows, OR the full segment result.
    // The engine (never the LLM) determines membership (spec #42/#43).
    let tree: SegmentDefinition | null = null;
    if (body.definition != null) {
      tree = parseTree(body.definition);
      if (!tree) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'definition must be { combinator, conditions[], exclude[] }.' });
        return;
      }
    } else if (body.segment_id != null) {
      const saved = ctx.outreachRepo.getSegment(Number(body.segment_id));
      if (saved) tree = saved.definition;
    }
    if (!tree) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'A segment definition or saved segment is required (campaigns never target the whole address book by accident).' });
      return;
    }

    // v2.2.1 audit fix (performance): this used to evaluate a page of 100,000
    // matched customers in one request - buildRows runs ~6-10 queries per
    // customer, so a large segment froze the request (and the single-threaded
    // local UI). The snapshot is bounded now (same guard class as the v2.2.0
    // performance work); truncation is disclosed in the response, never silent.
    const SNAPSHOT_LIMIT = 5000;
    const preview = ctx.segmentEngine.preview(tree, 1, SNAPSHOT_LIMIT);
    const selectedIds = Array.isArray(body.customer_ids) && body.customer_ids.length > 0 ? body.customer_ids.map(Number).filter(Number.isInteger) : preview.rows.map((r) => r.customer_local_id);
    const selectedSet = new Set(selectedIds);
    const rows = preview.rows.filter((r) => selectedSet.has(r.customer_local_id));
    if (rows.length === 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'No recipients selected.' });
      return;
    }
    const snapshotRowIds = new Set(preview.rows.map((r) => r.customer_local_id));
    const droppedSelected = selectedIds.filter((id) => !snapshotRowIds.has(id)).length;
    const campaignId = ctx.outreachRepo.createCampaign({
      name: body.name.trim(),
      subject: body.subject,
      body: body.body,
      mailbox_local_id: mailbox.id,
      tags: (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10),
      segment_id: body.segment_id ?? null,
      segment_snapshot: tree,
      recipients: rows.map((r) => ({
        customer_local_id: r.customer_local_id,
        customer_remote_id: r.customer_remote_id,
        email: r.chosen_email,
        why: r.why,
        matching_tickets: r.matching_tickets,
        property_values: r.properties
      }))
    });
    ctx.jobsRepo.audit({ actor: 'user', action: 'campaign_created', after_state: { id: campaignId, name: body.name, recipients: rows.length } });
    const truncated = preview.matched > preview.rows.length || droppedSelected > 0;
    return {
      ok: true,
      id: campaignId,
      recipients: rows.length,
      message: truncated
        ? `Campaign created with ${rows.length} recipients (segment matched ${preview.matched}; the recipient snapshot is capped at ${SNAPSHOT_LIMIT}${droppedSelected > 0 ? `, ${droppedSelected} explicitly-selected customer(s) beyond the cap were not included` : ''}). Recipients are a static snapshot - later segment changes will not alter this campaign.`
        : `Campaign created with ${rows.length} recipients. Recipients are a static snapshot - later segment changes will not alter this campaign.`
    };
  });

  app.get('/api/outreach/campaigns', async () => ({ campaigns: ctx.outreachRepo.listCampaigns() }));

  app.get('/api/outreach/campaigns/:id', async (request, reply) => {
    const c = ctx.outreachRepo.getCampaign(Number((request.params as { id: string }).id));
    if (!c) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Campaign not found.' });
      return;
    }
    return { campaign: c, events: ctx.outreachRepo.listEvents(c.id) };
  });

  app.get('/api/outreach/campaigns/:id/validate', async (request) => {
    return ctx.campaigns.validate(Number((request.params as { id: string }).id));
  });

  /** Campaign-less personalization preview: render subject/body for one customer (compose step, spec #26). */
  app.post('/api/outreach/render', async (request, reply) => {
    const body = request.body as { customer_local_id?: number; subject?: string; body?: string; matching_tickets?: RecipientWhyTicket[] };
    const customerId = Number(body?.customer_local_id);
    if (!Number.isInteger(customerId)) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'customer_local_id is required.' });
      return;
    }
    const customer = ctx.peopleRepo.getCustomerByLocalId(customerId);
    if (!customer) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer not found in the local mirror.' });
      return;
    }
    // Matching tickets: provided by the caller (wizard state) or derived from the
    // customer's most recent conversations - the same evidence the review shows.
    const tickets: RecipientWhyTicket[] = Array.isArray(body?.matching_tickets)
      ? (body.matching_tickets as RecipientWhyTicket[])
      : (ctx.db
          .prepare(
            `SELECT c.id AS conversationId, c.number, c.subject, c.status, c.remote_created_at AS createdAt,
               (SELECT GROUP_CONCAT(tg.name) FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
             FROM conversations c WHERE c.customer_local_id = ? AND c.deleted_at IS NULL ORDER BY c.remote_created_at DESC LIMIT 3`
          )
          .all(customerId) as { conversationId: number; number: number; subject: string | null; status: string; remote_created_at: string | null; tags: string | null }[]
        ).map((t) => ({ conversationId: t.conversationId, number: t.number, subject: t.subject, status: t.status, createdAt: t.remote_created_at, tags: t.tags ? t.tags.split(',').filter(Boolean) : [] }));
    const rendered = ctx.campaigns.renderFor(customerId, tickets, String(body?.subject ?? ''), String(body?.body ?? ''));
    return {
      rendered,
      customer: { first_name: customer.first_name, last_name: customer.last_name, email: customer.emails[0] ?? null },
      sources: tickets.slice(0, 3).map((t) => ({ number: t.number, subject: t.subject }))
    };
  });

  app.post('/api/outreach/campaigns/:id/preview', async (request, reply) => {
    const body = request.body as { customer_local_id?: number };
    const c = ctx.outreachRepo.getCampaign(Number((request.params as { id: string }).id));
    if (!c) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Campaign not found.' });
      return;
    }
    const recipient = c.recipients_list.find((r) => r.customer_local_id === Number(body?.customer_local_id));
    if (!recipient) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'That customer is not a recipient of this campaign.' });
      return;
    }
    const rendered = ctx.campaigns.renderFor(recipient.customer_local_id, recipient.matching_tickets, c.subject, c.body);
    return {
      rendered,
      customer: { first_name: recipient.first_name, last_name: recipient.last_name, email: recipient.email },
      sources: recipient.matching_tickets.slice(0, 3).map((t) => ({ number: t.number, subject: t.subject }))
    };
  });

  app.post('/api/outreach/campaigns/:id/queue', async (request) => {
    const result = ctx.campaigns.queue(Number((request.params as { id: string }).id));
    if (result.ok) ctx.jobsRepo.audit({ actor: 'user', action: 'campaign_queued', after_state: { id: Number((request.params as { id: string }).id) } });
    return result;
  });

  app.post('/api/outreach/campaigns/:id/pause', async (request) => ctx.campaigns.pause(Number((request.params as { id: string }).id)));
  app.post('/api/outreach/campaigns/:id/resume', async (request) => ctx.campaigns.resume(Number((request.params as { id: string }).id)));
  app.post('/api/outreach/campaigns/:id/cancel', async (request) => ctx.campaigns.cancelRemaining(Number((request.params as { id: string }).id)));
  app.post('/api/outreach/campaigns/:id/retry', async (request) => ctx.campaigns.retryFailed(Number((request.params as { id: string }).id)));

  app.post('/api/outreach/campaigns/:id/reconcile', async (request) => {
    const r = await ctx.campaigns.reconcile(Number((request.params as { id: string }).id));
    return { ok: true, message: `Reconciliation finished: ${r.resolvedSent} resolved as sent, ${r.returnedToQueue} returned to the queue, ${r.stillUnknown} still unknown.`, ...r };
  });

  app.get('/api/outreach/campaigns/:id/report', async (request) => {
    return ctx.campaigns.report(Number((request.params as { id: string }).id));
  });

  app.delete('/api/outreach/campaigns/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    const c = ctx.outreachRepo.getCampaign(id);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    if (c.status === 'queued' || c.status === 'sending') return { ok: false, message: 'Pause or cancel the campaign before deleting it.' };
    const ok = ctx.outreachRepo.deleteCampaign(id);
    return { ok, message: ok ? 'Campaign deleted (audit events and Help Scout conversations are untouched).' : 'Delete failed.' };
  });

  // ---------------- Do Not Contact ----------------

  app.get('/api/outreach/dnc', async () => ({ dnc: ctx.outreachRepo.listDnc() }));

  app.post('/api/outreach/dnc', async (request, reply) => {
    const body = request.body as { customer_local_id?: number; reason?: string | null };
    const id = Number(body?.customer_local_id);
    // v1.5.0 audit fix: negative/zero ids used to reach the INSERT and die on
    // the foreign key (SqliteError -> 500). Positive integers only.
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'customer_local_id must be a positive integer.' });
      return;
    }
    ctx.outreachRepo.addDnc(id, body.reason ?? null);
    ctx.jobsRepo.audit({ actor: 'user', action: 'dnc_added', after_state: { customer_local_id: id } });
    return { ok: true, message: 'Added to Do-Not-Contact. Every future campaign skips this customer.' };
  });

  app.delete('/api/outreach/dnc/:customerLocalId', async (request, reply) => {
    // v1.6.0 audit fix: NaN/nonexistent ids returned ok:true silently; 404 now.
    const raw = Number((request.params as { customerLocalId: string }).customerLocalId);
    if (!Number.isInteger(raw) || raw <= 0) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: 'A positive numeric customer id is required.' });
      return;
    }
    const ok = ctx.outreachRepo.removeDnc(raw);
    if (!ok) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Customer is not on the Do-Not-Contact list.' });
      return;
    }
    return { ok: true, message: 'Removed from Do-Not-Contact.' };
  });
}
