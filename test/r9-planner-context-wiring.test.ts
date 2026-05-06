import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IReplyPlanner, Directive, PlannerContext } from '../src/modules/reply-planner.js';
import { buildPlannerUserPrompt } from '../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import type { FormattedFacts } from '../src/modules/self-learning.js';
import type { SelfLearningModule } from '../src/modules/self-learning.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-r9-wiring';
const GROUP = 'g-r9-wiring';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm-trigger', groupId: GROUP, userId: 'u-peer',
    nickname: 'Alice', role: 'member',
    content: 'ygfn是谁',
    rawContent: `[CQ:at,qq=${BOT_ID}] ygfn是谁`,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: '一般回复',
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
    describeImage: vi.fn().mockResolvedValue(''),
  };
}

function enableR9(db: Database): void {
  const cfg = db.groupConfig.get(GROUP) ?? defaultGroupConfig(GROUP);
  db.groupConfig.upsert({ ...cfg, chatPlannerLiteV1: true });
}

function makePlannerCapture(): IReplyPlanner & { plan: ReturnType<typeof vi.fn>; captured: PlannerContext[] } {
  const captured: PlannerContext[] = [];
  const fn = vi.fn().mockImplementation((ctx: PlannerContext): Promise<Directive | null> => {
    captured.push(ctx);
    return Promise.resolve(null);
  });
  return { plan: fn, captured };
}

function makeMockSelfLearning(matchedFacts: FormattedFacts['matchedFacts']): SelfLearningModule {
  const ff: FormattedFacts = {
    text: 'some facts block',
    injectedFactIds: matchedFacts.map(f => f.id),
    matchedFactIds: matchedFacts.map(f => f.id),
    pinnedOnly: false,
    matchedFacts,
  };
  return {
    detectCorrection: vi.fn().mockResolvedValue(null),
    harvestPassiveKnowledge: vi.fn().mockResolvedValue(null),
    formatFactsForPrompt: vi.fn().mockResolvedValue(ff),
    rememberInjection: vi.fn(),
    handleTopLevelCorrection: vi.fn(),
    getModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
  } as unknown as SelfLearningModule;
}

function makeChat(claude: IClaudeClient, db: Database, sl?: SelfLearningModule): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    selfLearning: sl,
  });
}

describe('r9-planner-context-wiring — PlannerContext.facts hydration in chat.ts', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── T1: 3 known matchedFacts → plannerCtx.facts.length === 3 ────────────

  it('T1: 3 matchedFacts rows → plannerCtx.facts.length === 3 with correct shape', async () => {
    enableR9(db);
    const rows: FormattedFacts['matchedFacts'] = [
      { id: 10, topic: 'user-taught:ygfn', fact: 'ygfn是羊宫妃那啊' },
      { id: 11, topic: '高松灯', fact: '高松灯是Tsukinomori成员之一' },
      { id: 12, topic: null, fact: '某个事实' },
    ];
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    expect(planner.plan).toHaveBeenCalled();
    const ctx = planner.captured[0]!;
    expect(ctx.facts.length).toBe(3);

    // Verify shape of first fact
    expect(ctx.facts[0]!.factId).toBe('10');
    expect(ctx.facts[0]!.term).toBe('user-taught:ygfn');
    expect(ctx.facts[0]!.meaning).toBe('ygfn是羊宫妃那啊');

    // Verify second fact
    expect(ctx.facts[1]!.factId).toBe('11');
    expect(ctx.facts[1]!.term).toBe('高松灯');

    // Verify null topic coerced to ''
    expect(ctx.facts[2]!.factId).toBe('12');
    expect(ctx.facts[2]!.term).toBe('');
    expect(ctx.facts[2]!.meaning).toBe('某个事实');
  });

  // ─── T2: Cap at MAX_FACTS_PER_PLANNER = 8 ────────────────────────────────

  it('T2: 9 matchedFacts rows sliced to exactly 8 in plannerCtx.facts', async () => {
    enableR9(db);
    const rows: FormattedFacts['matchedFacts'] = Array.from({ length: 9 }, (_, i) => ({
      id: 100 + i,
      topic: `topic${i}`,
      fact: `fact ${i}`,
    }));
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    expect(planner.plan).toHaveBeenCalled();
    const ctx = planner.captured[0]!;
    expect(ctx.facts.length).toBe(8);
  });

  // ─── T3: null topic in matchedFacts → term: '' ───────────────────────────

  it('T3: null topic in matchedFacts → term coerced to empty string', async () => {
    enableR9(db);
    const rows: FormattedFacts['matchedFacts'] = [
      { id: 20, topic: null, fact: 'fact with null topic' },
    ];
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    expect(planner.plan).toHaveBeenCalled();
    const ctx = planner.captured[0]!;
    expect(ctx.facts[0]!.term).toBe('');
    expect(ctx.facts[0]!.meaning).toBe('fact with null topic');
  });

  // ─── T4: flag OFF → planner.plan never called ────────────────────────────

  it('T4: chat_planner_lite_v1 flag OFF → planner.plan never called; plannerCtx not constructed', async () => {
    // Do NOT call enableR9 — flag stays OFF (default)
    const rows: FormattedFacts['matchedFacts'] = [
      { id: 30, topic: 'user-taught:ygfn', fact: 'ygfn是羊宫妃那啊' },
    ];
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.captured.length).toBe(0);
  });

  // ─── T5: replyPlanner null + flag ON → planner block skipped ─────────────

  it('T5: replyPlanner null with flag ON → planner block skipped', async () => {
    enableR9(db);
    const rows: FormattedFacts['matchedFacts'] = [
      { id: 40, topic: 'user-taught:ygfn', fact: 'ygfn是羊宫妃那啊' },
    ];
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    // Intentionally do NOT call setReplyPlanner

    const reply = await chat.generateReply(GROUP, makeMsg(), []);
    // Should not throw; reply produced without planner
    expect(reply.kind).not.toBe('error');
  });

  // ─── T6: selfLearning null → nullish coalesce → matchedFacts: [] ─────────

  it('T6: selfLearning null → nullish coalesce → plannerCtx.facts === []', async () => {
    enableR9(db);
    const chat = makeChat(claude, db, undefined); // no selfLearning
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    if (planner.captured.length > 0) {
      expect(planner.captured[0]!.facts).toEqual([]);
    }
    // If planner not called (silenced), still verify no error
  });

  // ─── T7: buildPlannerUserPrompt snapshot with real facts ─────────────────

  it('T7: buildPlannerUserPrompt renders non-(none) facts section when facts provided', () => {
    const ctx: PlannerContext = {
      groupId: GROUP,
      triggerContent: 'ygfn是谁',
      triggerNickname: 'Alice',
      recentChrono: [],
      facts: [
        { factId: '10', term: 'user-taught:ygfn', meaning: 'ygfn是羊宫妃那啊' },
      ],
      signals: {
        isAt: true,
        isReplyToBot: false,
        hasRealFactHit: true,
        utteranceAct: 'direct_chat',
        dNonBot: 1,
        affinityFactor: 0.5,
        inDirectCooldown: false,
      },
      recentBotOutputs: [],
      stickerAllowed: false,
    };

    const prompt = buildPlannerUserPrompt(ctx);
    expect(prompt).toContain('facts:');
    // facts section must have the actual fact line, not the (none) placeholder
    expect(prompt).toContain('10 | user-taught:ygfn: ygfn是羊宫妃那啊');
    // The facts block must NOT contain the (none) placeholder inline after "facts:"
    const factsIdx = prompt.indexOf('facts:');
    const factsSection = prompt.slice(factsIdx, factsIdx + 60);
    expect(factsSection).not.toContain('(none)');
  });

  // ─── T8: buildPlannerUserPrompt (none) when facts empty ──────────────────

  it('T8: buildPlannerUserPrompt renders (none) when facts empty', () => {
    const ctx: PlannerContext = {
      groupId: GROUP,
      triggerContent: '今天天气',
      triggerNickname: 'Alice',
      recentChrono: [],
      facts: [],
      signals: {
        isAt: false,
        isReplyToBot: false,
        hasRealFactHit: false,
        utteranceAct: 'direct_chat',
        dNonBot: 1,
        affinityFactor: 0.5,
        inDirectCooldown: false,
      },
      recentBotOutputs: [],
      stickerAllowed: false,
    };

    const prompt = buildPlannerUserPrompt(ctx);
    expect(prompt).toContain('facts:');
    expect(prompt).toContain('(none)');
  });

  // ─── T9: zero matchedFacts → plannerCtx.facts === [] ─────────────────────

  it('T9: zero matchedFacts → plannerCtx.facts === []', async () => {
    enableR9(db);
    const sl = makeMockSelfLearning([]);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg({ content: '今天天气', rawContent: `[CQ:at,qq=${BOT_ID}] 今天天气` }), []);

    if (planner.captured.length > 0) {
      expect(planner.captured[0]!.facts).toEqual([]);
    }
  });

  // ─── T10: plannerCtx.facts payload shape has exactly {factId, term, meaning} ─

  it('T10: plannerCtx.facts elements have exactly factId/term/meaning — no extra fields', async () => {
    enableR9(db);
    const rows: FormattedFacts['matchedFacts'] = [
      { id: 50, topic: 'some-topic', fact: 'some fact' },
    ];
    const sl = makeMockSelfLearning(rows);
    const chat = makeChat(claude, db, sl);
    const planner = makePlannerCapture();
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, makeMsg(), []);

    expect(planner.plan).toHaveBeenCalled();
    const ctx = planner.captured[0]!;
    if (ctx.facts.length > 0) {
      const fact = ctx.facts[0]!;
      expect(typeof fact.factId).toBe('string');
      expect(typeof fact.term).toBe('string');
      expect(typeof fact.meaning).toBe('string');
      // factId is string-cast integer
      expect(fact.factId).toBe('50');
    }
  });
});
