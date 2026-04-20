import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../../src/core/router.js';
import { RateLimiter } from '../../src/core/rateLimiter.js';
import { Database } from '../../src/storage/db.js';
import { DeferQueue } from '../../src/utils/defer-queue.js';
import { defaultGroupConfig } from '../../src/config.js';
import type { GroupMessage, INapCatAdapter } from '../../src/adapter/napcat.js';
import type { IChatModule } from '../../src/modules/chat.js';
import type { ChatResult } from '../../src/utils/chat-result.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-r2a';

let msgCounter = 1000;
function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: String(++msgCounter),
    groupId: 'g1',
    userId: 'u1',
    nickname: 'TestUser',
    role: 'member',
    content: 'hello',
    rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(42),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function reply(text = 'ok'): ChatResult {
  return {
    kind: 'reply', text,
    meta: { decisionPath: 'normal', evasive: false, injectedFactIds: [], matchedFactIds: [], usedVoiceCount: 0, usedFactHint: false },
    reasonCode: 'engaged',
  };
}

function makeChatModule(generateReplyImpl: () => Promise<ChatResult>): IChatModule {
  return {
    generateReply: vi.fn().mockImplementation(generateReplyImpl),
    generatePrivateReply: vi.fn().mockResolvedValue(null),
    recordOutgoingMessage: vi.fn(),
    markReplyToUser: vi.fn(),
    invalidateLore: vi.fn(),
    tickStickerRefresh: vi.fn(),
    getMoodTracker: vi.fn(),
    noteAdminActivity: vi.fn(),
    getConsecutiveReplies: vi.fn().mockReturnValue(0),
    getActivityLevel: vi.fn().mockReturnValue('normal'),
  } as unknown as IChatModule;
}

describe('Router R2a — classifyPath integration', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let deferQueue: DeferQueue;

  beforeEach(() => {
    db = new Database(':memory:');
    db.groupConfig.upsert(defaultGroupConfig('g1'));
    adapter = makeAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    router.setBotNickname('bot');
    deferQueue = new DeferQueue();
    router.setDeferQueue(deferQueue);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function seedRecent(contents: Array<{ userId: string; content: string }>): void {
    const now = Math.floor(Date.now() / 1000);
    contents.forEach((c, i) => {
      db.messages.insert({
        groupId: 'g1',
        userId: c.userId,
        nickname: c.userId === BOT_ID ? 'bot' : `user-${c.userId}`,
        content: c.content,
        rawContent: c.content,
        timestamp: now - (contents.length - i),
        deleted: false,
      }, `seed-${i}`);
    });
  }

  function seedBurst(count: number): void {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < count; i++) {
      db.messages.insert({
        groupId: 'g1',
        userId: `burst-u-${i % 3}`,
        nickname: `u${i % 3}`,
        content: `burst ${i}`,
        rawContent: `burst ${i}`,
        timestamp: now,
        deleted: false,
      }, `burst-${i}`);
    }
  }

  it('burst + plain chat → classifyPath=timing-gated → evaluatePreGenerate reached + defer enqueued', async () => {
    const chat = makeChatModule(async () => reply());
    router.setChat(chat);
    // Set bot user id so classify-path signals compute
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;

    // Create burst condition: many recent messages close together to trigger rate-limit defer
    seedBurst(10);

    await router.dispatch(makeMsg({ content: 'just chatting about stuff' }));

    // generateReply should NOT be called — we're deferred
    expect(chat.generateReply).not.toHaveBeenCalled();
    // deferQueue should have enqueued the message
    expect(deferQueue.size('g1')).toBeGreaterThan(0);
  });

  it('burst + /stats (registered admin cmd) → handled by command dispatch at line 525, classifyPath never reached', async () => {
    const chat = makeChatModule(async () => reply());
    router.setChat(chat);
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;
    seedBurst(10);

    await router.dispatch(makeMsg({ content: '/stats', role: 'admin' }));

    // /stats is dispatched as a command; chat.generateReply not called; nothing deferred
    expect(chat.generateReply).not.toHaveBeenCalled();
    expect(deferQueue.size('g1')).toBe(0);
    // /stats response is sent via adapter
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('统计数据'));
  });

  it('relay echo (3 identical peer msgs) → classifyPath=ultra-light → generateReply called, timing gate bypassed', async () => {
    // Repeater fires on 3 identical-content recent messages at router.ts:582 BEFORE classifyPath,
    // so disable repeaterEnabled to isolate the R2a ultra-light path. This matches PLAN §3 case #6
    // ("burst + repeater" → N/A in classifyPath): repeater sits ahead of classifyPath by design.
    // upsert doesn't persist repeater_enabled, so patch via direct UPDATE.
    db.exec(`UPDATE group_config SET repeater_enabled = 0 WHERE group_id = 'g1'`);
    const chat = makeChatModule(async () => reply('666'));
    router.setChat(chat);
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;

    // Seed 3 identical short peer msgs — detectRelay needs last 3 peers all equal, 1-4 chars
    seedRecent([
      { userId: 'peer-a', content: '666' },
      { userId: 'peer-b', content: '666' },
      { userId: 'peer-c', content: '666' },
    ]);

    await router.dispatch(makeMsg({ content: '666', userId: 'peer-d' }));

    // Ultra-light path: chat.generateReply IS called (relay branch handles echo/silent inside chat.ts)
    expect(chat.generateReply).toHaveBeenCalledTimes(1);
    // Timing gate was bypassed — no defer enqueued
    expect(deferQueue.size('g1')).toBe(0);
  });

  it('reply-to-bot → classifyPath=direct → routed to _enqueueAtMention (timing gate bypassed)', async () => {
    const chat = makeChatModule(async () => reply());
    router.setChat(chat);
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;

    // Seed bot as having spoken recently
    seedRecent([{ userId: BOT_ID, content: '之前的回复' }]);
    // Burst to prove timing gate WOULD have deferred the organic path
    seedBurst(10);

    const raw = '[CQ:reply,id=999]哈';
    await router.dispatch(makeMsg({ content: '哈', rawContent: raw }));

    // Direct path → _enqueueAtMention → _processAtMention → chat.generateReply
    // (queue cap / in-flight dedup should let this through since atQueue is empty)
    expect(chat.generateReply).toHaveBeenCalledTimes(1);
    // Direct path bypassed the deferQueue
    expect(deferQueue.size('g1')).toBe(0);
  });

  it('@bot still branches at line 673 (pre-existing), classifyPath not reached', async () => {
    const chat = makeChatModule(async () => reply());
    router.setChat(chat);
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;
    seedBurst(10);

    const raw = `[CQ:at,qq=${BOT_ID}]hello`;
    await router.dispatch(makeMsg({ content: 'hello', rawContent: raw }));

    // @-mention routes through _enqueueAtMention regardless of R2a
    expect(chat.generateReply).toHaveBeenCalledTimes(1);
    expect(deferQueue.size('g1')).toBe(0);
  });
});
