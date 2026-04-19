import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function stubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

/**
 * Deterministic 8-dim embedder. Each axis is a topic; a text maps to a unit
 * vector on the first matching axis. Cosine similarity is therefore 1.0 for
 * same-axis pairs and 0.0 for different-axis pairs — exact by construction.
 *
 * Axis 0: 有利息 / 遠藤 / endo
 * Axis 1: fire bird / roselia
 * Axis 2: 天气 / weather
 * Axis 3: noise
 * Axis 4: relevant (legacy "old relevant" seed)
 * Axis 5: new noise
 * Axis 6: null fact
 * Axis 7: catch-all
 */
function fakeEmbedder(): IEmbeddingService {
  const lookup = (text: string): number[] => {
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    if (text.includes('有利息') || text.includes('遠藤') || text.includes('endo')) v[0] = 1;
    else if (text.includes('fire bird') || text.includes('roselia') || text.includes('Roselia')) v[1] = 1;
    else if (text.includes('天气') || text.includes('weather')) v[2] = 1;
    else if (text.includes('noise')) v[3] = 1;
    else if (text.includes('relevant')) v[4] = 1;
    else v[7] = 1;
    return v;
  };
  return {
    isReady: true,
    async embed(text: string): Promise<number[]> { return lookup(text); },
    async waitReady(): Promise<void> { /* always ready */ },
  };
}

function notReadyEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(_text: string): Promise<number[]> { throw new Error('not ready'); },
    async waitReady(): Promise<void> { /* noop */ },
  };
}

function throwingEmbedder(): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { throw new Error('boom'); },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function insertFact(
  db: Database,
  groupId: string,
  fact: string,
  embedding: number[] | null,
  confidence = 1.0,
): number {
  const id = db.learnedFacts.insert({
    groupId, topic: null, fact,
    sourceUserId: null, sourceUserNickname: null,
    sourceMsgId: null, botReplyId: null,
    confidence,
  });
  if (embedding !== null) db.learnedFacts.updateEmbedding(id, embedding);
  return id;
}

describe('SelfLearningModule.formatFactsForPrompt — semantic retrieval', () => {
  let db: Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { delete process.env['FACTS_RAG_DISABLED']; });

  it('semantic top-K: starved fact (older than pinned window) is recovered by similarity', async () => {
    // Insert the high-relevance target FIRST (oldest), then bury it under
    // 30 unrelated newer facts so the pinned-newest-5 window cannot save it.
    // Recency-only would have dropped it; semantic must lift it back into the result.
    const target = insertFact(db, 'g1', '有利息是 遠藤ゆりか', [1, 0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 30; i++) {
      insertFact(db, 'g1', `weather ${i}`, [0, 0, 1, 0, 0, 0, 0, 0]);
    }
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });

    // limit=15 → 5 pinned (newest weather) + similarity → target survives
    const out = await learner.formatFactsForPrompt('g1', 15, '有利息是谁');
    expect(out.injectedFactIds).toContain(target);
    expect(out.text).toContain('遠藤ゆりか');
  });

  it('hedge/lowconf facts excluded even when semantically perfect', async () => {
    insertFact(db, 'g1', '有利息可能是某个角色', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', '有利息可能与某乐队相关', [1, 0, 0, 0, 0, 0, 0, 0], 0.5);
    const clean = insertFact(db, 'g1', '有利息是 遠藤ゆりか', [1, 0, 0, 0, 0, 0, 0, 0]);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 10, '有利息是谁');
    expect(out.injectedFactIds).toEqual([clean]);
  });

  it('similarity below 0.30 floor → fact dropped (unless pinned)', async () => {
    // 12 noise facts. Trigger embeds to axis 0 → cosine = 0 with axis-3 noise.
    // PINNED_NEWEST_K = 5, so exactly the 5 newest survive.
    for (let i = 0; i < 12; i++) {
      insertFact(db, 'g1', `noise ${i}`, [0, 0, 0, 1, 0, 0, 0, 0]);
    }
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '有利息是谁');
    expect(out.injectedFactIds).toHaveLength(5);
  });

  it('pinned-newest-K holds: 5 newest are always kept regardless of score', async () => {
    // Insert 5 high-relevance facts (axis 0) then 5 unrelated newer facts.
    for (let i = 0; i < 5; i++) {
      insertFact(db, 'g1', `old relevant 有利息 ${i}`, [1, 0, 0, 0, 0, 0, 0, 0]);
    }
    const newIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      newIds.push(insertFact(db, 'g1', `new noise ${i}`, [0, 0, 0, 1, 0, 0, 0, 0]));
    }
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 10, '有利息是谁');
    // All 5 newest noise facts should be pinned in.
    for (const id of newIds) expect(out.injectedFactIds).toContain(id);
  });

  it('kill switch FACTS_RAG_DISABLED=1 → recency fallback path', async () => {
    process.env['FACTS_RAG_DISABLED'] = '1';
    insertFact(db, 'g1', 'oldest', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', 'middle', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', 'newest', [0, 0, 0, 1, 0, 0, 0, 0]);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '有利息是谁');
    expect(out.injectedFactIds).toHaveLength(3);
    expect(out.text).toContain('newest');
    expect(out.text).toContain('middle');
    expect(out.text).toContain('oldest');
  });

  it('embedding service not ready → recency fallback', async () => {
    insertFact(db, 'g1', 'fact A', null);
    insertFact(db, 'g1', 'fact B', null);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: notReadyEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, 'whatever');
    expect(out.injectedFactIds).toHaveLength(2);
  });

  it('embedding service throws on trigger embed → recency fallback', async () => {
    insertFact(db, 'g1', 'fact A', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', 'fact B', [1, 0, 0, 0, 0, 0, 0, 0]);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: throwingEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '有利息是谁');
    expect(out.injectedFactIds).toHaveLength(2);
  });

  it('empty group → empty result', async () => {
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('empty', 50, '有利息是谁');
    expect(out).toEqual(expect.objectContaining({ text: '', injectedFactIds: [] }));
  });

  it('empty trigger text → recency fallback (semantic disabled when no trigger)', async () => {
    insertFact(db, 'g1', 'fact A', [1, 0, 0, 0, 0, 0, 0, 0]);
    insertFact(db, 'g1', 'fact B', [0, 0, 0, 1, 0, 0, 0, 0]);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '');
    expect(out.injectedFactIds).toHaveLength(2);
  });

  it('rejected facts excluded from semantic retrieval', async () => {
    const a = insertFact(db, 'g1', '有利息是 X', [1, 0, 0, 0, 0, 0, 0, 0]);
    const b = insertFact(db, 'g1', '有利息是 遠藤', [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.markStatus(a, 'rejected');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: fakeEmbedder(),
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '有利息是谁');
    expect(out.injectedFactIds).toEqual([b]);
  });

  it('null embeddingService at construction → recency fallback', async () => {
    insertFact(db, 'g1', '有利息是 遠藤', [1, 0, 0, 0, 0, 0, 0, 0]);
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: null,
    });
    const out = await learner.formatFactsForPrompt('g1', 50, '有利息是谁');
    expect(out.injectedFactIds).toHaveLength(1);
  });
});
