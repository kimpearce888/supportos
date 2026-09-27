import { describe, it, expect } from 'vitest';
import { friendlyError } from '../../src/server/integrations/helpscout/client.js';
import { RateLimiter } from '../../src/server/integrations/helpscout/rateLimiter.js';
import { ApiQueue } from '../../src/server/integrations/helpscout/apiQueue.js';

describe('friendly error mapping (spec #68, #89)', () => {
  it('412 has a human explanation, never raw "HTTP 412"', () => {
    const msg = friendlyError(412, '', 'POST');
    expect(msg).toContain('cannot currently accept another thread');
    expect(msg).toContain('No local changes were treated as successful');
  });
  it('429 explains automatic retry', () => {
    expect(friendlyError(429, '', 'GET')).toContain('rate limit');
  });
  it('401 points to reconnect', () => {
    expect(friendlyError(401, '', 'GET')).toContain('Re-connect Help Scout');
  });
  it('404 explains merge/deletion possibility', () => {
    expect(friendlyError(404, '', 'GET')).toContain('deleted or merged');
  });
  it('504 warns about uncertain delivery for sends', () => {
    expect(friendlyError(504, '', 'POST')).toContain('may or may not have completed');
  });
});

describe('rate limiter (spec #7)', () => {
  it('tracks documented headers', () => {
    const rl = new RateLimiter(null, 100);
    const headers = new Headers({ 'x-ratelimit-limit-minute': '200', 'x-ratelimit-remaining-minute': '150' });
    rl.recordResponse(headers, false);
    const snap = rl.snapshot();
    expect(snap.limitPerMinute).toBe(200);
    expect(snap.remaining).toBe(150);
  });
  it('honors retry-after after a 429', () => {
    const rl = new RateLimiter(null, 100);
    rl.recordError429(30);
    expect(rl.waitTimeFor(false)).toBeGreaterThan(0);
  });
  it('waits when approaching the conservative local limit', () => {
    const rl = new RateLimiter(null, 20); // low limit for testing
    // simulate 16 requests in the window (limit - safety margin = 15)
    for (let i = 0; i < 16; i++) rl.recordResponse(new Headers(), false);
    expect(rl.waitTimeFor(false)).toBeGreaterThan(0);
  });
});

describe('API command queue priority (spec #7)', () => {
  it('executes P0 (user reply) before P4 (background indexing) even when queued later', async () => {
    const rl = new RateLimiter(null, 1000);
    const queue = new ApiQueue(rl, 1);
    const order: string[] = [];
    const slow = queue.enqueue(2, false, () => new Promise<void>((r) => setTimeout(() => { order.push('sync'); r(); }, 30)));
    const indexing = queue.enqueue(4, false, () => new Promise<void>((r) => { order.push('indexing'); r(); }));
    const reply = queue.enqueue(0, true, () => new Promise<void>((r) => { order.push('reply'); r(); }));
    await Promise.all([slow, indexing, reply]);
    expect(order[0]).toBe('sync'); // already claimed
    expect(order[1]).toBe('reply'); // P0 beats P4
    expect(order[2]).toBe('indexing');
  });
});
