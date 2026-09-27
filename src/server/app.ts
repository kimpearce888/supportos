import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import type { AppContext } from './services/context.js';
import { registerRoutes } from './routes/index.js';
import { WebhookEndpoint } from './services/webhookEndpoint.js';
import { createLogger } from './config/logger.js';

/**
 * Localhost-only CORS posture (spec #86): same-origin by default; explicit
 * localhost origins allowed. The allowlist is derived from the CONFIGURED
 * port (not hardcoded 3000) so the app works on any PORT the user sets,
 * plus the Vite dev server ports (5173-5175, Vite increments when taken).
 */
function allowedOrigins(port: number): string[] {
  const origins: string[] = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`
  ];
  for (const devPort of [5173, 5174, 5175]) {
    origins.push(`http://localhost:${devPort}`, `http://127.0.0.1:${devPort}`);
  }
  return origins;
}

/**
 * Rate limiting for LOCAL MUTATION endpoints (spec #86): reads are unmetered
 * (a local SQLite read is cheap and the SPA legitimately polls multiple
 * endpoints), the webhook endpoint is exempt (it is authenticated by HMAC and
 * deduplicated by payload hash), and every non-GET/HEAD/OPTIONS request is
 * limited to RATE_LIMIT_MAX per window.
 */
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
const mutationHits = new Map<string, { count: number; resetAt: number }>();

function rateLimitKey(request: { headers: Record<string, unknown> }): string {
  const ip = request.headers['x-forwarded-for'];
  // No proxy is trusted (trustProxy is off), so this is the socket address if present.
  return typeof ip === 'string' ? (ip.split(',')[0] ?? 'local').trim() : 'local';
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024, // attachment uploads (base64)
    trustProxy: false // localhost app: do not trust spoofable proxy headers
  });
  const logger = createLogger(ctx.config.logLevel).child({ service: 'http' });

  // Localhost-only CORS + CSRF posture: same-origin by default; explicit localhost origins allowed
  const origins = allowedOrigins(ctx.config.port);
  await app.register(
    (await import('@fastify/cors')).default,
    {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin (Vite proxy / static)
        if (origins.includes(origin)) return cb(null, true);
        cb(null, false); // deny WITHOUT throwing: no CORS headers are emitted, browser blocks the call
      },
      credentials: false
    }
  );

  // Mutation rate limiting (spec #86) - see helper above for scope rationale
  app.addHook('onRequest', async (request, reply) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (request.url === '/api/webhooks/helpscout') return; // HMAC-authenticated + deduplicated
    const key = rateLimitKey(request);
    const now = Date.now();
    const entry = mutationHits.get(key);
    if (!entry || now > entry.resetAt) {
      mutationHits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX) {
      reply.header('retry-after', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      reply.code(429).send({ statusCode: 429, error: 'TooManyRequests', message: 'Too many write requests in one minute. Slow down and retry shortly.' });
    }
  });

  // Webhook endpoint with raw body (signature verification needs the raw string)
  const webhook = new WebhookEndpoint(ctx.db, ctx.config.helpscout.webhookSecret);
  if (!ctx.config.helpscout.webhookSecret) {
    logger.warn('HELPSCOUT_WEBHOOK_SECRET is not set: incoming webhooks will be accepted WITHOUT signature verification. Set the secret before enabling webhooks in production.');
  }
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

  // Error envelope: friendly messages, technical detail behind expandable section (spec #89).
  // Validation errors (zod) are client errors -> 422 with the first issue as the message;
  // they are NOT logged as server errors and do not pollute application_errors.
  app.setErrorHandler((err, request, reply) => {
    const error = err as Error & { statusCode?: number };
    const isZod = error.name === 'ZodError';
    const status = isZod ? 422 : error.statusCode ?? 500;
    if (status >= 500) {
      logger.error('Request failed', { requestId: request.id, operation: String(request.url), errorCode: status, error: error.message });
      ctx.jobsRepo.logError('http', `${request.method} ${request.url}: ${error.message}`, error.stack);
    }
    if (isZod) {
      const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? [];
      const first = issues[0];
      const where = first?.path?.length ? ` (${first.path.join('.')})` : '';
      reply.status(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: `Invalid request${where}: ${first?.message ?? 'request body failed validation.'}`,
        issues: issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
      return;
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
