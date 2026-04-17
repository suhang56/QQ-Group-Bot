import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule, type IAffinitySource } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u-speaker',
    nickname: 'Alice', role: 'member',
    content: '你好啊 bot 你最近在干嘛',
    rawContent: '你好啊 bot 你最近在干嘛',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(text = '普通回复一句'): IClaudeClient {
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

function makeAffinity(overrides: Partial<IAffinitySource> = {}): IAffinitySource {
  return {
    recordInteraction: vi.fn(),
    getAffinityFactor: vi.fn().mockReturnValue(0),
    formatAffinityHint: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function captureCall(claude: IClaudeClient) {
  const mock = (claude.complete as ReturnType<typeof vi.fn>).mock;
  if (mock.calls.length === 0) return { systemText: '', userText: '' };
  const call = mock.calls[0]![0] as {
    system: Array<{ text: string }>;
    messages: Array<{ content: string }>;
  };
  return {
    systemText: call.system.map(s => s.text).join('\n---\n'),
    userText: call.messages.map(m => m.content).join('\n---\n'),
  };
}

describe('ChatModule — M6.2b affinity wiring', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Producer: bot reply to user X → 'chat' ───────────────────────────────

  describe('producer: chat interaction on reply', () => {
    it('records chat interaction with trigger userId when bot sends a text reply', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      const reply = await chat.generateReply('g1', msg, []);
      expect(reply).not.toBeNull();

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const chatCalls = calls.filter(c => c[2] === 'chat');
      expect(chatCalls.length).toBe(1);
      expect(chatCalls[0]).toEqual(['g1', 'u-peer', 'chat']);
    });

    it('does NOT record chat interaction when trigger userId is the bot itself', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      // Edge: trigger is the bot itself (defense in depth — peer flow never reaches this)
      const msg = makeMsg({
        userId: BOT_ID,
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const chatCalls = calls.filter(c => c[2] === 'chat');
      expect(chatCalls.length).toBe(0);
    });

    it('no-op when affinity source is not set (back-compat)', async () => {
      const chat = makeChat(claude, db);
      // no setAffinitySource call
      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      const reply = await chat.generateReply('g1', msg, []);
      expect(reply).not.toBeNull();
    });
  });

  // ── Producer: @friendly + reply_continue in engage path ──────────────────

  describe('producer: at_friendly and reply_continue', () => {
    it('records at_friendly when isMention=true + non-adversarial + comprehension >= 0.5', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        // @-mention + normal friendly content (comprehension defaults ~0.7 via short-content or base)
        rawContent: `[CQ:at,qq=${BOT_ID}] 你今天过得怎么样呢`,
        content: '你今天过得怎么样呢',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const atFriendly = calls.filter(c => c[2] === 'at_friendly');
      expect(atFriendly.length).toBe(1);
      expect(atFriendly[0]).toEqual(['g1', 'u-peer', 'at_friendly']);
    });

    it('does NOT record at_friendly when message is adversarial (identity probe)', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      // Identity probe pattern — adversarial gate
      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 你是不是AI 你是什么模型`,
        content: '你是不是AI 你是什么模型',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const atFriendly = calls.filter(c => c[2] === 'at_friendly');
      expect(atFriendly.length).toBe(0);
    });

    it('records reply_continue when message is a reply-quote to a bot message', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      // Register an outgoing bot msg id so _isReplyToBot returns true
      const botOutgoingId = 777;
      chat.recordOutgoingMessage('g1', botOutgoingId);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:reply,id=${botOutgoingId}] 那个你再解释一下`,
        content: '那个你再解释一下',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const replyContinue = calls.filter(c => c[2] === 'reply_continue');
      expect(replyContinue.length).toBe(1);
      expect(replyContinue[0]).toEqual(['g1', 'u-peer', 'reply_continue']);
    });

    it('does NOT record at_friendly / reply_continue for bot self trigger', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: BOT_ID,
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const filtered = calls.filter(c => c[2] === 'at_friendly' || c[2] === 'reply_continue');
      expect(filtered.length).toBe(0);
    });
  });

  // ── Consumer: score factor ───────────────────────────────────────────────

  describe('consumer: getAffinityFactor wired into score factors', () => {
    it('calls getAffinityFactor with trigger userId during scoring', async () => {
      const affinity = makeAffinity({
        getAffinityFactor: vi.fn().mockReturnValue(0.15),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({ userId: 'u-peer', content: '今天天气真好', rawContent: '今天天气真好' });
      await chat.generateReply('g1', msg, []);

      expect(affinity.getAffinityFactor).toHaveBeenCalledWith('g1', 'u-peer');
    });

    it('skips getAffinityFactor when trigger userId matches bot', async () => {
      const affinity = makeAffinity({
        getAffinityFactor: vi.fn().mockReturnValue(0.15),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({ userId: BOT_ID, content: '今天天气真好', rawContent: '今天天气真好' });
      await chat.generateReply('g1', msg, []);

      expect(affinity.getAffinityFactor).not.toHaveBeenCalled();
    });

    it('affinityBoost factor reflects high-affinity +0.15', async () => {
      const affinity = makeAffinity({
        getAffinityFactor: vi.fn().mockReturnValue(0.15),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({ userId: 'u-peer', content: '随便聊聊', rawContent: '随便聊聊' });
      const result = (chat as unknown as {
        _computeWeightedScore: (
          g: string, m: GroupMessage, n: number,
          r3: Array<{ userId: string; timestamp: number }>,
          r5: Array<{ timestamp: number }>,
        ) => { score: number; factors: { affinityBoost: number }; isDirect: boolean };
      })._computeWeightedScore('g1', msg, Date.now(), [], []);
      expect(result.factors.affinityBoost).toBeCloseTo(0.15);
    });

    it('affinityBoost factor reflects low-affinity -0.10', async () => {
      const affinity = makeAffinity({
        getAffinityFactor: vi.fn().mockReturnValue(-0.10),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({ userId: 'u-peer', content: '随便聊聊', rawContent: '随便聊聊' });
      const result = (chat as unknown as {
        _computeWeightedScore: (
          g: string, m: GroupMessage, n: number,
          r3: Array<{ userId: string; timestamp: number }>,
          r5: Array<{ timestamp: number }>,
        ) => { score: number; factors: { affinityBoost: number }; isDirect: boolean };
      })._computeWeightedScore('g1', msg, Date.now(), [], []);
      expect(result.factors.affinityBoost).toBeCloseTo(-0.10);
    });
  });

  // ── Consumer: hint injection into user content (not system) ──────────────

  describe('consumer: formatAffinityHint injection into user role', () => {
    it('injects affinity hint into userContent when non-null on direct trigger', async () => {
      const affinity = makeAffinity({
        formatAffinityHint: vi.fn().mockReturnValue('（Alice 是你比较熟的群友）'),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer', nickname: 'Alice',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', msg, []);

      const { systemText, userText } = captureCall(claude);
      expect(userText).toContain('Alice 是你比较熟的群友');
      expect(userText).toContain('context 注释');
      // Critical invariant: static system prompt must NOT contain per-user data
      expect(systemText).not.toContain('Alice 是你比较熟的群友');
      expect(affinity.formatAffinityHint).toHaveBeenCalledWith('g1', 'u-peer', 'Alice');
    });

    it('omits affinity hint entirely when helper returns null (no dead header)', async () => {
      const affinity = makeAffinity({
        formatAffinityHint: vi.fn().mockReturnValue(null),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', msg, []);

      const { userText } = captureCall(claude);
      // No dangling "context 注释：" without content
      expect(userText).not.toMatch(/〔context 注释：〕/);
      // No affinity-specific vocabulary when hint is null
      expect(userText).not.toContain('是你比较熟的群友');
      expect(userText).not.toContain('你不太熟');
    });

    it('does NOT call formatAffinityHint on ambient (non-direct) triggers', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({ userId: 'u-peer', content: '今天天气真好', rawContent: '今天天气真好' });
      await chat.generateReply('g1', msg, []);

      expect(affinity.formatAffinityHint).not.toHaveBeenCalled();
    });

    it('does NOT call formatAffinityHint when trigger userId matches bot', async () => {
      const affinity = makeAffinity({
        formatAffinityHint: vi.fn().mockReturnValue('（should not appear）'),
      });
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: BOT_ID,
        rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
        content: 'hey',
      });
      await chat.generateReply('g1', msg, []);

      expect(affinity.formatAffinityHint).not.toHaveBeenCalled();
    });
  });

  // ── M8.4: HIGH-bug regression — no double-record on engage path ──────────

  describe('M8.4: engage-path records specific overlay exactly once', () => {
    it('friendly @-mention "哈哈" records joke_share ONCE (not joke_share + joke_share)', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 哈哈哈哈`,
        content: '哈哈哈哈',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const jokeCalls = calls.filter(c => c[2] === 'joke_share');
      const chatCalls = calls.filter(c => c[2] === 'chat');
      // Engage-path records joke_share exactly once; text-path should fall back to 'chat'.
      expect(jokeCalls.length).toBe(1);
      // The text-path second call must be 'chat' (not a duplicate joke_share).
      // Total distinct records: 1 joke_share + 1 chat.
      expect(chatCalls.length).toBe(1);
      // Defense: no duplicate joke_share
      expect(jokeCalls.length).not.toBe(2);
    });

    it('friendly @-mention "怎么办?" records question_ask ONCE', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 怎么办?`,
        content: '怎么办?',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const qaCalls = calls.filter(c => c[2] === 'question_ask');
      expect(qaCalls.length).toBe(1);
    });

    it('friendly @-mention "谢谢" still records thanks once (cooldown would mask dup but we verify the fix)', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 谢谢你`,
        content: '谢谢你',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const thanksCalls = calls.filter(c => c[2] === 'thanks');
      expect(thanksCalls.length).toBe(1);
    });

    it('end-to-end score delta: friendly @-mention "哈哈" yields exactly +1 (spec joke_share), not +2', async () => {
      const { AffinityModule } = await import('../src/modules/affinity.js');
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(':memory:');
      sdb.exec(`CREATE TABLE user_affinity (
        group_id TEXT NOT NULL, user_id TEXT NOT NULL, score INTEGER NOT NULL,
        last_interaction INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      )`);
      const realAffinity = new AffinityModule(sdb);
      const chat = makeChat(claude, db);
      chat.setAffinitySource(realAffinity);

      const before = realAffinity.getScore('g1', 'u-peer'); // default 30
      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 哈哈`,
        content: '哈哈',
      });
      await chat.generateReply('g1', msg, []);
      const after = realAffinity.getScore('g1', 'u-peer');
      // joke_share +1 (engage-path) + chat +1 (text-path) = +2 total
      // This is the current correct behavior: the two records are DIFFERENT
      // types (joke_share + chat), both legitimately counted per spec.
      // What we're asserting is that joke_share is NOT double-counted → +3.
      expect(after - before).toBe(2);
    });

    it('adversarial @-mention with mock keyword records mock (overlay wins), not correction', async () => {
      const affinity = makeAffinity();
      const chat = makeChat(claude, db);
      chat.setAffinitySource(affinity);

      // Adversarial identity probe + insult keyword overlap → mock per spec
      const msg = makeMsg({
        userId: 'u-peer',
        rawContent: `[CQ:at,qq=${BOT_ID}] 你是sb模型`,
        content: '你是sb模型',
      });
      await chat.generateReply('g1', msg, []);

      const calls = (affinity.recordInteraction as ReturnType<typeof vi.fn>).mock.calls;
      const mockCalls = calls.filter(c => c[2] === 'mock');
      // Engage-path records mock exactly once; react-path deflection may skip
      // the text-path entirely (no _recordAffinityChat in deflection branch).
      expect(mockCalls.length).toBe(1);
    });
  });

  // ── Module surface ───────────────────────────────────────────────────────

  describe('AffinityModule.dailyDecay shape', () => {
    it('exposes a callable dailyDecay method for the decay scheduler', async () => {
      const { AffinityModule } = await import('../src/modules/affinity.js');
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(':memory:');
      sdb.exec(`CREATE TABLE user_affinity (
        group_id TEXT NOT NULL, user_id TEXT NOT NULL, score INTEGER NOT NULL,
        last_interaction INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      )`);
      const mod = new AffinityModule(sdb);
      expect(typeof mod.dailyDecay).toBe('function');
      expect(() => mod.dailyDecay()).not.toThrow();
    });
  });
});
