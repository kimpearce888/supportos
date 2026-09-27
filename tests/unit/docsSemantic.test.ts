import { describe, it, expect } from 'vitest';
import { mergeDocHits, cosineSimilarity, chunkContext } from '../../src/server/search/docsSemantic.js';

/**
 * v1.4.0 semantic docs search: RRF fusion + cosine helpers. These pure
 * functions decide result ordering and provenance labels, so they get their
 * own deterministic unit tests (no model, no database).
 */
describe('mergeDocHits (Reciprocal Rank Fusion)', () => {
  it('ranks an article found by BOTH retrievers above single-retriever hits', () => {
    const merged = mergeDocHits(
      [{ articleId: 1, rank: 0 }, { articleId: 2, rank: 1 }],
      [{ articleId: 3, score: 0.98 }, { articleId: 1, score: 0.71 }],
      10
    );
    expect(merged[0]?.articleId).toBe(1); // found by fts AND semantic
    const article1 = merged.find((m) => m.articleId === 1);
    expect(article1?.why).toEqual(expect.arrayContaining(['fts', 'semantic']));
    expect(new Set(article1?.why).size).toBe(2);
  });

  it('includes semantic-only and fts-only articles with honest why labels', () => {
    const merged = mergeDocHits([{ articleId: 5, rank: 0 }], [{ articleId: 7, score: 0.5 }], 10);
    const ftsOnly = merged.find((m) => m.articleId === 5);
    const semOnly = merged.find((m) => m.articleId === 7);
    expect(ftsOnly?.why).toEqual(['fts']);
    expect(semOnly?.why).toEqual(['semantic']);
  });

  it('respects the limit', () => {
    const fts = [1, 2, 3, 4, 5].map((articleId, rank) => ({ articleId, rank }));
    const merged = mergeDocHits(fts, [], 3);
    expect(merged.length).toBe(3);
  });

  it('is deterministic for equal inputs (stable tiebreak by article id)', () => {
    const a = mergeDocHits([{ articleId: 9, rank: 0 }], [], 5);
    const b = mergeDocHits([{ articleId: 9, rank: 0 }], [], 5);
    expect(a).toEqual(b);
  });

  it('empty retrievers yield empty results', () => {
    expect(mergeDocHits([], [], 10)).toEqual([]);
  });
});

describe('cosineSimilarity', () => {
  it('identical vectors score 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('orthogonal vectors score 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('opposite vectors score -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('zero-length or mismatched vectors score 0 instead of throwing', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('works on Float32Array views of stored buffers (the local fallback path)', () => {
    const stored = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    const view = new Float32Array(stored.buffer, stored.byteOffset, stored.byteLength / 4);
    expect(cosineSimilarity([0.1, 0.2, 0.3], view)).toBeCloseTo(1, 5);
  });
});

describe('chunkContext', () => {
  it('keeps the title inside the chunk so vectors stay self-describing', () => {
    expect(chunkContext('Refunds', 'We refund within 30 days.')).toContain('Refunds');
    expect(chunkContext('Refunds', 'We refund within 30 days.')).toContain('30 days');
  });
});
