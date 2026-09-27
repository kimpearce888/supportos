import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../state/uiStore.js';

/**
 * Client side of the real-time layer (v1.3.0).
 *
 * ONE shared EventSource for the whole SPA (module-level, lazily created,
 * reference-counted): multiple components can subscribe without opening a
 * stream each. EventSource reconnects automatically; on 'error' we simply let
 * it reconnect (local server hiccups are transient).
 *
 * ServerEventsBridge is mounted once in App: it turns server events into
 * TanStack Query invalidations + a toast for new ratings, so every dashboard
 * and inbox view refreshes within seconds without polling.
 */

type ServerEventHandler = (event: string, data: unknown) => void;

let source: EventSource | null = null;
const listeners = new Set<ServerEventHandler>();

function ensureSource(): void {
  if (source != null || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  const forward = (event: string) => (e: MessageEvent<string>) => {
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      data = e.data;
    }
    for (const l of listeners) {
      try {
        l(event, data);
      } catch {
        /* listener bugs never break the stream */
      }
    }
  };
  for (const name of ['hello', 'ratings', 'sync', 'error']) {
    source.addEventListener(name, forward(name) as EventListener);
  }
}

/** Subscribe to server events; returns an unsubscribe function. */
export function onServerEvents(handler: ServerEventHandler): () => void {
  ensureSource();
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
    // Keep the stream open (reconnects are free and the app reconnects on nav);
    // EventSource closes only when the page unloads.
  };
}

export interface RatingEventData {
  rating: 'great' | 'okay' | 'not-good' | null;
  conversationId: number | null;
  conversationNumber: number | null;
  customerId: number | null;
  customerName: string | null;
  comments: string | null;
  at: string;
}

export interface SyncEventData {
  kind: 'initial' | 'incremental' | 'reconciliation' | 'single';
  processed: number;
  errors: number;
  at: string;
}

const RATING_LABEL: Record<string, string> = { great: 'Great', okay: 'Okay', 'not-good': 'Not good' };

/** Mount once: wires server events into query invalidation + rating toasts. */
export function ServerEventsBridge(): null {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    const off = onServerEvents((event, data) => {
      if (event === 'ratings') {
        const d = data as RatingEventData;
        // Ratings affect the dashboard KPIs and customer profiles.
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        void qc.invalidateQueries({ queryKey: ['customer'] });
        void qc.invalidateQueries({ queryKey: ['interaction-profile'] });
        if (d.rating != null && 'conversationId' in d) {
          pushToast({
            kind: d.rating === 'great' ? 'success' : d.rating === 'okay' ? 'info' : 'warning',
            message: `New ${RATING_LABEL[d.rating] ?? d.rating} rating${d.conversationNumber ? ` on #${d.conversationNumber}` : ''}${d.customerName ? ` · ${d.customerName}` : ''}`,
            detail: d.comments ?? undefined
          });
        }
      } else if (event === 'sync') {
        const d = data as SyncEventData;
        // A finished sync means conversations and dashboards may have changed.
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['conversation'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        void qc.invalidateQueries({ queryKey: ['nav-counts'] });
        if (d.kind === 'incremental' && d.processed > 0) {
          void qc.invalidateQueries({ queryKey: ['docs'] });
        }
      }
    });
    return off;
  }, [qc, pushToast]);

  return null;
}
