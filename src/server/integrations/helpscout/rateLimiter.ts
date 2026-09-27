import type { DB } from '../../database/connection.js';

export interface RateLimitState {
  limitPerMinute: number;
  remaining: number | null;
  retryAfterSec: number | null;
  updatedAt: string;
}

/**
 * Centralized account-wide rate limiter (spec #7).
 * Tracks Help Scout's documented headers:
 *   X-RateLimit-Limit-Minute / X-RateLimit-Remaining-Minute / X-RateLimit-Retry-After
 * Writes (POST/PUT/DELETE/PATCH) count as 2 requests toward the limit.
 */
export class RateLimiter {
  private state: RateLimitState;
  private sendTimestamps: number[] = [];
  private writeTimestamps: number[] = [];

  constructor(
    private db: DB | null = null,
    private defaultLimitPerMinute = 150
  ) {
    this.state = {
      limitPerMinute: defaultLimitPerMinute,
      remaining: null,
      retryAfterSec: null,
      updatedAt: new Date().toISOString()
    };
    if (db) this.load();
  }

  private load(): void {
    if (!this.db) return;
    try {
      const row = this.db.prepare("SELECT value FROM application_settings WHERE key='hs_rate_limit'").get() as { value: string } | undefined;
      if (row) this.state = { ...this.state, ...JSON.parse(row.value) };
    } catch {
      /* fresh state */
    }
  }

  private persist(): void {
    if (!this.db) return;
    try {
      this.db
        .prepare("INSERT INTO application_settings (key, value, updated_at) VALUES ('hs_rate_limit', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(this.state));
    } catch {
      /* non-fatal */
    }
  }

  recordResponse(headers: Headers, isWrite: boolean): void {
    const limit = headers.get('x-ratelimit-limit-minute');
    const remaining = headers.get('x-ratelimit-remaining-minute');
    const retryAfter = headers.get('x-ratelimit-retry-after');
    if (limit) this.state.limitPerMinute = parseInt(limit, 10) || this.state.limitPerMinute;
    this.state.remaining = remaining !== null ? parseInt(remaining, 10) : this.state.remaining;
    this.state.retryAfterSec = retryAfter !== null ? parseInt(retryAfter, 10) : null;
    this.state.updatedAt = new Date().toISOString();
    this.persist();
    const now = Date.now();
    if (isWrite) this.writeTimestamps.push(now);
    this.sendTimestamps.push(now);
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < 60_000);
    this.writeTimestamps = this.writeTimestamps.filter((t) => now - t < 60_000);
  }

  recordError429(retryAfterSec: number | null): void {
    this.state.retryAfterSec = retryAfterSec ?? 30;
    this.state.remaining = 0;
    this.state.updatedAt = new Date().toISOString();
    this.persist();
  }

  /** Milliseconds to wait before the next request may be sent (0 = go now). */
  waitTimeFor(isWrite: boolean): number {
    const now = Date.now();
    if (this.state.retryAfterSec && this.state.remaining === 0) {
      const resetAt = new Date(this.state.updatedAt).getTime() + this.state.retryAfterSec * 1000;
      if (resetAt > now) return resetAt - now + 250;
      this.state.retryAfterSec = null;
    }
    // Local conservative tracking: limit minus safety margin
    const effectiveLimit = Math.max(5, this.state.limitPerMinute - 5);
    const cost = isWrite ? 2 : 1;
    const projected = this.sendTimestamps.length + cost;
    if (projected > effectiveLimit) {
      const oldest = this.sendTimestamps[0] ?? now;
      const wait = 60_000 - (now - oldest) + 100;
      if (wait > 0) return wait;
    }
    return 0;
  }

  snapshot(): RateLimitState & { inFlightWindow: number } {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < 60_000);
    return { ...this.state, inFlightWindow: this.sendTimestamps.length };
  }
}
