import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function stubClaude(replies: string[]): IClaudeClient {
  let i = 0;
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      const text = replies[Math.min(i, replies.length - 1)] ?? '';
      i++;
      return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function failingClaude(): IClaudeClient {
  return {
    async complete(): Promise<ClaudeResponse> { throw new Error('boom'); },
    async describeImage(): Promise<string> { return ''; },
  };
}

function seedBotReply(db: Database, groupId: string, trigger: string, reply: string): number {
  const row = db.botReplies.insert({
    groupId,
    triggerMsgId: 'm-trigger',
    triggerUserNickname: 'asker',
    triggerContent: trigger,
    botReply: reply,
    module: 'chat',
    sentAt: nowSec(),
  });
  return row.id;
}

describe('SelfLearningModule.detectCorrection', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('inserts a learned fact for a clean correction', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'fire bird 谁唱的', 'RAS 唱的吧');
    const claude = stubClaude([
      JSON.stringify({ isCorrection: true, wrongFact: 'RAS', correctFact: 'fire bird 是 Roselia 的曲', topic: 'roselia 曲目' }),
    ]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 RAS 是 Roselia', userId: 'u1', nickname: 'sino', messageId: 'm1' },
    });

    expect(result).not.toBeNull();
    expect(result!.fact).toBe('fire bird 是 Roselia 的曲');
    const facts = db.learnedFacts.listActive('g1', 10);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.sourceUserNickname).toBe('sino');
    expect(facts[0]!.botReplyId).toBe(botReplyId);
  });

  it('skips when the correction comes from the bot itself', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude([JSON.stringify({ isCorrection: true, correctFact: 'z' })]);
    const learner = new SelfLearningModule({ db, claude, botUserId: 'BOT' });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 RAS 是 Roselia', userId: 'BOT', nickname: 'bot', messageId: 'm1' },
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('skips when content is too short', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude([JSON.stringify({ isCorrection: true, correctFact: 'z' })]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不', userId: 'u1', nickname: 'sino', messageId: 'm1' },
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('rate-limits after 5 corrections per group within 10 minutes', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude(Array(10).fill(
      JSON.stringify({ isCorrection: true, correctFact: 'fact' }),
    ));
    const learner = new SelfLearningModule({ db, claude });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await learner.detectCorrection({
        groupId: 'g1',
        botReplyId,
        correctionMsg: { content: `不是 X 是 Y${i}`, userId: 'u', nickname: 'n', messageId: `m${i}` },
      }));
    }
    const accepted = results.filter(r => r !== null);
    expect(accepted).toHaveLength(5);
    expect(results[5]).toBeNull();
  });

  it('skips when Claude returns isCorrection:false', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude([JSON.stringify({ isCorrection: false })]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y', userId: 'u', nickname: 'n', messageId: 'm' },
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('skips on malformed JSON without crashing', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude(['not actually json {{']);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y', userId: 'u', nickname: 'n', messageId: 'm' },
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('skips when content does not match any correction pattern', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude([JSON.stringify({ isCorrection: true, correctFact: 'z' })]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '哈哈哈哈哈', userId: 'u', nickname: 'n', messageId: 'm' },
    });

    expect(result).toBeNull();
  });

  it('skips when Claude throws', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const learner = new SelfLearningModule({ db, claude: failingClaude() });

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y', userId: 'u', nickname: 'n', messageId: 'm' },
    });

    expect(result).toBeNull();
  });
});

describe('SelfLearningModule.harvestPassiveKnowledge', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('inserts a learned fact when followups contain the answer', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'fire bird 谁唱的', '忘了');
    db.botReplies.markEvasive(botReplyId);
    const claude = stubClaude([
      JSON.stringify({ hasAnswer: true, answer: 'fire bird 是 Roselia 的', topic: 'roselia' }),
    ]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.harvestPassiveKnowledge({
      groupId: 'g1',
      evasiveBotReplyId: botReplyId,
      originalTrigger: 'fire bird 谁唱的',
      followups: [
        { nickname: 'sino', content: '是 roselia 的吧', userId: 'u1', messageId: 'm1' },
        { nickname: 'ykn', content: '对就是 roselia', userId: 'u2', messageId: 'm2' },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.fact).toBe('fire bird 是 Roselia 的');
    const facts = db.learnedFacts.listActive('g1', 10);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.sourceUserNickname).toBe('sino,ykn');
  });

  it('returns null and inserts nothing when followups are irrelevant', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const claude = stubClaude([JSON.stringify({ hasAnswer: false })]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.harvestPassiveKnowledge({
      groupId: 'g1',
      evasiveBotReplyId: botReplyId,
      originalTrigger: 'x',
      followups: [{ nickname: 'a', content: '今天吃啥', userId: 'u', messageId: 'm' }],
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('returns null on empty followup list without calling Claude', async () => {
    const botReplyId = seedBotReply(db, 'g1', 'x', 'y');
    const completeSpy = vi.fn();
    const claude: IClaudeClient = {
      complete: completeSpy as unknown as IClaudeClient['complete'],
      async describeImage() { return ''; },
    };
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.harvestPassiveKnowledge({
      groupId: 'g1',
      evasiveBotReplyId: botReplyId,
      originalTrigger: 'x',
      followups: [],
    });

    expect(result).toBeNull();
    expect(completeSpy).not.toHaveBeenCalled();
  });
});

describe('SelfLearningModule.formatFactsForPrompt', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function insertFact(groupId: string, fact: string, nickname: string | null): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      sourceUserId: null, sourceUserNickname: nickname,
      sourceMsgId: null, botReplyId: null,
    });
  }

  it('returns a formatted markdown block with 3 active facts', () => {
    insertFact('g1', 'fact A', 'sino');
    insertFact('g1', 'fact B', 'ykn');
    insertFact('g1', 'fact C', null);
    const learner = new SelfLearningModule({ db, claude: stubClaude([]) });

    const out = learner.formatFactsForPrompt('g1', 50);
    expect(out).toContain('群里学到的事实');
    expect(out).toContain('fact A');
    expect(out).toContain('fact B');
    expect(out).toContain('fact C');
    expect(out).toContain('被 sino 纠正过');
    expect(out).toContain('被 ykn 纠正过');
  });

  it('returns empty string when group has no active facts', () => {
    const learner = new SelfLearningModule({ db, claude: stubClaude([]) });
    expect(learner.formatFactsForPrompt('empty-group', 50)).toBe('');
  });

  it('excludes rejected facts and lists only active ones', () => {
    const a = insertFact('g1', 'fact A', 'sino');
    insertFact('g1', 'fact B', 'ykn');
    insertFact('g1', 'fact C', 'tk');
    db.learnedFacts.markStatus(a, 'rejected');

    const learner = new SelfLearningModule({ db, claude: stubClaude([]) });
    const out = learner.formatFactsForPrompt('g1', 50);
    expect(out).not.toContain('fact A');
    expect(out).toContain('fact B');
    expect(out).toContain('fact C');
  });
});

describe('SelfLearningModule.researchOnline', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function seedEvasive(groupId: string): number {
    const reply = db.botReplies.insert({
      groupId, triggerMsgId: 't1', triggerUserNickname: 'a',
      triggerContent: 'fire bird 谁唱的', botReply: '忘了',
      module: 'chat', sentAt: Math.floor(Date.now() / 1000),
    });
    db.botReplies.markEvasive(reply.id);
    return reply.id;
  }

  it('inserts a learned fact when web search returns a high-confidence answer', async () => {
    const claude = stubClaude([
      JSON.stringify({ found: true, fact: 'fire bird 是 Roselia 的曲', source: 'bandori.fandom.com', confidence: 0.9 }),
    ]);
    const learner = new SelfLearningModule({ db, claude });
    const evasiveId = seedEvasive('g1');

    const result = await learner.researchOnline({
      groupId: 'g1',
      evasiveBotReplyId: evasiveId,
      originalTrigger: 'fire bird 是谁唱的',
    });

    expect(result).not.toBeNull();
    expect(result!.fact).toBe('fire bird 是 Roselia 的曲');

    const facts = db.learnedFacts.listActive('g1', 10);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.sourceUserNickname).toBe('[online:bandori.fandom.com]');
    expect(facts[0]!.botReplyId).toBe(evasiveId);
    expect(facts[0]!.confidence).toBeCloseTo(0.9);
  });

  it('drops answers with confidence below 0.6', async () => {
    const claude = stubClaude([
      JSON.stringify({ found: true, fact: 'maybe Roselia', source: 'reddit.com', confidence: 0.4 }),
    ]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('returns null when web search reports found:false', async () => {
    const claude = stubClaude([JSON.stringify({ found: false })]);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('blocks personal-info probes without calling Claude', async () => {
    const completeSpy = vi.fn();
    const claude: IClaudeClient = {
      complete: completeSpy as unknown as IClaudeClient['complete'],
      async describeImage() { return ''; },
    };
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: '你电话是多少',
    });

    expect(result).toBeNull();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('rate-limits per-group after 3 successful calls in 10 minutes', async () => {
    const ok = JSON.stringify({ found: true, fact: 'x', source: 'wiki', confidence: 0.9 });
    const claude = stubClaude([ok, ok, ok, ok, ok]);
    const completeSpy = vi.spyOn(claude, 'complete');
    const learner = new SelfLearningModule({ db, claude });
    const evasiveId = seedEvasive('g1');

    for (let i = 0; i < 4; i++) {
      await learner.researchOnline({
        groupId: 'g1', evasiveBotReplyId: evasiveId, originalTrigger: `fire bird q${i}`,
      });
    }

    expect(completeSpy).toHaveBeenCalledTimes(3);
  });

  it('rate-limits globally after researchMaxPerDayGlobal hits across groups', async () => {
    const ok = JSON.stringify({ found: true, fact: 'x', source: 'wiki', confidence: 0.9 });
    const claude = stubClaude(Array(10).fill(ok));
    const completeSpy = vi.spyOn(claude, 'complete');
    const learner = new SelfLearningModule({
      db, claude,
      researchMaxPer10MinPerGroup: 100,
      researchMaxPerDayGlobal: 2,
    });

    for (let i = 0; i < 4; i++) {
      const evasiveId = seedEvasive(`g${i}`);
      await learner.researchOnline({
        groupId: `g${i}`, evasiveBotReplyId: evasiveId, originalTrigger: `q ${i}`,
      });
    }

    expect(completeSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows Claude errors and returns null', async () => {
    const learner = new SelfLearningModule({ db, claude: failingClaude() });
    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });
    expect(result).toBeNull();
  });

  it('drops malformed JSON without crashing', async () => {
    const claude = stubClaude(['not json {{']);
    const learner = new SelfLearningModule({ db, claude });

    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });

    expect(result).toBeNull();
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('returns null immediately when researchEnabled is false', async () => {
    const completeSpy = vi.fn();
    const claude: IClaudeClient = {
      complete: completeSpy as unknown as IClaudeClient['complete'],
      async describeImage() { return ''; },
    };
    const learner = new SelfLearningModule({ db, claude, researchEnabled: false });

    const result = await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });

    expect(result).toBeNull();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('forwards allowedTools:[WebSearch] to the Claude client', async () => {
    const claude = stubClaude([JSON.stringify({ found: false })]);
    const completeSpy = vi.spyOn(claude, 'complete');
    const learner = new SelfLearningModule({ db, claude });

    await learner.researchOnline({
      groupId: 'g1', evasiveBotReplyId: seedEvasive('g1'),
      originalTrigger: 'fire bird 谁唱的',
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const req = completeSpy.mock.calls[0]![0];
    expect(req.allowedTools).toEqual(['WebSearch']);
  });
});
