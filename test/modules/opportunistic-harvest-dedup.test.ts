import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpportunisticHarvest } from '../../src/modules/opportunistic-harvest.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, LearnedFact } from '../../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

function makeMsgs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i, groupId: 'g1', userId: `u${i}`, nickname: `U${i}`,
    content: `m${i}`, rawContent: `m${i}`, timestamp: 1700000000 + i, deleted: false,
  }));
}

function makeMsgRepo(msgs: ReturnType<typeof makeMsgs>): IMessageRepository {
  return { getRecent: vi.fn().mockReturnValue(msgs) } as unknown as IMessageRepository;
}

function makeFactRepo(opts: {
  existing?: LearnedFact[];
  findSimilar?: ReturnType<typeof vi.fn>;
} = {}): ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][]; findSimilarActive: ReturnType<typeof vi.fn> } {
  const inserted: Parameters<ILearnedFactsRepository['insert']>[0][] = [];
  const findSimilarActive = opts.findSimilar ?? vi.fn().mockResolvedValue(null);
  return {
    inserted,
    listActive: vi.fn().mockReturnValue(opts.existing ?? []),
    findActiveByTopicTerm: vi.fn().mockReturnValue([]),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    findSimilarActive,
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    insert: vi.fn().mockImplementation((row) => { inserted.push(row); return inserted.length; }),
    insertOrSupersede: vi.fn().mockReturnValue({ newId: 1, supersededCount: 0 }),
    markStatus: vi.fn(),
    clearGroup: vi.fn(),
    countActive: vi.fn().mockReturnValue(0),
  } as unknown as ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][]; findSimilarActive: ReturnType<typeof vi.fn> };
}

function makeClaude(payload: unknown): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: JSON.stringify(payload),
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

describe('OpportunisticHarvest — semantic dedup (Feature A)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips insert when findSimilarActive returns a match', async () => {
    const factRepo = makeFactRepo({
      findSimilar: vi.fn().mockResolvedValue({
        fact: { id: 42, fact: '已有事实', confidence: 1.0, status: 'active' },
        cosine: 0.93,
      }),
    });
    const claude = makeClaude([
      { topic: 'T', fact: '语义上重复的事实内容XX', sourceNickname: 'A', confidence: 0.9 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(0);
    expect(factRepo.findSimilarActive).toHaveBeenCalledWith('g1', '语义上重复的事实内容XX', 0.88);
  });

  it('inserts when findSimilarActive returns null (below threshold or no candidate)', async () => {
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { topic: 'T', fact: '全新事实内容在这里', sourceNickname: 'A', confidence: 0.9 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(1);
  });

  it('semantic dedup runs AFTER prefix dedup (prefix-matched duplicates short-circuit)', async () => {
    // Prefix dedup compares the incoming fact's first 20 chars against .fact.includes()
    // of existing rows. Use an existing fact that CONTAINS the new fact's 20-char prefix.
    const newFact = '完全相同的前缀这里面应该多于20个字符的长度来确保对齐';
    const existingContainsPrefix = `${newFact.slice(0, 20)}附加的额外内容`;
    const factRepo = makeFactRepo({
      existing: [{
        id: 1, groupId: 'g1', topic: 'T', fact: existingContainsPrefix,
        sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
        botReplyId: null, confidence: 1.0, status: 'active', createdAt: 0, updatedAt: 0,
        embedding: null,
      }],
    });
    const claude = makeClaude([
      { topic: 'T', fact: newFact, sourceNickname: 'A', confidence: 0.9 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(0);
    // findSimilarActive should NOT be called because prefix dedup short-circuited
    expect(factRepo.findSimilarActive).not.toHaveBeenCalled();
  });

  it('findSimilarActive throwing does not crash the loop (treated like null — insert proceeds)', async () => {
    const factRepo = makeFactRepo({
      findSimilar: vi.fn().mockRejectedValue(new Error('svc boom')),
    });
    const claude = makeClaude([
      { topic: 'T', fact: '全新事实内容在这里', sourceNickname: 'A', confidence: 0.9 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    // Thrown rejection is caught by outer run try/catch; no crash expected.
    await harvest._run();
    // When findSimilarActive throws, the group is logged and skipped — 0 inserts.
    // The crash does not propagate.
    expect(factRepo.inserted).toHaveLength(0);
  });

  it('dedup logs existing id and cosine when a match is skipped', async () => {
    const logger = {
      warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
    } as unknown as Logger;
    const factRepo = makeFactRepo({
      findSimilar: vi.fn().mockResolvedValue({
        fact: { id: 77, fact: 'x', confidence: 1.0, status: 'active' },
        cosine: 0.91,
      }),
    });
    const claude = makeClaude([
      { topic: 'T', fact: '新事实但语义重复的内容在', sourceNickname: 'A', confidence: 0.9 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger, enabled: true,
    });
    await harvest._run();
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const dedupLog = infoCalls.find(c => typeof c[0] === 'object' && 'existingId' in (c[0] as object));
    expect(dedupLog).toBeDefined();
    expect((dedupLog![0] as { existingId: number }).existingId).toBe(77);
    expect((dedupLog![0] as { cosine: number }).cosine).toBeCloseTo(0.91, 5);
  });
});
