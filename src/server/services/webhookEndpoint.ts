import crypto from 'node:crypto';
import type { DB } from '../database/connection.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { SyncRepository } from '../database/repositories/syncRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';

/**
 * Webhook support (spec #13, #14): optional feature. Localhost apps cannot receive
 * external webhooks directly - a network-accessible relay is required (documented).
 * The endpoint: verifies signature (base64 HMAC-SHA1 of the RAW body with the secret),
 * persists first, acknowledges fast, processes asynchronously, dedupes via event hash.
 */
export class WebhookEndpoint {
  private sync: SyncRepository;
  private jobs: JobRepository;

  constructor(
    private db: DB,
    private secret: string
  ) {
    this.sync = new SyncRepository(db);
    this.jobs = new JobRepository(db);
  }

  verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
    if (!signature || !secret) return false;
    const computed = crypto.createHmac('sha1', secret).update(Buffer.from(rawBody, 'utf8')).digest('base64');
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const eventType = (headers['x-helpscout-event'] as string) || 'unknown';
    const signature = headers['x-helpscout-signature'] as string | undefined;

    if (this.secret) {
      if (!this.verifySignature(raw, signature, this.secret)) {
        reply.code(401).send({ error: 'Invalid webhook signature' });
        return;
      }
    }
    // Persist first (fast ack)
    const { id, duplicate } = this.sync.insertWebhookEvent(eventType, raw);
    if (duplicate) {
      this.sync.setWebhookEventState(id, 'duplicate');
      reply.code(200).send({ received: true, duplicate: true });
      return;
    }
    // Async processing - never inside the HTTP request
    void this.processEvent(id, eventType, raw).catch(() => undefined);
    reply.code(200).send({ received: true });
  }

  /** Idempotent asynchronous processing. */
  async processEvent(id: number, eventType: string, raw: string): Promise<void> {
    try {
      this.sync.setWebhookEventState(id, 'processing');
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.sync.setWebhookEventState(id, 'failed', 'Unparseable payload');
        return;
      }
      const conversationId = (payload.objectID ?? payload.id ?? payload.conversationId) as number | undefined;
      switch (eventType) {
        case 'convo.created':
        case 'convo.updated':
        case 'convo.assigned':
        case 'convo.status':
        case 'convo.tags':
        case 'convo.custom-fields':
        case 'convo.moved':
        case 'convo.customer.reply.created':
        case 'convo.agent.reply.created':
        case 'convo.note.created':
        case 'convo.ai-answers.created':
          if (conversationId) this.jobs.enqueue('sync', 'sync_conversation', { remoteId: conversationId }, 2, 3);
          break;
        case 'convo.merged':
          if (conversationId) this.jobs.enqueue('sync', 'sync_conversation_merge', { remoteId: conversationId }, 2, 3);
          break;
        case 'convo.deleted':
          if (conversationId) this.jobs.enqueue('sync', 'delete_conversation', { remoteId: conversationId }, 2, 1);
          break;
        case 'customer.created':
        case 'customer.updated':
          if (conversationId) this.jobs.enqueue('sync', 'sync_customer', { remoteId: conversationId }, 2, 3);
          break;
        case 'customer.deleted':
          if (conversationId) this.jobs.enqueue('sync', 'delete_customer', { remoteId: conversationId }, 2, 1);
          break;
        case 'organization.created':
        case 'organization.updated':
        case 'organization.deleted':
          this.jobs.enqueue('sync', 'sync_organizations', {}, 3, 2);
          break;
        case 'satisfaction.ratings':
          this.jobs.enqueue('sync', 'sync_conversation_ratings', { conversationId: conversationId ?? null }, 3, 2);
          break;
        case 'tag.created':
        case 'tag.updated':
        case 'tag.deleted':
          this.jobs.enqueue('sync', 'sync_tags', {}, 3, 2);
          break;
        case 'user.status.changed':
          this.jobs.enqueue('sync', 'sync_user_statuses', {}, 3, 2);
          break;
        default:
          // Unknown/other events are recorded but not processed
          break;
      }
      this.sync.setWebhookEventState(id, 'processed');
    } catch (e) {
      this.sync.setWebhookEventState(id, 'failed', e instanceof Error ? e.message : String(e));
    }
  }

  /** Process leftover pending events (e.g. after restart). */
  async drainPending(): Promise<number> {
    const pending = this.sync.getPendingWebhookEvents(50);
    for (const ev of pending) {
      await this.processEvent(ev.id, ev.event_type, ev.payload);
    }
    return pending.length;
  }
}
