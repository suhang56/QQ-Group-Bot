import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { DeferQueue } from '../src/utils/defer-queue.js';
import type { DeferredItem } from '../src/utils/defer-queue.js';
import { ChatDecisionTracker } from '../src/modules/chat-decision-tracker.js';
import { defaultGroupConfig } from '../src/config.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { IChatModule } from '../src/modules/chat.js';
import type { ChatResult } from '../src/utils/chat-result.js';
import { classifyUtteranceAct } from '../src/utils/strategy-preview.js';
import type { StrategyPreviewContext, UtteranceAct } from '../src/utils/utterance-act.js';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT = 'bot-r4lite';
const GROUP = 'g-r4lite';

let msgCounter = 30000;
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

function silentChatResult(reasonCode = 'timing'): ChatResult {
  return { kind: 'silent', reasonCode: reasonCode as 'timing', meta: { decisionPath: 'silent' } };
}

function replyChatResult(): ChatResult {
  return {
    kind: 'reply',
    text: 'hi',
    reasonCode: 'engaged',
    meta: {
      decisionPath: 'normal',
      evasive: false,
      injectedFactIds: [],
      matchedFactIds: [],
      usedVoiceCount: 0,
      usedFactHint: false,
    },
  } as ChatResult;
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

describe('Router._recheckItems — utterance_act fill on silent paths (r4-lite)', () => {
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

  async function callRecheckItems(groupId: string, items: DeferredItem[]): Promise<void> {
    const fn = (router as unknown as { _recheckItems: (g: string, items: DeferredItem[], trig: 'deadline' | 'new-message') => Promise<void> })._recheckItems;
    await fn.call(router, groupId, items, 'deadline');
  }

  // T1 — cap-reached silent: recheckCount becomes 3 (>=3 cap) → silent timing emitted
  // with utteranceAct populated.
  it('T1: recheckCount cap reached → silent emitted with utteranceAct populated', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    // Force evaluatePreGenerate to defer (rate-limit) so cap branch runs.
    const map = (router as unknown as { lastBotReplyAtSec: Map<string, number> }).lastBotReplyAtSec;
    map.set(GROUP, Math.floor(Date.now() / 1000) - 5);

    const msgA = makeMsg({ content: '随便说点啥', timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
      recheckCount: 2, // next increment → 3 (cap)
    });

    await callRecheckItems(GROUP, [item]);

    expect(deferQueue.size(GROUP)).toBe(0);
    const events = readEventsByGroup(db, GROUP);
    const silentEvent = events.find(e => e.result_kind === 'silent' && e.reason_code === 'timing');
    expect(silentEvent).toBeDefined();
    expect(silentEvent!.utterance_act).not.toBeNull();
    // For plain content, no relay, no at-mention → 'chime_in'
    expect(silentEvent!.utterance_act).toBe('chime_in');
  });

  // T2 — recheck-silent (cooldown): recentNegativeScore < -0.4 → silent emitted
  // with utteranceAct populated.
  it('T2: recheck silent (cooldown) → silent emitted with utteranceAct populated', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    // Force the silent (cooldown) branch by stubbing _computeRecentNegativeScore.
    (router as unknown as { _computeRecentNegativeScore: (g: string) => number })
      ._computeRecentNegativeScore = () => -0.9;

    const msgA = makeMsg({ content: '今天天气不错', timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
    });

    await callRecheckItems(GROUP, [item]);

    expect(deferQueue.size(GROUP)).toBe(0);
    const events = readEventsByGroup(db, GROUP);
    const silentEvent = events.find(e => e.result_kind === 'silent');
    expect(silentEvent).toBeDefined();
    expect(silentEvent!.utterance_act).not.toBeNull();
    expect(silentEvent!.utterance_act).toBe('chime_in');
  });

  // T3 — proceed: no silent decision captured by _recheckItems silent branches.
  // The chat path captures its own decision at line 1281, but those silent branches
  // (cap + cooldown) must not fire.
  it('T3: recheck proceed → no _recheckItems silent emitted (chat path handles capture)', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    // No lastBotReplyAtSec, no negative score, low burst → proceed.
    const msgA = makeMsg({ content: '随便聊聊', timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
      recheckCount: 0,
    });

    const captureSpy = vi.spyOn(tracker, 'captureDecision');

    await callRecheckItems(GROUP, [item]);

    // chatModule.generateReply was invoked (proceed path)
    expect((chat.generateReply as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // The single captureDecision call must come from the chat path (line 1281),
    // carrying the silent ChatResult returned by chatModule. Its meta is the
    // silentChatResult.meta = { decisionPath: 'silent' } — utteranceAct undefined
    // is acceptable here (chat path is responsible for its own utteranceAct fill).
    // The point of T3: NO additional silent capture from _recheckItems silent branches.
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [resultArg] = captureSpy.mock.calls[0]!;
    expect(resultArg.kind).toBe('silent');
    // The captured meta is the chatModule's stub silentChatResult.meta — confirms
    // it's the chat-path capture, not the _recheckItems silent capture.
    expect(resultArg.meta.decisionPath).toBe('silent');
  });

  // T4 — snapshot: meta.utteranceAct must equal classifyUtteranceAct(ctx) 1:1 for
  // identical inputs. We reconstruct the same ctx the router builds and compare.
  it('T4: meta.utteranceAct === classifyUtteranceAct(ctx) for the same inputs', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    (router as unknown as { _computeRecentNegativeScore: (g: string) => number })
      ._computeRecentNegativeScore = () => -0.9; // force silent

    const content = '今天我比较开心';
    const msgA = makeMsg({ content, rawContent: content, timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
    });

    await callRecheckItems(GROUP, [item]);

    const events = readEventsByGroup(db, GROUP);
    const silentEvent = events.find(e => e.result_kind === 'silent');
    expect(silentEvent).toBeDefined();

    // Reconstruct the ctx the router would have built.
    const freshMsgs = db.messages.getRecent(GROUP, 20).map(m => ({
      content: m.content,
      userId: m.userId,
    }));
    const ctx: StrategyPreviewContext = {
      msg: {
        content,
        rawContent: content,
        isAtMention: false,
        isDirect: false,
        shouldReply: true,
      },
      recent5Msgs: freshMsgs.slice(-5),
      hasKnownFactTerm: false,
      hasRealFactHit: undefined,
      relayHit: false,
    };
    const expected: UtteranceAct = classifyUtteranceAct(ctx);
    expect(silentEvent!.utterance_act).toBe(expected);
  });

  // T5 — empty content/rawContent: classifyUtteranceAct must return a valid act,
  // captureDecision receives a defined utteranceAct, no crash.
  it('T5: empty content + rawContent → valid utteranceAct, no crash', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    (router as unknown as { _computeRecentNegativeScore: (g: string) => number })
      ._computeRecentNegativeScore = () => -0.9;

    const msgA = makeMsg({ content: '', rawContent: '', timestamp: Math.floor(Date.now() / 1000) - 10 });
    persistMsg(db, msgA);
    const item = mkItem(msgA, {
      queuedInternalId: 1,
      queuedAtSec: msgA.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(callRecheckItems(GROUP, [item])).resolves.toBeUndefined();

    const events = readEventsByGroup(db, GROUP);
    const silentEvent = events.find(e => e.result_kind === 'silent');
    expect(silentEvent).toBeDefined();
    expect(silentEvent!.utterance_act).not.toBeNull();
    expect(silentEvent!.utterance_act).toBe('chime_in'); // default for plain non-relay content
  });

  // T6 — relay path: seed real db rows matching detectRelay vote pattern;
  // utteranceAct must be 'relay' (no mock, real detector).
  it('T6: relay shape (peer messages match VOTE_RE) → utteranceAct === "relay"', async () => {
    const chat = makeChatModule(async () => silentChatResult('timing'));
    router.setChat(chat);

    (router as unknown as { _computeRecentNegativeScore: (g: string) => number })
      ._computeRecentNegativeScore = () => -0.9; // force silent path

    const baseTs = Math.floor(Date.now() / 1000) - 100;
    // Seed 3 peer messages matching VOTE_RE ('+1', '+1', '+1')
    persistMsg(db, makeMsg({ content: '+1', userId: 'peerA', timestamp: baseTs + 1 }));
    persistMsg(db, makeMsg({ content: '+1', userId: 'peerB', timestamp: baseTs + 2 }));
    persistMsg(db, makeMsg({ content: '+1', userId: 'peerC', timestamp: baseTs + 3 }));

    // The deferred item itself — its content shape is irrelevant for relay
    // classification; relay is determined by detectRelay over the recent peer
    // messages already in the db.
    const msgItem = makeMsg({ content: '+1', userId: 'peerD', timestamp: baseTs + 4 });
    persistMsg(db, msgItem);
    const item = mkItem(msgItem, {
      queuedInternalId: 4,
      queuedAtSec: msgItem.timestamp,
      deadlineSec: Math.floor(Date.now() / 1000) - 1,
    });

    await callRecheckItems(GROUP, [item]);

    const events = readEventsByGroup(db, GROUP);
    const silentEvent = events.find(e => e.result_kind === 'silent');
    expect(silentEvent).toBeDefined();
    expect(silentEvent!.utterance_act).toBe('relay');
  });
});

// Suppress unused warning: replyChatResult is exported for potential future expansion.
void replyChatResult;
