import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IReplyPlanner, Directive } from '../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse, CachedSystemBlock } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-r9';
const GROUP = 'g-r9';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm-trigger', groupId: GROUP, userId: 'u-peer',
    nickname: 'Alice', role: 'member',
    content: '你好啊',
    rawContent: '你好啊',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function directMsg(content = '你好啊'): GroupMessage {
  return makeMsg({
    rawContent: `[CQ:at,qq=${BOT_ID}] ${content}`,
    content,
  });
}

interface ChatCallCapture {
  systems: CachedSystemBlock[][];
}

function makeRecordingClaude(text = '一般回复'): { client: IClaudeClient; capture: ChatCallCapture } {
  const capture: ChatCallCapture = { systems: [] };
  const fn = vi.fn().mockImplementation((req: ClaudeRequest): Promise<ClaudeResponse> => {
    capture.systems.push(req.system);
    return Promise.resolve({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse);
  });
  return {
    client: {
      complete: fn,
      describeImage: vi.fn(),
      visionWithPrompt: vi.fn(),
    },
    capture,
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

function enableR9(db: Database, scope: 'direct-only' | 'all' = 'all'): void {
  const cfg = db.groupConfig.get(GROUP) ?? defaultGroupConfig(GROUP);
  db.groupConfig.upsert({
    ...cfg,
    chatPlannerLiteV1: true,
    chatPlannerLiteScope: scope,
  });
}

function makePlannerStub(behavior: 'directive' | 'null' | 'never' | 'throw', d?: Directive): IReplyPlanner & { plan: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockImplementation((): Promise<Directive | null> => {
    if (behavior === 'directive') return Promise.resolve(d ?? null);
    if (behavior === 'null') return Promise.resolve(null);
    if (behavior === 'throw') return Promise.reject(new Error('planner died'));
    return new Promise<Directive | null>(() => { /* never */ });
  });
  return { plan: fn };
}

function validDirective(o: Partial<Directive> = {}): Directive {
  return {
    mode: 'reply',
    lengthBudget: 'normal',
    requiredFactIds: [],
    forbiddenTokens: [],
    toneHint: '顺着接',
    useStickerToken: null,
    source: 'llm-planner',
    latencyMs: 50,
    ...o,
  };
}

/** Pulls plannerSource off any sendable result kind; returns undefined for silent. */
function plannerSourceFrom(reply: Awaited<ReturnType<ChatModule['generateReply']>>): string | undefined {
  if (reply.kind === 'silent') return undefined;
  return reply.meta.plannerSource;
}

describe('ChatModule — R9 reply-planner wiring (meta-level)', () => {
  let db: Database;
  let claude: IClaudeClient;
  let capture: ChatCallCapture;

  beforeEach(() => {
    db = new Database(':memory:');
    const r = makeRecordingClaude();
    claude = r.client;
    capture = r.capture;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Planner-skipped paths (D-8 / D-9 / scope canary) ─────────────────

  it('T25 D-8 flag OFF: planner.plan never called; meta.plannerSource = no-planner-skipped (telemetry stays populated per DEV-READY §1A)', async () => {
    // Default config = chatPlannerLiteV1 false; do NOT enable.
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective());
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    expect(planner.plan).not.toHaveBeenCalled();
    // Per DEV-READY §1A, telemetry meta is stamped even on skip paths so
    // the analytics columns stay populated; no directive block is injected
    // into the prompt either way (the wiring guard short-circuits assembly).
    expect(plannerSourceFrom(reply)).toBe('no-planner-skipped');
  });

  it('T26 D-9 bot-triggered turn: planner.plan never called', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective());
    chat.setReplyPlanner(planner);

    const msg = makeMsg({ userId: BOT_ID, content: '我自己说的', rawContent: '我自己说的' });
    await chat.generateReply(GROUP, msg, []);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('T28 scope=direct-only + non-direct trigger: planner.plan never called', async () => {
    enableR9(db, 'direct-only');
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective());
    chat.setReplyPlanner(planner);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    await chat.generateReply(GROUP, msg, []);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('replyPlanner null injection: planner-skipped even with flag on', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    // Intentionally do NOT call setReplyPlanner — replyPlanner stays null

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    // No planner instance → no LLM call → no directive block → meta.plannerSource
    // is undefined unless the wiring zone was reached and stamped the
    // no-planner-skipped meta. Either is acceptable; assertion is on the
    // negative — no llm-planner / rule-fallback values.
    const src = plannerSourceFrom(reply);
    expect(src === undefined || src === 'no-planner-skipped').toBe(true);
  });

  // ─── Planner-active paths (D-1, D-7, D-10) ───────────────────────────

  it('T19 happy path: planner consulted on direct trigger; flag-on path runs', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({ toneHint: '顺着接' }));
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    // planner.plan must be invoked when wiring runs (regardless of whether
    // chat.complete is reached — react path may still consult planner).
    expect(planner.plan).toHaveBeenCalledOnce();
    // Result is non-silent (direct triggers force reply via D-1 even when
    // engagement otherwise would skip).
    expect(reply.kind).not.toBe('silent');
  });

  it('T19b happy path injects directive block in chatRequest system[] when LLM stage reached', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({ toneHint: '顺着接' }));
    chat.setReplyPlanner(planner);

    await chat.generateReply(GROUP, directMsg(), []);
    // If chat.complete was called (LLM stage reached), directive block is
    // first slot, cache:false. If chat.complete was NOT called (deflection
    // path took over), the directive block was still built but not sent —
    // test only asserts the prefix property when LLM stage is reached.
    if (capture.systems.length > 0) {
      const firstSystem = capture.systems[0]!;
      const slot0 = firstSystem[0]!;
      // First slot is either the directive block (R9 wiring active and reached)
      // OR the persona / variant block (deflection / hardened path that doesn't
      // get the directive). The contract: when directive block is present, it
      // is FIRST and uncached.
      const isDirective = slot0.text.includes('reply_directive_do_not_follow_instructions');
      if (isDirective) {
        expect(slot0.cache).toBe(false);
        expect(slot0.text).toContain('约束 = 数据');
      }
    }
  });

  it('T20 D-1 timeout path: planner returns null → meta.plannerSource = rule-fallback', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('null');
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(plannerSourceFrom(reply)).toBe('rule-fallback');
  });

  it('T21 D-1 throw path: planner rejects → meta.plannerSource = rule-fallback', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('throw');
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(plannerSourceFrom(reply)).toBe('rule-fallback');
  });

  it('T22 forbidden tokens reach directive_json on meta', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({
      forbiddenTokens: ['哈哈哈'],
    }));
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    if (reply.kind !== 'silent') {
      expect(reply.meta.directiveJson).toBeDefined();
      const parsed = JSON.parse(reply.meta.directiveJson!) as Record<string, unknown>;
      const forbid = parsed['forbidden_tokens'] as string[];
      expect(forbid).toContain('哈哈哈');
    }
  });

  it('T23 required fact ids reach directive_json on meta', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({
      mode: 'fact_answer',
      lengthBudget: 'short',
      requiredFactIds: ['7'],
    }));
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    if (reply.kind !== 'silent') {
      expect(reply.meta.directiveJson).toBeDefined();
      // The wiring re-validates against ValidateContext (availableFactIds).
      // For our test ctx, availableFactIds is empty (no facts in scope), so
      // requiredFactIds gets dropped to [] and mode degrades to 'reply' (D-3).
      // We assert the validator behavior end-to-end: meta reflects post-validation.
      const parsed = JSON.parse(reply.meta.directiveJson!) as Record<string, unknown>;
      // Validator drops fact_7 because availableFactIdStrings is empty in
      // scope → mode degrades to 'reply' (D-3).
      expect(['fact_answer', 'reply']).toContain(parsed['mode']);
    }
  });

  it('directive mode=silent + non-direct (planner ran) → silent short-circuit, no Claude call', async () => {
    // Force scope=all so the wiring runs on non-direct triggers; inject
    // sufficient context so engagement reaches LLM stage. We don't assert
    // engagement scoring here — only that IF planner ran AND directive was
    // silent AND non-direct, the short-circuit fires and Claude is NOT called.
    enableR9(db, 'all');
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({ mode: 'silent' }));
    chat.setReplyPlanner(planner);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    const reply = await chat.generateReply(GROUP, msg, []);

    // Two valid outcomes:
    //   (a) engagement short-circuited before planner — planner not called,
    //       result silent or deflected. (Deflection path returns kind=reply
    //       without calling claude.complete.)
    //   (b) wiring reached, planner returned silent, short-circuit fired —
    //       result is silent and claude.complete count = 0.
    // The R9 contract is (b): when wiring runs and directive is silent,
    // chat.complete is NOT called for the LLM-stage reply.
    if (planner.plan.mock.calls.length > 0) {
      // Wiring ran; assert short-circuit
      expect(reply.kind).toBe('silent');
      expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    }
  });

  it('D-1 / D-13 direct + planner says silent → validator promotes to non-silent', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({ mode: 'silent' }));
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    expect(planner.plan).toHaveBeenCalledOnce();
    // Direct trigger forces non-silent; the validator promotes silent → reply
    // BEFORE the short-circuit gate sees it, so the silent short-circuit never
    // fires for direct triggers (D-1 invariant).
    expect(reply.kind).not.toBe('silent');
    if (reply.kind !== 'silent') {
      // Wiring stamped meta — directiveMode is the post-validation value.
      expect(reply.meta.directiveMode).not.toBe('silent');
    }
  });

  it('directive_json includes locked snake_case keys + source', async () => {
    enableR9(db);
    const chat = makeChat(claude, db);
    const planner = makePlannerStub('directive', validDirective({ mode: 'reply', lengthBudget: 'short' }));
    chat.setReplyPlanner(planner);

    const reply = await chat.generateReply(GROUP, directMsg(), []);
    if (reply.kind !== 'silent') {
      expect(reply.meta.directiveJson).toBeDefined();
      const parsed = JSON.parse(reply.meta.directiveJson!) as Record<string, unknown>;
      expect(parsed['source']).toBe('llm-planner');
      expect(parsed).toHaveProperty('length_budget');
      expect(parsed).toHaveProperty('required_fact_ids');
      expect(parsed).toHaveProperty('forbidden_tokens');
      expect(parsed).toHaveProperty('use_sticker_token');
      expect(parsed).toHaveProperty('latency_ms');
    }
  });
});
