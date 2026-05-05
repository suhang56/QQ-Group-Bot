import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { SelfLearningModule } from '../../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import { initLogger } from '../../src/utils/logger.js';

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

// Disabled embedder forces BM25-only retrieval — exactly the path the bug
// motivating this PR exercises. semanticEnabled=false in self-learning.ts.
function disabledEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(_text: string): Promise<number[]> { return []; },
    async waitReady(): Promise<void> {},
  };
}

function seedFact(db: Database, groupId: string, fact: string, canonical: string | null): number {
  return db.learnedFacts.insert({
    groupId,
    topic: null,
    fact,
    canonicalForm: canonical,
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    status: 'active',
  });
}

describe('SelfLearningModule formatFactsForPrompt — date-token expansion', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('I1: 618 query retrieves fact whose canonical text contains 6月18日', async () => {
    // Fact text uses canonical Chinese date form. FTS5 trigram tokenizer needs a
    // 3-char window, so the alternate "6月18日" hits via trigram overlap with
    // the doc; "6月" alone (2 chars) is below trigram floor and cannot match
    // standalone — that's why the fix needs the day-form alternates, not just
    // the month-only form.
    const seededId = seedFact(db, 'g1', '6月18日 Boot IGNITION live', '6月18日 Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '618附近有哪些live');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I2: 6/18 slash form retrieves the same canonical-date fact', async () => {
    const seededId = seedFact(db, 'g1', '6月18日 Boot IGNITION live', '6月18日 Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '6/18 live');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I3: non-date query baseline — BanG Dream fes still retrieves matching fact', async () => {
    const seededId = seedFact(db, 'g1', 'BanG Dream 7th Anniversary fes', 'BanG Dream 7th Anniversary fes');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, 'BanG Dream fes');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I4: query with no date and no overlap — date-fact NOT retrieved (no false positive)', async () => {
    seedFact(db, 'g1', '6月Boot IGNITION live', '6月Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    // '随便聊聊' has no overlap with '6月Boot IGNITION'. Expansion must not fire
    // (no date tokens), so retrieval depends purely on BM25 on the original.
    const result = await learner.formatFactsForPrompt('g1', 50, '随便聊聊');
    expect(result.matchedFactIds).toHaveLength(0);
  });

  it('I5: 12/31 retrieves fact stored as 12月31日跨年演唱会', async () => {
    const seededId = seedFact(db, 'g1', '12月31日跨年演唱会', '12月31日跨年演唱会');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '12/31 跨年');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I6: idempotence — query "6月18号 还有 6/19" with seeded 6月19日 fact retrieves it without 6/18 double-expansion', async () => {
    const seededId = seedFact(db, 'g1', '6月19日附加场', '6月19日附加场');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '6月18号 还有 6/19');
    expect(result.matchedFactIds).toContain(seededId);
  });
});
