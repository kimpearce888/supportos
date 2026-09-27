import type { DB } from '../../database/connection.js';
import { RateLimiter } from './rateLimiter.js';
import { ApiQueue } from './apiQueue.js';
import { PRIORITY } from '../../../shared/constants.js';
import type { ProviderPriority } from './provider.js';

export class HelpScoutApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public friendly: string,
    public correlationId: string | null = null,
    public retryable: boolean = false,
    public retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'HelpScoutApiError';
  }
}

/** Friendly, contextual error messages (spec #68, #89). Never show raw "HTTP 412". */
export function friendlyError(status: number, body: string, method: string): string {
  const detail = body ? body.slice(0, 300) : '';
  switch (status) {
    case 400:
      return `Help Scout rejected the request as invalid${method === 'GET' ? ' (check the filters used)' : ' (check the values you entered)'}. No changes were made. ${detail}`;
    case 401:
      return 'The Help Scout connection is no longer authenticated. Re-connect Help Scout in Settings, then retry. No changes were made.';
    case 403:
      return `Help Scout denied permission for this operation (your user role may not allow it). No changes were made. ${detail}`;
    case 404:
      return 'Help Scout reports this record no longer exists (it may have been deleted or merged into another conversation). Local data was preserved.';
    case 409:
      return `Help Scout reported a conflict - the record changed on the server while we were working. Refresh the conversation and retry. ${detail}`;
    case 412:
      return 'Help Scout rejected this change because the conversation cannot currently accept another thread. No local changes were treated as successful.';
    case 413:
      return 'The request was too large (attachments or message size exceed Help Scout limits). Try smaller content.';
    case 415:
      return 'Help Scout did not accept the format of this request. No changes were made.';
    case 423:
      return 'Help Scout has this conversation locked (another process or user is acting on it right now). Try again in a moment.';
    case 429:
      return 'Help Scout rate limit reached. The operation will be retried automatically when the limit resets.';
    case 500:
      return 'Help Scout reported an internal error. The operation can be retried; no local data was changed.';
    case 503:
      return 'Help Scout is temporarily unavailable. The operation can be retried automatically.';
    case 504:
      return 'The request to Help Scout timed out. It may or may not have completed remotely - verify in Help Scout before retrying a send.';
    default:
      return `Help Scout returned status ${status}. ${detail}`;
  }
}

const RETRYABLE = new Set([429, 500, 503, 504]);
const PERMANENT = new Set([400, 401, 403, 404, 409, 412, 413, 415, 423]);

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  formBody?: Record<string, string>;
  priority?: ProviderPriority;
  rawResponse?: boolean;
  maxRetries?: number;
}

/**
 * HelpScoutHttpClient: single point for all Help Scout HTTP.
 * - Bearer token from the token store (auto-refresh on 401)
 * - Goes through the central ApiQueue (priority + rate limiting)
 * - Maps status codes to friendly errors, preserves correlation ids
 */
export class HelpScoutHttpClient {
  private apiBase: string;
  public limiter: RateLimiter;
  public queue: ApiQueue;
  private getToken: () => Promise<string | null>;
  private onAuthFailure: () => Promise<void>;
  /**
   * authMode 'bearer' (default): getToken returns an OAuth token, requests send
   * `Authorization: Bearer <token>` and a 401 triggers the refresh flow.
   * authMode 'header': getToken returns the COMPLETE Authorization header value
   * (e.g. `Basic <base64>`); used for the Docs API, which authenticates with a
   * separate Docs API key via HTTP Basic and has no refresh flow.
   */
  private authMode: 'bearer' | 'header';

  constructor(opts: {
    apiBase: string;
    db?: DB | null;
    concurrency?: number;
    getToken: () => Promise<string | null>;
    onAuthFailure: () => Promise<void>;
    authMode?: 'bearer' | 'header';
  }) {
    this.apiBase = opts.apiBase.replace(/\/$/, '');
    this.limiter = new RateLimiter(opts.db ?? null);
    this.queue = new ApiQueue(this.limiter, opts.concurrency ?? 2);
    this.getToken = opts.getToken;
    this.onAuthFailure = opts.onAuthFailure;
    this.authMode = opts.authMode ?? 'bearer';
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const isWrite = method !== 'GET';
    const priority = options.priority ?? (isWrite ? PRIORITY.INTERACTIVE : PRIORITY.SYNC);
    return this.queue.enqueue(priority, isWrite, () => this.attempt<T>(path, method, options, options.maxRetries ?? 3));
  }

  private async attempt<T>(path: string, method: NonNullable<RequestOptions['method']>, options: RequestOptions, retriesLeft: number): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const isWrite = method !== 'GET';
    let authorization: string | null;
    if (this.authMode === 'header') {
      authorization = await this.getToken(); // complete header value (Docs API Basic auth)
    } else {
      const token = await this.getToken();
      if (!token) {
        throw new HelpScoutApiError(401, 'No Help Scout token available', friendlyError(401, '', method), null, false);
      }
      authorization = `Bearer ${token}`;
    }
    const headers: Record<string, string> = { Authorization: authorization ?? '', Accept: 'application/json' };
    let bodyStr: string | undefined;
    if (options.formBody) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      bodyStr = new URLSearchParams(options.formBody).toString();
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: bodyStr, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (retriesLeft > 0 && (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('network'))) {
        await this.delay(1500);
        return this.attempt<T>(path, method, options, retriesLeft - 1);
      }
      throw new HelpScoutApiError(0, `Network error contacting Help Scout: ${msg}`, 'Help Scout is unreachable. Local data remains fully browsable - you are in offline mode for remote actions.', null, true);
    }

    this.limiter.recordResponse(res.headers, isWrite);
    const correlationId = res.headers.get('x-helpscout-correlation-id') ?? res.headers.get('x-correlation-id') ?? res.headers.get('x-request-id');

    // 301 = merged conversation: surface as special error with location
    if (res.status === 301) {
      const location = res.headers.get('location') ?? '';
      const newId = location.match(/conversations\/(\d+)/)?.[1];
      throw new HelpScoutApiError(301, `Conversation merged into ${newId ?? 'another conversation'}`, 'This conversation was merged into another conversation in Help Scout. Open the target conversation instead.', correlationId, false);
    }

    if (res.status === 401 && retriesLeft > 0 && this.authMode === 'bearer') {
      await this.onAuthFailure();
      const token = await this.getToken();
      if (token) {
        return this.attempt<T>(path, method, options, retriesLeft - 1);
      }
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('x-ratelimit-retry-after') ?? res.headers.get('retry-after') ?? '30', 10);
      this.limiter.recordError429(retryAfter);
      if (retriesLeft > 0) {
        await this.delay(Math.min(retryAfter, 60) * 1000 + 250);
        return this.attempt<T>(path, method, options, retriesLeft - 1);
      }
    }

    if (RETRYABLE.has(res.status) && retriesLeft > 0) {
      await this.delay(2000);
      return this.attempt<T>(path, method, options, retriesLeft - 1);
    }

    if (res.status === 204 || (res.status >= 200 && res.status < 300 && options.rawResponse)) {
      return (options.rawResponse ? res : undefined) as T;
    }

    if (res.status >= 200 && res.status < 300) {
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HelpScoutApiError(res.status, 'Invalid JSON from Help Scout', 'Help Scout returned an unexpected response format. The raw response was preserved for diagnostics.', correlationId, false);
      }
    }

    const body = await res.text();
    throw new HelpScoutApiError(res.status, `Help Scout ${method} ${path} -> ${res.status}: ${body.slice(0, 400)}`, friendlyError(res.status, body, method), correlationId, RETRYABLE.has(res.status) && !PERMANENT.has(res.status));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
