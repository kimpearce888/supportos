/**
 * ServerEventBus (v1.3.0): typed in-process pub/sub for real-time updates.
 *
 * Design decisions:
 * - Server-Sent Events (not WebSockets): ratings/sync updates are one-way
 *   server->client notifications; SSE gives us auto-reconnect, plain HTTP
 *   semantics and zero extra dependencies. The client only needs EventSource.
 * - Module-level singleton (same pattern as the mutation rate-limit map in
 *   app.ts): every emitter (sync coordinator, ratings watcher, demo routes)
 *   and the SSE route share one bus without threading it through every
 *   constructor.
 * - Handlers are synchronous and must never throw into the bus: emit()
 *   isolates handler errors so a broken SSE client can never break sync.
 */

export interface RatingReceivedEvent {
  rating: 'great' | 'okay' | 'not-good' | null;
  conversationId: number | null;
  conversationNumber: number | null;
  customerId: number | null;
  customerName: string | null;
  comments: string | null;
  at: string;
}

export interface RatingsRefreshedEvent {
  processed: number;
  fresh: number;
  at: string;
}

export interface SyncCompletedEvent {
  kind: 'initial' | 'incremental' | 'reconciliation' | 'single';
  processed: number;
  errors: number;
  at: string;
}

/** v1.4.0: a single conversation changed in the mirror (webhook push, manual refresh or sync). */
export interface ConversationUpdatedEvent {
  conversationId: number | null;
  conversationNumber: number | null;
  mailboxId: number | null;
  subject: string | null;
  /** Where the update came from - lets the UI phrase toasts honestly. */
  reason: 'webhook' | 'sync' | 'manual';
  at: string;
}

export interface ServerEventMap {
  'rating-received': RatingReceivedEvent;
  'ratings-refreshed': RatingsRefreshedEvent;
  'sync-completed': SyncCompletedEvent;
  'conversation-updated': ConversationUpdatedEvent;
}

type Handler<K extends keyof ServerEventMap> = (payload: ServerEventMap[K]) => void;

/**
 * Internal storage is erased to (payload: unknown) => void and re-cast at the
 * read boundary: this avoids the generic-varariance trap that makes TypeScript
 * reject Set<Handler<K>> stored in a mapped-type record.
 */
class ServerEventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on<K extends keyof ServerEventMap>(key: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => {
      set?.delete(erased);
    };
  }

  emit<K extends keyof ServerEventMap>(key: K, payload: ServerEventMap[K]): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch {
        /* a failing subscriber (e.g. closed SSE socket) must never break the emitter */
      }
    }
  }

  subscriberCount<K extends keyof ServerEventMap>(key: K): number {
    return this.handlers.get(key)?.size ?? 0;
  }
}

export const serverEventBus = new ServerEventBus();
