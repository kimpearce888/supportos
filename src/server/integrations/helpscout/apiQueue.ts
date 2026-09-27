import { RateLimiter } from './rateLimiter.js';
import type { ProviderPriority } from './provider.js';

export { RateLimiter };

interface QueueItem {
  priority: number;
  seq: number;
  isWrite: boolean;
  run: () => Promise<void>;
}

/**
 * Centralized API command queue (spec #7).
 * All Help Scout HTTP goes through here: priority ordered, rate-limited, bounded concurrency.
 * P0 = user sending a reply; P1 = interactive ops; P2 = sync; P3 = analytics; P4 = indexing.
 */
export class ApiQueue {
  private items: QueueItem[] = [];
  private seq = 0;
  private active = 0;
  private concurrency: number;
  private limiter: RateLimiter;
  private stats = { dispatched: 0, completed: 0, failed: 0, queueHighWater: 0 };
  private timer: NodeJS.Timeout | null = null;

  constructor(limiter: RateLimiter, concurrency = 2) {
    this.limiter = limiter;
    this.concurrency = concurrency;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    this.pump();
  }

  enqueue<T>(priority: ProviderPriority, isWrite: boolean, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        priority,
        seq: this.seq++,
        isWrite,
        run: async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        }
      });
      this.stats.queueHighWater = Math.max(this.stats.queueHighWater, this.items.length);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.items.length > 0) {
      this.items.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const item = this.items.shift()!;
      const wait = this.limiter.waitTimeFor(item.isWrite);
      if (wait > 0) {
        this.items.unshift(item);
        if (!this.timer) {
          this.timer = setTimeout(
            () => {
              this.timer = null;
              this.pump();
            },
            Math.min(wait, 5000)
          );
        }
        return;
      }
      this.active++;
      this.stats.dispatched++;
      void item
        .run()
        .then(() => {
          this.stats.completed++;
        })
        .catch(() => {
          this.stats.failed++;
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  statsSnapshot(): { queued: number; active: number; dispatched: number; completed: number; failed: number; highWater: number } {
    return { queued: this.items.length, active: this.active, dispatched: this.stats.dispatched, completed: this.stats.completed, failed: this.stats.failed, highWater: this.stats.queueHighWater };
  }
}
