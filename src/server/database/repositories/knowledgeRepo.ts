import type { DB } from '../connection.js';
import {  } from './helpers.js';
import crypto from 'node:crypto';
import type { KnowledgeDocument, KnowledgeSource } from '../../../shared/types.js';
import { chunkText } from '../../../shared/utils.js';

/** Knowledge sources/documents/chunks with FTS maintenance. */
export class KnowledgeRepository {
  constructor(private db: DB) {}

  createSource(name: string, kind: 'local_file' | 'manual' | 'import', visibility: 'customer_safe' | 'internal_only'): number {
    const r = this.db.prepare('INSERT INTO knowledge_sources (name, kind, visibility) VALUES (?, ?, ?)').run(name, kind, visibility);
    return Number(r.lastInsertRowid);
  }

  getSource(name: string): KnowledgeSource | undefined {
    return (this.db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.visibility, s.created_at,
           (SELECT COUNT(*) FROM knowledge_documents d WHERE d.source_id = s.id) AS document_count
         FROM knowledge_sources s WHERE s.name = ?`
      )
      .get(name) as KnowledgeSource | undefined);
  }

  listSources(): KnowledgeSource[] {
    return this.db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.visibility, s.created_at,
           (SELECT COUNT(*) FROM knowledge_documents d WHERE d.source_id = s.id) AS document_count
         FROM knowledge_sources s ORDER BY s.name`
      )
      .all() as KnowledgeSource[];
  }

  /** Insert or update a document; returns (document_id, changed). */
  upsertDocument(sourceId: number, title: string, content: string, opts: { visibility: 'customer_safe' | 'internal_only'; format?: string; checksum?: string }): { id: number; changed: boolean } {
    const checksum = opts.checksum ?? crypto.createHash('sha256').update(content).digest('hex');
    const existing = this.db.prepare('SELECT id, checksum, version FROM knowledge_documents WHERE source_id = ? AND title = ?').get(sourceId, title) as { id: number; checksum: string | null; version: number } | undefined;
    if (existing && existing.checksum === checksum) {
      return { id: existing.id, changed: false };
    }
    let docId = existing?.id ?? 0;
    // chunk + FTS. The whole insert-or-replace path is atomic: a crash
    // mid-update previously left a document with deleted chunks and no FTS rows.
    const chunks = chunkText(content, 1200, 150);
    const insChunk = this.db.prepare('INSERT INTO knowledge_chunks (document_id, chunk_index, content, chunk_version) VALUES (?, ?, ?, 2)');
    const insFts = this.db.prepare('INSERT INTO fts_knowledge (title, content, chunk_id, document_id, visibility) VALUES (?, ?, ?, ?, ?)');
    const tx = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare("UPDATE knowledge_documents SET version = version + 1, checksum = ?, content = ?, format = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?")
          .run(checksum, content, opts.format ?? 'markdown', opts.visibility, existing.id);
        this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(existing.id);
        this.db.prepare('DELETE FROM fts_knowledge WHERE document_id = ?').run(existing.id);
      } else {
        const r = this.db
          .prepare('INSERT INTO knowledge_documents (source_id, title, visibility, version, checksum, content, format) VALUES (?, ?, ?, 1, ?, ?, ?)')
          .run(sourceId, title, opts.visibility, checksum, content, opts.format ?? 'markdown');
        docId = Number(r.lastInsertRowid);
      }
      chunks.forEach((c, i) => {
        const r = insChunk.run(docId, i, c);
        insFts.run(title, c, Number(r.lastInsertRowid), docId, opts.visibility);
      });
      this.db.prepare("UPDATE knowledge_documents SET last_indexed_at = datetime('now') WHERE id = ?").run(docId);
    });
    tx();
    return { id: docId, changed: true };
  }

  listDocuments(sourceId?: number): KnowledgeDocument[] {
    const rows = sourceId
      ? (this.db.prepare('SELECT * FROM knowledge_documents WHERE source_id = ? ORDER BY title').all(sourceId) as (KnowledgeDocument & { content: string })[])
      : (this.db.prepare('SELECT * FROM knowledge_documents ORDER BY title').all() as (KnowledgeDocument & { content: string })[]);
    return rows.map((r) => ({ ...r, content_preview: (r.content ?? '').slice(0, 200), chunk_count: (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE document_id = ?').get(r.id) as { n: number }).n }));
  }

  getDocument(id: number): (KnowledgeDocument & { content: string; source_name: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT d.*, s.name AS source_name,
           (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM knowledge_documents d JOIN knowledge_sources s ON s.id = d.source_id WHERE d.id = ?`
      )
      .get(id) as (KnowledgeDocument & { content: string; source_name: string; content_preview?: string; chunk_count?: number }) | undefined;
    if (!row) return undefined;
    return { ...row, content_preview: (row.content ?? '').slice(0, 200) };
  }

  searchKnowledge(query: string, visibility?: 'customer_safe' | 'internal_only'): { chunk_id: number; document_id: number; title: string; snippet: string; visibility: string }[] {
    const ftsQuery = query
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .slice(0, 8)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!ftsQuery) return [];
    const vis = visibility ? 'AND f.visibility = ?' : '';
    const rows = this.db
      .prepare(
        `SELECT f.chunk_id, f.document_id, f.title, snippet(fts_knowledge, 1, '[', ']', '…', 12) AS snippet, f.visibility
         FROM fts_knowledge f WHERE fts_knowledge MATCH ? ${vis} ORDER BY rank LIMIT 25`
      )
      .all(...(visibility ? [ftsQuery, visibility] : [ftsQuery])) as { chunk_id: number; document_id: number; title: string; snippet: string; visibility: string }[];
    return rows;
  }

  getChunkContent(chunkId: number): { document_id: number; content: string; visibility: string; title: string } | undefined {
    return this.db
      .prepare(
        `SELECT c.document_id, c.content, d.visibility, d.title FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE c.id = ?`
      )
      .get(chunkId) as { document_id: number; content: string; visibility: string; title: string } | undefined;
  }

  listChunksNeedingEmbedding(limit = 100): { id: number; document_id: number; content: string; visibility: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, c.content, d.visibility, d.title
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.embedding_state = 'not_indexed' OR c.embedding_state = 'failed' LIMIT ?`
      )
      .all(limit) as { id: number; document_id: number; content: string; visibility: string; title: string }[];
  }

  setChunkEmbeddingState(chunkId: number, state: string, model?: string | null): void {
    this.db.prepare('UPDATE knowledge_chunks SET embedding_state = ?, embedding_model = COALESCE(?, embedding_model) WHERE id = ?').run(state, model ?? null, chunkId);
  }

  updateChunkEmbedding(chunkId: number, model: string | null, embedding: Float32Array | null, state: string): void {
    this.db.prepare('UPDATE knowledge_chunks SET embedding = ?, embedding_model = ?, embedding_state = ? WHERE id = ?').run(embedding ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null, model, state, chunkId);
  }

  countIndexed(): { conversations_indexed: number; chunks_indexed: number; chunks_pending: number; chunks_failed: number } {
    const r = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM threads WHERE embedding_state='indexed') AS conv_threads_indexed,
          (SELECT COUNT(*) FROM knowledge_chunks WHERE embedding_state='indexed') AS chunks_indexed,
          (SELECT COUNT(*) FROM knowledge_chunks WHERE embedding_state IN ('not_indexed','queued')) AS chunks_pending,
          (SELECT COUNT(*) FROM knowledge_chunks WHERE embedding_state='failed') AS chunks_failed`
      )
      .get() as { conv_threads_indexed: number; chunks_indexed: number; chunks_pending: number; chunks_failed: number };
    return { conversations_indexed: r.conv_threads_indexed ?? 0, chunks_indexed: r.chunks_indexed ?? 0, chunks_pending: r.chunks_pending ?? 0, chunks_failed: r.chunks_failed ?? 0 };
  }

  deleteDocument(id: number): void {
    // Atomic: a crash mid-sequence previously left orphaned FTS rows that kept
    // matching searches for a deleted document.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM fts_knowledge WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id);
    })();
  }
}
