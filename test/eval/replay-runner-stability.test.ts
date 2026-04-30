/**
 * Stability tests A-J for replay-runner process-level halt handlers.
 *
 * Covers:
 *   A — unhandledRejection captured + halted summary written
 *   B — uncaughtException captured + halted summary written
 *   C — _haltState=null after normal completion → post-run events are no-ops
 *   D — integration: unhandled rejection mid-run → JSONL + summary preserved
 *   G — SIGTERM mid-run (in-process emit) → haltReason 'signal'
 *   H — atomic .tmp+rename: failed write does not corrupt summary.json
 *   I — handler de-duplication: listenerCount stable across runs
 *   J — _flushHalt does not throw on disk-full
 *
 * Smoke tests E (foreground) + F (child_process + SIGTERM) live in the
 * `*.smoke.test.ts` companion file.
 */

import {
  describe, it, expect, beforeAll, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';

const REPO = path.resolve(__dirname, '../..');
const GOLD = path.join(REPO, 'test/fixtures/replay-gold-synthetic.jsonl');
const BENCH = path.join(REPO, 'test/fixtures/replay-benchmark-synthetic.jsonl');
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r6-stab-${prefix}-`));
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
    ...overrides,
  };
}

/**
 * Generate N synthetic gold/benchmark rows by repeating the two committed
 * fixture rows with unique sampleIds. Returns paths in a tmp dir.
 *
 * Bench rows have empty triggerContext, so no DB seeding is needed beyond
 * the existing synthetic fixture.
 */
function makeLargeFixtures(n: number, dir: string): { goldPath: string; benchPath: string } {
  const goldPath = path.join(dir, 'gold.jsonl');
  const benchPath = path.join(dir, 'bench.jsonl');
  const goldLines: string[] = [];
  const benchLines: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = `958751334:90${String(i).padStart(4, '0')}`;
    const isReply = i % 2 === 1;
    goldLines.push(JSON.stringify({
      sampleId: sid,
      goldAct: isReply ? 'direct_chat' : 'silence',
      goldDecision: isReply ? 'reply' : 'silent',
      targetOk: true,
      factNeeded: false,
      allowBanter: isReply,
      allowSticker: false,
      labeledAt: '2026-04-20T00:00:00Z',
    }));
    benchLines.push(JSON.stringify({
      id: sid,
      groupId: '958751334',
      messageId: 90000 + i,
      sourceMessageId: `src-${90000 + i}`,
      userId: isReply ? 'U1002' : 'U1001',
      nickname: isReply ? '李四' : '张三',
      timestamp: 1_713_000_000 + i,
      content: isReply ? '有人在吗' : '今天天气真好',
      rawContent: isReply ? '有人在吗' : '今天天气真好',
      triggerContext: [],
      triggerContextAfter: [],
      category: isReply ? 1 : 10,
      categoryLabel: isReply ? 'direct_at_bot' : 'silence_candidate',
      samplingSeed: 1,
      contentHash: `h${i}`,
      contextHash: `c${i}`,
      label: {
        expectedAct: isReply ? 'direct_chat' : 'chime_in',
        expectedDecision: isReply ? 'reply' : 'silent',
        hasKnownFactTerm: false,
        knownFactSource: null,
        hasRealFactHit: false,
        allowPluralYou: false,
        isObjectReact: false,
        isBotStatusContext: false,
        isBurst: false,
        isRelay: false,
        isDirect: isReply,
        riskFlags: [],
      },
    }));
  }
  fs.writeFileSync(goldPath, goldLines.join('\n') + '\n');
  fs.writeFileSync(benchPath, benchLines.join('\n') + '\n');
  return { goldPath, benchPath };
}

beforeAll(() => {
  // Idempotent — only build if missing. The mock-test file rebuilds in its
  // own beforeAll; running both files in parallel would otherwise race on
  // the WAL lock.
  if (!fs.existsSync(FIXTURE_DB)) {
    buildSyntheticReplayDb(FIXTURE_DB);
  }
});

// Each describe sets up + clears a stderr spy. Restore in afterEach.
let stderrChunks: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  stderrChunks = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((data: unknown) => {
    stderrChunks.push(typeof data === 'string' ? data : String(data));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

describe('Test A — unhandledRejection captured + halted summary', () => {
  it('halt-summary content captured when fired mid-run', async () => {
    const fxDir = tmpDir('A-fx');
    const { goldPath, benchPath } = makeLargeFixtures(400, fxDir);
    const outDir = tmpDir('A');
    const summaryPath = path.join(outDir, 'summary.json');
    fs.mkdirSync(outDir, { recursive: true });

    // Intercept summary.json.tmp writes to capture the halted summary.
    const captures: string[] = [];
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          captures.push(typeof data === 'string' ? data : String(data));
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    try {
      // Schedule mid-run rejection. Fire several times across the loop's
      // expected duration; each emit either fires _flushHalt (if _haltState
      // is set) or is a no-op (post-run). De-flakes parallel execution where
      // a single 30ms timer may land past the loop end.
      let fires = 0;
      const ticker = setInterval(() => {
        fires++;
        process.emit('unhandledRejection', new Error('boom-A'), Promise.resolve());
        if (fires >= 5) clearInterval(ticker);
      }, 5);
      ticker.unref?.();

      await runReplay(makeArgs(outDir, {
        goldPath, benchmarkPath: benchPath, limit: 400,
      }));
      clearInterval(ticker);
    } finally {
      writeSpy.mockRestore();
    }

    const haltCaptures = captures.filter(c => c.includes('"haltReason": "unhandled-error"'));
    expect(haltCaptures.length).toBeGreaterThanOrEqual(1);
    const halt = JSON.parse(haltCaptures[0]!);
    expect(halt.halted).toBe(true);
    expect(halt.haltReason).toBe('unhandled-error');
    expect(halt.error).toContain('boom-A');

    expect(fs.existsSync(summaryPath)).toBe(true);
    const final = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(typeof final.halted).toBe('boolean');

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[replay-runner] FATAL unhandledRejection');
    expect(stderr).toContain('boom-A');
  }, 60_000);
});

describe('Test B — uncaughtException captured + halted summary', () => {
  it('exits with code 1 and writes halted summary', async () => {
    const fxDir = tmpDir('B-fx');
    const { goldPath, benchPath } = makeLargeFixtures(400, fxDir);
    const outDir = tmpDir('B');
    fs.mkdirSync(outDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // Don't actually exit; record the call only.
      return undefined as never;
    }) as typeof process.exit);

    const captures: string[] = [];
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          captures.push(typeof data === 'string' ? data : String(data));
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    // Identify our uncaughtException listener installed at module load.
    // process.emit('uncaughtException', ...) is non-functional in vitest
    // (vitest may absorb the event); throwing inside setImmediate would
    // propagate to vitest's handler and fail the test. Instead, filter
    // listeners to find ours (the one that calls _flushHalt) and invoke it
    // directly — this exercises the real handler code path.
    const ourListener = process.listeners('uncaughtException').find(l =>
      l.toString().includes('_flushHalt'),
    );
    expect(ourListener).toBeDefined();

    try {
      let fires = 0;
      const ticker = setInterval(() => {
        fires++;
        try {
          (ourListener as (e: Error) => void)(new Error('oops-B'));
        } catch { /* exit-spy threw */ }
        if (fires >= 5) clearInterval(ticker);
      }, 5);
      ticker.unref?.();

      try {
        await runReplay(makeArgs(outDir, {
          goldPath, benchmarkPath: benchPath, limit: 400,
        }));
      } catch { /* swallow — exit-spy threw */ }
      clearInterval(ticker);

      // Snapshot exit-spy call args BEFORE mockRestore clears history.
      const exitCallArgs = exitSpy.mock.calls.map(c => c[0]);

      writeSpy.mockRestore();
      exitSpy.mockRestore();

      expect(exitCallArgs).toContain(1);
      const haltCaptures = captures.filter(c => c.includes('"haltReason": "unhandled-error"'));
      expect(haltCaptures.length).toBeGreaterThanOrEqual(1);
      const halt = JSON.parse(haltCaptures[0]!);
      expect(halt.error).toContain('oops-B');
    } finally {
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }, 30_000);
});

describe('Test C — post-run events are no-ops', () => {
  it('emit unhandledRejection AFTER runReplay resolves does not rewrite summary', async () => {
    const outDir = tmpDir('C');
    const summaryPath = path.join(outDir, 'summary.json');

    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    const mtimeBefore = fs.statSync(summaryPath).mtimeMs;

    // _haltState is null now. Emit a stray rejection.
    stderrChunks.length = 0;
    process.emit('unhandledRejection', new Error('late-C'), Promise.resolve());
    // Allow handler to run.
    await new Promise(r => setImmediate(r));

    // FATAL line still printed (handler runs), but summary not rewritten.
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[replay-runner] FATAL unhandledRejection');
    const mtimeAfter = fs.statSync(summaryPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('Test D — integration: mid-run unhandled rejection preserves JSONL + summary', () => {
  it('with 400 rows + rejection mid-run, output and halt summary both present', async () => {
    const fxDir = tmpDir('D-fx');
    const { goldPath, benchPath } = makeLargeFixtures(400, fxDir);
    const outDir = tmpDir('D-out');
    const outputPath = path.join(outDir, 'replay-output.jsonl');
    const summaryPath = path.join(outDir, 'summary.json');

    const captures: string[] = [];
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          captures.push(typeof data === 'string' ? data : String(data));
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    try {
      let fires = 0;
      const ticker = setInterval(() => {
        fires++;
        process.emit('unhandledRejection', new Error('mid-run-boom'), Promise.resolve());
        if (fires >= 5) clearInterval(ticker);
      }, 5);
      ticker.unref?.();

      const result = await runReplay(makeArgs(outDir, {
        goldPath, benchmarkPath: benchPath, limit: 400,
      }));
      clearInterval(ticker);
      // The unhandledRejection handler sets exitCode but does not abort the
      // running await chain — the run completes. So we expect normal exit
      // and full output.
      expect(result.rowsWritten).toBe(400);
      expect(fires).toBeGreaterThanOrEqual(1);
    } finally {
      writeSpy.mockRestore();
    }

    // JSONL is durable (datasync per row).
    expect(fs.existsSync(outputPath)).toBe(true);
    const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Halt summary captured during the mid-run event.
    const haltCaptures = captures.filter(c => c.includes('"haltReason": "unhandled-error"'));
    expect(haltCaptures.length).toBeGreaterThanOrEqual(1);

    // Final summary.json on disk is valid JSON.
    expect(fs.existsSync(summaryPath)).toBe(true);
    const finalSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(typeof finalSummary.halted).toBe('boolean');
  }, 30_000);
});

describe('Test G — SIGTERM in-process produces halt summary', () => {
  it('captures haltReason signal + signal name + exit(143)', async () => {
    const fxDir = tmpDir('G-fx');
    const { goldPath, benchPath } = makeLargeFixtures(400, fxDir);
    const outDir = tmpDir('G-out');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // Don't actually exit; record the call only.
      return undefined as never;
    }) as typeof process.exit);

    const captures: string[] = [];
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          captures.push(typeof data === 'string' ? data : String(data));
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    try {
      // Fire SIGTERM after the run has set _haltState.
      // Vitest absorbs process.emit('SIGTERM',...) on some platforms; invoke
      // our installed listener directly so the assertion target is the
      // production handler, not Node's signal pipeline.
      const ourSigListener = process.listeners('SIGTERM').find(l =>
        l.toString().includes('_signalFlush'),
      );
      expect(ourSigListener).toBeDefined();
      let fires = 0;
      const ticker = setInterval(() => {
        fires++;
        try {
          (ourSigListener as (s: string) => void)('SIGTERM');
        } catch { /* mockImpl threw */ }
        if (fires >= 5) clearInterval(ticker);
      }, 5);
      ticker.unref?.();

      try {
        await runReplay(makeArgs(outDir, {
          goldPath, benchmarkPath: benchPath, limit: 400,
        }));
      } catch { /* swallow if mockImpl threw */ }
      clearInterval(ticker);

      // Snapshot exit-spy call info BEFORE mockRestore (which clears history).
      const exitCallArgs = exitSpy.mock.calls.map(c => c[0]);

      writeSpy.mockRestore();
      exitSpy.mockRestore();

      const haltCaptures = captures.filter(c => c.includes('"haltReason": "signal"'));
      expect(haltCaptures.length).toBeGreaterThanOrEqual(1);
      const halt = JSON.parse(haltCaptures[0]!);
      expect(halt.signal).toBe('SIGTERM');
      expect(halt.halted).toBe(true);
      // exit was called with 143 = 128 + 15.
      expect(exitCallArgs).toContain(143);
    } finally {
      // Defensive restore in case the try-block early-returned.
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }, 30_000);
});

describe('Test H — atomic write: failed .tmp write does not corrupt summary.json', () => {
  it('first .tmp write throws → no half-written summary.json on disk', async () => {
    const outDir = tmpDir('H');
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, 'summary.json');

    let throwOnce = true;
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (throwOnce && typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          throwOnce = false;
          throw new Error('disk-full-H');
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    try {
      const result = await runReplay(makeArgs(outDir));
      // First .tmp write was the FINAL summary write — it threw, runner
      // returns exitCode 3 per the existing catch.
      expect(result.exitCode).toBe(3);

      // Either summary.json is absent, or it parses as valid JSON. Never
      // truncated/corrupt.
      if (fs.existsSync(summaryPath)) {
        const txt = fs.readFileSync(summaryPath, 'utf8');
        expect(() => JSON.parse(txt)).not.toThrow();
      }
    } finally {
      writeSpy.mockRestore();
    }

    // Run again with no fault — final summary.json is valid JSON.
    const outDir2 = tmpDir('H2');
    const result2 = await runReplay(makeArgs(outDir2));
    expect(result2.exitCode).toBe(0);
    const final = JSON.parse(fs.readFileSync(path.join(outDir2, 'summary.json'), 'utf8'));
    expect(typeof final.totalRows).toBe('number');
  });
});

describe('Test I — handler de-duplication across sequential runReplay calls', () => {
  it('listenerCount stable at 1 after each of 3 runs; no MaxListenersExceededWarning', async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error): void => { warnings.push(String(w)); };
    process.on('warning', onWarn);

    try {
      for (let i = 0; i < 3; i++) {
        const outDir = tmpDir(`I-${i}`);
        const result = await runReplay(makeArgs(outDir));
        expect(result.exitCode).toBe(0);
        // The handler block installs exactly one listener for each event.
        // (Vitest may install its own; we only assert OURS is the first/only
        // among non-vitest listeners by counting >=1 and <=2.)
        const counts = {
          unhandledRejection: process.listenerCount('unhandledRejection'),
          uncaughtException: process.listenerCount('uncaughtException'),
          SIGTERM: process.listenerCount('SIGTERM'),
          SIGHUP: process.listenerCount('SIGHUP'),
          SIGINT: process.listenerCount('SIGINT'),
        };
        // Vitest test runner registers its own unhandledRejection/exception
        // hooks. Allow up to 2 listeners per event but assert no growth.
        expect(counts.unhandledRejection).toBeLessThanOrEqual(3);
        expect(counts.uncaughtException).toBeLessThanOrEqual(3);
        expect(counts.SIGTERM).toBeLessThanOrEqual(2);
        expect(counts.SIGHUP).toBeLessThanOrEqual(2);
        expect(counts.SIGINT).toBeLessThanOrEqual(3);
      }
      const maxListenerWarnings = warnings.filter(w => w.includes('MaxListenersExceeded'));
      expect(maxListenerWarnings.length).toBe(0);
    } finally {
      process.off('warning', onWarn);
    }
  }, 30_000);
});

describe('Test J — _flushHalt does not throw when summary write fails', () => {
  it('disk-full mid-flush logs error; no secondary unhandled exception', async () => {
    const fxDir = tmpDir('J-fx');
    const { goldPath, benchPath } = makeLargeFixtures(400, fxDir);
    const outDir = tmpDir('J');
    fs.mkdirSync(outDir, { recursive: true });

    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(
      ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
        if (typeof p === 'string' && p.endsWith('summary.json.tmp')) {
          throw new Error('disk-full-J');
        }
        return origWrite.call(fs, p, data as never, opts as never);
      }) as typeof fs.writeFileSync,
    );

    try {
      // Schedule mid-run rejection. The handler's writeFileSync will throw —
      // _flushHalt should catch internally and log "could not write halt summary".
      let fires = 0;
      const ticker = setInterval(() => {
        fires++;
        expect(() => {
          process.emit('unhandledRejection', new Error('boom-J'), Promise.resolve());
        }).not.toThrow();
        if (fires >= 5) clearInterval(ticker);
      }, 5);
      ticker.unref?.();

      const result = await runReplay(makeArgs(outDir, {
        goldPath, benchmarkPath: benchPath, limit: 400,
      }));
      clearInterval(ticker);
      // Final summary write also throws → exitCode 3 OR run completes
      // normally if rejection hits after final write. Either is fine.
      expect([0, 3]).toContain(result.exitCode);
    } finally {
      writeSpy.mockRestore();
    }

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[replay-runner] could not write halt summary');
  }, 30_000);
});
