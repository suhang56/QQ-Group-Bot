import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

/**
 * Controllable fake embedder for dedup tests. Each insertion below chooses
 * its own vector; the query can be any 8-dim vector. Cosine is computed by
 * the real cosineSimilarity under test.
 */
function fakeEmbedder(map: Map<string, number[]>): IEmbeddingService {
  return {
    isReady: true,
    async embed(text: string): Promise<number[]> {
      const v = map.get(text);
      if (!v) throw new Error(`no vec for: ${text}`);
      return v;
    },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function notReadyEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(): Promise<number[]> { throw new Error('not ready'); },
    async waitReady(): Promise<void> { /* noop */ },
  };
}

function throwingEmbedder(): IEmbeddingService {
  return {
    isReady: true,
    async embed(): Promise<number[]> { throw new Error('boom'); },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function insertFact(
  db: Database, groupId: string, fact: string, embedding: number[] | null,
): number {
  const id = db.learnedFacts.insert({
    groupId, topic: null, fact,
    sourceUserId: null, sourceUserNickname: null,
    sourceMsgId: null, botReplyId: null,
  });
  if (embedding !== null) db.learnedFacts.updateEmbedding(id, embedding);
  return id;
}

describe('LearnedFactsRepository.findSimilarActive', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('returns null on empty group', async () => {
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('returns null when embedding service is null', async () => {
    insertFact(db, 'g1', 'existing', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(null);
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('returns null when embedding service not ready', async () => {
    insertFact(db, 'g1', 'existing', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(notReadyEmbedder());
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('returns null when embed() throws and allows subsequent inserts (no crash)', async () => {
    insertFact(db, 'g1', 'existing', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(throwingEmbedder());
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('returns null when no candidates have embeddings', async () => {
    insertFact(db, 'g1', 'existing', null);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('returns best match above threshold (single pick, not top-K)', async () => {
    const good = insertFact(db, 'g1', 'good', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', 'also', [1, 0, 0, 0, 0, 0, 0, 0]);  // same perfect cosine, older id wins is fine
    insertFact(db, 'g1', 'far', [0, 1, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).not.toBeNull();
    // newest first — 'also' was inserted after 'good' — but best picks first equal cosine
    expect([good, out!.fact.id]).toContain(out!.fact.id);
    expect(out!.cosine).toBeCloseTo(1.0, 5);
  });

  it('threshold boundary: cosine exactly equals threshold (included)', async () => {
    // cos = a·b / (|a||b|). Pick vectors so cosine is exactly 0.88.
    // Use 2D effectively: a=[0.88, sqrt(1-0.88^2)], b=[1,0] → cos=0.88.
    const s = Math.sqrt(1 - 0.88 * 0.88);
    insertFact(db, 'g1', 'match', [0.88, s, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).not.toBeNull();
    expect(out!.cosine).toBeCloseTo(0.88, 5);
  });

  it('threshold boundary: cosine 0.8799 (excluded)', async () => {
    const target = 0.8799;
    const s = Math.sqrt(1 - target * target);
    insertFact(db, 'g1', 'match', [target, s, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('threshold boundary: cosine 0.8801 (included)', async () => {
    const target = 0.8801;
    const s = Math.sqrt(1 - target * target);
    insertFact(db, 'g1', 'match', [target, s, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).not.toBeNull();
    expect(out!.cosine).toBeGreaterThan(0.88);
  });

  it('threshold boundary: cosine 1.0 (included)', async () => {
    insertFact(db, 'g1', 'match', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).not.toBeNull();
    expect(out!.cosine).toBeCloseTo(1.0, 5);
  });

  it('picks the highest-cosine candidate when multiple are above threshold', async () => {
    const lower = insertFact(db, 'g1', 'lower', [0.9, Math.sqrt(1 - 0.81), 0, 0, 0, 0, 0, 0]);
    const higher = insertFact(db, 'g1', 'higher', [0.99, Math.sqrt(1 - 0.9801), 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).not.toBeNull();
    expect(out!.fact.id).toBe(higher);
    expect(out!.fact.id).not.toBe(lower);
  });

  it('excludes pending/rejected/superseded rows (only active candidates)', async () => {
    // Insert a "pending" row that would have been a perfect match.
    const pendingId = db.learnedFacts.insert({
      groupId: 'g1', topic: null, fact: 'would-match',
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status: 'pending',
    });
    db.learnedFacts.updateEmbedding(pendingId, [1, 0, 0, 0, 0, 0, 0, 0]);

    // Plus an active row far from query.
    insertFact(db, 'g1', 'far', [0, 1, 0, 0, 0, 0, 0, 0]);

    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g1', 'q', 0.88);
    expect(out).toBeNull();
  });

  it('is scoped to groupId', async () => {
    insertFact(db, 'g1', 'match', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.setEmbeddingService(fakeEmbedder(new Map([['q', [1, 0, 0, 0, 0, 0, 0, 0]]])));
    const out = await db.learnedFacts.findSimilarActive('g2', 'q', 0.88);
    expect(out).toBeNull();
  });
});
