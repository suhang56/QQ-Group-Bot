import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function stubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function stubEmbedder(vec: number[]): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { return vec; },
    async waitReady(): Promise<void> {},
  };
}

describe('hybrid-retrieval (BM25 + vector RRF)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function insertFact(
    groupId: string,
    fact: string,
    canonicalForm: string | null,
    personaForm: string | null,
    confidence = 1.0,
  ): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      canonicalForm, personaForm,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      confidence,
    });
  }

  it('legacy-shape row (canonical=NULL, persona=NULL) retrieves via fact column and injects fact text', async () => {
    // Legacy row: canonical_form + persona_form both null. BM25 falls back to
    // fact-column FTS; _renderFacts falls back to fact-column text. Query uses
    // an ASCII token (trigram tokenizer handles >=3 char substrings in any script).
    const id = insertFact('g1', '群梗 fire bird 意思', null, null, 1.0);

    // BM25 hits via fact column
    const bm25 = db.learnedFacts.searchByBM25('g1', 'fire bird', 10);
    expect(bm25.length).toBe(1);
    expect(bm25[0]!.id).toBe(id);

    // _renderFacts path: empty-trigger → recency fallback which also calls _renderFacts
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 10, '');
    expect(out.text).toContain('群梗 fire bird');
    expect(out.factIds).toEqual([id]);
  });

  it('empty vector DB + populated BM25 returns BM25-only RRF results', async () => {
    // No embeddings stored on rows — listActiveWithEmbeddings returns [].
    // BM25 branch still finds matches; RRF degrades to BM25-only. Hybrid
    // formatFactsForPrompt must not crash and must surface the BM25 hits.
    // Contiguous CJK + 3+ char query so trigram tokenizer produces tokens.
    const a = insertFact('g1', 'RAS fact', 'RAS是一个乐队', 'RAS就是乐队啦', 1.0);
    const b = insertFact('g1', 'Roselia fact', 'Roselia是另一个乐队', 'Roselia嘛另一个乐队', 1.0);

    const embedder = stubEmbedder([0.1, 0.2, 0.3]);
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: embedder,
    });

    // Trigger matches both via BM25 keyword `一个乐队`; neither row has embedding_vec
    // so vector list is empty. Hybrid must still return them.
    const out = await learner.formatFactsForPrompt('g1', 10, '一个乐队');
    expect(out.factIds.length).toBeGreaterThanOrEqual(2);
    expect(out.factIds).toEqual(expect.arrayContaining([a, b]));
    // Persona text ('啦' / '嘛') should appear since personaForm preferred for injection
    expect(out.text).toMatch(/就是乐队啦|嘛另一个乐队/);
  });

  it('RRF debug log records per-source contributions with topContributions', async () => {
    insertFact('g1', 'fire bird is Roselia song', 'fire bird 是 Roselia 的曲', null, 1.0);
    insertFact('g1', 'fact two', '另一个 事实', null, 1.0);

    // Spy on the logger the module uses. The module pulls its logger via the
    // optional `logger` option; inject a pino-compatible stub we can inspect.
    const debugSpy = vi.fn();
    const warnSpy = vi.fn();
    const logger = {
      debug: debugSpy,
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => logger,
      level: 'debug',
    } as unknown as Parameters<typeof SelfLearningModule.prototype.constructor>[0]['logger'];

    const embedder = stubEmbedder([0.1, 0.2, 0.3]);
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: embedder,
      logger: logger as import('pino').Logger,
    });

    await learner.formatFactsForPrompt('g1', 10, 'Roselia');

    // Confirm the hybrid-path debug line fired at least once with topContributions
    const hybridLogCall = debugSpy.mock.calls.find(
      call => typeof call[1] === 'string' && call[1].includes('hybrid BM25+vector RRF'),
    );
    expect(hybridLogCall).toBeDefined();
    const payload = hybridLogCall![0] as { topContributions?: Array<{ id: number; score: number; sources: number[] }> };
    expect(payload.topContributions).toBeDefined();
    expect(Array.isArray(payload.topContributions)).toBe(true);
    // Top contribution should reference at least one source-list index
    if (payload.topContributions!.length > 0) {
      expect(payload.topContributions![0]!.sources.length).toBeGreaterThanOrEqual(1);
    }
  });
});
