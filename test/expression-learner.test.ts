import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpressionLearner } from '../src/modules/expression-learner.js';
import type { IMessageRepository, IExpressionPatternRepository, ExpressionPattern } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const BOT_USER_ID = 'bot123';
const GROUP = 'g1';

function makeMsg(userId: string, nickname: string, content: string, timestamp = 1700000000) {
  return { id: 0, groupId: GROUP, userId, nickname, content, rawContent: content, timestamp, deleted: false };
}

function makeMsgRepo(msgs: ReturnType<typeof makeMsg>[]): IMessageRepository {
  return {
    getRecent: vi.fn().mockReturnValue(msgs),
    getByUser: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
  } as unknown as IMessageRepository;
}

function makePatternRepo(): IExpressionPatternRepository & {
  _store: Map<string, ExpressionPattern>;
} {
  const store = new Map<string, ExpressionPattern>();
  const key = (g: string, s: string, e: string) => `${g}|${s}|${e}`;

  return {
    _store: store,
    upsert: vi.fn().mockImplementation((groupId: string, situation: string, expression: string) => {
      const k = key(groupId, situation, expression);
      const existing = store.get(k);
      if (existing) {
        store.set(k, { ...existing, weight: existing.weight + 1, updatedAt: Date.now() });
      } else {
        store.set(k, { groupId, situation, expression, weight: 1.0, createdAt: Date.now(), updatedAt: Date.now() });
      }
    }),
    listAll: vi.fn().mockImplementation((groupId: string) => {
      return [...store.values()].filter(p => p.groupId === groupId);
    }),
    getTopN: vi.fn().mockImplementation((groupId: string, limit: number) => {
      return [...store.values()]
        .filter(p => p.groupId === groupId)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit);
    }),
    updateWeight: vi.fn().mockImplementation((groupId: string, situation: string, expression: string, weight: number) => {
      const k = key(groupId, situation, expression);
      const existing = store.get(k);
      if (existing) store.set(k, { ...existing, weight, updatedAt: Date.now() });
    }),
    delete: vi.fn().mockImplementation((groupId: string, situation: string, expression: string) => {
      store.delete(key(groupId, situation, expression));
    }),
  };
}

describe('ExpressionLearner', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('scan', () => {
    it('extracts consecutive user→bot message pairs', () => {
      // Messages in DESC order (as getRecent returns)
      const msgs = [
        makeMsg(BOT_USER_ID, 'Bot', 'bot reply 2', 1700000004),
        makeMsg('u2', 'Alice', 'hello again', 1700000003),
        makeMsg(BOT_USER_ID, 'Bot', 'bot reply 1', 1700000002),
        makeMsg('u1', 'Bob', 'hey there', 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);

      expect(patternRepo.upsert).toHaveBeenCalledTimes(2);
      expect(patternRepo.upsert).toHaveBeenCalledWith(GROUP, 'hey there', 'bot reply 1');
      expect(patternRepo.upsert).toHaveBeenCalledWith(GROUP, 'hello again', 'bot reply 2');
    });

    it('skips messages shorter than 3 characters', () => {
      const msgs = [
        makeMsg(BOT_USER_ID, 'Bot', 'ok', 1700000002),  // < 3 chars
        makeMsg('u1', 'Bob', 'hi', 1700000001),          // < 3 chars
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('skips messages starting with /', () => {
      const msgs = [
        makeMsg(BOT_USER_ID, 'Bot', 'command response', 1700000002),
        makeMsg('u1', 'Bob', '/help me please', 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('skips pure CQ code messages', () => {
      const msgs = [
        makeMsg(BOT_USER_ID, 'Bot', '[CQ:image,file=abc.jpg]', 1700000002),
        makeMsg('u1', 'Bob', 'look at this image', 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('skips when both consecutive messages are from non-bot users', () => {
      const msgs = [
        makeMsg('u2', 'Alice', 'another message', 1700000002),
        makeMsg('u1', 'Bob', 'some message here', 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('skips when first message is from bot (bot→bot or bot→user)', () => {
      const msgs = [
        makeMsg('u1', 'Bob', 'user reply', 1700000002),
        makeMsg(BOT_USER_ID, 'Bot', 'bot says something', 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('truncates situation to 50 chars and expression to 100 chars', () => {
      const longUserMsg = 'a'.repeat(80);
      const longBotMsg = 'b'.repeat(150);
      const msgs = [
        makeMsg(BOT_USER_ID, 'Bot', longBotMsg, 1700000002),
        makeMsg('u1', 'Bob', longUserMsg, 1700000001),
      ];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).toHaveBeenCalledWith(GROUP, 'a'.repeat(50), 'b'.repeat(100));
    });

    it('handles empty message list gracefully', () => {
      const msgRepo = makeMsgRepo([]);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });

    it('handles single message gracefully', () => {
      const msgs = [makeMsg('u1', 'Bob', 'lonely message', 1700000001)];
      const msgRepo = makeMsgRepo(msgs);
      const patternRepo = makePatternRepo();

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      learner.scan(GROUP);
      expect(patternRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('applyDecay', () => {
    it('decays weights based on time elapsed', () => {
      const patternRepo = makePatternRepo();
      // Seed a pattern updated 10 days ago
      const tenDaysAgoMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
      patternRepo._store.set(`${GROUP}|hello|world`, {
        groupId: GROUP, situation: 'hello', expression: 'world',
        weight: 5.0, createdAt: tenDaysAgoMs, updatedAt: tenDaysAgoMs,
      });

      const msgRepo = makeMsgRepo([]);
      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
        decayDays: 15,
      });

      learner.applyDecay(GROUP);

      // Weight should decay: 5.0 * exp(-10/15) ≈ 2.567
      expect(patternRepo.updateWeight).toHaveBeenCalled();
      const call = (patternRepo.updateWeight as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const newWeight = call[3] as number;
      expect(newWeight).toBeGreaterThan(2.0);
      expect(newWeight).toBeLessThan(3.0);
    });

    it('deletes patterns with weight below 0.01', () => {
      const patternRepo = makePatternRepo();
      // Seed a pattern updated 100 days ago with low weight
      const longAgoMs = Date.now() - 100 * 24 * 60 * 60 * 1000;
      patternRepo._store.set(`${GROUP}|old|pattern`, {
        groupId: GROUP, situation: 'old', expression: 'pattern',
        weight: 0.02, createdAt: longAgoMs, updatedAt: longAgoMs,
      });

      const msgRepo = makeMsgRepo([]);
      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
        decayDays: 15,
      });

      learner.applyDecay(GROUP);
      expect(patternRepo.delete).toHaveBeenCalledWith(GROUP, 'old', 'pattern');
    });

    it('enforces maxPatternsPerGroup limit', () => {
      const patternRepo = makePatternRepo();
      // Seed 5 patterns
      for (let i = 0; i < 5; i++) {
        const now = Date.now();
        patternRepo._store.set(`${GROUP}|sit${i}|exp${i}`, {
          groupId: GROUP, situation: `sit${i}`, expression: `exp${i}`,
          weight: i + 1, createdAt: now, updatedAt: now,
        });
      }

      const msgRepo = makeMsgRepo([]);
      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
        maxPatternsPerGroup: 3,
      });

      learner.applyDecay(GROUP);

      // Should have deleted the 2 lowest-weight patterns (sit0/exp0 weight=1, sit1/exp1 weight=2)
      expect(patternRepo.delete).toHaveBeenCalledWith(GROUP, 'sit0', 'exp0');
      expect(patternRepo.delete).toHaveBeenCalledWith(GROUP, 'sit1', 'exp1');
    });
  });

  describe('formatForPrompt', () => {
    it('returns formatted string for top patterns', () => {
      const patternRepo = makePatternRepo();
      const now = Date.now();
      patternRepo._store.set(`${GROUP}|你好|你也好`, {
        groupId: GROUP, situation: '你好', expression: '你也好',
        weight: 5.0, createdAt: now, updatedAt: now,
      });
      patternRepo._store.set(`${GROUP}|再见|拜拜`, {
        groupId: GROUP, situation: '再见', expression: '拜拜',
        weight: 3.0, createdAt: now, updatedAt: now,
      });

      const msgRepo = makeMsgRepo([]);
      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      const result = learner.formatForPrompt(GROUP, 5);
      expect(result).toContain('## 你之前的回复风格参考');
      expect(result).toContain('当有人说「你好」时，你回过「你也好」');
      expect(result).toContain('当有人说「再见」时，你回过「拜拜」');
    });

    it('returns empty string when no patterns exist', () => {
      const patternRepo = makePatternRepo();
      const msgRepo = makeMsgRepo([]);

      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      expect(learner.formatForPrompt(GROUP)).toBe('');
    });

    it('respects limit parameter', () => {
      const patternRepo = makePatternRepo();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        patternRepo._store.set(`${GROUP}|sit${i}|exp${i}`, {
          groupId: GROUP, situation: `sit${i}`, expression: `exp${i}`,
          weight: 10 - i, createdAt: now, updatedAt: now,
        });
      }

      const msgRepo = makeMsgRepo([]);
      const learner = new ExpressionLearner({
        messages: msgRepo, expressionPatterns: patternRepo,
        botUserId: BOT_USER_ID, logger: silentLogger,
      });

      const result = learner.formatForPrompt(GROUP, 3);
      const lines = result.split('\n').filter(l => l.startsWith('- '));
      expect(lines).toHaveLength(3);
    });
  });
});
