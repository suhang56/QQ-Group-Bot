import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
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

function makeMockClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  };
}

// Minimal ScoreFactors — all zero by default; tests override specific fields.
function makeFactors(overrides: Record<string, number> = {}) {
  return {
    mention: 0, replyToBot: 0, question: 0, silence: 0, loreKw: 0, length: 0,
    twoUser: 0, burst: 0, replyToOther: 0, implicitBotRef: 0, continuity: 0,
    clarification: 0, topicStick: 0, metaIdentityProbe: 0, adminBoost: 0, stickerRequest: 0,
    ...overrides,
  };
}

describe('ChatModule._pickChatModel — layered routing', () => {
  let db: Database;
  let chat: ChatModule;

  beforeEach(() => {
    // Ensure kill switch is off for most tests
    delete process.env['CHAT_QWEN_DISABLED'];
    db = new Database(':memory:');
    chat = new ChatModule(makeMockClaude(), db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      moodProactiveEnabled: false, deflectCacheEnabled: false,
    });
  });

  afterEach(() => {
    chat.destroy();
  });

  // Type-unsafe access to the private method for testing
  const pick = (msg: GroupMessage, factors: ReturnType<typeof makeFactors>): string =>
    (chat as unknown as { _pickChatModel: (m: GroupMessage, f: unknown) => string })._pickChatModel(msg, factors);

  describe('always-Sonnet rules', () => {
    it('returns sonnet when factors.mention > 0', () => {
      const model = pick(makeMsg(), makeFactors({ mention: 1.0 }));
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns sonnet when factors.replyToBot > 0', () => {
      const model = pick(makeMsg(), makeFactors({ replyToBot: 1.0 }));
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns sonnet when role is admin', () => {
      const model = pick(makeMsg({ role: 'admin' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns sonnet when role is owner', () => {
      const model = pick(makeMsg({ role: 'owner' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns sonnet when factors.metaIdentityProbe > 0', () => {
      const model = pick(makeMsg(), makeFactors({ metaIdentityProbe: 0.6 }));
      expect(model).toBe('claude-sonnet-4-6');
    });
  });

  describe('sensitive content routing', () => {
    const sensitiveInputs = [
      '上你',
      '那我上你',
      '我上你',
      '干你',
      '日你',
      '睡你',
      '搞你',
      '艹你',
    ];
    for (const content of sensitiveInputs) {
      it(`routes "${content}" to sonnet`, () => {
        const model = pick(makeMsg({ content }), makeFactors());
        expect(model).toBe('claude-sonnet-4-6');
      });
    }

    it('routes tech meta-talk (usage 烧没了) to sonnet', () => {
      const model = pick(makeMsg({ content: 'usage 烧没了吧' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('routes "穿梭没设对节点" (VPN) to sonnet', () => {
      const model = pick(makeMsg({ content: '穿梭可能没设对节点' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('routes identity probe ("你是不是bot") to sonnet', () => {
      const model = pick(makeMsg({ content: '你是不是bot' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('routes political tripwire ("习近平") to sonnet', () => {
      const model = pick(makeMsg({ content: '你觉得习近平怎么样' }), makeFactors());
      expect(model).toBe('claude-sonnet-4-6');
    });
  });

  describe('default Qwen (casual lurker)', () => {
    it('routes plain "哈哈笑死" to qwen', () => {
      const model = pick(makeMsg({ content: '哈哈笑死' }), makeFactors());
      expect(model).toBe('qwen3:8b');
    });

    it('routes plain "牛逼" to qwen', () => {
      const model = pick(makeMsg({ content: '牛逼' }), makeFactors());
      expect(model).toBe('qwen3:8b');
    });

    it('routes plain "草" to qwen', () => {
      const model = pick(makeMsg({ content: '草' }), makeFactors());
      expect(model).toBe('qwen3:8b');
    });

    it('routes a short BanG Dream question to qwen (non-@, non-admin)', () => {
      const model = pick(makeMsg({ content: 'roselia新歌怎么样' }), makeFactors());
      expect(model).toBe('qwen3:8b');
    });
  });

  describe('kill switch', () => {
    it('CHAT_QWEN_DISABLED=1 forces sonnet even for casual triggers', async () => {
      process.env['CHAT_QWEN_DISABLED'] = '1';
      // Need a fresh ChatModule to pick up the env var at module eval time —
      // config.ts reads it once. Re-import via dynamic import.
      vi.resetModules();
      const { ChatModule: FreshChatModule } = await import('../src/modules/chat.js');
      const freshChat = new FreshChatModule(makeMockClaude(), db, {
        botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
        moodProactiveEnabled: false, deflectCacheEnabled: false,
      });
      try {
        const fresh = freshChat as unknown as { _pickChatModel: (m: GroupMessage, f: unknown) => string };
        const model = fresh._pickChatModel(makeMsg({ content: '哈哈' }), makeFactors());
        expect(model).toBe('claude-sonnet-4-6');
      } finally {
        freshChat.destroy();
        delete process.env['CHAT_QWEN_DISABLED'];
      }
    });
  });
});
