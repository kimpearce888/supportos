import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { clampListParam } from './helpers.js';
import { connectorCreateSchema, connectorPatchSchema } from '../../shared/workspace.js';
import type { ConnectorRecord } from '../database/repositories/connectorRepo.js';

/**
 * Connector routes (plan Phase 22). HTTP configs are SSRF-checked at
 * CREATE/PATCH time (fail fast) and again at every refresh (fail closed).
 * Auth material is NEVER returned - reads always carry the redacted auth
 * object. Refresh runs the snapshot pipeline and reports health honestly.
 */
export async function registerConnectorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const svc = () => ctx.connectors;

  const redacted = (c: ConnectorRecord) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    config: c.config,
    auth: ctx.connectors.repository.redactedAuth(c),
    refresh_method: c.refresh_method,
    refresh_seconds: c.refresh_seconds,
    allowed_ai: c.allowed_ai === 1,
    enabled: c.enabled === 1,
    schema_json: c.schema_json,
    last_sync_at: c.last_sync_at,
    last_sync_status: c.last_sync_status,
    last_sync_error: c.last_sync_error,
    last_sync_rows: c.last_sync_rows,
    health: c.health,
    row_count: ctx.connectors.repository.countRows(c.id),
    created_at: c.created_at,
    updated_at: c.updated_at
  });

  app.get('/api/connectors', async () => {
    return { connectors: svc().repository.list().map(redacted) };
  });

  app.post('/api/connectors', async (request, reply) => {
    const parsed = connectorCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    const d = parsed.data;
    // Eager SSRF/jail validation: refuse unsafe configuration up front.
    const problem = await svc().validateConfig({ kind: d.config.kind, file: 'file' in d.config ? d.config.file : undefined, url: 'url' in d.config ? d.config.url : undefined, table: 'table' in d.config ? d.config.table : undefined });
    if (problem) {
      reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: problem });
      return;
    }
    try {
      const connector = svc().repository.create({
        name: d.name,
        kind: d.config.kind,
        config: d.config as unknown as Record<string, unknown>,
        auth: d.auth as unknown as Record<string, unknown>,
        refreshMethod: d.refreshMethod,
        refreshSeconds: d.refreshSeconds,
        allowedAi: d.allowedAi
      });
      ctx.jobsRepo.audit({ actor: 'user', action: 'connector_created', after_state: { id: connector.id, name: connector.name, kind: connector.kind } });
      return { ok: true, connector: redacted(connector) };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/api/connectors/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const connector = svc().repository.get(id);
    if (!connector) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
      return;
    }
    return { connector: redacted(connector) };
  });

  app.patch('/api/connectors/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = connectorPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message).join('; ').slice(0, 300) });
      return;
    }
    const d = parsed.data;
    if (d.config) {
      const problem = await svc().validateConfig({ kind: d.config.kind, file: 'file' in d.config ? d.config.file : undefined, url: 'url' in d.config ? d.config.url : undefined, table: 'table' in d.config ? d.config.table : undefined });
      if (problem) {
        reply.code(422).send({ statusCode: 422, error: 'ValidationError', message: problem });
        return;
      }
    }
    try {
      const connector = svc().repository.patch(id, {
        name: d.name,
        config: d.config as unknown as Record<string, unknown> | undefined,
        auth: d.auth as unknown as Record<string, unknown> | undefined,
        refreshMethod: d.refreshMethod,
        refreshSeconds: d.refreshSeconds,
        allowedAi: d.allowedAi,
        enabled: d.enabled
      });
      if (!connector) {
        reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
        return;
      }
      ctx.jobsRepo.audit({ actor: 'user', action: 'connector_updated', after_state: { id, fields: Object.keys(d) } });
      return { ok: true, connector: redacted(connector) };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: (e as Error).message };
    }
  });

  app.delete('/api/connectors/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const deleted = svc().repository.delete(id);
    if (!deleted) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'connector_deleted', before_state: { id } });
    return { ok: true, message: 'Connector and its cached rows deleted.' };
  });

  app.post('/api/connectors/:id/refresh', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!svc().repository.get(id)) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
      return;
    }
    const result = await svc().refresh(id);
    ctx.jobsRepo.audit({ actor: 'user', action: 'connector_refreshed', after_state: { id, ok: result.ok, rows: result.rows, pruned: result.pruned } });
    if (!result.ok) {
      reply.code(422);
      return { ok: false, message: `Refresh failed: ${result.error ?? 'unknown error'}`, result };
    }
    return { ok: true, result };
  });

  app.get('/api/connectors/:id/rows', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const connector = svc().repository.get(id);
    if (!connector) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
      return;
    }
    const q = request.query as Record<string, string>;
    const result = svc().repository.listRows(id, (q.q ?? '').slice(0, 120) || null, clampListParam(q.pageSize, 50, 1, 200), (clampListParam(q.page, 1, 1, 100000) - 1) * clampListParam(q.pageSize, 50, 1, 200));
    return { rows: result.rows, total: result.total };
  });

  /** Preview without persisting: validates config + source reachability. */
  app.post('/api/connectors/:id/test', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const connector = svc().repository.get(id);
    if (!connector) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Connector not found.' });
      return;
    }
    const problem = await svc().validateConfig({ kind: connector.kind, file: (connector.config as { file?: string }).file, url: (connector.config as { url?: string }).url, table: (connector.config as { table?: string }).table });
    if (problem) {
      return { ok: false, message: problem };
    }
    // v2.2.1 audit fix: honesty - validateConfig checks URL shape + DNS
    // resolution (and file existence), it does NOT fetch the source. The old
    // "source is reachable" wording claimed more than the check performs.
    return { ok: true, message: 'Configuration is valid and the source host resolves. Full reachability is verified on the next refresh.' };
  });
}
