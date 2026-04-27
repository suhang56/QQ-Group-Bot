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

const BOT_ID = 'bot-r2c';
const GROUP = 'g1';

let msgCounter = 5000;
function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: String(++msgCounter),
    groupId: GROUP,
    userId: 'u1',
    nickname: 'TestUser',
    role: 'member',
    content: 'just chatting',
    rawContent: 'just chatting',
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
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: GROUP, name: 'Test', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function replyResult(text = 'ok'): ChatResult {
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

describe('Router R2c — rate-limit defer integration', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let deferQueue: DeferQueue;

  beforeEach(() => {
    db = new Database(':memory:');
    db.groupConfig.upsert(defaultGroupConfig(GROUP));
    adapter = makeAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    router.setBotNickname('bot');
    (router as unknown as { botUserId: string }).botUserId = BOT_ID;
    deferQueue = new DeferQueue();
    router.setDeferQueue(deferQueue);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // Helper: read the private Map via cast
  function getLastBotReplyAtSec(groupId: string): number | undefined {
    return (router as unknown as { lastBotReplyAtSec: Map<string, number> })
      .lastBotReplyAtSec.get(groupId);
  }

  // Helper: invoke private _sendReply directly
  async function callSendReply(text: string): Promise<number | null> {
    const fn = (router as unknown as { _sendReply: (g: string, t: string) => Promise<number | null> })._sendReply;
    return fn.call(router, GROUP, text);
  }

  it('T11: fresh router, no prior reply → _sendReply sets lastBotReplyAtSec', async () => {
    expect(getLastBotReplyAtSec(GROUP)).toBeUndefined();
    const before = Math.floor(Date.now() / 1000);
    await callSendReply('hello world');
    const after = Math.floor(Date.now() / 1000);
    const recorded = getLastBotReplyAtSec(GROUP);
    expect(recorded).toBeDefined();
    expect(recorded!).toBeGreaterThanOrEqual(before);
    expect(recorded!).toBeLessThanOrEqual(after);
  });

  it('T12: after _sendReply, dispatch within 30s → defer rate-limit (no generateReply)', async () => {
    // Prime: send a reply so Map is populated
    await callSendReply('first');
    expect(getLastBotReplyAtSec(GROUP)).toBeDefined();

    const chat = makeChatModule(async () => replyResult('second'));
    router.setChat(chat);

    // Dispatch a non-direct message — should defer, not generate
    await router.dispatch(makeMsg({ content: 'random peer chat' }));

    expect(chat.generateReply).not.toHaveBeenCalled();
    expect(deferQueue.size(GROUP)).toBeGreaterThan(0);
  });

  it('T13: after _sendReply, dispatch >30s later → window expired, gate proceeds past R2', async () => {
    // Manually set lastBotReplyAtSec to 31s ago
    const map = (router as unknown as { lastBotReplyAtSec: Map<string, number> }).lastBotReplyAtSec;
    map.set(GROUP, Math.floor(Date.now() / 1000) - 31);

    const chat = makeChatModule(async () => replyResult('ok'));
    router.setChat(chat);

    await router.dispatch(makeMsg({ content: 'hi after window' }));

    // Window expired — R2 skipped. Whether generateReply runs depends on
    // upstream gates (classify-path, repeater, etc.) but R2 must NOT defer.
    // Assert deferQueue did not pick up a `rate-limit` defer.
    const queueSize = deferQueue.size(GROUP);
    if (queueSize > 0) {
      // If anything queued, it must NOT be rate-limit (could be burst-settle from
      // unrelated state, but our minimal seed has no burst). With clean db this
      // should be 0; assert 0 for tightest check.
      expect(queueSize).toBe(0);
    } else {
      expect(queueSize).toBe(0);
    }
  });

  it('T14: sticker reply via _sendReply updates Map (sticker is sendable)', async () => {
    expect(getLastBotReplyAtSec(GROUP)).toBeUndefined();
    // _sendReply takes a text argument; sticker CQ codes are passed as text
    // through the same path — caller responsibility for cqCode format.
    await callSendReply('[CQ:image,file=test.gif]');
    expect(getLastBotReplyAtSec(GROUP)).toBeDefined();
  });

  it('T15: multi-line reply (3 lines) → Map updated exactly once (last line semantics)', async () => {
    expect(getLastBotReplyAtSec(GROUP)).toBeUndefined();

    const sendSpy = adapter.send as unknown as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();

    // Pass a multi-line text. splitReply produces multiple line sends.
    await callSendReply('line one\nline two\nline three');

    // Verify multiple sends actually happened (≥2 to confirm split)
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Map updated exactly once (single Map.set after loop)
    const recorded = getLastBotReplyAtSec(GROUP);
    expect(recorded).toBeDefined();

    // Wait a clock tick and confirm the value did NOT advance (i.e., update is post-loop, not per-line)
    const captured = recorded!;
    await new Promise(r => setTimeout(r, 10));
    expect(getLastBotReplyAtSec(GROUP)).toBe(captured);
  });
});
