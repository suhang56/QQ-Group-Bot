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

function makeFactRepo(existing: LearnedFact[] = []): ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] } {
  const inserted: Parameters<ILearnedFactsRepository['insert']>[0][] = [];
  return {
    inserted,
    listActive: vi.fn().mockReturnValue(existing),
    findActiveByTopicTerm: vi.fn().mockReturnValue([]),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    findSimilarActive: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    insert: vi.fn().mockImplementation((row) => { inserted.push(row); return inserted.length; }),
    insertOrSupersede: vi.fn().mockReturnValue({ newId: 1, supersededCount: 0 }),
    markStatus: vi.fn(),
    clearGroup: vi.fn(),
    countActive: vi.fn().mockReturnValue(0),
  } as unknown as ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] };
}

function makeClaude(payload: unknown): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: JSON.stringify(payload),
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

describe('OpportunisticHarvest — pending queue (Feature B)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts low-confidence rows with status="pending"', async () => {
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { topic: 'T', fact: '全新事实A长度够格的内容', sourceNickname: 'A', confidence: 0.7 },
      { topic: 'T', fact: '全新事实B长度够格的内容', sourceNickname: 'B', confidence: 0.75 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(2);
    for (const row of factRepo.inserted) {
      expect(row.status).toBe('pending');
    }
  });

  it('UR-H: high-confidence rows also land as pending (auto-activate removed)', async () => {
    // UR-H security hardening: the pending-queue isolation gate only holds
    // if every harvested row actually lands pending. Auto-activating rows
    // with confidence >= 0.85 let an adversarial sample with a confident
    // LLM score bypass human approval and inject directly into chat via
    // formatFactsForPrompt (which filters status='active').
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { topic: 'T', fact: '高置信度事实A内容示例足够长', sourceNickname: 'A', confidence: 0.9 },
      { topic: 'T', fact: '低置信度事实B内容示例足够长', sourceNickname: 'B', confidence: 0.5 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted).toHaveLength(2);
    expect(factRepo.inserted[0]!.status).toBe('pending');
    expect(factRepo.inserted[1]!.status).toBe('pending');
  });

  it('preserves LLM confidence unchanged (no 0.5 cap)', async () => {
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { topic: 'T', fact: '高置信度事实内容在这里啊', sourceNickname: 'A', confidence: 0.95 },
      { topic: 'T', fact: '中等置信度事实内容在这', sourceNickname: 'B', confidence: 0.7 },
      { topic: 'T', fact: '低置信度事实内容在这里A', sourceNickname: 'C', confidence: 0.3 },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted.map(r => r.confidence)).toEqual([0.95, 0.7, 0.3]);
  });

  it('defaults confidence to 0.7 when LLM omits it', async () => {
    const factRepo = makeFactRepo();
    const claude = makeClaude([
      { topic: 'T', fact: '无置信度的事实内容在这里', sourceNickname: 'A' },
    ]);
    const harvest = new OpportunisticHarvest({
      messages: makeMsgRepo(makeMsgs(15)), learnedFacts: factRepo,
      claude, activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });
    await harvest._run();
    expect(factRepo.inserted[0]!.confidence).toBe(0.7);
    expect(factRepo.inserted[0]!.status).toBe('pending');
  });
});
