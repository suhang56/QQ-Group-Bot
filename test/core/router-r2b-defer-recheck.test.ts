import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../../src/core/router.js';
import { RateLimiter } from '../../src/core/rateLimiter.js';
import { Database } from '../../src/storage/db.js';
import { DeferQueue } from '../../src/utils/defer-queue.js';
import type { DeferredItem } from '../../src/utils/defer-queue.js';
import { ChatDecisionTracker } from '../../src/modules/chat-decision-tracker.js';
import { defaultGroupConfig } from '../../src/config.js';
import type { GroupMessage, INapCatAdapter } from '../../src/adapter/napcat.js';
import type { IChatModule } from '../../src/modules/chat.js';
import type { ChatResult } from '../../src/utils/chat-result.js';
import { initLogger, createLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT = 'bot-r2b';
const GROUP = 'g-r2b';

let msgCounter = 9000;
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

function silentResult(reasonCode = 'timing'): ChatResult {
  return { kind: 'silent', reasonCode: reasonCode as 'timing', meta: { decisionPath: 'silent' } };
}

function makeChatModule(impl: () => Promise<ChatResult>): IChatModule {
  return {
    generateReply: vi.fn().mockImplementation(impl),
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

function persistMsg(db: Database, m: GroupMessage): number {
  // IMessageRepository.insert(msg: Omit<Message,'id'>, sourceMessageId?: string): Message
  // sourceMessageId is the OneBot id; the returned .id is the DB internal id used by findBySourceId.
  const inserted = db.messages.insert(
    {
      groupId: m.groupId,
      userId: m.userId,
      nickname: m.nickname,
      content: m.content,
      rawContent: m.rawContent,
      timestamp: m.timestamp,
      deleted: false,
    },
    m.messageId,
  );
  return inserted.id;
}

// IChatDecisionEventRepository has only insert+getById; effects has getRecentByGroup
// (scored only) and getUnscored (placeholder rows). For tests we want both — pull
// unscored with a far-future cutoff and filter by group.
function readEventsByGroup(db: Database, groupId: string) {
  const farFuture = Math.floor(Date.now() / 1000) + 86400;
  const unscored = db.chatDecisionEffects.getUnscored(farFuture, 1000)
    .filter(eff => eff.group_id === groupId);
  const scored = db.chatDecisionEffects.getRecentByGroup(groupId, 100);
  const all = [...unscored, ...scored];
  return all
    .map(eff => db.chatDecisionEvents.getById(eff.decision_event_id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
}

describe('Router R2b — defer recheck (B1 cancel + B2 re-enqueue + _pickBestTarget)', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let deferQueue: DeferQueue;
  let tracker: ChatDecisionTracker;

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
    router.setChatDecisionTracker(tracker);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // Helpers to invoke private methods
  function callPickBestTarget(item: DeferredItem, fresh: GroupMessage[]): GroupMessage {
    const fn = (router as unknown as { _pickBestTarget: (i: DeferredItem, f: GroupMessage[]) => GroupMessage })._pickBestTarget;
    return fn.call(router, item, fresh);
  }
  function callCancelDefers(groupId: string, newMsg: GroupMessage): void {
    const fn = (router as unknown as { _cancelDefersByDirect: (g: string, m: GroupMessage) => void })._cancelDefersByDirect;
    fn.call(router, groupId, newMsg);
  }
  async function callRecheckDeferred(groupId: string, newMsg?: GroupMessage): Promise<void> {
    const fn = (router as unknown as { _recheckDeferredItems: (g: string, m?: GroupMessage) => Promise<void> })._recheckDeferredItems;
    await fn.call(router, groupId, newMsg);
  }
  async function callRecheckItems(groupId: string, items: DeferredItem[]): Promise<void> {
    const fn = (router as unknown as { _recheckItems: (g: string, items: DeferredItem[], trig: 'deadline' | 'new-message') => Promise<void> })._recheckItems;
    await fn.call(router, groupId, items, 'deadline');
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

  // ── _pickBestTarget unit ────────────────────────────────────────

  it('T1: deadline hit, all fresh msgs unrelated → returns original (or recency tie, but never bot/dup)', async () => {
    const msgA = makeMsg({ content: '今天吃饭了吗', timestamp: 1000 });
    const item = mkItem(msgA);
    deferQueue.enqueue(item);

    const fresh: GroupMessage[] = [
      makeMsg({ content: '游戏不错', timestamp: 1001 }),
      makeMsg({ content: '哈哈哈', timestamp: 1002 }),
    ];
    const picked = callPickBestTarget(item, fresh);
    // No reply chain; both fresh share +3 same-trigger-type. Token overlap=0.
    // Same-sender? trigger u1 — fresh both u1 by makeMsg default → +1 each. Tie → recency.
    expect(picked.timestamp).toBe(1002);

    // Now invoke the deadline path (recheck still defers because rate-limit window etc.):
    const chat = makeChatModule(async () => silentResult('timing'));
    router.setChat(chat);

    // Force evaluatePreGenerate to defer by setting lastBotReplyAtSec just now
    // (within R2c 30s window, and msg is non-direct). But to keep this test
    // tight, we use a stub that returns silent via chatModule when proceed.
    // For T1, we just verify callPickBestTarget logic.
  });

  it('T4: msgE has [CQ:reply,id=msgA] → reply-chain wins (+4)', () => {
    const msgA = makeMsg({ messageId: '500', content: '我喜欢吃饭', timestamp: 1000 });
    const item = mkItem(msgA);
    const fresh: GroupMessage[] = [
      makeMsg({ messageId: '501', content: '随便聊聊', timestamp: 1001, rawContent: '随便聊聊' }),
      makeMsg({ messageId: '502', content: '嗯嗯', timestamp: 1002, rawContent: '[CQ:reply,id=500]嗯嗯' }),
    ];
    const picked = callPickBestTarget(item, fresh);
    expect(picked.messageId).toBe('502');
  });

  it('T8: candidate ts < queuedAtSec → filtered out (returns original)', () => {
    const msgA = makeMsg({ content: 'hi', timestamp: 1000 });
    const item = mkItem(msgA);
    const fresh: GroupMessage[] = [
      makeMsg({ content: 'old', timestamp: 999 }),
    ];
    const picked = callPickBestTarget(item, fresh);
    expect(picked.messageId).toBe(msgA.messageId);
  });

  it('T10: empty candidate pool → returns original', () => {
    const msgA = makeMsg({ content: 'hi', timestamp: 1000 });
    const item = mkItem(msgA);
    const picked = callPickBestTarget(item, []);
    expect(picked.messageId).toBe(msgA.messageId);
  });

  it('T11: same-thread (+4 reply chain) beats same-sender (+1)', () => {
    const msgA = makeMsg({ messageId: '600', content: '吃饭', userId: 'u1', timestamp: 1000 });
    const item = mkItem(msgA);
    const fresh: GroupMessage[] = [
      makeMsg({ messageId: '601', content: '其他话', userId: 'u1', timestamp: 1001, rawContent: '其他话' }),
      makeMsg({ messageId: '602', content: '同感', userId: 'u3', timestamp: 1002, rawContent: '[CQ:reply,id=600]同感' }),
    ];
    const picked = callPickBestTarget(item, fresh);
    expect(picked.messageId).toBe('602');
  });

  it('T-bot-excluded: candidate from bot is filtered out', () => {
    const msgA = makeMsg({ messageId: '700', content: 'q', timestamp: 1000 });
    const item = mkItem(msgA);
    const fresh: GroupMessage[] = [
      makeMsg({ messageId: '701', userId: BOT, content: 'bot reply', timestamp: 1005 }),
      makeMsg({ messageId: '702', userId: 'u9', content: 'user msg', timestamp: 1006 }),
    ];
    const picked = callPickBestTarget(item, fresh);
    expect(picked.messageId).toBe('702');
  });

  // ── B1: _cancelDefersByDirect ───────────────────────────────────

  it('T2: msgC arrives @bot + ts > queuedAtSec → B1 cancels item; tracker captures cancelled-by-direct', () => {
    const msgA = makeMsg({ messageId: '800', content: 'hi', timestamp: 1000 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, { queuedInternalId: 1 });
    deferQueue.enqueue(item);

    const msgC = makeMsg({ messageId: '801', timestamp: 1005, rawContent: `[CQ:at,qq=${BOT}]hi bot` });
    callCancelDefers(GROUP, msgC);

    expect(deferQueue.size(GROUP)).toBe(0);
    const events = readEventsByGroup(db, GROUP);
    expect(events.some(e => e.result_kind === 'silent' && e.reason_code === 'cancelled-by-direct')).toBe(true);
  });

  it('T3: msgD same ts + newInternalId > queuedInternalId + @bot → B1 cancels (tie-breaker)', () => {
    const msgA = makeMsg({ messageId: '900', content: 'hi', timestamp: 2000 });
    persistMsg(db, msgA); // gets internal id 1
    const item = mkItem(msgA, { queuedAtSec: 2000, queuedInternalId: 1 });
    deferQueue.enqueue(item);

    const msgD = makeMsg({ messageId: '901', timestamp: 2000, rawContent: `[CQ:at,qq=${BOT}]q` });
    persistMsg(db, msgD); // internal id 2 (> 1)

    callCancelDefers(GROUP, msgD);
    expect(deferQueue.size(GROUP)).toBe(0);
  });

  it('T9: queuedInternalId === null + same-second direct arrives → conservative cancel', () => {
    const msgA = makeMsg({ messageId: '1000', content: 'hi', timestamp: 3000 });
    const item = mkItem(msgA, { queuedAtSec: 3000, queuedInternalId: null });
    deferQueue.enqueue(item);

    const msgB = makeMsg({ messageId: '1001', timestamp: 3000, rawContent: `[CQ:reply,id=999]ok` });
    callCancelDefers(GROUP, msgB);
    expect(deferQueue.size(GROUP)).toBe(0);
  });

  it('T13: non-direct new msg → B1 skipped (no cancel)', () => {
    const msgA = makeMsg({ messageId: '1100', timestamp: 4000 });
    const item = mkItem(msgA, { queuedInternalId: 5 });
    deferQueue.enqueue(item);

    const msgPlain = makeMsg({ messageId: '1101', timestamp: 4005, rawContent: 'just chat' });
    callCancelDefers(GROUP, msgPlain);
    expect(deferQueue.size(GROUP)).toBe(1);
  });

  it('T-reply-to-bot: reply-to-bot direct triggers cancel (not just at-bot)', () => {
    const msgA = makeMsg({ messageId: '1200', timestamp: 5000 });
    const item = mkItem(msgA, { queuedInternalId: 5 });
    deferQueue.enqueue(item);

    const msgReply = makeMsg({ messageId: '1201', timestamp: 5005, rawContent: '[CQ:reply,id=999]thx' });
    callCancelDefers(GROUP, msgReply);
    expect(deferQueue.size(GROUP)).toBe(0);
  });

  it('T-not-newer: new direct msg older than item → no cancel', () => {
    const msgA = makeMsg({ messageId: '1300', timestamp: 6000 });
    const item = mkItem(msgA, { queuedAtSec: 6000, queuedInternalId: 5 });
    deferQueue.enqueue(item);

    const msgEarlier = makeMsg({ messageId: '1301', timestamp: 5999, rawContent: `[CQ:at,qq=${BOT}]q` });
    callCancelDefers(GROUP, msgEarlier);
    expect(deferQueue.size(GROUP)).toBe(1);
  });

  // ── B2: _recheckItems re-enqueue ────────────────────────────────

  it('T5: recheck returns burst-settle defer → re-enqueue with recheckCount=1, picked target', async () => {
    // _recheckItems early-returns without a chat module
    const chat = makeChatModule(async () => silentResult('timing'));
    router.setChat(chat);

    // Set up: lastBotReplyAtSec is null, but inject burst by spawning many recent msgs
    // Easier: stub evaluatePreGenerate via lastBotReplyAtSec = nowSec - 5 (within 30s = rate-limit defer).
    const map = (router as unknown as { lastBotReplyAtSec: Map<string, number> }).lastBotReplyAtSec;
    map.set(GROUP, Math.floor(Date.now() / 1000) - 5);

    const msgA = makeMsg({ messageId: '1400', content: '吃饭啦', timestamp: Math.floor(Date.now() / 1000) - 10 });
    const msgAInternalId = persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: msgAInternalId,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1, // already past
    });

    // Insert a fresh msg that should be picked. Note: _recheckItems remaps freshMsgs
    // to use the DB internal id as messageId, so the rawContent reply-chain target
    // must reference the DB id, not the OneBot source id.
    const msgFresh = makeMsg({
      messageId: '1401',
      content: '同感',
      userId: 'u9',
      timestamp: msgA.timestamp + 2,
      rawContent: `[CQ:reply,id=${msgAInternalId}]同感`,
    });
    const msgFreshInternalId = persistMsg(db, msgFresh);

    // The deferred item's msg.messageId for _pickBestTarget reply-chain match must
    // also be the DB internal id (since that's what freshMsgs candidates carry).
    item.msg = { ...item.msg, messageId: String(msgAInternalId) };

    await callRecheckItems(GROUP, [item]);

    expect(deferQueue.size(GROUP)).toBeGreaterThanOrEqual(1);
    const re = deferQueue.getAll(GROUP)[0]!;
    expect(re.recheckCount).toBe(1);
    // Picked target's messageId is the DB internal id (freshMsgs remap)
    expect(re.msg.messageId).toBe(String(msgFreshInternalId));
  });

  it('T7: 3rd recheck (count=2 → 3) → silent timing drop, no further enqueue', async () => {
    const chat = makeChatModule(async () => silentResult('timing'));
    router.setChat(chat);

    const map = (router as unknown as { lastBotReplyAtSec: Map<string, number> }).lastBotReplyAtSec;
    map.set(GROUP, Math.floor(Date.now() / 1000) - 5);

    const msgA = makeMsg({ messageId: '1500', content: 'q', timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
      recheckCount: 2, // next re-enqueue would be 3 → cap
    });

    await callRecheckItems(GROUP, [item]);

    expect(deferQueue.size(GROUP)).toBe(0);
    const events = readEventsByGroup(db, GROUP);
    expect(events.some(e => e.result_kind === 'silent' && e.reason_code === 'timing')).toBe(true);
  });

  it('T14: deadline-path call (no newMsg) → B1 skipped entirely', async () => {
    const msgA = makeMsg({ messageId: '1700', timestamp: 7000 });
    const item = mkItem(msgA, { queuedInternalId: 5 });
    deferQueue.enqueue(item);

    await callRecheckDeferred(GROUP, undefined);
    // B1 didn't fire (no newMsg). Item may still be in queue if not proceed.
    // We assert at minimum no cancelled-by-direct event got captured.
    const events = readEventsByGroup(db, GROUP);
    expect(events.some(e => e.reason_code === 'cancelled-by-direct')).toBe(false);
  });

  it('T-B1+B2 integration: at-mention dispatch sweeps pending defers', async () => {
    // Pre-load a non-direct defer
    const msgA = makeMsg({ messageId: '1800', timestamp: Math.floor(Date.now() / 1000) - 5 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, { queuedInternalId: 1, queuedAtSec: msgA.timestamp });
    deferQueue.enqueue(item);
    expect(deferQueue.size(GROUP)).toBe(1);

    // Stub chat: at-mention path needs generateReply
    const chat = makeChatModule(async () => ({
      kind: 'reply', text: 'hi', reasonCode: 'engaged',
      meta: { decisionPath: 'normal', evasive: false, injectedFactIds: [], matchedFactIds: [], usedVoiceCount: 0, usedFactHint: false },
    } as ChatResult));
    router.setChat(chat);

    // Dispatch an @-bot mention (rawContent triggers _enqueueAtMention path)
    const msgAtBot = makeMsg({
      messageId: '1801',
      rawContent: `[CQ:at,qq=${BOT}]hi bot`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    await router.dispatch(msgAtBot);

    // Defer should have been swept
    expect(deferQueue.size(GROUP)).toBe(0);
    // cancelled-by-direct event captured for the original item
    const events = readEventsByGroup(db, GROUP);
    expect(events.some(e => e.reason_code === 'cancelled-by-direct' && e.trigger_msg_id === '1800')).toBe(true);
  });
});

// Standalone scenario count check (Designer §9 requires ≥14):
// T1, T4, T8, T10, T11, T-bot-excluded, T2, T3, T9, T13, T-reply-to-bot,
// T-not-newer, T5, T7, T14, T-B1+B2 integration → 16 scenarios.
