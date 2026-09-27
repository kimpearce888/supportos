import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import type { AppContext } from './services/context.js';
import { registerRoutes } from './routes/index.js';
import { WebhookEndpoint } from './services/webhookEndpoint.js';
import { createLogger } from './config/logger.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024, // attachment uploads (base64)
    trustProxy: true
  });
  const logger = createLogger(ctx.config.logLevel).child({ service: 'http' });

  // Localhost-only CORS + CSRF posture: same-origin by default; explicit localhost origins allowed
  await app.register(
    (await import('@fastify/cors')).default,
    {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin (Vite proxy / static)
        const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];
        if (allowed.includes(origin)) return cb(null, true);
        cb(new Error('Origin not allowed'), false);
      },
      credentials: false
    }
  );

  // Rate limiting for local mutation endpoints (spec #86)
  await app.register(
    (await import('@fastify/rate-limit')).default,
    { max: 300, timeWindow: '1 minute' }
  );

  // Webhook endpoint with raw body (signature verification needs the raw string)
  const webhook = new WebhookEndpoint(ctx.db, ctx.config.helpscout.webhookSecret);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = String(body);
    try {
      done(null, JSON.parse(String(body)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.post('/api/webhooks/helpscout', async (request, reply) => webhook.handle(request, reply));

  // All routes
  await registerRoutes(app, ctx);

  // Error envelope: friendly messages, technical detail behind expandable section (spec #89)
  app.setErrorHandler((err, request, reply) => {
    const error = err as Error & { statusCode?: number };
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      logger.error('Request failed', { requestId: request.id, operation: String(request.url), errorCode: status, error: error.message });
      ctx.jobsRepo.logError('http', `${request.method} ${request.url}: ${error.message}`, error.stack);
    }
    reply.status(status).send({
      statusCode: status,
      error: error.name ?? 'Error',
      message: status >= 500 ? 'An internal error occurred. Technical details are below.' : error.message,
      detail: status >= 500 ? error.message : undefined
    });
  });

  // Static client (production build) - SPA fallback
  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDir)) {
    await app.register((await import('@fastify/static')).default, {
      root: clientDir,
      prefix: '/'
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'Unknown API endpoint.' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
