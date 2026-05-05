import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { MockClaudeClient } from '../../scripts/eval/mock-llm.js';
import type { ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import { snapshotProdDb, assertNoProdContamination } from './helpers.js';

const ENV_KEY = 'R9_REPLYER_LITE_ENABLED';
const BOT_QQ = '1705075399';
const GROUP_ID = '958751334';
const REPO = path.resolve(__dirname, '../..');
// Dedicated synthetic fixture path. Using the canonical
// 'replay-prod-db-synthetic.sqlite' would race buildSyntheticReplayDb across
// vitest fork-pool's parallel test files. Filename still contains 'synthetic'
// so the constructChatModule tripwire is satisfied.
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic-r9smoke.sqlite');

/**
 * Why we don't use the committed test/fixtures/replay-benchmark-synthetic.jsonl:
 *
 * The committed synthetic benchmark row 9002 has rawContent='有人在吗' — labeled
 * isDirect=true at the gold/benchmark level, but lacking the [CQ:at,qq=BOT]
 * token. ChatModule's direct-bypass at chat.ts:1850-1854 reads rawContent for
 * '[CQ:at,qq=${botUserId}]' (NOT the label), so the committed fixture silences
 * on debounce 'timing' (chat.ts:1968) BEFORE reaching the R9 gate at
 * chat.ts:3157. Result: plannerSource never assigned -> stays undefined -> ?? null.
 *
 * Inline JSONL fixtures with CQ-at rawContent let us reach the R9 gate. We
 * keep this test-internal so the committed fixture (used by replay-runner-mock
 * and future R9.4 baselines) stays untouched. See DEV-READY §3.2 follow-up note.
 */
function writeInlineFixtures(dir: string, withCqAt: boolean): { goldPath: string; benchmarkPath: string } {
  const goldPath = path.join(dir, 'gold.jsonl');
  const benchmarkPath = path.join(dir, 'benchmark.jsonl');
  const rawContent = withCqAt ? `[CQ:at,qq=${BOT_QQ}] 在不在` : '在不在';
  fs.writeFileSync(goldPath, JSON.stringify({
    sampleId: '958751334:9002',
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    targetOk: true,
    factNeeded: false,
    allowBanter: true,
    allowSticker: false,
    labeledAt: '2026-04-20T00:00:00Z',
  }) + '\n');
  fs.writeFileSync(benchmarkPath, JSON.stringify({
    id: '958751334:9002',
    groupId: GROUP_ID,
    messageId: 9002,
    sourceMessageId: 'src-9002',
    userId: 'U1002',
    nickname: '李四',
    timestamp: 1_713_000_060,
    content: '在不在',
    rawContent,
    triggerContext: [],
    triggerContextAfter: [],
    category: 1,
    categoryLabel: 'direct_at_bot',
    samplingSeed: 1,
    contentHash: 'a2',
    contextHash: 'b2',
    label: {
      expectedAct: 'direct_chat',
      expectedDecision: 'reply',
      hasKnownFactTerm: false,
      knownFactSource: null,
      hasRealFactHit: false,
      allowPluralYou: false,
      isObjectReact: false,
      isBotStatusContext: false,
      isBurst: false,
      isRelay: false,
      isDirect: true,
      riskFlags: [],
    },
  }) + '\n');
  return { goldPath, benchmarkPath };
}

function makeArgs(outputDir: string, overrides: Partial<ReplayerArgs> = {}): ReplayerArgs {
  return {
    goldPath: '',
    benchmarkPath: '',
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: FIXTURE_DB,
    botQQ: BOT_QQ,
    groupIdForReplay: GROUP_ID,
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    maxConsecutiveErrors: null,
    ...overrides,
  };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r9-smoke-${prefix}-`));
}

/**
 * Inline mirror of MockClaudeClient.complete (mock-llm.ts:32-50). Used by
 * the prototype-mutation patches below: an `extends`+`super.complete()`
 * subclass cannot be borrowed onto MockClaudeClient.prototype.complete
 * because `super` resolves via the subclass's lexical home object — once
 * installed on the parent's prototype, the lookup walks to the (now-patched)
 * parent slot and recurses infinitely. Inlining the deterministic
 * [mock:hex8] body sidesteps that. See DEV-READY §3.2 inline-fallback path.
 */
function defaultMockComplete(this: MockClaudeClient, req: ClaudeRequest): Promise<ClaudeResponse> {
  const self = this as unknown as { callCount: number; calls: { model: string; systemChars: number; msgChars: number }[] };
  self.callCount++;
  const systemText = req.system.map(b => b.text).join('\n');
  const messagesText = req.messages.map(m => `${m.role}:${m.content}`).join('\n');
  const fullPrompt = systemText + '\n' + messagesText;
  const hex8 = createHash('sha1').update(fullPrompt).digest('hex').slice(0, 8);
  self.calls.push({
    model: String(req.model),
    systemChars: systemText.length,
    msgChars: messagesText.length,
  });
  return Promise.resolve({
    text: `[mock:${hex8}] 好的`,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

/**
 * Patch body that intercepts the Planner system-prompt call (sentinel-matched
 * on the first line of R9_PLANNER_SYSTEM_PROMPT, reply-planner.ts:463) and
 * returns a canned valid Directive JSON. Non-planner calls fall through to
 * the inlined [mock:hex8] default.
 */
async function plannerAwareComplete(
  this: MockClaudeClient,
  req: ClaudeRequest,
): Promise<ClaudeResponse> {
  const sysText = req.system.map(b => b.text).join('\n');
  if (sysText.startsWith('你是一个回复计划器')) {
    return {
      text: JSON.stringify({
        mode: 'reply',
        length_budget: 'short',
        required_fact_ids: [],
        forbidden_tokens: [],
        tone_hint: '群友语气',
        use_sticker_token: null,
      }),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  return defaultMockComplete.call(this, req);
}

/**
 * Patch body that throws on the Planner system-prompt call. ReplyPlanner.plan()
 * catches the throw at reply-planner.ts:643-648 and returns null, which
 * chat.ts:3231-3242 maps to plannerSource='rule-fallback' with
 * fellBackReason='parse' (NOT 'timeout' — the throw never escapes Planner's
 * catch). Test asserts on plannerSource only.
 */
async function throwingPlannerComplete(
  this: MockClaudeClient,
  req: ClaudeRequest,
): Promise<ClaudeResponse> {
  const sysText = req.system.map(b => b.text).join('\n');
  if (sysText.startsWith('你是一个回复计划器')) {
    throw new Error('planner-mock simulated timeout');
  }
  return defaultMockComplete.call(this, req);
}

describe('replay-runner harness — R9 smoke (T-3 / T-3b / T-3c)', () => {
  let savedEnv: string | undefined;
  let originalComplete: typeof MockClaudeClient.prototype.complete;

  beforeAll(() => {
    buildSyntheticReplayDb(FIXTURE_DB);
  });

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    // Snapshot the original MockClaudeClient.complete so afterEach can restore.
    originalComplete = MockClaudeClient.prototype.complete;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    // Restore prototype to pristine deterministic [mock:hex8] behavior so
    // sibling tests in other files that import MockClaudeClient see the
    // original implementation (cross-file pollution guard).
    MockClaudeClient.prototype.complete = originalComplete;
  });

  it('T-3: R9 ON + planner-aware mock -> at least one row plannerSource === llm-planner', async () => {
    process.env[ENV_KEY] = '1';
    // Patch prototype so runReplay's internally-constructed MockClaudeClient
    // routes Planner system-prompt calls to the canned Directive JSON.
    MockClaudeClient.prototype.complete = plannerAwareComplete;

    const outDir = tmpDir('t3');
    const fixtures = writeInlineFixtures(outDir, true);
    const before = snapshotProdDb(FIXTURE_DB);
    const result = await runReplay(makeArgs(outDir, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const sources = lines.map(l => JSON.parse(l).plannerSource);
    expect(sources).toContain('llm-planner');

    assertNoProdContamination(FIXTURE_DB, before);
  }, 30_000);

  it('T-3b (edge): R9 OFF -> every non-error row plannerSource === no-planner-skipped', async () => {
    delete process.env[ENV_KEY];
    // Vanilla MockClaudeClient.complete (no patch).
    const outDir = tmpDir('t3b');
    const fixtures = writeInlineFixtures(outDir, true);
    const result = await runReplay(makeArgs(outDir, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      // Error rows have plannerSource: null (chat path errored before R9 gate).
      // Non-error rows must be 'no-planner-skipped' when flag off.
      if (parsed.resultKind !== 'error') {
        expect(parsed.plannerSource).toBe('no-planner-skipped');
      }
    }
  }, 30_000);

  it('T-3c (edge): R9 ON + throwing-planner mock -> at least one row plannerSource === rule-fallback', async () => {
    process.env[ENV_KEY] = '1';
    // Patch prototype so Planner LLM call throws; ReplyPlanner.plan catches
    // and returns null; chat.ts maps to rule-fallback with fellBackReason='parse'.
    MockClaudeClient.prototype.complete = throwingPlannerComplete;

    const outDir = tmpDir('t3c');
    const fixtures = writeInlineFixtures(outDir, true);
    const result = await runReplay(makeArgs(outDir, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const sources = lines.map(l => JSON.parse(l).plannerSource);
    expect(sources).toContain('rule-fallback');
    // Also confirms the wire was reached: at least one row is NOT
    // 'no-planner-skipped' (would indicate the gate short-circuited
    // before Planner.plan() got called).
    expect(sources.some(s => s !== 'no-planner-skipped' && s !== null)).toBe(true);
  }, 30_000);
});
