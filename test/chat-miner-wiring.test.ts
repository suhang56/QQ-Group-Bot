import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type {
  IExpressionPromptSource,
  IStylePromptSource,
  IRelationshipPromptSource,
} from '../src/modules/chat.js';
import type { SocialRelation } from '../src/modules/relationship-tracker.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

function captureCall(claude: IClaudeClient) {
  const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    system: Array<{ text: string }>;
    messages: Array<{ content: string }>;
  };
  return {
    systemText: call.system.map(s => s.text).join('\n---\n'),
    userText: call.messages.map(m => m.content).join('\n---\n'),
  };
}

describe('ChatModule — M6.2a miner wiring', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── expression-learner → system prompt ──────────────────────────────────────

  describe('expression-learner injection', () => {
    it('injects expression section into system prompt when helper returns non-empty', async () => {
      const expressionSource: IExpressionPromptSource = {
        formatForPrompt: vi.fn().mockReturnValue(
          '## 你之前的回复风格参考\n- 当有人说「test」时，你回过「yep」',
        ),
      };
      const chat = makeChat(claude, db);
      chat.setExpressionSource(expressionSource);

      await chat.generateReply('g1', makeMsg(), []);

      const { systemText } = captureCall(claude);
      expect(systemText).toContain('你之前的回复风格参考');
      expect(systemText).toContain('当有人说「test」时，你回过「yep」');
      expect(expressionSource.formatForPrompt).toHaveBeenCalledWith('g1');
    });

    it('omits expression section entirely when helper returns empty string (no dead header)', async () => {
      const expressionSource: IExpressionPromptSource = {
        formatForPrompt: vi.fn().mockReturnValue(''),
      };
      const chat = makeChat(claude, db);
      chat.setExpressionSource(expressionSource);

      await chat.generateReply('g1', makeMsg(), []);

      const { systemText } = captureCall(claude);
      expect(systemText).not.toContain('你之前的回复风格参考');
    });

    it('omits expression section when source is not set', async () => {
      const chat = makeChat(claude, db);
      // no setExpressionSource call

      await chat.generateReply('g1', makeMsg(), []);

      const { systemText } = captureCall(claude);
      expect(systemText).not.toContain('你之前的回复风格参考');
    });
  });

  // ── style-learner → userContent (user role) ────────────────────────────────

  describe('style-learner injection', () => {
    it('injects style hint into userContent (not system) when trigger is @ mention', async () => {
      const styleSource: IStylePromptSource = {
        formatStyleForPrompt: vi.fn().mockReturnValue(
          '## 这个人的说话风格\n- 口头禅: 草、啊这',
        ),
      };
      const chat = makeChat(claude, db);
      chat.setStyleSource(styleSource);

      const atMsg = makeMsg({
        userId: 'u-triggerer',
        nickname: 'Zoe',
        content: 'hey',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      });
      await chat.generateReply('g1', atMsg, []);

      const { systemText, userText } = captureCall(claude);
      // style must be in user role, NOT in system
      expect(userText).toContain('Zoe 最近这么说话');
      expect(userText).toContain('口头禅: 草、啊这');
      expect(systemText).not.toContain('Zoe 最近这么说话');
      expect(styleSource.formatStyleForPrompt).toHaveBeenCalledWith('g1', 'u-triggerer');
    });

    it('does NOT call style helper on non-direct triggers (ambient chat)', async () => {
      const styleSource: IStylePromptSource = {
        formatStyleForPrompt: vi.fn().mockReturnValue('## 这个人的说话风格\n- 口头禅: x'),
      };
      const chat = makeChat(claude, db);
      chat.setStyleSource(styleSource);

      // plain message, no @mention, no reply to bot
      await chat.generateReply('g1', makeMsg({ userId: 'u-random', content: '今天天气真好' }), []);

      expect(styleSource.formatStyleForPrompt).not.toHaveBeenCalled();
      const { userText } = captureCall(claude);
      expect(userText).not.toContain('最近这么说话');
    });

    it('skips style hint when helper returns empty (no dead brackets)', async () => {
      const styleSource: IStylePromptSource = {
        formatStyleForPrompt: vi.fn().mockReturnValue(''),
      };
      const chat = makeChat(claude, db);
      chat.setStyleSource(styleSource);

      const atMsg = makeMsg({
        userId: 'u-triggerer',
        nickname: 'Zoe',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', atMsg, []);

      const { userText } = captureCall(claude);
      expect(userText).not.toContain('最近这么说话');
      expect(userText).not.toContain('context 注释');
    });

    it('skips style hint when trigger userId matches bot', async () => {
      const styleSource: IStylePromptSource = {
        formatStyleForPrompt: vi.fn().mockReturnValue('## 这个人的说话风格\n- 口头禅: x'),
      };
      const chat = makeChat(claude, db);
      chat.setStyleSource(styleSource);

      // bot "triggering" itself via @ (edge case) — must not self-profile
      const atMsg = makeMsg({
        userId: BOT_ID,
        nickname: 'bot',
        content: 'hey',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      });
      await chat.generateReply('g1', atMsg, []);

      expect(styleSource.formatStyleForPrompt).not.toHaveBeenCalled();
    });
  });

  // ── relationship-tracker → system prompt ───────────────────────────────────

  describe('relationship-tracker injection', () => {
    it('injects relationship section into system prompt when data exists, using distinct speakers from immediate context', async () => {
      const ts = Math.floor(Date.now() / 1000);
      // seed 2 distinct speakers in immediate context
      db.messages.insert({ groupId: 'g1', userId: 'u-alice', nickname: 'Alice', content: 'hi Bob', timestamp: ts - 30, deleted: false });
      db.messages.insert({ groupId: 'g1', userId: 'u-bob', nickname: 'Bob', content: 'hey Alice', timestamp: ts - 20, deleted: false });

      const relation: SocialRelation = {
        groupId: 'g1',
        fromUser: 'u-alice',
        toUser: 'u-bob',
        relationType: '铁磁/密友',
        strength: 0.9,
        evidence: '经常互相回复',
        updatedAt: ts,
      };

      const relationshipSource: IRelationshipPromptSource = {
        getRelevantRelations: vi.fn().mockReturnValue([relation]),
        formatRelationsForPrompt: vi.fn().mockReturnValue(
          '## 群友关系\nAlice 和 Bob 的关系：铁磁/密友（经常互相回复）',
        ),
      };
      const chat = makeChat(claude, db);
      chat.setRelationshipSource(relationshipSource);

      await chat.generateReply('g1', makeMsg({ userId: 'u-carol', nickname: 'Carol', content: 'what' }), []);

      const { systemText } = captureCall(claude);
      expect(systemText).toContain('群友关系');
      expect(systemText).toContain('Alice 和 Bob 的关系：铁磁/密友');

      // assert distinct speakers from immediate chron were used, bot excluded
      expect(relationshipSource.getRelevantRelations).toHaveBeenCalledTimes(1);
      const [calledGroupId, calledUserIds] = (relationshipSource.getRelevantRelations as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(calledGroupId).toBe('g1');
      expect(calledUserIds).toEqual(expect.arrayContaining(['u-alice', 'u-bob']));
      expect(calledUserIds).not.toContain(BOT_ID);
    });

    it('omits relationship section when helper returns empty (no dead header)', async () => {
      const ts = Math.floor(Date.now() / 1000);
      db.messages.insert({ groupId: 'g1', userId: 'u-alice', nickname: 'Alice', content: 'hi', timestamp: ts - 10, deleted: false });

      const relationshipSource: IRelationshipPromptSource = {
        getRelevantRelations: vi.fn().mockReturnValue([]),
        formatRelationsForPrompt: vi.fn().mockReturnValue(''),
      };
      const chat = makeChat(claude, db);
      chat.setRelationshipSource(relationshipSource);

      await chat.generateReply('g1', makeMsg(), []);

      const { systemText } = captureCall(claude);
      expect(systemText).not.toContain('群友关系');
      expect(systemText).not.toContain('## 群友关系');
    });

    it('excludes bot userId from the speakers passed to the helper', async () => {
      const ts = Math.floor(Date.now() / 1000);
      // bot spoke in immediate context
      db.messages.insert({ groupId: 'g1', userId: BOT_ID, nickname: 'bot', content: 'hi there', timestamp: ts - 20, deleted: false });
      db.messages.insert({ groupId: 'g1', userId: 'u-alice', nickname: 'Alice', content: 'oh', timestamp: ts - 10, deleted: false });

      const relationshipSource: IRelationshipPromptSource = {
        getRelevantRelations: vi.fn().mockReturnValue([]),
        formatRelationsForPrompt: vi.fn().mockReturnValue(''),
      };
      const chat = makeChat(claude, db);
      chat.setRelationshipSource(relationshipSource);

      await chat.generateReply('g1', makeMsg({ userId: 'u-carol', nickname: 'Carol' }), []);

      expect(relationshipSource.getRelevantRelations).toHaveBeenCalledTimes(1);
      const [, calledUserIds] = (relationshipSource.getRelevantRelations as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(calledUserIds).not.toContain(BOT_ID);
      expect(calledUserIds).toContain('u-alice');
    });
  });

  // ── Regression: base prompt still contains persona anchor ──────────────────

  it('preserves persona anchor in system prompt when all miner sources empty', async () => {
    const chat = makeChat(claude, db);
    chat.setExpressionSource({ formatForPrompt: () => '' });
    chat.setRelationshipSource({
      getRelevantRelations: () => [],
      formatRelationsForPrompt: () => '',
    });

    await chat.generateReply('g1', makeMsg(), []);
    const { systemText } = captureCall(claude);
    // BANGDREAM persona header still present (sanity check existing contract)
    expect(systemText.length).toBeGreaterThan(0);
    // no miner dead headers
    expect(systemText).not.toContain('你之前的回复风格参考');
    expect(systemText).not.toContain('## 群友关系');
  });
});
