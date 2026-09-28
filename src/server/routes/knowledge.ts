import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { knowledgeImportRequestSchema, knowledgeImportFileRequestSchema } from '../../shared/schemas.js';
import fs from 'node:fs';
import path from 'node:path';

function underRoot(abs: string, root: string): boolean {
  // Separator-aware containment: a sibling like knowledge-import-x/ must NOT match
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function registerKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/knowledge/sources', async () => ({ sources: ctx.knowledgeRepo.listSources() }));

  app.get('/api/knowledge/documents', async (request) => {
    const q = request.query as Record<string, string>;
    return { documents: ctx.knowledgeRepo.listDocuments(q.sourceId ? Number(q.sourceId) : undefined) };
  });

  app.get('/api/knowledge/documents/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const doc = ctx.knowledgeRepo.getDocument(id);
    if (!doc) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Document not found.' });
      return;
    }
    // v2.2.1 audit fix: this used to be a knowledge-base FTS hit count for the
    // document's own title (a DOCUMENT count that included self-matches) - not
    // tickets. The honest number for a "related tickets" estimate is the
    // distinct conversations whose AI analysis actually cited this document.
    const relatedTickets = (
      ctx.db
        .prepare(
          `SELECT COUNT(DISTINCT r.conversation_id) AS n
             FROM ai_sources s JOIN ai_runs r ON r.id = s.run_id
            WHERE s.source_type = 'knowledge_document' AND s.source_id = ? AND r.conversation_id IS NOT NULL`
        )
        .get(id) as { n: number }
    ).n;
    return {
      document: doc,
      related_ticket_estimate: relatedTickets,
      related_known_issues: ctx.issueRepo.searchKnownIssues(doc.title)
    };
  });

  // Import documents as JSON payload
  app.post('/api/knowledge/import', async (request) => {
    const body = knowledgeImportRequestSchema.parse(request.body);
    const result = ctx.knowledge.importManual(body.sourceName, body.documents, body.visibility);
    ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, 4, 2);
    ctx.jobsRepo.audit({ actor: 'user', action: 'knowledge_imported', after_state: { count: result.length, visibility: body.visibility } });
    return { ok: true, imported: result.length, documents: result };
  });

  // Import a local file (MD/TXT/CSV/JSON/HTML/PDF/DOCX) via path
  app.post('/api/knowledge/import-file', async (request, reply) => {
    const parsed = knowledgeImportFileRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ statusCode: 400, error: 'BadRequest', message: 'A file path is required.' });
      return;
    }
    // Path safety: resolve and require the file to live under the allowed import
    // roots. This applies in demo mode too - a showcase/CI instance must not be
    // able to read arbitrary files from the machine via the API.
    const abs = path.resolve(parsed.data.path);
    // v1.6.0 audit fix: the allowlist used to include data/ (the live SQLite DB,
    // WAL files, sync bundles and attachments live there - importing any of them
    // as "knowledge" is never legitimate). Only the knowledge-import folder is
    // importable now.
    const allowedRoots = [path.resolve(process.cwd(), 'knowledge-import')];
    const allowed = allowedRoots.some((r) => underRoot(abs, r));
    if (!allowed) {
      reply.code(400).send({
        statusCode: 400,
        error: 'BadRequest',
        message: `For safety, file imports must live inside the "knowledge-import" folder of the project. Create it and copy your documents there, then import "knowledge-import/${path.basename(abs)}".`
      });
      return;
    }
    try {
      const result = await ctx.knowledge.importFile(abs, parsed.data.sourceName ?? path.basename(abs), parsed.data.visibility);
      ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, 4, 2);
      return { ok: true, imported: result.length, documents: result };
    } catch (e) {
      reply.code(422);
      return { ok: false, message: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  app.delete('/api/knowledge/documents/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    ctx.knowledgeRepo.deleteDocument(id);
    ctx.jobsRepo.audit({ actor: 'user', action: 'knowledge_deleted', before_state: { id } });
    return { ok: true, message: 'Document deleted.' };
  });

  app.get('/api/knowledge/search', async (request) => {
    const q = request.query as Record<string, string>;
    const results = ctx.knowledgeRepo.searchKnowledge(q.q ?? '', q.visibility === 'customer_safe' ? 'customer_safe' : undefined);
    // v2.0.0 (M4, plan Phase 25): local usage observability for freshness.
    // Chunk hits are deduped per document so one search = one usage bump.
    ctx.knowledgeFreshness.recordUsage([...new Set(results.map((r) => r.document_id))].filter((x) => Number.isInteger(x) && x > 0));
    return { results };
  });

  // ---------------- v2.0.0 (M4, plan Phase 25): freshness ----------------

  app.get('/api/knowledge/freshness', async () => {
    return { documents: ctx.knowledgeFreshness.report() };
  });

  app.post('/api/knowledge/documents/:id/review', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const ok = ctx.knowledgeFreshness.markReviewed(id);
    if (!ok) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Document not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'knowledge_reviewed', after_state: { id } });
    return { ok: true, message: 'Reviewed (timestamp recorded; nothing is published automatically).' };
  });

  app.post('/api/knowledge/documents/:id/verify', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const ok = ctx.knowledgeFreshness.markVerified(id);
    if (!ok) {
      reply.code(404).send({ statusCode: 404, error: 'NotFound', message: 'Document not found.' });
      return;
    }
    ctx.jobsRepo.audit({ actor: 'user', action: 'knowledge_verified', after_state: { id } });
    return { ok: true, message: 'Verified (timestamp recorded; nothing is published automatically).' };
  });

  app.post('/api/knowledge/reindex', async () => {
    ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, 4, 2);
    return { ok: true, message: 'Reindexing queued.' };
  });

  // List importable files in the knowledge-import folder
  app.get('/api/knowledge/importable', async () => {
    const dir = path.resolve(process.cwd(), 'knowledge-import');
    const files: string[] = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        // v1.6.0 audit fix: tolerate stat races (file vanishing mid-listing)
        // instead of 500ing the route.
        try {
          const stat = fs.statSync(path.join(dir, f));
          if (stat.isFile() && /\.(md|txt|csv|json|html?|pdf|docx)$/i.test(f)) files.push(f);
        } catch {
          // vanished between readdir and stat - skip it
        }
      }
    }
    return { dir, files };
  });
}
