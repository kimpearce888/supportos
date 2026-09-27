/**
 * Semantic docs search helpers (v1.4.0): pure functions for the hybrid layer.
 *
 * Design decisions:
 * - Cosine similarity over stored Float32 embeddings gives semantic search
 *   EVEN WITHOUT Qdrant (embeddings are persisted locally in docs_chunks,
 *   mirroring the knowledge_chunks fallback). When Qdrant is up, it serves the
 *   same vectors with ANN speed; when it is down, we scan locally - a docs
 *   mirror is small enough that a linear scan is milliseconds.
 * - Hybrid merge uses Reciprocal Rank Fusion (RRF): rank-based, score-scale
 *   free, so FTS ranks and cosine scores never need to be normalized against
 *   each other. Provenencce is preserved: every hit records WHICH retrievers
 *   found it ('fts', 'semantic') so the UI can label it honestly.
 */

export interface FtsDocHit {
  articleId: number;
  /** FTS rank position, 0-based, ascending relevance. */
  rank: number;
}

export interface SemanticDocHit {
  articleId: number;
  /** cosine similarity, typically -1..1 (higher = closer). */
  score: number;
}

export interface MergedDocHit {
  articleId: number;
  /** RRF fused score; comparable across retrievers, NOT a cosine value. */
  score: number;
  why: ('fts' | 'semantic')[];
}

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion of FTS + semantic result lists.
 *
 * Both retrievers contribute RANK-based scores only (1 / (RRF_K + rank + 1)):
 * FTS ranks and cosine scores live on incommensurable scales, so mixing raw
 * cosine into the fused score would silently let one retriever dominate.
 * The semantic list is expected pre-sorted by similarity (its rank IS the
 * signal); provenance is preserved per hit in `why`.
 */
export function mergeDocHits(fts: FtsDocHit[], semantic: SemanticDocHit[], limit: number): MergedDocHit[] {
  const scores = new Map<number, { s: number; why: Set<'fts' | 'semantic'> }>();
  fts.forEach((h, i) => {
    const cur = scores.get(h.articleId) ?? { s: 0, why: new Set<'fts' | 'semantic'>() };
    cur.s += 1 / (RRF_K + i + 1);
    cur.why.add('fts');
    scores.set(h.articleId, cur);
  });
  semantic.forEach((h, i) => {
    const cur = scores.get(h.articleId) ?? { s: 0, why: new Set<'fts' | 'semantic'>() };
    cur.s += 1 / (RRF_K + i + 1);
    cur.why.add('semantic');
    scores.set(h.articleId, cur);
  });
  return [...scores.entries()]
    .map(([articleId, v]) => ({ articleId, score: Math.round(v.s * 10000) / 10000, why: [...v.why] }))
    .sort((a, b) => b.score - a.score || a.articleId - b.articleId)
    .slice(0, limit);
}

/** Cosine similarity of two equal-length vectors (0 when lengths mismatch). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Build a query embedding context string: title + text keep chunks self-describing. */
export function chunkContext(title: string, text: string): string {
  return `${title}\n\n${text}`;
}
