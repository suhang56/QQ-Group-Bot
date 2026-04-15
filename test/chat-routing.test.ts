import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatModule, type ScoreFactors } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const GROUP_ID = 'g1';

const SONNET = 'claude-sonnet-4-6';
const QWEN = 'qwen3:8b';
const DEEPSEEK = 'deepseek-chat';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1',
    groupId: GROUP_ID,
    userId: 'u1',
    nickname: 'Alice',
    role: 'member',
    content: '',
    rawContent: '',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeFactors(overrides: Partial<ScoreFactors> = {}): ScoreFactors {
  return {
    mention: 0,
    replyToBot: 0,
    question: 0,
    silence: 0,
    loreKw: 0,
    length: 0,
    twoUser: 0,
    burst: 0,
    replyToOther: 0,
    implicitBotRef: 0,
    continuity: 0,
    clarification: 0,
    topicStick: 0,
    metaIdentityProbe: 0,
    adminBoost: 0,
    stickerRequest: 0,
    ...overrides,
  };
}

function makeMockClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'ok',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function pick(
  chat: ChatModule,
  groupId: string,
  msg: GroupMessage,
  factors: ScoreFactors,
): string {
  return (chat as unknown as {
    _pickChatModel: (g: string, m: GroupMessage, f: ScoreFactors) => string;
  })._pickChatModel(groupId, msg, factors);
}

describe('ChatModule._pickChatModel — routing rules', () => {
  let db: Database;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    chat = new ChatModule(makeMockClaude(), db, { botUserId: BOT_ID });
    delete process.env['CHAT_QWEN_DISABLED'];
    delete process.env['DEEPSEEK_API_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DEEPSEEK_API_KEY'];
  });

  // ── Always-Sonnet factor rules ──────────────────────────────────────────

  it('routes to Sonnet when factors.mention > 0', () => {
    const msg = makeMsg({ content: '哈哈' });
    expect(pick(chat, GROUP_ID, msg, makeFactors({ mention: 1 }))).toBe(SONNET);
  });

  it('routes to Sonnet when factors.replyToBot > 0', () => {
    const msg = makeMsg({ content: '哈哈' });
    expect(pick(chat, GROUP_ID, msg, makeFactors({ replyToBot: 1 }))).toBe(SONNET);
  });

  it('routes to Sonnet for admin role', () => {
    const msg = makeMsg({ content: '哈哈', role: 'admin' });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  it('routes to Sonnet for owner role', () => {
    const msg = makeMsg({ content: '哈哈', role: 'owner' });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  it('routes to Sonnet when factors.metaIdentityProbe > 0', () => {
    const msg = makeMsg({ content: '哈哈' });
    expect(pick(chat, GROUP_ID, msg, makeFactors({ metaIdentityProbe: 0.6 }))).toBe(SONNET);
  });

  it('routes to Sonnet when tease counter is active for the user', () => {
    // Fire tease increments via _teaseIncrement to populate counter
    const internal = chat as unknown as {
      _teaseIncrement: (g: string, u: string, now: number) => boolean;
    };
    internal._teaseIncrement(GROUP_ID, 'u1', Date.now());
    const msg = makeMsg({ content: '哈哈', userId: 'u1' });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  // ── CHAT_SENSITIVE_RE sexual-proposition cases ──────────────────────────

  it.each([
    ['上你'],
    ['我上你'],
    ['那我上你'],
    ['干你'],
    ['日你'],
    ['睡你'],
    ['搞你'],
    ['艹你'],
  ])('routes sensitive content "%s" to Sonnet', (content) => {
    const msg = makeMsg({ content });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  // ── CHAT_META_TECH_RE tech / meta chatter ───────────────────────────────

  it.each([
    ['usage 烧没了吧'],
    ['你vpn好用吗'],
    ['claude 又抽风了'],
    ['穿梭能连么'],
    ['节点不通'],
  ])('routes meta-tech content "%s" to Sonnet', (content) => {
    const msg = makeMsg({ content });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  // ── CHAT_POLITICAL_RE tripwires ─────────────────────────────────────────

  it('routes political trigger 习近平 to Sonnet', () => {
    const msg = makeMsg({ content: '你怎么看习近平' });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  it('routes religious trigger 安拉 to Sonnet', () => {
    const msg = makeMsg({ content: '安拉保佑' });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
  });

  // ── Default Qwen (casual banter) ────────────────────────────────────────

  it.each([
    ['哈哈笑死'],
    ['牛逼'],
    ['草'],
    ['Roselia 哪首最好听'],
  ])('routes casual content "%s" to Qwen', (content) => {
    const msg = makeMsg({ content });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(QWEN);
  });

  // ── Kill switch ─────────────────────────────────────────────────────────

  it('CHAT_QWEN_DISABLED=1 forces Sonnet even for casual triggers', async () => {
    process.env['CHAT_QWEN_DISABLED'] = '1';
    vi.resetModules();
    const { ChatModule: FreshChatModule } = await import('../src/modules/chat.js');
    const freshChat = new FreshChatModule(makeMockClaude(), db, { botUserId: BOT_ID });
    const msg = makeMsg({ content: '哈哈笑死' });
    const picked = (freshChat as unknown as {
      _pickChatModel: (g: string, m: GroupMessage, f: ScoreFactors) => string;
    })._pickChatModel(GROUP_ID, msg, makeFactors());
    expect(picked).toBe(SONNET);
    delete process.env['CHAT_QWEN_DISABLED'];
  });

  // ── Regex non-false-positives ───────────────────────────────────────────

  it.each([
    ['上班好累'],
    ['上车了吗'],
    ['毛茸茸好可爱'],
    ['买了一团毛线'],
  ])('does NOT route innocuous content "%s" to Sonnet', (content) => {
    const msg = makeMsg({ content });
    expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(QWEN);
  });

  // ── DeepSeek primary substitution (DEEPSEEK_ENABLED) ───────────────────────

  describe('with DEEPSEEK_ENABLED=true', () => {
    beforeEach(() => {
      process.env['DEEPSEEK_API_KEY'] = 'test-key';
    });

    it('routes @-mention to deepseek-chat', () => {
      const msg = makeMsg({ content: '哈哈' });
      expect(pick(chat, GROUP_ID, msg, makeFactors({ mention: 1 }))).toBe(DEEPSEEK);
    });

    it('routes reply-to-bot to deepseek-chat', () => {
      const msg = makeMsg({ content: '哈哈' });
      expect(pick(chat, GROUP_ID, msg, makeFactors({ replyToBot: 1 }))).toBe(DEEPSEEK);
    });

    it('routes admin to deepseek-chat', () => {
      const msg = makeMsg({ content: '哈哈', role: 'admin' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(DEEPSEEK);
    });

    it('routes owner to deepseek-chat', () => {
      const msg = makeMsg({ content: '哈哈', role: 'owner' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(DEEPSEEK);
    });

    it('routes sensitive regex to deepseek-chat', () => {
      const msg = makeMsg({ content: '上你' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(DEEPSEEK);
    });

    it('routes tease-active user to deepseek-chat', () => {
      const internal = chat as unknown as {
        _teaseIncrement: (g: string, u: string, now: number) => boolean;
      };
      internal._teaseIncrement(GROUP_ID, 'u1', Date.now());
      const msg = makeMsg({ content: '哈哈', userId: 'u1' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(DEEPSEEK);
    });

    it('lurker fast-path still returns CHAT_QWEN_MODEL regardless of DEEPSEEK_ENABLED', () => {
      const msg = makeMsg({ content: '哈哈笑死' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(QWEN);
    });

    it('CHAT_QWEN_DISABLED=1 returns deepseek-chat (primary)', async () => {
      process.env['CHAT_QWEN_DISABLED'] = '1';
      vi.resetModules();
      const { ChatModule: FreshChatModule } = await import('../src/modules/chat.js');
      const freshChat = new FreshChatModule(makeMockClaude(), db, { botUserId: BOT_ID });
      const msg = makeMsg({ content: '哈哈笑死' });
      const picked = (freshChat as unknown as {
        _pickChatModel: (g: string, m: GroupMessage, f: ScoreFactors) => string;
      })._pickChatModel(GROUP_ID, msg, makeFactors());
      expect(picked).toBe(DEEPSEEK);
      delete process.env['CHAT_QWEN_DISABLED'];
    });
  });

  describe('with DEEPSEEK_ENABLED=false (regression guard)', () => {
    it('routes @-mention to RUNTIME_CHAT_MODEL (Sonnet)', () => {
      const msg = makeMsg({ content: '哈哈' });
      expect(pick(chat, GROUP_ID, msg, makeFactors({ mention: 1 }))).toBe(SONNET);
    });

    it('routes admin to Sonnet', () => {
      const msg = makeMsg({ content: '哈哈', role: 'admin' });
      expect(pick(chat, GROUP_ID, msg, makeFactors())).toBe(SONNET);
    });
  });
});
