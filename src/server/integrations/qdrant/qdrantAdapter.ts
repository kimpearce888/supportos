import { QDRANT_COLLECTION } from '../../../shared/constants.js';

export interface VectorPoint {
  id: number; // deterministic numeric id from entity mapping
  vector: number[];
  payload: {
    entity_type: 'conversation' | 'thread' | 'knowledge_chunk' | 'known_issue' | 'saved_reply' | 'support_case' | 'docs_chunk';
    entity_id: number;
    chunk_id?: number | null;
    title: string;
    text: string;
    visibility: 'customer_safe' | 'internal_only';
    embedding_model: string;
    index_version: number;
  };
}

export interface QdrantHealth {
  connected: boolean;
  url: string;
  collections: string[];
  error: string | null;
}

/**
 * Qdrant adapter for local vector search. Uses the documented REST API.
 * The application degrades gracefully to SQLite FTS when Qdrant is unavailable (spec #26).
 */
export class QdrantAdapter {
  private url: string;
  private enabled: boolean;
  private collection: string;
  private lastError: string | null = null;
  private connected = false;

  constructor(opts: { url: string; enabled: boolean; collection?: string }) {
    this.url = opts.url.replace(/\/$/, '');
    this.enabled = opts.enabled;
    this.collection = opts.collection ?? QDRANT_COLLECTION;
  }

  reconfigure(opts: { url?: string; enabled?: boolean }): void {
    if (opts.url !== undefined) this.url = opts.url.replace(/\/$/, '');
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Qdrant ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async health(): Promise<QdrantHealth> {
    if (!this.enabled) return { connected: false, url: this.url, collections: [], error: 'Qdrant disabled in settings' };
    try {
      const collections = await this.req<{ result: { name: string }[] }>('GET', '/collections');
      this.connected = true;
      this.lastError = null;
      return { connected: true, url: this.url, collections: collections.result.map((c) => c.name), error: null };
    } catch (e) {
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      return { connected: false, url: this.url, collections: [], error: this.lastError };
    }
  }

  async ensureCollection(dimension: number): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.req('PUT', `/collections/${this.collection}`, { vectors: { size: dimension, distance: 'Cosine' } });
      return true;
    } catch {
      return false;
    }
  }

  async upsert(points: VectorPoint[]): Promise<boolean> {
    if (!this.enabled || points.length === 0) return false;
    try {
      await this.req('POST', `/collections/${this.collection}/points?wait=true`, { points }, 30_000);
      return true;
    } catch {
      return false;
    }
  }

  async search(vector: number[], limit = 10, filter?: Record<string, unknown>): Promise<{ id: number; score: number; payload: VectorPoint['payload'] }[]> {
    if (!this.enabled) return [];
    try {
      const res = await this.req<{ result: { id: number; score: number; payload: VectorPoint['payload'] }[] }>(
        'POST',
        `/collections/${this.collection}/points/search`,
        { vector, limit, with_payload: true, filter }
      );
      return res.result;
    } catch {
      return [];
    }
  }

  async deleteByEntity(entityType: string, entityIds: number[]): Promise<boolean> {
    if (!this.enabled || entityIds.length === 0) return false;
    try {
      await this.req('POST', `/collections/${this.collection}/points/delete`, {
        filter: { must: [{ key: 'entity_type', match: { value: entityType } }, { key: 'entity_id', match: { any: entityIds } }] }
      });
      return true;
    } catch {
      return false;
    }
  }

  async countByEntity(entityType: string): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const res = await this.req<{ result: { count: number } }>('POST', `/collections/${this.collection}/points/count`, {
        filter: { must: [{ key: 'entity_type', match: { value: entityType } }] },
        exact: true
      });
      return res.result.count;
    } catch {
      return 0;
    }
  }

  async dropCollection(): Promise<boolean> {
    try {
      await this.req('DELETE', `/collections/${this.collection}`);
      return true;
    } catch {
      return false;
    }
  }

  snapshot(): { connected: boolean; url: string; collection: string; enabled: boolean; lastError: string | null } {
    return { connected: this.connected, url: this.url, collection: this.collection, enabled: this.enabled, lastError: this.lastError };
  }
}
