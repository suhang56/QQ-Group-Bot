/**
 * R7 — replay-runner consecutive-error halt + incomplete-summary parity.
 *
 * Covers the new --max-consecutive-errors halt branch and the `incomplete`
 * field on ReplaySummary. Tests T1-T6 exercise the row-loop halt; T7 unit-
 * tests the process-level handlers (_flushHalt, _signalFlush) directly via
 * the test-only setter for parity coverage.
 *
 * T8 (subprocess SIGTERM end-to-end) is covered by the existing smoke test
 * in replay-runner-stability.smoke.test.ts:206-208 (now asserts incomplete=true
 * on the signal-halt summary).
 */

import {
  describe, it, expect, beforeAll, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test-controlled per-call result kinds for runReplayRow stub. Indexed by
// invocation order. Must be set BEFORE the test triggers runReplay, and
// reset between tests. Using vi.hoisted so the mock factory below can read
// the same object reference at runtime.
const stubKinds = vi.hoisted(() => ({
  kinds: [] as Array<'error' | 'reply'>,
  idx: 0,
}));

vi.mock('../../scripts/eval/replay-runner-core.js', async (importActual) => {
  const actual = await importActual<typeof import('../../scripts/eval/replay-runner-core.js')>();
  return {
    ...actual,
    runReplayRow: vi.fn(async (args: Parameters<typeof actual.runReplayRow>[0]) => {
      const kind = stubKinds.kinds[stubKinds.idx++] ?? 'reply';
      const baseRow = {
        sampleId: args.gold.sampleId,
        category: args.category,
        goldAct: args.gold.goldAct,
        goldDecision: args.gold.goldDecision,
        factNeeded: args.gold.factNeeded,
        allowBanter: args.gold.allowBanter,
        allowSticker: args.gold.allowSticker,
        reasonCode: null,
        guardPath: null,
        targetMsgId: args.triggerMessage.messageId,
        usedFactHint: null,
        matchedFactIds: null,
        injectedFactIds: null,
        replyText: null,
        promptVariant: null,
        violationTags: [] as string[],
        errorMessage: null,
        durationMs: 1,
        llmInputTokens: null,
        llmOutputTokens: null,
        llmCostUsd: null,
      };
      if (kind === 'error') {
        return {
          ...baseRow,
          resultKind: 'error',
          utteranceAct: 'none',
          errorMessage: 'stubbed-error',
        } as ReplayRow;
      }
      return {
        ...baseRow,
        resultKind: 'reply',
        utteranceAct: 'direct_chat',
        replyText: '[stub] ok',
      } as ReplayRow;
    }),
  };
});

import {
  runReplay,
  _flushHalt,
  _signalFlush,
  _setHaltStateForTest,
  type HaltState,
} from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs, ReplayRow } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { GeminiClient } from '../../src/ai/providers/gemini-llm.js';

const REPO = path.resolve(__dirname, '../..');
const GOLD = path.join(REPO, 'test/fixtures/replay-gold-synthetic.jsonl');
const BENCH = path.join(REPO, 'test/fixtures/replay-benchmark-synthetic.jsonl');
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r7-halt-${prefix}-`));
}

function makeArgs(outputDir: string, overrides: Partial<ReplayerArgs> = {}): ReplayerArgs {
  return {
    goldPath: GOLD,
    benchmarkPath: BENCH,
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: FIXTURE_DB,
    botQQ: '1705075399',
    groupIdForReplay: '958751334',
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    maxConsecutiveErrors: null,
    ...overrides,
  };
}

/**
 * Build N direct_chat synthetic rows in a tmp dir. All rows are
 * direct_at_bot so ChatModule always invokes complete() — required for
 * tests that inject errors via spying complete().
 */
function makeDirectFixtures(n: number, dir: string): { goldPath: string; benchPath: string } {
  const goldPath = path.join(dir, 'gold.jsonl');
  const benchPath = path.join(dir, 'bench.jsonl');
  const goldLines: string[] = [];
  const benchLines: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = `958751334:80${String(i).padStart(4, '0')}`;
    goldLines.push(JSON.stringify({
      sampleId: sid,
      goldAct: 'direct_chat',
      goldDecision: 'reply',
      targetOk: true,
      factNeeded: false,
      allowBanter: true,
      allowSticker: false,
      labeledAt: '2026-04-20T00:00:00Z',
    }));
    benchLines.push(JSON.stringify({
      id: sid,
      groupId: '958751334',
      messageId: 80000 + i,
      sourceMessageId: `src-${80000 + i}`,
      userId: 'U1002',
      nickname: '李四',
      timestamp: 1_713_000_000 + i,
      content: '@bot 有人在吗',
      rawContent: '@bot 有人在吗',
      triggerContext: [],
      triggerContextAfter: [],
      category: 1,
      categoryLabel: 'direct_at_bot',
      samplingSeed: 1,
      contentHash: `h${i}`,
      contextHash: `c${i}`,
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
    }));
  }
  fs.writeFileSync(goldPath, goldLines.join('\n') + '\n');
  fs.writeFileSync(benchPath, benchLines.join('\n') + '\n');
  return { goldPath, benchPath };
}

beforeAll(() => {
  if (!fs.existsSync(FIXTURE_DB)) {
    buildSyntheticReplayDb(FIXTURE_DB);
  }
});

// Silence stderr so the gate-output is readable.
let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  stubKinds.kinds = [];
  stubKinds.idx = 0;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
});
afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

describe('T1 — 5 consecutive errors halts with retry-budget-exhausted', () => {
  it('halts at row 5; haltReason=retry-budget-exhausted, incomplete=true', async () => {
    const fxDir = tmpDir('T1-fx');
    const { goldPath, benchPath } = makeDirectFixtures(20, fxDir);
    const outDir = tmpDir('T1');
    stubKinds.kinds = ['error', 'error', 'error', 'error', 'error', 'reply', 'reply'];

    const result = await runReplay(makeArgs(outDir, {
      goldPath, benchmarkPath: benchPath,
      maxConsecutiveErrors: 5, limit: 20,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(5);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.haltReason).toBe('retry-budget-exhausted');
    expect(summary.incomplete).toBe(true);
  }, 30_000);
});

describe('T2 — 4 errors then success → counter resets, no halt', () => {
  it('8 rows: errors at 1-4, success at 5+; no halt, incomplete=false', async () => {
    const fxDir = tmpDir('T2-fx');
    const { goldPath, benchPath } = makeDirectFixtures(8, fxDir);
    const outDir = tmpDir('T2');
    stubKinds.kinds = ['error', 'error', 'error', 'error', 'reply', 'reply', 'reply', 'reply'];

    const result = await runReplay(makeArgs(outDir, {
      goldPath, benchmarkPath: benchPath,
      maxConsecutiveErrors: 5, limit: 8,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(8);

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(false);
    expect(summary.incomplete).toBe(false);
    expect(summary.haltReason).toBeUndefined();
  }, 30_000);
});

describe('T3 — interleaved err/ok pattern, never 5 in a row → no halt', () => {
  it('err/ok/err/ok/err/ok/err pattern over 7 rows; counter resets each ok', async () => {
    const fxDir = tmpDir('T3-fx');
    const { goldPath, benchPath } = makeDirectFixtures(7, fxDir);
    const outDir = tmpDir('T3');
    stubKinds.kinds = ['error', 'reply', 'error', 'reply', 'error', 'reply', 'error'];

    const result = await runReplay(makeArgs(outDir, {
      goldPath, benchmarkPath: benchPath,
      maxConsecutiveErrors: 5, limit: 7,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(7);

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(false);
    expect(summary.incomplete).toBe(false);
  }, 30_000);
});

describe('T4 — zero errors, run completes naturally', () => {
  it('default 2-row fixture, all succeed → halted=false, incomplete=false', async () => {
    const outDir = tmpDir('T4');
    // Empty stubKinds — stub falls back to kind='reply' for both rows.
    const result = await runReplay(makeArgs(outDir, { maxConsecutiveErrors: 5 }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(2);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(false);
    expect(summary.incomplete).toBe(false);
    expect(summary.haltReason).toBeUndefined();
  }, 30_000);
});

describe('T5 — cost-cap halt sets incomplete=true and haltReason=cost-cap', () => {
  // Real-mode wiring: spy GeminiClient.prototype.complete and set
  // maxCostUsd=0 so the pre-row-loop cost cap fires immediately.
  let savedKey: string | undefined;
  let geminiSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    savedKey = process.env['GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'fake-r7';
    geminiSpy = vi.spyOn(GeminiClient.prototype, 'complete').mockImplementation(async () => ({
      text: 'real-stub',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
  });
  afterEach(() => {
    geminiSpy?.mockRestore();
    geminiSpy = null;
    if (savedKey === undefined) delete process.env['GEMINI_API_KEY'];
    else process.env['GEMINI_API_KEY'] = savedKey;
  });

  it('cost-cap halt: incomplete=true, haltReason=cost-cap', async () => {
    const outDir = tmpDir('T5');
    const result = await runReplay(makeArgs(outDir, {
      llmMode: 'real', maxCostUsd: 0,
      maxConsecutiveErrors: null,
    }));
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.haltReason).toBe('cost-cap');
    expect(summary.incomplete).toBe(true);
  }, 30_000);
});

describe('T6 — --max-consecutive-errors override', () => {
  it('threshold=2 halts after 2nd consecutive error', async () => {
    const fxDir = tmpDir('T6-fx');
    const { goldPath, benchPath } = makeDirectFixtures(10, fxDir);
    const outDir = tmpDir('T6');
    stubKinds.kinds = ['error', 'error', 'error', 'error', 'error'];

    const result = await runReplay(makeArgs(outDir, {
      goldPath, benchmarkPath: benchPath,
      maxConsecutiveErrors: 2, limit: 10,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(2);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.haltReason).toBe('retry-budget-exhausted');
    expect(summary.incomplete).toBe(true);
  }, 30_000);
});

describe('T7 — _flushHalt + _signalFlush directly write incomplete=true', () => {
  // Direct unit test of the process-level handlers. Bypasses the row loop;
  // exercises the Object.assign branch in each handler. Per Architect Issue B.

  function makeHaltStateFixture(outDir: string): HaltState {
    fs.mkdirSync(outDir, { recursive: true });
    return {
      outputPath: path.join(outDir, 'replay-output.jsonl'),
      summaryPath: path.join(outDir, 'summary.json'),
      rows: [] as ReplayRow[],
      goldByKey: new Map(),
      llmMode: 'mock',
      goldPath: '/fake/gold.jsonl',
      benchmarkPath: '/fake/bench.jsonl',
      llmStats: null,
    };
  }

  afterEach(() => {
    _setHaltStateForTest(null);
  });

  it('T7a — _flushHalt writes summary with halted, haltReason=unhandled-error, incomplete=true', () => {
    const outDir = tmpDir('T7a');
    const fx = makeHaltStateFixture(outDir);
    _setHaltStateForTest(fx);
    _flushHalt('test', new Error('boom-T7a'));
    const summary = JSON.parse(fs.readFileSync(fx.summaryPath, 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.haltReason).toBe('unhandled-error');
    expect(summary.incomplete).toBe(true);
    expect(String(summary.error)).toContain('boom-T7a');
  });

  it('T7b — _signalFlush writes summary with halted, haltReason=signal, incomplete=true', () => {
    const outDir = tmpDir('T7b');
    const fx = makeHaltStateFixture(outDir);
    _setHaltStateForTest(fx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('exit-stub');
    }) as typeof process.exit);
    try {
      try { _signalFlush('SIGTERM'); } catch { /* exit-stub */ }
    } finally {
      exitSpy.mockRestore();
    }
    const summary = JSON.parse(fs.readFileSync(fx.summaryPath, 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.haltReason).toBe('signal');
    expect(summary.incomplete).toBe(true);
    expect(summary.signal).toBe('SIGTERM');
  });
});
