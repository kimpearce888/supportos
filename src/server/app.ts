import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
// Prune threshold: without this, unique spoofed keys would grow the map without bound.
const RATE_LIMIT_MAP_MAX = 512;

function rateLimitKey(request: FastifyRequest): string {
  // v1.6.0 audit fix: X-Forwarded-For is CLIENT-CONTROLLED input (trustProxy is
  // off - no proxy rewrites that header), so keying the limiter on it let any
  // non-browser client rotate the header for an unlimited budget. Key on the
  // actual socket address instead; on this localhost-only app that is constant
  // ('::ffff:127.0.0.1' or similar), which is exactly the intended semantics:
  // one local user, one budget.
  return request.socket.remoteAddress ?? 'local';
}

/**
 * v2.2.1 audit fix (DNS-rebinding guard): this app is local-first by design,
 * but nothing validated the Host header. A attacker-controlled page at
 * http://attacker.com that re-resolves to 127.0.0.1 is SAME-ORIGIN from the
 * browser's viewpoint (the origin is the attacker's NAME), so CORS - even a
 * perfect allowlist - enforces nothing against it, and Firefox/Safari happily
 * let such pages read AND write localhost APIs. Fastify performs no Host
 * check of its own. We now refuse any request whose Host is not a loopback
 * name. Deliberately skipped when HOST is explicitly bound non-loopback (that
 * is the documented, loudly-warned network-exposure mode).
 */
function isLoopbackHostHeader(host: string | undefined): boolean {
  if (host == null || host === '') return true; // HTTP/1.0-style / injected requests carry no Host - nothing to forge
  let h = host.toLowerCase();
  // Strip an optional :port without breaking IPv6 literals ([::1]:3000).
  if (!h.endsWith(']')) {
    const idx = h.lastIndexOf(':');
    if (idx > -1 && /^\d+$/.test(h.slice(idx + 1))) h = h.slice(0, idx);
  }
  h = h.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1';
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024, // attachment uploads (base64)
    trustProxy: false // localhost app: do not trust spoofable proxy headers
  });
  const logger = createLogger(ctx.config.logLevel).child({ service: 'http' });

  // v2.2.1 audit fix: DNS-rebinding guard (see isLoopbackHostHeader). Only
  // enforced in the default loopback bind mode - an explicit non-loopback
  // HOST is the documented network-exposure mode and keeps working.
  const loopbackBindMode = ctx.config.host === '127.0.0.1' || ctx.config.host === 'localhost' || ctx.config.host === '::1';
  if (loopbackBindMode) {
    app.addHook('onRequest', async (request, reply) => {
      if (!isLoopbackHostHeader(request.headers.host)) {
        reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'SupportOS is a local application: requests with non-loopback Host headers are refused (DNS-rebinding guard).'
        });
      }
    });
  }

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
    // Opportunistic pruning: sweep expired entries once the map grows past the
    // threshold so long-lived processes cannot accumulate stale keys.
    if (mutationHits.size > RATE_LIMIT_MAP_MAX) {
      for (const [k, v] of mutationHits) {
        if (now > v.resetAt) mutationHits.delete(k);
      }
    }
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
    } catch {
      // v1.5.0 audit fix: a malformed JSON body is a CLIENT error (400), not a
      // server error. Fastify's default parser maps this to 400; the custom
      // raw-body parser used to forward the raw SyntaxError, which has no
      // statusCode and therefore surfaced as a 500 + error-level log entry.
      const bad = new Error('Request body is not valid JSON.');
      (bad as Error & { statusCode?: number }).statusCode = 400;
      done(bad, undefined);
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

  // Static client (production build) - SPA fallback.
  // SUPPORTOS_CLIENT_DIST lets packaged builds (Tauri) point at the bundled client
  // copy instead of a path relative to the (arbitrary) process working directory.
  const clientDir = process.env.SUPPORTOS_CLIENT_DIST
    ? path.resolve(process.env.SUPPORTOS_CLIENT_DIST)
    : path.resolve(process.cwd(), 'dist', 'client');
  const hasClient = fs.existsSync(clientDir);
  if (hasClient) {
    await app.register((await import('@fastify/static')).default, {
      root: clientDir,
      prefix: '/'
    });
  }
  // v2.2.1 audit fix: the JSON 404 envelope for unknown /api/* paths used to
  // be registered ONLY when a client build existed - dev runs (no dist/client)
  // returned Fastify's default "Route GET:/... not found" shape, so the API
  // error envelope differed between dev and packaged builds. Registered
  // unconditionally now; the SPA fallback applies only when the build exists.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url === '/api') {
      reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'Unknown API endpoint.' });
      return;
    }
    if (hasClient) {
      reply.sendFile('index.html');
      return;
    }
    reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'Not found.' });
  });

  return app;
}
