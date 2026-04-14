import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { ChatModule } from '../src/modules/chat.js';
import type { SelfLearningModule } from '../src/modules/self-learning.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
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

function makeMockAdapter(): INapCatAdapter {
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
  };
}

function makeMockSelfLearning(): SelfLearningModule {
  return {
    detectCorrection: vi.fn().mockResolvedValue(null),
    harvestPassiveKnowledge: vi.fn().mockResolvedValue(null),
    formatFactsForPrompt: vi.fn().mockReturnValue(''),
    getModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
  } as unknown as SelfLearningModule;
}

function makeMockClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

// ── detectCorrection trigger ───────────────────────────────────────────────────

describe('Router — self-learning detectCorrection', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let sl: SelfLearningModule;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    sl = makeMockSelfLearning();
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
    router.setSelfLearning(sl);
  });

  afterEach(() => {
    router.dispose();
    vi.restoreAllMocks();
  });

  it('calls detectCorrection when incoming message reply-quotes a known bot_reply row', async () => {
    const botRow = db.botReplies.insert({
      groupId: 'g1', triggerMsgId: 'tm1', triggerUserNickname: 'Alice',
      triggerContent: 'fire bird 是谁唱的', botReply: 'RAS 唱的',
      module: 'chat', sentAt: Math.floor(Date.now() / 1000),
    });

    const msg = makeMsg({
      rawContent: `[CQ:reply,id=${botRow.id}]不是 这是 Roselia 唱的`,
      content: '不是 这是 Roselia 唱的',
    });
    await router.dispatch(msg);

    await new Promise(r => setTimeout(r, 10));
    expect(sl.detectCorrection).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'g1',
      botReplyId: botRow.id,
      correctionMsg: expect.objectContaining({ content: '不是 这是 Roselia 唱的' }),
    }));
  });

  it('does NOT call detectCorrection when reply quotes a non-bot message id', async () => {
    const msg = makeMsg({
      rawContent: '[CQ:reply,id=9999]不是这样的',
      content: '不是这样的',
    });
    await router.dispatch(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(sl.detectCorrection).not.toHaveBeenCalled();
  });

  it('does NOT call detectCorrection when message has no reply CQ code', async () => {
    const msg = makeMsg({ content: '普通消息', rawContent: '普通消息' });
    await router.dispatch(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(sl.detectCorrection).not.toHaveBeenCalled();
  });

  it('detectCorrection throw is caught silently (no crash)', async () => {
    (sl.detectCorrection as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Claude timeout'));
    const botRow = db.botReplies.insert({
      groupId: 'g1', triggerMsgId: 'tm1', triggerUserNickname: null,
      triggerContent: '啥', botReply: '忘了', module: 'chat',
      sentAt: Math.floor(Date.now() / 1000),
    });
    const msg = makeMsg({
      rawContent: `[CQ:reply,id=${botRow.id}]应该是X`,
      content: '应该是X',
    });
    await expect(router.dispatch(msg)).resolves.not.toThrow();
  });
});

// ── evasive reply → markEvasive + harvest timer ────────────────────────────────

describe('Router — evasive reply + harvest scheduling', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let sl: SelfLearningModule;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    sl = makeMockSelfLearning();
    claude = makeMockClaude('忘了');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      moodProactiveEnabled: false, deflectCacheEnabled: false,
    });
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
    router.setSelfLearning(sl);
    router.setChat(chat);
  });

  afterEach(() => {
    router.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks bot_reply as evasive when reply is an evasive phrase', async () => {
    const markEvasiveSpy = vi.spyOn(db.botReplies, 'markEvasive');
    const msg = makeMsg({ content: 'fire bird 是谁唱的', rawContent: 'fire bird 是谁唱的' });
    await router.dispatch(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(markEvasiveSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark evasive when reply is normal text', async () => {
    (claude.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '是Roselia唱的', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse);
    const markEvasiveSpy = vi.spyOn(db.botReplies, 'markEvasive');
    const msg = makeMsg({ content: 'fire bird 是谁唱的', rawContent: 'fire bird 是谁唱的' });
    await router.dispatch(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(markEvasiveSpy).not.toHaveBeenCalled();
  });

  it('schedules harvest timer after evasive reply (fires after 60s)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 });
    const dispatchTime = Math.floor(Date.now() / 1000);
    const msg = makeMsg({ content: 'fire bird 是谁唱的', rawContent: 'fire bird 是谁唱的', timestamp: dispatchTime });
    await router.dispatch(msg);

    // Insert follow-up messages with ≥2 token overlap to trigger harvest
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'fire bird 是 Roselia 唱的', timestamp: dispatchTime + 10, deleted: false });
    db.messages.insert({ groupId: 'g1', userId: 'u3', nickname: 'Eve', content: 'fire bird Roselia的歌', timestamp: dispatchTime + 20, deleted: false });

    expect(sl.harvestPassiveKnowledge).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(sl.harvestPassiveKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'g1',
      originalTrigger: 'fire bird 是谁唱的',
    }));
  });

  it('dispose() cancels pending harvest timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 });
    const msg = makeMsg({ content: '啥来的', rawContent: '啥来的' });
    await router.dispatch(msg);

    router.dispose();
    await vi.runAllTimersAsync();

    expect(sl.harvestPassiveKnowledge).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('evasive path calls BOTH harvestPassiveKnowledge (via timer) AND researchOnline (immediate)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 });
    const researchOnline = vi.fn().mockResolvedValue(null);
    // Attach researchOnline to the mock SelfLearningModule (method dev-5 is adding)
    (sl as unknown as Record<string, unknown>)['researchOnline'] = researchOnline;

    const dispatchTime = Math.floor(Date.now() / 1000);
    const msg = makeMsg({ content: 'fire bird 是谁唱的', rawContent: 'fire bird 是谁唱的', timestamp: dispatchTime });
    await router.dispatch(msg);

    // researchOnline fires immediately — should be called before timer fires
    await Promise.resolve();
    expect(researchOnline).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'g1',
      originalTrigger: 'fire bird 是谁唱的',
    }));

    // harvestPassiveKnowledge fires after 60s timer — insert overlap messages first
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'fire bird 是 Roselia 唱的', timestamp: dispatchTime + 10, deleted: false });
    await vi.runAllTimersAsync();
    expect(sl.harvestPassiveKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'g1',
      originalTrigger: 'fire bird 是谁唱的',
    }));
  });
});

// ── /facts command ─────────────────────────────────────────────────────────────

describe('Router — /facts command', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
  });

  afterEach(() => {
    router.dispose();
    vi.restoreAllMocks();
  });

  it('/facts with no learned facts → replies "还没有"', async () => {
    await router.dispatch(makeMsg({ content: '/facts', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('还没有'));
  });

  it('/facts with active facts → lists them with ID and content', async () => {
    db.learnedFacts.insert({
      groupId: 'g1', topic: null, fact: 'fire bird 是 Roselia 的曲子',
      sourceUserId: 'u1', sourceUserNickname: '群友A', sourceMsgId: 'm1', botReplyId: 1,
    });
    await router.dispatch(makeMsg({ content: '/facts', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('Roselia'));
  });

  it('/facts is accessible to all roles (non-admin)', async () => {
    await router.dispatch(makeMsg({ content: '/facts', role: 'member' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('还没有'));
  });
});

// ── /fact_reject command ───────────────────────────────────────────────────────

describe('Router — /fact_reject command', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
  });

  afterEach(() => {
    router.dispose();
    vi.restoreAllMocks();
  });

  it('/fact_reject <id> by admin → marks rejected, replies confirmed', async () => {
    const id = db.learnedFacts.insert({
      groupId: 'g1', topic: null, fact: 'wrong fact',
      sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: 1,
    });
    await router.dispatch(makeMsg({ content: `/fact_reject ${id}`, role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('拒绝'));
    const active = db.learnedFacts.listActive('g1', 10);
    expect(active.every(f => f.id !== id)).toBe(true);
  });

  it('/fact_reject without valid id → usage error', async () => {
    await router.dispatch(makeMsg({ content: '/fact_reject notanumber', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('/fact_reject'));
  });

  it('/fact_reject by non-admin → permission denied', async () => {
    await router.dispatch(makeMsg({ content: '/fact_reject 1', role: 'member' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有权限'));
  });
});

// ── /fact_clear command ────────────────────────────────────────────────────────

describe('Router — /fact_clear command', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
  });

  afterEach(() => {
    router.dispose();
    vi.restoreAllMocks();
  });

  it('/fact_clear by admin → clears all facts, replies with count', async () => {
    db.learnedFacts.insert({ groupId: 'g1', topic: null, fact: 'fact 1', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: 1 });
    db.learnedFacts.insert({ groupId: 'g1', topic: null, fact: 'fact 2', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: 2 });
    await router.dispatch(makeMsg({ content: '/fact_clear', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('2'));
    expect(db.learnedFacts.listActive('g1', 10)).toHaveLength(0);
  });

  it('/fact_clear by non-admin → permission denied', async () => {
    await router.dispatch(makeMsg({ content: '/fact_clear', role: 'member' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有权限'));
  });

  it('/fact_clear on empty group → clears 0, still replies', async () => {
    await router.dispatch(makeMsg({ content: '/fact_clear', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('0'));
  });
});
