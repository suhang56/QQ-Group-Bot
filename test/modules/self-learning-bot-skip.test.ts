import { describe, it, expect, vi } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { SelfLearningModule } from '../../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = '1705075399';

function stubClaude(replies: string[]): IClaudeClient {
  let i = 0;
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      const text = replies[Math.min(i, replies.length - 1)] ?? '';
      i++;
      return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  } as unknown as IClaudeClient;
}

function seedBotReply(db: Database, groupId: string): number {
  const row = db.botReplies.insert({
    groupId,
    triggerMsgId: 'm-trigger',
    triggerUserNickname: 'asker',
    triggerContent: 'x',
    botReply: 'y',
    module: 'chat',
    sentAt: Math.floor(Date.now() / 1000),
  });
  return row.id;
}

/**
 * PR3 regression:
 * self-learning.ts line 242 guard (detectCorrection: botUserId === correctionMsg.userId → return null)
 * must short-circuit before insertOrSupersede call at line 277 of the same function.
 * This spec specifically asserts insertOrSupersede is NOT called via the spy,
 * complementing the existing behavioral test at test/self-learning.test.ts:77.
 */
describe('SelfLearningModule — bot-skip regression (PR3)', () => {
  it('MUST-NOT-FIRE: bot-authored correction → insertOrSupersede spy is not called', async () => {
    const db = new Database(':memory:');
    const botReplyId = seedBotReply(db, 'g1');
    const claude = stubClaude([JSON.stringify({ isCorrection: true, correctFact: 'z' })]);
    const learner = new SelfLearningModule({ db, claude, botUserId: BOT_ID });
    const spy = vi.spyOn(db.learnedFacts, 'insertOrSupersede');

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y', userId: BOT_ID, nickname: 'bot', messageId: 'm1' },
    });

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    db.close();
  });

  it('MUST-FIRE: user-authored correction → insertOrSupersede called once', async () => {
    const db = new Database(':memory:');
    const botReplyId = seedBotReply(db, 'g1');
    const claude = stubClaude([
      JSON.stringify({ isCorrection: true, correctFact: 'z 是 y 的解释', wrongFact: 'y', topic: 't' }),
    ]);
    const learner = new SelfLearningModule({ db, claude, botUserId: BOT_ID });
    const spy = vi.spyOn(db.learnedFacts, 'insertOrSupersede');

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y 正确的', userId: 'user-42', nickname: 'sino', messageId: 'm1' },
    });

    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('botUserId undefined → filter no-op, user correction still processed', async () => {
    const db = new Database(':memory:');
    const botReplyId = seedBotReply(db, 'g1');
    const claude = stubClaude([
      JSON.stringify({ isCorrection: true, correctFact: 'z 是 y 的解释' }),
    ]);
    const learner = new SelfLearningModule({ db, claude });
    const spy = vi.spyOn(db.learnedFacts, 'insertOrSupersede');

    const result = await learner.detectCorrection({
      groupId: 'g1',
      botReplyId,
      correctionMsg: { content: '不是 X 是 Y 正确的', userId: 'user-42', nickname: 'u', messageId: 'm1' },
    });

    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalled();
    db.close();
  });
});
