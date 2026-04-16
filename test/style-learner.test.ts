import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StyleLearner } from '../src/modules/style-learner.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, IUserStyleRepository, StyleJsonData } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP = 'g1';

function makeMsg(userId: string, nickname: string, content: string, timestamp = 1700000000) {
  return { id: 0, groupId: GROUP, userId, nickname, content, rawContent: content, timestamp, deleted: false };
}

function makeRecentTimestamp(): number {
  return Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
}

function makeMsgRepo(topUsers: Array<{ userId: string; nickname: string; count: number }>, userMsgs: Map<string, ReturnType<typeof makeMsg>[]>): IMessageRepository {
  return {
    getRecent: vi.fn().mockReturnValue([]),
    getByUser: vi.fn().mockImplementation((_groupId: string, userId: string) => {
      return userMsgs.get(userId) ?? [];
    }),
    getTopUsers: vi.fn().mockReturnValue(topUsers),
  } as unknown as IMessageRepository;
}

function makeStyleRepo(): IUserStyleRepository & {
  _store: Map<string, { nickname: string; style: StyleJsonData }>;
} {
  const store = new Map<string, { nickname: string; style: StyleJsonData }>();
  return {
    _store: store,
    upsert: vi.fn().mockImplementation((groupId: string, userId: string, nickname: string, styleJson: StyleJsonData) => {
      store.set(`${groupId}|${userId}`, { nickname, style: styleJson });
    }),
    get: vi.fn().mockImplementation((groupId: string, userId: string) => {
      return store.get(`${groupId}|${userId}`)?.style ?? null;
    }),
    listAll: vi.fn().mockReturnValue([]),
  };
}

function makeClaudeWith(response: string): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  } as unknown as IClaudeClient;
}

const validStyleJson: StyleJsonData = {
  catchphrases: ['啊这', '何意味'],
  punctuationStyle: '少句号，多省略号',
  sentencePattern: '中日英混用',
  emotionalSignatures: { happy: '哈哈', annoyed: '阴阳怪气' },
  topicAffinity: ['BanG Dream', 'cos'],
};

describe('StyleLearner', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('learnStyles', () => {
    it('analyzes active users with sufficient messages', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 50 }];
      const msgs = Array.from({ length: 30 }, (_, i) =>
        makeMsg('u1', 'Alice', `message content number ${i} is long enough`, recentTs + i),
      );
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith(JSON.stringify(validStyleJson));

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);

      expect(styleRepo.upsert).toHaveBeenCalledTimes(1);
      expect(styleRepo.upsert).toHaveBeenCalledWith(GROUP, 'u1', 'Alice', validStyleJson);
    });

    it('skips users with fewer than 20 filtered messages', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 10 }];
      const msgs = Array.from({ length: 10 }, (_, i) =>
        makeMsg('u1', 'Alice', `msg ${i} long enough`, recentTs + i),
      );
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith(JSON.stringify(validStyleJson));

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);
      expect(claude.complete).not.toHaveBeenCalled();
      expect(styleRepo.upsert).not.toHaveBeenCalled();
    });

    it('skips users inactive for more than 7 days', async () => {
      const oldTs = Math.floor(Date.now() / 1000) - 10 * 24 * 3600; // 10 days ago
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 50 }];
      const msgs = Array.from({ length: 30 }, (_, i) =>
        makeMsg('u1', 'Alice', `old message number ${i} long enough`, oldTs + i),
      );
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith(JSON.stringify(validStyleJson));

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);
      expect(claude.complete).not.toHaveBeenCalled();
    });

    it('filters out CQ-only, command, and short messages before counting', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 30 }];
      const msgs: ReturnType<typeof makeMsg>[] = [];
      // 15 valid messages
      for (let i = 0; i < 15; i++) {
        msgs.push(makeMsg('u1', 'Alice', `valid message number ${i}`, recentTs + i));
      }
      // 15 invalid messages (short, CQ, commands)
      for (let i = 0; i < 5; i++) {
        msgs.push(makeMsg('u1', 'Alice', 'hi', recentTs + 15 + i)); // < 3 chars
        msgs.push(makeMsg('u1', 'Alice', '[CQ:image,file=x.jpg]', recentTs + 20 + i)); // pure CQ
        msgs.push(makeMsg('u1', 'Alice', '/help please now', recentTs + 25 + i)); // command
      }
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith(JSON.stringify(validStyleJson));

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);
      // 15 valid < 20 threshold → should skip
      expect(claude.complete).not.toHaveBeenCalled();
    });

    it('handles LLM returning invalid JSON gracefully', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 50 }];
      const msgs = Array.from({ length: 30 }, (_, i) =>
        makeMsg('u1', 'Alice', `message content number ${i} is long enough`, recentTs + i),
      );
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('not valid json at all');

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);
      expect(styleRepo.upsert).not.toHaveBeenCalled();
    });

    it('handles LLM call failure gracefully', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [{ userId: 'u1', nickname: 'Alice', count: 50 }];
      const msgs = Array.from({ length: 30 }, (_, i) =>
        makeMsg('u1', 'Alice', `message content number ${i} is long enough`, recentTs + i),
      );
      const userMsgs = new Map([['u1', msgs]]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = {
        complete: vi.fn().mockRejectedValue(new Error('API error')),
      } as unknown as IClaudeClient;

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      // Should not throw
      await learner.learnStyles(GROUP);
      expect(styleRepo.upsert).not.toHaveBeenCalled();
    });

    it('processes multiple users in sequence', async () => {
      const recentTs = makeRecentTimestamp();
      const topUsers = [
        { userId: 'u1', nickname: 'Alice', count: 50 },
        { userId: 'u2', nickname: 'Bob', count: 40 },
      ];
      const makeMsgs = (uid: string, nick: string) =>
        Array.from({ length: 25 }, (_, i) =>
          makeMsg(uid, nick, `${nick} message content number ${i}`, recentTs + i),
        );
      const userMsgs = new Map([
        ['u1', makeMsgs('u1', 'Alice')],
        ['u2', makeMsgs('u2', 'Bob')],
      ]);
      const msgRepo = makeMsgRepo(topUsers, userMsgs);
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith(JSON.stringify(validStyleJson));

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      await learner.learnStyles(GROUP);
      expect(styleRepo.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStyle', () => {
    it('returns style from repository', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      styleRepo._store.set(`${GROUP}|u1`, { nickname: 'Alice', style: validStyleJson });

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      const result = learner.getStyle(GROUP, 'u1');
      expect(result).toEqual(validStyleJson);
    });

    it('returns null for unknown user', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      expect(learner.getStyle(GROUP, 'unknown')).toBeNull();
    });
  });

  describe('formatStyleForPrompt', () => {
    it('returns formatted style string', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      styleRepo._store.set(`${GROUP}|u1`, { nickname: 'Alice', style: validStyleJson });

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      const result = learner.formatStyleForPrompt(GROUP, 'u1');
      expect(result).toContain('## 这个人的说话风格');
      expect(result).toContain('口头禅: 啊这、何意味');
      expect(result).toContain('标点习惯: 少句号，多省略号');
      expect(result).toContain('句式特点: 中日英混用');
      expect(result).toContain('常聊话题: BanG Dream、cos');
    });

    it('returns empty string for unknown user', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      expect(learner.formatStyleForPrompt(GROUP, 'unknown')).toBe('');
    });

    it('returns empty string when style has no useful data', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      const emptyStyle: StyleJsonData = {
        catchphrases: [],
        punctuationStyle: '',
        sentencePattern: '',
        emotionalSignatures: {},
        topicAffinity: [],
      };
      styleRepo._store.set(`${GROUP}|u1`, { nickname: 'Alice', style: emptyStyle });

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
      });

      expect(learner.formatStyleForPrompt(GROUP, 'u1')).toBe('');
    });
  });

  describe('lifecycle', () => {
    it('start and dispose manage timers correctly', () => {
      const msgRepo = makeMsgRepo([], new Map());
      const styleRepo = makeStyleRepo();
      const claude = makeClaudeWith('');

      const learner = new StyleLearner({
        messages: msgRepo, userStyles: styleRepo, claude,
        activeGroups: [GROUP], logger: silentLogger,
        intervalMs: 1000,
      });

      learner.start();
      // Should not throw
      learner.dispose();
      // Double dispose should also be safe
      learner.dispose();
    });
  });
});
