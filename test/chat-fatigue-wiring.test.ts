import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import type { IFatigueSource } from '../src/modules/fatigue.js';
import { FatigueModule } from '../src/modules/fatigue.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-fatigue';
const GROUP_ID = 'g-fatigue';

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

function makeChat(db: Database, claude: IClaudeClient, overrides: Record<string, unknown> = {}): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: 0.45,
    chatSilenceBonusSec: 999999,
    chatBurstCount: 99,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
    ...overrides,
  });
}

type ScoreRet = {
  score: number;
  factors: { fatiguePenalty: number; interestMatch: number; affinityBoost: number };
  isDirect: boolean;
};

function scoreOf(chat: ChatModule, msg: GroupMessage): ScoreRet {
  return (chat as unknown as {
    _computeWeightedScore: (
      g: string, m: GroupMessage, n: number,
      r3: Array<{ userId: string; timestamp: number }>,
      r5: Array<{ timestamp: number }>,
    ) => ScoreRet;
  })._computeWeightedScore(GROUP_ID, msg, Date.now(), [], []);
}

function bumpFatigue(chat: ChatModule, groupId: string, n: number): void {
  const recordFn = (chat as unknown as {
    _recordOwnReply: (g: string, r: string) => void;
  })._recordOwnReply.bind(chat);
  for (let i = 0; i < n; i++) recordFn(groupId, `reply ${i}`);
}

describe('ChatModule — M6.3 fatigue wiring (hybrid multiplicative)', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── (a) 5× _recordOwnReply ON HOT msg: fatiguePenalty < 0 AND final sum < positive total ──
  it('(a) fatigue active → hot message gets fatiguePenalty < 0 and sum drops below positive total', () => {
    const chat = makeChat(db, claude);
    const fatigue = new FatigueModule();
    chat.setFatigueSource(fatigue);

    bumpFatigue(chat, GROUP_ID, 5); // score=5, above threshold=4

    // Hot message: bandori-interest keyword "MyGO"
    const msg = makeMsg({ content: 'MyGO 新活动开了', rawContent: 'MyGO 新活动开了' });
    const r = scoreOf(chat, msg);

    expect(r.isDirect).toBe(false);
    expect(r.factors.fatiguePenalty).toBeLessThan(0);
    expect(r.factors.interestMatch).toBeGreaterThan(0);
    // Reconstructed positive sum BEFORE fatigue would have been > final score
    const positiveSum = Object.entries(r.factors)
      .filter(([k, v]) => k !== 'fatiguePenalty' && typeof v === 'number' && v > 0)
      .reduce((s, [, v]) => s + (v as number), 0);
    expect(r.score).toBeLessThan(positiveSum);
  });

  // ── (b) 10× _recordOwnReply: saturated — hot msg drops below chatMinScore → silenced ──
  it('(b) saturated fatigue dampens hot message below chatMinScore', () => {
    const chat = makeChat(db, claude, { chatMinScore: 0.45 });
    const fatigue = new FatigueModule();
    chat.setFatigueSource(fatigue);

    bumpFatigue(chat, GROUP_ID, 10);

    const msg = makeMsg({ content: 'MyGO 新活动开了', rawContent: 'MyGO 新活动开了' });
    const r = scoreOf(chat, msg);

    // multiplier at score=10 → max(0.3, 1 - 0.15*(10-4)) = max(0.3, 0.1) = 0.3
    // positive signal = interestMatch (~0.85 for bandori seed) → 0.85 * 0.3 = 0.255 < 0.45
    expect(r.isDirect).toBe(false);
    expect(r.factors.fatiguePenalty).toBeLessThan(0);
    expect(r.score).toBeLessThan(0.45);
  });

  // ── (c) direct trigger (@bot) at fatigue=10: short-circuit, fatiguePenalty untouched ──
  it('(c) direct trigger @bot short-circuits — fatiguePenalty stays 0 even at high fatigue', () => {
    const chat = makeChat(db, claude);
    const spy: IFatigueSource = {
      onReply: vi.fn(),
      getRawScore: vi.fn().mockReturnValue(10),
      getPenalty: vi.fn().mockReturnValue(-0.3),
    };
    chat.setFatigueSource(spy);

    const msg = makeMsg({
      content: '说点啥',
      rawContent: `[CQ:at,qq=${BOT_ID}] 说点啥`,
    });
    const r = scoreOf(chat, msg);

    expect(r.isDirect).toBe(true);
    expect(r.factors.fatiguePenalty).toBe(0);
    expect(spy.getRawScore).not.toHaveBeenCalled();
    expect(spy.getPenalty).not.toHaveBeenCalled();
  });

  // ── (d) backward compat: no setFatigueSource → fatiguePenalty === 0 ──
  it('(d) backward compat: never called setFatigueSource → fatiguePenalty = 0', () => {
    const chat = makeChat(db, claude);
    // no setFatigueSource

    const msg = makeMsg({ content: 'MyGO 新活动开了', rawContent: 'MyGO 新活动开了' });
    const r = scoreOf(chat, msg);

    expect(r.factors.fatiguePenalty).toBe(0);
  });

  // ── (e) edge: high fatigue + only negative factors → fatiguePenalty = 0 (no accidental gain) ──
  it('(e) high fatigue with zero positive factors → fatiguePenalty = 0 (no phantom boost)', () => {
    // No interest-category config, so no positive factors match
    db.groupConfig.upsert({ ...defaultGroupConfig(GROUP_ID), chatInterestCategories: [] });
    const chat = makeChat(db, claude, { chatMinScore: -999 });
    const fatigue = new FatigueModule();
    chat.setFatigueSource(fatigue);

    // Suppress silence factor by pretending bot just spoke
    (chat as unknown as { lastProactiveReply: Map<string, number> })
      .lastProactiveReply.set(GROUP_ID, Date.now());

    bumpFatigue(chat, GROUP_ID, 10);

    // Bland message + burst window wide → all factors should be 0 or non-positive
    const msg = makeMsg({ content: '嗯', rawContent: '嗯' });
    const r = scoreOf(chat, msg);

    const positiveSum = Object.entries(r.factors)
      .filter(([k, v]) => k !== 'fatiguePenalty' && typeof v === 'number' && v > 0)
      .reduce((s, [, v]) => s + (v as number), 0);
    expect(positiveSum).toBe(0);
    expect(r.factors.fatiguePenalty).toBeCloseTo(0, 10);
  });

  // ── (f) edge: fatigue exactly at threshold=4 → fatiguePenalty = 0 ──
  it('(f) fatigue exactly at threshold → fatiguePenalty = 0 (no activation)', () => {
    const chat = makeChat(db, claude);
    const fatigue = new FatigueModule();
    chat.setFatigueSource(fatigue);

    bumpFatigue(chat, GROUP_ID, 4); // score=4, not strictly > threshold

    const msg = makeMsg({ content: 'MyGO 新活动开了', rawContent: 'MyGO 新活动开了' });
    const r = scoreOf(chat, msg);

    expect(r.factors.fatiguePenalty).toBe(0);
    expect(r.factors.interestMatch).toBeGreaterThan(0);
  });

  // ── _recordOwnReply wires fatigue.onReply correctly ──
  it('_recordOwnReply invokes fatigue.onReply with the groupId', () => {
    const chat = makeChat(db, claude);
    const spy: IFatigueSource = {
      onReply: vi.fn(),
      getRawScore: vi.fn().mockReturnValue(0),
      getPenalty: vi.fn().mockReturnValue(0),
    };
    chat.setFatigueSource(spy);

    (chat as unknown as {
      _recordOwnReply: (g: string, r: string) => void;
    })._recordOwnReply(GROUP_ID, 'hi');

    expect(spy.onReply).toHaveBeenCalledWith(GROUP_ID);
  });
});
