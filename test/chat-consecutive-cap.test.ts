import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { isSendable } from '../src/utils/chat-result.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { MAX_CONSECUTIVE_BOT_REPLIES } from '../src/modules/engagement-decision.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-cap';
const GROUP_ID = 'g-cap';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP_ID, userId: 'u-peer',
    nickname: 'Alice', role: 'member',
    content: '随便聊聊', rawContent: '随便聊聊',
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

/**
 * Low chatMinScore so non-direct messages clear Gate 6 on their own, letting
 * us isolate Gate 5.6 behavior. chatSilenceBonusSec short-circuited to avoid
 * silence-factor drift between calls.
 */
function makeChat(db: Database, claude: IClaudeClient, overrides: Record<string, unknown> = {}): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    chatSilenceBonusSec: 999999,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
    ...overrides,
  });
}

type CounterMap = { get: (k: string) => number | undefined; set: (k: string, v: number) => void };

function readCount(chat: ChatModule, groupId: string): number {
  const m = (chat as unknown as { consecutiveReplies: CounterMap }).consecutiveReplies;
  return m.get(groupId) ?? 0;
}

function seedCount(chat: ChatModule, groupId: string, n: number): void {
  (chat as unknown as { consecutiveReplies: CounterMap }).consecutiveReplies.set(groupId, n);
}

function callRecordOwn(chat: ChatModule, groupId: string, reply: string): void {
  (chat as unknown as { _recordOwnReply: (g: string, r: string) => void })._recordOwnReply(groupId, reply);
}

function callBump(chat: ChatModule, groupId: string): void {
  (chat as unknown as { _bumpConsecutive: (g: string) => void })._bumpConsecutive(groupId);
}

describe('ChatModule — M6.4 consecutive-reply cap', () => {
  let db: Database;
  let claude: ReturnType<typeof makeMockClaude>;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    chat = makeChat(db, claude);
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // ── Counter mechanics ────────────────────────────────────────────────
  it('_recordOwnReply bumps the consecutive-reply counter', () => {
    expect(readCount(chat, GROUP_ID)).toBe(0);
    callRecordOwn(chat, GROUP_ID, 'first');
    expect(readCount(chat, GROUP_ID)).toBe(1);
    callRecordOwn(chat, GROUP_ID, 'second');
    expect(readCount(chat, GROUP_ID)).toBe(2);
  });

  it('_bumpConsecutive increments by one', () => {
    callBump(chat, GROUP_ID);
    callBump(chat, GROUP_ID);
    callBump(chat, GROUP_ID);
    expect(readCount(chat, GROUP_ID)).toBe(3);
  });

  // ── Gate 5.6 behavior via generateReply ──────────────────────────────
  it('bot monologued to cap → next non-direct peer msg is skipped via Gate 5.6', async () => {
    seedCount(chat, GROUP_ID, MAX_CONSECUTIVE_BOT_REPLIES);
    claude.complete = vi.fn();

    const result = await chat.generateReply(
      GROUP_ID, makeMsg({ messageId: 'post-cap', content: '继续聊' }), [],
    );
    expect(result.kind).toBe('silent');
    expect(claude.complete).not.toHaveBeenCalled();
    // Reset happened as part of the call.
    expect(readCount(chat, GROUP_ID)).toBe(0);
  });

  it('direct @-mention bypasses the cap and lets the reply through', async () => {
    seedCount(chat, GROUP_ID, MAX_CONSECUTIVE_BOT_REPLIES);

    const atMsg = makeMsg({
      messageId: 'at',
      content: '说话',
      rawContent: `[CQ:at,qq=${BOT_ID}] 说话`,
    });
    const result = await chat.generateReply(GROUP_ID, atMsg, []);
    expect(result.kind).not.toBe('silent');
    // Counter should have reset AND then been bumped by the reply (value = 1).
    expect(readCount(chat, GROUP_ID)).toBe(1);
  });

  it('direct reply-to-bot bypasses the cap', async () => {
    seedCount(chat, GROUP_ID, MAX_CONSECUTIVE_BOT_REPLIES + 2);

    // Register a recent outgoing bot message so _isReplyToBot can match it.
    chat.recordOutgoingMessage(GROUP_ID, 99999);
    const replyMsg = makeMsg({
      messageId: 'reply-to-bot',
      content: '回复下',
      rawContent: '[CQ:reply,id=99999] 回复下',
    });
    const result = await chat.generateReply(GROUP_ID, replyMsg, []);
    expect(result.kind).not.toBe('silent');
  });

  it('peer message (any) resets counter back to 0', async () => {
    seedCount(chat, GROUP_ID, 2);
    // A non-direct peer msg that will be engaged (low threshold → reply).
    await chat.generateReply(GROUP_ID, makeMsg({ content: 'hello' }), []);
    // Reset to 0 at top, then bumped to 1 by _recordOwnReply on reply.
    expect(readCount(chat, GROUP_ID)).toBe(1);
  });

  it('count below cap lets non-direct msg proceed to Claude', async () => {
    seedCount(chat, GROUP_ID, MAX_CONSECUTIVE_BOT_REPLIES - 1);
    const result = await chat.generateReply(GROUP_ID, makeMsg({ content: 'hi there' }), []);
    expect(result.kind).not.toBe('silent');
  });

  // ── Edge: deflection path bumps counter (sentinel path that bypasses _recordOwnReply) ──
  it('edge: deflection path (adversarial) bumps counter even though it bypasses _recordOwnReply', async () => {
    seedCount(chat, GROUP_ID, 0);
    // IDENTITY_PROBE pattern triggers deflection. @-mention makes it direct so Gate 5.6 doesn't block.
    const adversarial = makeMsg({
      messageId: 'adv',
      content: '你是AI吗',
      rawContent: `[CQ:at,qq=${BOT_ID}] 你是AI吗`,
    });
    await chat.generateReply(GROUP_ID, adversarial, []);
    // Reset at 1189 → 0, deflection path bumps → 1.
    expect(readCount(chat, GROUP_ID)).toBe(1);
  });

  // ── Edge: pure @-mention deflection bumps counter ──
  it('edge: pure @-mention (at_only deflection) bumps counter', async () => {
    seedCount(chat, GROUP_ID, 0);
    const pureAt = makeMsg({
      messageId: 'pure-at',
      content: '',
      rawContent: `[CQ:at,qq=${BOT_ID}]`,
    });
    await chat.generateReply(GROUP_ID, pureAt, []);
    expect(readCount(chat, GROUP_ID)).toBe(1);
  });

  // ── Edge: debounced peer msg still resets counter ──
  it('edge: debounced peer msg still resets counter (reset runs before debounce)', async () => {
    // Debounce window large, two rapid peer msgs: first sets lastTrigger, second is debounced.
    const debouncedChat = makeChat(db, claude, { debounceMs: 5000 });
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
    seedCount(debouncedChat, GROUP_ID, 2);
    // First peer msg (will reset counter, debounce map gets set, no prior → passes debounce)
    await debouncedChat.generateReply(GROUP_ID, makeMsg({ messageId: 'p1', content: 'hi' }), []);
    // Counter is now 1 (reset then bumped by reply).
    seedCount(debouncedChat, GROUP_ID, 5); // simulate bot monologued via proactive
    // Second peer msg arrives immediately → debounced inside generateReply, but reset still ran.
    const result = await debouncedChat.generateReply(GROUP_ID, makeMsg({ messageId: 'p2', content: '再说' }), []);
    expect(result.kind).toBe('silent'); // debounced
    expect(readCount(debouncedChat, GROUP_ID)).toBe(0); // reset fired despite debounce
  });

  // ── Edge: consecutive counter survives short-ack / meta / pic-bot skip paths ──
  it('short-ack skip still reset counter (peer spoke, even if skip)', async () => {
    seedCount(chat, GROUP_ID, 3);
    const ack = makeMsg({ content: '好的', rawContent: '好的' });
    const result = await chat.generateReply(GROUP_ID, ack, []);
    expect(result.kind).toBe('silent'); // short ack → skip
    expect(readCount(chat, GROUP_ID)).toBe(0); // reset ran
  });

  // ── Edge: proactive _sendProactive bumps counter (monologue detection) ──
  it('edge: _sendProactive bumps counter (proactive speech counts toward cap)', async () => {
    type SendFn = (g: string, t: string, n: number, r: string) => Promise<void>;
    const sendProactive = (chat as unknown as { _sendProactive: SendFn })._sendProactive.bind(chat);
    // Give _sendProactive an adapter that succeeds so the path completes.
    (chat as unknown as { setProactiveAdapter: (fn: (g: string, t: string) => Promise<number | null>) => void })
      .setProactiveAdapter(() => Promise.resolve(1));

    const now = Date.now();
    await sendProactive(GROUP_ID, 'proactive 1', now, 'mood');
    await sendProactive(GROUP_ID, 'proactive 2', now, 'mood');
    await sendProactive(GROUP_ID, 'proactive 3', now, 'mood');
    expect(readCount(chat, GROUP_ID)).toBe(MAX_CONSECUTIVE_BOT_REPLIES);
  });

  // ── Cap value sanity ──
  it('MAX_CONSECUTIVE_BOT_REPLIES is 3', () => {
    expect(MAX_CONSECUTIVE_BOT_REPLIES).toBe(3);
  });
});
