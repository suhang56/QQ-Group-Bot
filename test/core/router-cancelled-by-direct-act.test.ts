import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../../src/core/router.js';
import { RateLimiter } from '../../src/core/rateLimiter.js';
import { Database } from '../../src/storage/db.js';
import { DeferQueue } from '../../src/utils/defer-queue.js';
import type { DeferredItem } from '../../src/utils/defer-queue.js';
import { ChatDecisionTracker } from '../../src/modules/chat-decision-tracker.js';
import { defaultGroupConfig } from '../../src/config.js';
import type { GroupMessage, INapCatAdapter } from '../../src/adapter/napcat.js';
import { initLogger, createLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT = 'bot-act';
const GROUP = 'g-act';

let msgCounter = 5000;
function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  const id = String(++msgCounter);
  return {
    messageId: id,
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
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(42),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: GROUP, name: 'T', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function mkItem(msg: GroupMessage, overrides: Partial<DeferredItem> = {}): DeferredItem {
  return {
    groupId: GROUP,
    msg,
    recentMsgs: [],
    queuedAtSec: msg.timestamp,
    deadlineSec: msg.timestamp + 8,
    recheckCount: 0,
    queuedMessageId: msg.messageId,
    queuedInternalId: null,
    ...overrides,
  };
}

describe('Router R2b — _cancelDefersByDirect populates utteranceAct on silent ChatResult', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let deferQueue: DeferQueue;
  let tracker: ChatDecisionTracker;
  let captureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.groupConfig.upsert(defaultGroupConfig(GROUP));
    adapter = makeAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    router.setBotNickname('bot');
    (router as unknown as { botUserId: string }).botUserId = BOT;
    deferQueue = new DeferQueue();
    router.setDeferQueue(deferQueue);
    tracker = new ChatDecisionTracker({
      events: db.chatDecisionEvents,
      effects: db.chatDecisionEffects,
      messages: db.messages,
      logger: createLogger('test'),
    });
    captureSpy = vi.spyOn(tracker, 'captureDecision');
    router.setChatDecisionTracker(tracker);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function callCancelDefers(groupId: string, newMsg: GroupMessage): void {
    const fn = (router as unknown as { _cancelDefersByDirect: (g: string, m: GroupMessage) => void })._cancelDefersByDirect;
    fn.call(router, groupId, newMsg);
  }

  it('t5: deferred plain group msg cancelled by direct → meta.utteranceAct === "chime_in"', () => {
    const deferredMsg = makeMsg({
      content: 'hello world',
      rawContent: 'hello world',
      timestamp: 1000,
    });
    deferQueue.enqueue(mkItem(deferredMsg));

    const directMsg = makeMsg({
      content: 'hi there',
      rawContent: `[CQ:at,qq=${BOT}] hi there`,
      timestamp: 1005,
    });
    callCancelDefers(GROUP, directMsg);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const result = captureSpy.mock.calls[0]![0] as { meta: { decisionPath: string; utteranceAct?: string } };
    expect(result.meta.decisionPath).toBe('silent');
    expect(result.meta.utteranceAct).toBe('chime_in');
  });

  it('t6: deferred [CQ:at,] msg cancelled by direct → meta.utteranceAct === "direct_chat"', () => {
    const deferredMsg = makeMsg({
      content: '在么',
      rawContent: '[CQ:at,qq=99999] 在么',
      timestamp: 2000,
    });
    deferQueue.enqueue(mkItem(deferredMsg));

    const directMsg = makeMsg({
      content: '问个事',
      rawContent: `[CQ:at,qq=${BOT}] 问个事`,
      timestamp: 2005,
    });
    callCancelDefers(GROUP, directMsg);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const result = captureSpy.mock.calls[0]![0] as { meta: { utteranceAct?: string } };
    expect(typeof result.meta.utteranceAct).toBe('string');
    expect(result.meta.utteranceAct).toBe('direct_chat');
  });

  it('t7: multiple cancelled items → each gets its own non-null act, mixed types', () => {
    const plainMsg = makeMsg({
      content: 'hello world',
      rawContent: 'hello world',
      timestamp: 3000,
    });
    const atMsg = makeMsg({
      content: '在么',
      rawContent: '[CQ:at,qq=88888] 在么',
      timestamp: 3000,
    });
    const replyMsg = makeMsg({
      content: '同感',
      rawContent: '[CQ:reply,id=1234] 同感',
      timestamp: 3000,
    });
    deferQueue.enqueue(mkItem(plainMsg));
    deferQueue.enqueue(mkItem(atMsg));
    deferQueue.enqueue(mkItem(replyMsg));

    const directMsg = makeMsg({
      content: '吃了吗',
      rawContent: `[CQ:at,qq=${BOT}] 吃了吗`,
      timestamp: 3010,
    });
    callCancelDefers(GROUP, directMsg);

    expect(captureSpy).toHaveBeenCalledTimes(3);
    const acts = captureSpy.mock.calls.map(c => {
      const r = c[0] as { meta: { utteranceAct?: string } };
      return r.meta.utteranceAct;
    });
    for (const act of acts) {
      expect(act).not.toBeNull();
      expect(act).not.toBeUndefined();
      expect(typeof act).toBe('string');
    }
    expect(acts[0]).toBe('chime_in');
    expect(acts[1]).toBe('direct_chat');
    expect(acts[2]).toBe('direct_chat');
    expect(acts[0]).not.toBe(acts[1]);
  });
});
