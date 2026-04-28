import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AliasMiner } from '../../src/modules/alias-miner.js';
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
} = {}): ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insertOrSupersede']>[0][]; findSimilarActive: ReturnType<typeof vi.fn> } {
  const inserted: Parameters<ILearnedFactsRepository['insertOrSupersede']>[0][] = [];
  const findSimilarActive = opts.findSimilar ?? vi.fn().mockResolvedValue(null);
  return {
    inserted,
    listActive: vi.fn().mockReturnValue(opts.existing ?? []),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    findSimilarActive,
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    insert: vi.fn().mockImplementation(() => 0),
    insertOrSupersede: vi.fn().mockImplementation((row) => {
      inserted.push(row);
      return { newId: inserted.length, supersededCount: 0 };
    }),
    markStatus: vi.fn(),
    clearGroup: vi.fn(),
    countActive: vi.fn().mockReturnValue(0),
  } as unknown as ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insertOrSupersede']>[0][]; findSimilarActive: ReturnType<typeof vi.fn> };
}

function makeClaude(payload: unknown): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: JSON.stringify(payload),
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

describe('AliasMiner — semantic dedup + pending queue', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips alias insert on semantic dedup hit', async () => {
    const msgs = makeMsgs(60);
    const factRepo = makeFactRepo({
      findSimilar: vi.fn().mockResolvedValue({
        fact: { id: 10, fact: 'x', confidence: 1.0, status: 'active' },
        cosine: 0.95,
      }),
    });
    const claude = makeClaude([
      { alias: '拉神', realUserNickname: 'U5', realUserId: 'u5', evidence: '群友直接叫他' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepo(msgs), learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await miner._run();
    expect(factRepo.inserted).toHaveLength(0);
    expect(factRepo.findSimilarActive).toHaveBeenCalled();
    // threshold constant should be 0.88 (independent of harvest but same initial value)
    expect(factRepo.findSimilarActive).toHaveBeenCalledWith('g1', expect.any(String), 0.88);
  });

  it('inserts alias with status="pending" and default confidence 0.8', async () => {
    const msgs = makeMsgs(60);
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { alias: '拉神', realUserNickname: 'U5', realUserId: 'u5', evidence: '群友直接叫他拉神' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepo(msgs), learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await miner._run();
    expect(factRepo.inserted).toHaveLength(1);
    expect(factRepo.inserted[0]!.status).toBe('pending');
    expect(factRepo.inserted[0]!.confidence).toBe(0.8);
  });

  it('honors LLM-supplied confidence when present (not capped to 0.5)', async () => {
    const msgs = makeMsgs(60);
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { alias: 'X', realUserNickname: 'U5', realUserId: 'u5', evidence: 'e', confidence: 0.95 },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepo(msgs), learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await miner._run();
    expect(factRepo.inserted[0]!.confidence).toBe(0.95);
  });

  it('prefix-based dupe check still skips before semantic dedup runs', async () => {
    const msgs = makeMsgs(60);
    const existingFact: LearnedFact = {
      id: 1, groupId: 'g1', topic: '群友别名:拉神',
      fact: '拉神 = U5 (QQ u5)。其它evidence内容',
      sourceUserId: null, sourceUserNickname: '[alias-miner]', sourceMsgId: null,
      botReplyId: null, confidence: 0.8, status: 'active', createdAt: 0, updatedAt: 0,
      embedding: null,
    };
    const factRepo = makeFactRepo({ existing: [existingFact] });
    const claude = makeClaude([
      { alias: '拉神', realUserNickname: 'U5', realUserId: 'u5', evidence: '新证据不一样' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepo(msgs), learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await miner._run();
    expect(factRepo.inserted).toHaveLength(0);
    // Prefix dupe short-circuit: findSimilarActive should NOT have been called
    expect(factRepo.findSimilarActive).not.toHaveBeenCalled();
  });

  it('findSimilarActive null → insert proceeds', async () => {
    const msgs = makeMsgs(60);
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { alias: '新外号', realUserNickname: 'U5', realUserId: 'u5', evidence: '新' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepo(msgs), learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await miner._run();
    expect(factRepo.inserted).toHaveLength(1);
  });
});
