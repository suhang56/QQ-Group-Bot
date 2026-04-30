/**
 * R6.4 — Real-mode integration tests for replay-runner.
 *
 * Two layers:
 *   1. Direct unit tests of `RealClaudeClientForReplay` — cover cost calc,
 *      retry logic, cost cap, timeout, error counting. No ChatModule, no
 *      runner round-trip — fastest + most precise per behavior.
 *   2. Runner integration tests — cover wiring: --llm-mode=real exit-2 lifted,
 *      DI branch picks real client, summary section populated, halted flag,
 *      --limit, recorded mode still exits 2.
 *
 * Strategy: spy `GeminiClient.prototype.complete` so zero real network calls
 * leave the test process. The spy intercepts BEFORE GeminiClient's internal
 * try/catch wrap, so error throws reach `RealClaudeClientForReplay` raw —
 * tests can simulate `{ status: 429 }` etc. directly and the client's
 * `extractRawErr` handles both raw and ClaudeApiError-wrapped paths.
 *
 * NEVER use mockResolvedValueOnce + fallthrough — full mock or test burns
 * real API quota.
 */

import {
  describe, it, expect, beforeAll, afterAll, beforeEach, vi,
  type MockInstance,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReplay } from '../../../scripts/eval/replay-runner.js';
import { GeminiClient } from '../../../src/ai/providers/gemini-llm.js';
import {
  RealClaudeClientForReplay,
  CostCapError,
  type RealLlmConfig,
} from '../../../src/ai/real-claude-client-for-replay.js';
import { ClaudeApiError } from '../../../src/utils/errors.js';
import { buildSyntheticReplayDb } from '../../../scripts/eval/build-synthetic-replay-db.js';
import type { ReplayerArgs } from '../../../scripts/eval/replay-types.js';
import type { ClaudeRequest, ClaudeResponse } from '../../../src/ai/claude.js';

const REPO = path.resolve(__dirname, '../../..');
const GOLD = path.join(REPO, 'test/fixtures/replay-gold-synthetic.jsonl');
const BENCH = path.join(REPO, 'test/fixtures/replay-benchmark-synthetic.jsonl');
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r6-4-real-${prefix}-`));
}

function makeArgs(outputDir: string, overrides: Partial<ReplayerArgs> = {}): ReplayerArgs {
  return {
    goldPath: GOLD,
    benchmarkPath: BENCH,
    outputDir,
    llmMode: 'real',
    limit: null,
    prodDbPath: FIXTURE_DB,
    botQQ: '1705075399',
    groupIdForReplay: '958751334',
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    ...overrides,
  };
}

function defaultStubResponse(): ClaudeResponse {
  return {
    text: 'mock-real reply',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function dummyReq(): ClaudeRequest {
  return {
    model: 'gemini-2.5-flash',
    maxTokens: 200,
    system: [{ text: 'sys', cache: false }],
    messages: [{ role: 'user', content: 'hi' }],
  };
}

function defaultCfg(o: Partial<RealLlmConfig> = {}): RealLlmConfig {
  return {
    apiKey: 'fake',
    maxCostUsd: 5.00,
    perCallTimeoutMs: 1000,
    rateLimitRps: 1000,
    retryMax: 3,
    ...o,
  };
}

let spy: MockInstance;
let savedKey: string | undefined;
let savedRetry: string | undefined;
let savedRps: string | undefined;
let savedCost: string | undefined;
let savedTimeout: string | undefined;

describe('RealClaudeClientForReplay — direct unit tests', () => {
  beforeAll(() => {
    savedKey = process.env['GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'fake-ci-key';
    spy = vi.spyOn(GeminiClient.prototype, 'complete').mockImplementation(async () => defaultStubResponse());
  });

  afterAll(() => {
    spy.mockRestore();
    if (savedKey === undefined) delete process.env['GEMINI_API_KEY']; else process.env['GEMINI_API_KEY'] = savedKey;
  });

  beforeEach(() => {
    spy.mockReset();
    spy.mockImplementation(async () => defaultStubResponse());
  });

  it('successful complete() accumulates inputTokens/outputTokens/costUsd', async () => {
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg());
    await client.complete(dummyReq());
    const stats = client.getStats();
    expect(stats.totalInputTokens).toBe(100);
    expect(stats.totalOutputTokens).toBe(50);
    // 100*0.000075/1000 + 50*0.000300/1000 = 7.5e-6 + 15e-6 = 22.5e-6
    expect(stats.totalCostUsd).toBeCloseTo(22.5e-6, 12);
    expect(stats.errorCount).toBe(0);
  });

  it('429 retry succeeds: 3x throw {status:429} then success', async () => {
    let i = 0;
    spy.mockImplementation(async () => {
      i++;
      if (i <= 3) throw Object.assign(new Error('rate limit'), { status: 429 });
      return defaultStubResponse();
    });
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ retryMax: 5, perCallTimeoutMs: 30_000 }));
    const resp = await client.complete(dummyReq());
    expect(resp.text).toBe('mock-real reply');
    expect(i).toBe(4);
    expect(client.getStats().errorCount).toBe(0);
  }, 30_000);

  it('429 exhaust: all calls throw {status:429} → throws + errorCount++', async () => {
    spy.mockImplementation(async () => {
      throw Object.assign(new Error('rate limit'), { status: 429 });
    });
    const inner = new GeminiClient({ apiKey: 'fake' });
    // retryMax=1 → 2 attempts total, backoff ~1s.
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ retryMax: 1, perCallTimeoutMs: 30_000 }));
    await expect(client.complete(dummyReq())).rejects.toThrow();
    expect(client.getStats().errorCount).toBe(1);
  }, 30_000);

  it('5xx retry: throw {status:503} then succeed', async () => {
    let i = 0;
    spy.mockImplementation(async () => {
      i++;
      if (i === 1) throw Object.assign(new Error('upstream'), { status: 503 });
      return defaultStubResponse();
    });
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ retryMax: 2, perCallTimeoutMs: 30_000 }));
    await client.complete(dummyReq());
    expect(client.getStats().errorCount).toBe(0);
  }, 30_000);

  it('ClaudeApiError-wrapped 429 (prod path): cause.status extracted, retry triggered', async () => {
    let i = 0;
    spy.mockImplementation(async () => {
      i++;
      if (i === 1) {
        // Production path: GeminiClient catches the SDK error and wraps it.
        const inner = Object.assign(new Error('rate limit'), { status: 429 });
        throw new ClaudeApiError(inner);
      }
      return defaultStubResponse();
    });
    const ic = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(ic, defaultCfg({ retryMax: 2, perCallTimeoutMs: 30_000 }));
    await client.complete(dummyReq());
    expect(client.getStats().errorCount).toBe(0);
    expect(i).toBe(2);
  }, 30_000);

  it('cost cap: pre-call check throws CostCapError when totalCostUsd >= cap', async () => {
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ maxCostUsd: 1e-7 }));
    // First call succeeds (cap not yet exceeded BEFORE call), accumulates 22.5e-6.
    await client.complete(dummyReq());
    expect(client.getStats().totalCostUsd).toBeGreaterThan(1e-7);
    // Second call: pre-check fires, CostCapError thrown.
    await expect(client.complete(dummyReq())).rejects.toBeInstanceOf(CostCapError);
    // CostCapError NOT counted as errorCount (it's control flow, not a server error).
    expect(client.getStats().errorCount).toBe(0);
  });

  it('per-call timeout: stub never resolves → rejects "timeout after Nms", errorCount++', async () => {
    spy.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ perCallTimeoutMs: 50, retryMax: 0 }));
    await expect(client.complete(dummyReq())).rejects.toThrow(/timeout after/);
    expect(client.getStats().errorCount).toBe(1);
  }, 5_000);

  it('non-retryable error (no status): immediate rethrow, errorCount++', async () => {
    spy.mockImplementation(async () => {
      throw new Error('unknown failure');
    });
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg());
    await expect(client.complete(dummyReq())).rejects.toThrow(/unknown failure/);
    expect(client.getStats().errorCount).toBe(1);
  });

  it('rate limiter: 4 sub-RPS calls with rps=2 measurably throttled', async () => {
    spy.mockImplementation(async () => defaultStubResponse());
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg({ rateLimitRps: 2 }));
    const t0 = Date.now();
    // First 2 calls fit in window 1; calls 3 and 4 must wait for window 2.
    await client.complete(dummyReq());
    await client.complete(dummyReq());
    await client.complete(dummyReq());
    await client.complete(dummyReq());
    const elapsed = Date.now() - t0;
    // Expect at least one ~1s sleep between window 1 and window 2.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 5_000);

  it('vision methods delegate to inner without retry/cost tracking', async () => {
    const visionSpy = vi
      .spyOn(GeminiClient.prototype, 'visionWithPrompt')
      .mockImplementation(async () => 'vision result');
    const inner = new GeminiClient({ apiKey: 'fake' });
    const client = new RealClaudeClientForReplay(inner, defaultCfg());
    const out = await client.visionWithPrompt(Buffer.from([0xff, 0xd8]), 'gemini-2.5-flash', 'p');
    expect(out).toBe('vision result');
    // Cost remains 0 — vision is not metered here.
    expect(client.getStats().totalCostUsd).toBe(0);
    visionSpy.mockRestore();
  });
});

describe('replay-runner — real mode wiring', () => {
  beforeAll(() => {
    buildSyntheticReplayDb(FIXTURE_DB);
    savedKey = process.env['GEMINI_API_KEY'];
    savedRetry = process.env['REPLAY_RETRY_MAX'];
    savedRps = process.env['REPLAY_RATE_LIMIT_RPS'];
    savedCost = process.env['REPLAY_MAX_COST_USD'];
    savedTimeout = process.env['REPLAY_PER_CALL_TIMEOUT_MS'];
    process.env['GEMINI_API_KEY'] = 'fake-ci-key';
    spy = vi.spyOn(GeminiClient.prototype, 'complete').mockImplementation(async () => defaultStubResponse());
  });

  afterAll(() => {
    spy.mockRestore();
    if (savedKey === undefined) delete process.env['GEMINI_API_KEY']; else process.env['GEMINI_API_KEY'] = savedKey;
    if (savedRetry === undefined) delete process.env['REPLAY_RETRY_MAX']; else process.env['REPLAY_RETRY_MAX'] = savedRetry;
    if (savedRps === undefined) delete process.env['REPLAY_RATE_LIMIT_RPS']; else process.env['REPLAY_RATE_LIMIT_RPS'] = savedRps;
    if (savedCost === undefined) delete process.env['REPLAY_MAX_COST_USD']; else process.env['REPLAY_MAX_COST_USD'] = savedCost;
    if (savedTimeout === undefined) delete process.env['REPLAY_PER_CALL_TIMEOUT_MS']; else process.env['REPLAY_PER_CALL_TIMEOUT_MS'] = savedTimeout;
  });

  beforeEach(() => {
    spy.mockReset();
    spy.mockImplementation(async () => defaultStubResponse());
  });

  it('--llm-mode=real no longer hits exit-2 path (was the R6.3 unimplemented gate)', async () => {
    const outDir = tmpDir('real-not-exit2');
    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(2);
  }, 30_000);

  it('summary has realLlm:true and r6.4 cost section', async () => {
    const outDir = tmpDir('summary');
    await runReplay(makeArgs(outDir));
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.realLlm).toBe(true);
    expect(summary.runnerVersion).toBe('r6.4.0');
    expect(typeof summary.totalLlmInputTokens).toBe('number');
    expect(typeof summary.totalLlmOutputTokens).toBe('number');
    expect(typeof summary.totalLlmCostUsd).toBe('number');
    expect(typeof summary.llmErrorCount).toBe('number');
    expect(summary.halted).toBe(false);
  }, 30_000);

  it('mock mode summary has realLlm:false', async () => {
    const outDir = tmpDir('summary-mock');
    await runReplay(makeArgs(outDir, { llmMode: 'mock' }));
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.realLlm).toBe(false);
    expect(summary.halted).toBe(false);
  }, 30_000);

  it('cost cap halt: extremely tiny cap with pre-existing accumulated cost halts run', async () => {
    // Force LLM call before runner: the synthetic gold rows may not trigger
    // generateReply → complete(); so we test halt by setting cap=0, which makes
    // the pre-check fire on row 1 (since 0 >= 0 is the cap-met condition? No —
    // pre-check is `totalCostUsd >= cap`; 0 >= 0 means halt before row 1).
    // Set cap=0 so pre-check fires immediately.
    const outDir = tmpDir('cap-zero');
    const result = await runReplay(makeArgs(outDir, { maxCostUsd: 0 }));
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.halted).toBe(true);
    expect(summary.totalRows).toBe(0);
  }, 30_000);

  it('--limit caps row count to 1', async () => {
    const outDir = tmpDir('limit');
    const result = await runReplay(makeArgs(outDir, { limit: 1 }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(1);
  }, 30_000);

  it('recorded mode → exit 2 (unchanged out-of-scope)', async () => {
    const outDir = tmpDir('recorded');
    const result = await runReplay(makeArgs(outDir, { llmMode: 'recorded' }));
    expect(result.exitCode).toBe(2);
  });

  it('GEMINI_API_KEY missing → exit 1', async () => {
    const saved = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runReplay(makeArgs(tmpDir('no-key')))).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      exitSpy.mockRestore();
      writeSpy.mockRestore();
      if (saved !== undefined) process.env['GEMINI_API_KEY'] = saved;
    }
  }, 30_000);
});
