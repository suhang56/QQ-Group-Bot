import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpportunisticHarvest } from '../src/modules/opportunistic-harvest.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, LearnedFact } from '../src/storage/db.js';
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
      { topic: 'T1', fact: '事实A很重要', sourceNickname: 'Alice' },
      { topic: 'T2', fact: '事实B也重要', sourceNickname: 'Bob' },
      { topic: 'T3', fact: '事实C同样重要', sourceNickname: 'Carol' },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true, now: () => Date.now(),
    });

    await harvest._run();

    expect(factRepo.inserted).toHaveLength(3);
    expect(factRepo.inserted[0]!.fact).toBe('事实A很重要');
    expect(factRepo.inserted[0]!.sourceUserNickname).toBe('[harvest:Alice]');
    expect(factRepo.inserted[0]!.confidence).toBe(0.7);
  });

  it('skips duplicate facts (same prefix already in DB)', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    // The dupe check: existing.fact.includes(newFact.slice(0, 20))
    // Make existing fact contain the first 20 chars of the duplicate new fact
    const dupeFact = 'Alice喜欢BanG Dream，最爱Poppin Party乐队的演出';
    const dupePrefix = dupeFact.slice(0, 20); // 'Alice喜欢BanG Dream，最'
    const existingFact: LearnedFact = {
      id: 1, groupId: GROUP, topic: 'T1', fact: `${dupePrefix}这里已有记录了`,
      sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
      botReplyId: null, confidence: 1.0, status: 'active', createdAt: 0, updatedAt: 0,
    };
    const factRepo = makeFactRepo([existingFact]);
    const claude = makeClaudeWith(JSON.stringify([
      { topic: 'T1', fact: dupeFact, sourceNickname: 'Alice' },
      { topic: 'T2', fact: '全新的事实B内容这里，Bob住在东京', sourceNickname: 'Bob' },
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
    // Access private timer via bracket notation for test
    expect((harvest as unknown as { timer: unknown }).timer).toBeNull();
    harvest.dispose();
  });

  it('skips group when fewer than 10 new messages since last run', async () => {
    let callCount = 0;
    const now = vi.fn().mockImplementation(() => {
      callCount++;
      // First call returns base time; second returns +5s (same hour)
      return callCount === 1 ? 1700000000000 : 1700000005000;
    });

    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith(JSON.stringify([
      { topic: 'T', fact: '新事实内容在这里', sourceNickname: 'X' },
    ]));

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true, now,
    });

    // First run: all 15 msgs are new (lastRunTs=0) → inserts
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(1);

    // Second run: msgs timestamps (1700000000+i seconds) → *1000 ms ≈ 1700000000000ms
    // lastRunTs is now 1700000005000ms, messages at ~1700000000000ms → older → 0 new msgs
    await harvest._run();
    // Should be skipped, no additional inserts
    expect(factRepo.inserted).toHaveLength(1);
  });

  it('dispose() clears interval so no further runs occur', async () => {
    const msgs = makeRecentMsgs(15);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
      intervalMs: 50_000,
    });

    harvest.start();
    harvest.dispose();

    expect((harvest as unknown as { timer: unknown }).timer).toBeNull();
    expect((harvest as unknown as { firstTimer: unknown }).firstTimer).toBeNull();
  });
});
