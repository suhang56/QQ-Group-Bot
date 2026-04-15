import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { runFactEmbeddingBackfill } from '../src/modules/fact-embedding-backfill.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const logger = createLogger('test');

function fixedEmbedder(value = [0.1, 0.2, 0.3, 0.4]): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { return value.slice(); },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function notReadyEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(_text: string): Promise<number[]> { throw new Error('nope'); },
    async waitReady(): Promise<void> { /* noop */ },
  };
}

function failingEmbedder(): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { throw new Error('boom'); },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function insertNullFact(db: Database, groupId: string, fact: string): number {
  return db.learnedFacts.insert({
    groupId, topic: null, fact,
    sourceUserId: null, sourceUserNickname: null,
    sourceMsgId: null, botReplyId: null,
  });
}

describe('runFactEmbeddingBackfill', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('fills NULL embeddings for every active fact', async () => {
    for (let i = 0; i < 10; i++) insertNullFact(db, 'g1', `fact ${i}`);
    const before = db.learnedFacts.listActiveWithEmbeddings('g1');
    expect(before).toHaveLength(0);

    const result = await runFactEmbeddingBackfill(db, fixedEmbedder(), logger);
    expect(result.filled).toBe(10);
    expect(result.failed).toBe(0);

    const after = db.learnedFacts.listActiveWithEmbeddings('g1');
    expect(after).toHaveLength(10);
    for (const f of after) {
      expect(f.embedding).not.toBeNull();
      expect(f.embedding!).toHaveLength(4);
      expect(f.embedding![0]!).toBeCloseTo(0.1, 5);
      expect(f.embedding![1]!).toBeCloseTo(0.2, 5);
      expect(f.embedding![2]!).toBeCloseTo(0.3, 5);
      expect(f.embedding![3]!).toBeCloseTo(0.4, 5);
    }
  });

  it('handles empty DB (no facts) without error', async () => {
    const result = await runFactEmbeddingBackfill(db, fixedEmbedder(), logger);
    expect(result).toEqual({ filled: 0, failed: 0 });
  });

  it('skips run when embedding service is not ready', async () => {
    insertNullFact(db, 'g1', 'fact');
    const result = await runFactEmbeddingBackfill(db, notReadyEmbedder(), logger);
    expect(result).toEqual({ filled: 0, failed: 0 });
    expect(db.learnedFacts.listActiveWithEmbeddings('g1')).toHaveLength(0);
  });

  it('records per-row failures and continues without infinite-looping', async () => {
    insertNullFact(db, 'g1', 'fact A');
    insertNullFact(db, 'g1', 'fact B');
    const result = await runFactEmbeddingBackfill(db, failingEmbedder(), logger);
    expect(result.filled).toBe(0);
    expect(result.failed).toBe(2);
  });

  it('skips facts whose embedding is already populated', async () => {
    const id = insertNullFact(db, 'g1', 'has emb');
    db.learnedFacts.updateEmbedding(id, [9, 9, 9, 9]);
    insertNullFact(db, 'g1', 'no emb');
    const result = await runFactEmbeddingBackfill(db, fixedEmbedder([1, 1, 1, 1]), logger);
    expect(result.filled).toBe(1);
    const all = db.learnedFacts.listActiveWithEmbeddings('g1');
    const preserved = all.find(f => f.id === id);
    expect(preserved?.embedding).toHaveLength(4);
    expect(preserved!.embedding![0]!).toBeCloseTo(9, 5);
  });

  it('only touches active facts, not rejected/superseded ones', async () => {
    const a = insertNullFact(db, 'g1', 'active');
    const b = insertNullFact(db, 'g1', 'rejected');
    db.learnedFacts.markStatus(b, 'rejected');
    await runFactEmbeddingBackfill(db, fixedEmbedder(), logger);
    const active = db.learnedFacts.listActiveWithEmbeddings('g1');
    expect(active.map(f => f.id)).toEqual([a]);
  });
});
