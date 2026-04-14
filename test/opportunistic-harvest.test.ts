import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpportunisticHarvest } from '../src/modules/opportunistic-harvest.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, LearnedFact } from '../src/storage/db.js';
import type { SelfLearningModule } from '../src/modules/self-learning.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

function makeMsgRepo(msgs: Array<{ nickname: string; content: string; timestamp: number; userId: string; groupId: string; id: number; rawContent: string; deleted: boolean }>): IMessageRepository {
  return {
    getRecent: vi.fn().mockReturnValue(msgs),
  } as unknown as IMessageRepository;
}

function makeFactRepo(existing: LearnedFact[] = []): ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] } {
  const inserted: Parameters<ILearnedFactsRepository['insert']>[0][] = [];
  return {
    inserted,
    listActive: vi.fn().mockReturnValue(existing),
    insert: vi.fn().mockImplementation((row) => { inserted.push(row); return inserted.length; }),
    markStatus: vi.fn(),
    clearGroup: vi.fn(),
    countActive: vi.fn().mockReturnValue(0),
  } as unknown as ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] };
}

function makeClaudeWith(response: string): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  } as unknown as IClaudeClient;
}

function makeRecentMsgs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i, groupId: 'g1', userId: `u${i}`, nickname: `User${i}`,
    content: `message ${i}`, rawContent: `message ${i}`,
    timestamp: 1700000000 + i, deleted: false,
  }));
}

const GROUP = 'g1';

describe('OpportunisticHarvest', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts 3 facts when Claude returns 3 valid items', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith(JSON.stringify([
      { category: '群友个人信息', topic: 'T1', fact: '事实A很重要', sourceNickname: 'Alice', confidence: 0.9 },
      { category: 'fandom 事实', topic: 'T2', fact: '事实B也重要', sourceNickname: 'Bob', confidence: 0.8 },
      { category: '群内梗', topic: 'T3', fact: '事实C同样重要', sourceNickname: 'Carol', confidence: 0.7 },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true, now: () => Date.now(),
    });

    await harvest._run();

    expect(factRepo.inserted).toHaveLength(3);
    expect(factRepo.inserted[0]!.fact).toBe('事实A很重要');
    expect(factRepo.inserted[0]!.sourceUserNickname).toBe('[harvest:Alice]');
    expect(factRepo.inserted[0]!.confidence).toBe(0.9);
    // topic should be prefixed with category
    expect(factRepo.inserted[0]!.topic).toContain('群友个人信息');
  });

  it('skips duplicate facts (same prefix already in DB)', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const dupeFact = 'Alice喜欢BanG Dream，最爱Poppin Party乐队的演出';
    const dupePrefix = dupeFact.slice(0, 20);
    const existingFact: LearnedFact = {
      id: 1, groupId: GROUP, topic: 'T1', fact: `${dupePrefix}这里已有记录了`,
      sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
      botReplyId: null, confidence: 1.0, status: 'active', createdAt: 0, updatedAt: 0,
    };
    const factRepo = makeFactRepo([existingFact]);
    const claude = makeClaudeWith(JSON.stringify([
      { topic: 'T1', fact: dupeFact, sourceNickname: 'Alice', confidence: 0.8 },
      { topic: 'T2', fact: '全新的事实B内容这里，Bob住在东京', sourceNickname: 'Bob', confidence: 0.9 },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(factRepo.inserted).toHaveLength(1);
    expect(factRepo.inserted[0]!.fact).toBe('全新的事实B内容这里，Bob住在东京');
  });

  it('inserts nothing when Claude returns empty array', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(factRepo.inserted).toHaveLength(0);
    expect(silentLogger.info).toHaveBeenCalledWith({ groupId: GROUP }, 'harvest: no facts extracted');
  });

  it('catches and logs Claude error without crashing', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = {
      complete: vi.fn().mockRejectedValue(new Error('network timeout')),
    } as unknown as IClaudeClient;

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await expect(harvest._run()).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
    expect(factRepo.inserted).toHaveLength(0);
  });

  it('start() is a no-op when enabled=false', () => {
    const msgRepo = makeMsgRepo([]);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: false,
    });

    harvest.start();
    expect((harvest as unknown as { timer: unknown }).timer).toBeNull();
    expect((harvest as unknown as { deepTimer: unknown }).deepTimer).toBeNull();
    harvest.dispose();
  });

  it('skips group when fewer than 8 new messages since last run', async () => {
    const now = vi.fn().mockReturnValueOnce(1700001000000);

    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith(JSON.stringify([
      { topic: 'T', fact: '新事实内容在这里', sourceNickname: 'X', confidence: 0.8 },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true, now,
    });

    // First run: all 15 msgs are new → inserts
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(1);

    // Second run: lastRunTs = 1700001000000ms > all msg timestamps → 0 new → skipped
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(1);
  });

  it('dispose() clears all intervals and timeouts', () => {
    const msgRepo = makeMsgRepo([]);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
      intervalMs: 50_000, deepIntervalMs: 100_000,
    });

    harvest.start();
    harvest.dispose();

    expect((harvest as unknown as { timer: unknown }).timer).toBeNull();
    expect((harvest as unknown as { firstTimer: unknown }).firstTimer).toBeNull();
    expect((harvest as unknown as { deepTimer: unknown }).deepTimer).toBeNull();
    expect((harvest as unknown as { deepFirstTimer: unknown }).deepFirstTimer).toBeNull();
  });

  it('prompt contains all 8 extraction category labels', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain('群友个人信息');
    expect(prompt).toContain('群友关系');
    expect(prompt).toContain('群内梗');
    expect(prompt).toContain('fandom 事实');
    expect(prompt).toContain('群友态度');
    expect(prompt).toContain('群文化');
    expect(prompt).toContain('新事件');
    expect(prompt).toContain('群友的纠正');
  });

  it('max facts limit is 12 in regular prompt', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain('最多 12 条');
  });

  it('window size defaults to 150 for regular cycle', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(msgRepo.getRecent).toHaveBeenCalledWith(GROUP, 150);
  });

  it('deep cycle uses 1000-message window and 30 max facts', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._runDeep();

    expect(msgRepo.getRecent).toHaveBeenCalledWith(GROUP, 1000);
    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain('最多 30 条');
    expect(prompt).toContain('反复出现 3+ 次');
  });

  it('deep cycle runs on its own independent timer', () => {
    const msgRepo = makeMsgRepo([]);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
      intervalMs: 50_000, deepIntervalMs: 200_000,
    });

    harvest.start();
    expect((harvest as unknown as { deepTimer: unknown }).deepTimer).not.toBeNull();
    expect((harvest as unknown as { deepFirstTimer: unknown }).deepFirstTimer).not.toBeNull();
    harvest.dispose();
  });

  it('log message after run contains insert/dedup counts and total active facts', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const dupeFact = 'Alice喜欢BanG Dream，已经存在的事实前缀';
    const dupePrefix = dupeFact.slice(0, 20);
    const existingFact: LearnedFact = {
      id: 1, groupId: GROUP, topic: 'existing', fact: `${dupePrefix}在库里`,
      sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
      botReplyId: null, confidence: 0.9, status: 'active', createdAt: 0, updatedAt: 0,
    };
    const factRepo = makeFactRepo([existingFact]);
    const claude = makeClaudeWith(JSON.stringify([
      { topic: 'new', fact: '全新的事实不重复的内容，详细描述', sourceNickname: 'A', confidence: 0.8 },
      { topic: 'dupe', fact: dupeFact, sourceNickname: 'B', confidence: 0.9 },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    // inserted=1, dedupped=1, totalActiveFacts=2 (1 existing + 1 new)
    const infoCalls = (silentLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const logCall = infoCalls.find(c => typeof c[0] === 'object' && 'inserted' in c[0]);
    expect(logCall).toBeDefined();
    expect(logCall![0].inserted).toBe(1);
    expect(logCall![0].dedupped).toBe(1);
    expect(logCall![0].totalActiveFacts).toBe(2);
  });
});

// ── Unknown-term auto-research ────────────────────────────────────────────────

describe('OpportunisticHarvest — unknown-term resolver', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeSelfLearning(researchResult = null as null | { factId: number; fact: string }): SelfLearningModule & { researchCalls: unknown[] } {
    const researchCalls: unknown[] = [];
    return {
      researchCalls,
      researchOnline: vi.fn().mockImplementation((params: unknown) => {
        researchCalls.push(params);
        return Promise.resolve(researchResult);
      }),
    } as unknown as SelfLearningModule & { researchCalls: unknown[] };
  }

  function makeClaudePair(termResponse: string, factResponse = '[]'): IClaudeClient {
    let callCount = 0;
    return {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        const text = callCount === 1 ? factResponse : termResponse;
        return Promise.resolve({ text, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
      }),
    } as unknown as IClaudeClient;
  }

  it('calls researchOnline once per unknown term (3 terms → 3 calls)', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const selfLearning = makeSelfLearning();
    const termsJson = JSON.stringify([
      { term: 'jtty', contextSentence: 'jtty 好看', guessedDomain: 'fandom' },
      { term: '渡瀬', contextSentence: '渡瀬真的不错', guessedDomain: 'fandom' },
      { term: '智械危机', contextSentence: '智械危机这首歌', guessedDomain: 'fandom' },
    ]);
    const claude = makeClaudePair(termsJson);

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      selfLearning, activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(selfLearning.researchCalls).toHaveLength(3);
    expect((selfLearning.researchCalls[0] as { topic: string }).topic).toBe('jtty');
  });

  it('skips term already researched in last 24h (in-memory dedup)', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const selfLearning = makeSelfLearning();
    const termsJson = JSON.stringify([
      { term: 'jtty', contextSentence: 'jtty 塌房了', guessedDomain: 'fandom' },
    ]);
    const claude = makeClaudePair(termsJson);

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      selfLearning, activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    // First run: researches jtty
    await harvest._run();
    expect(selfLearning.researchCalls).toHaveLength(1);

    // Second run: same term still in dedup map → skipped
    await harvest._run();
    expect(selfLearning.researchCalls).toHaveLength(1);
  });

  it('calls no researchOnline when Claude returns empty array', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const selfLearning = makeSelfLearning();
    const claude = makeClaudePair('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      selfLearning, activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(selfLearning.researchCalls).toHaveLength(0);
  });

  it('caps research at 3 terms per cycle even if Claude returns 4', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const selfLearning = makeSelfLearning();
    const termsJson = JSON.stringify([
      { term: 'term1', contextSentence: 'ctx1', guessedDomain: 'fandom' },
      { term: 'term2', contextSentence: 'ctx2', guessedDomain: 'fandom' },
      { term: 'term3', contextSentence: 'ctx3', guessedDomain: 'fandom' },
      { term: 'term4', contextSentence: 'ctx4', guessedDomain: 'fandom' },
    ]);
    const claude = makeClaudePair(termsJson);

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      selfLearning, activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(selfLearning.researchCalls).toHaveLength(3);
  });
});
