import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function stubClaude(): IClaudeClient {
  return {
    async complete(): Promise<ClaudeResponse> {
      return { text: '{"found": false}', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function insertFact(db: Database, groupId: string, fact: string, confidence = 1.0): number {
  return db.learnedFacts.insert({
    groupId, topic: null, fact,
    sourceUserId: null, sourceUserNickname: null,
    sourceMsgId: null, botReplyId: null,
    confidence,
  });
}

describe('SelfLearningModule.handleTopLevelCorrection', () => {
  let db: Database;
  let learner: SelfLearningModule;
  let markStatusSpy: ReturnType<typeof vi.spyOn>;
  let researchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = makeDb();
    learner = new SelfLearningModule({ db, claude: stubClaude() });
    markStatusSpy = vi.spyOn(db.learnedFacts, 'markStatus');
    // researchOnline is async but handleTopLevelCorrection fires it with `void`
    researchSpy = vi.spyOn(learner, 'researchOnline').mockResolvedValue(null);
  });

  it('negation + referent + matching injection → facts rejected + research fired', () => {
    const f1 = insertFact(db, 'g1', 'fire bird 是 RAS 的曲');
    const f2 = insertFact(db, 'g1', '另一个错误事实');
    learner.rememberInjection('g1', 42, [f1, f2]);

    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是 fire bird 是 Roselia 的',
      priorBotReply: { id: 42, content: 'fire bird 是 RAS 唱的', trigger: 'fire bird 谁唱的' },
    });

    expect(markStatusSpy).toHaveBeenCalledWith(f1, 'rejected');
    expect(markStatusSpy).toHaveBeenCalledWith(f2, 'rejected');
    expect(researchSpy).toHaveBeenCalledWith({
      groupId: 'g1',
      evasiveBotReplyId: 42,
      originalTrigger: 'fire bird 谁唱的',
    });
  });

  it('negation without referent → no-op (no rejection, no research)', () => {
    const f1 = insertFact(db, 'g1', 'some fact');
    learner.rememberInjection('g1', 42, [f1]);

    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是 完全不相关的话题',
      priorBotReply: { id: 42, content: 'fire bird 是 RAS 唱的', trigger: 'fire bird 谁唱的' },
    });

    expect(markStatusSpy).not.toHaveBeenCalled();
    expect(researchSpy).not.toHaveBeenCalled();
  });

  it('referent present but no negation marker → no-op', () => {
    const f1 = insertFact(db, 'g1', 'some fact');
    learner.rememberInjection('g1', 42, [f1]);

    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: 'fire bird 好听',
      priorBotReply: { id: 42, content: 'fire bird 是 RAS 唱的', trigger: 'fire bird 谁唱的' },
    });

    expect(markStatusSpy).not.toHaveBeenCalled();
    expect(researchSpy).not.toHaveBeenCalled();
  });

  it('no prior bot reply → no-op', () => {
    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是 fire bird',
      priorBotReply: null,
    });

    expect(markStatusSpy).not.toHaveBeenCalled();
    expect(researchSpy).not.toHaveBeenCalled();
  });

  it('prior reply id does not match injectionMemory → research still fires, no rejection', () => {
    const f1 = insertFact(db, 'g1', 'some fact');
    learner.rememberInjection('g1', 99, [f1]); // memory for a different reply

    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是 fire bird 吧',
      priorBotReply: { id: 42, content: 'fire bird 是 RAS 唱的', trigger: 'fire bird 谁唱的' },
    });

    expect(markStatusSpy).not.toHaveBeenCalled();
    expect(researchSpy).toHaveBeenCalledWith({
      groupId: 'g1',
      evasiveBotReplyId: 42,
      originalTrigger: 'fire bird 谁唱的',
    });
  });

  it('injectionMemory evicts oldest when exceeding 200 entries', () => {
    // Seed 201 different groups; the first should be evicted.
    for (let i = 0; i < 201; i++) {
      learner.rememberInjection(`g${i}`, i, [i * 10]);
    }
    // `g0` was inserted first; after 201 entries it should be gone.
    // Exercise via handleTopLevelCorrection: attempt on g0 should not reject
    // (memory missing) but research still fires because priorBotReply exists.
    const f = insertFact(db, 'g0', 'seed');
    // Note: g0's original fact id is not in the db any more; we only test
    // that markStatus is NOT called for the originally-remembered id.
    learner.handleTopLevelCorrection({
      groupId: 'g0',
      content: '不是 seed 吧',
      priorBotReply: { id: 0, content: 'seed', trigger: 't' },
    });

    expect(markStatusSpy).not.toHaveBeenCalledWith(0, 'rejected');
    // An unrelated sanity check — a late group still has its entry.
    const privateMem = (learner as unknown as { injectionMemory: Map<string, unknown> }).injectionMemory;
    expect(privateMem.has('g200')).toBe(true);
    expect(privateMem.has('g0')).toBe(false);
    // Reference the inserted fact to keep it live for the linter.
    expect(f).toBeGreaterThan(0);
  });

  it('rememberInjection overwrites prior entry for the same groupId', () => {
    const f1 = insertFact(db, 'g1', 'first');
    const f2 = insertFact(db, 'g1', 'second');
    learner.rememberInjection('g1', 1, [f1]);
    learner.rememberInjection('g1', 2, [f2]);

    // Correction targeting the new reply (id=2) should reject only f2.
    learner.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是 second 吧',
      priorBotReply: { id: 2, content: 'second', trigger: 't' },
    });
    expect(markStatusSpy).toHaveBeenCalledWith(f2, 'rejected');
    expect(markStatusSpy).not.toHaveBeenCalledWith(f1, 'rejected');
  });
});
