import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { serverEventBus } from '../services/eventBus.js';
import { APP_VERSION } from '../../shared/constants.js';

/**
 * Server-Sent Events endpoint (v1.3.0): real-time push over plain HTTP.
 *
 * Design decisions:
 * - SSE instead of WebSockets: updates are one-way server->client
 *   notifications; EventSource reconnects automatically and needs no extra
 *   dependency. The SPA subscribes once (see src/client/api/events.ts).
 * - GET is exempt from the mutation rate limit; the stream itself is cheap
 *   (a keep-alive comment every 25s).
 * - Every subscription cleans up its bus listeners + timer on disconnect so
 *   a closed tab can never leak handlers into the emitter path.
 */
export async function registerEventsRoutes(app: FastifyInstance, _ctx: AppContext): Promise<void> {
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let closed = false;
    const write = (chunk: string): void => {
      if (closed) return;
      try {
        reply.raw.write(chunk);
      } catch {
        cleanup();
      }
    };
    const send = (event: string, data: unknown): void => {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Cap concurrent streams defensively; drop the oldest is NOT acceptable,
    // so reject politely beyond the cap (a local single-user app will never hit it).
    if (serverEventBus.subscriberCount('rating-received') >= 25) {
      send('error', { message: 'Too many event streams open. Close another tab.' });
      reply.raw.end();
      return;
    }

    send('hello', { at: new Date().toISOString(), channels: ['ratings', 'sync'], version: APP_VERSION });

    const offRating = serverEventBus.on('rating-received', (p) => send('ratings', p));
    const offRefresh = serverEventBus.on('ratings-refreshed', (p) => send('ratings', p));
    const offSync = serverEventBus.on('sync-completed', (p) => send('sync', p));
    const ping = setInterval(() => write(': ping\n\n'), 25_000);

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      offRating();
      offRefresh();
      offSync();
    }

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
