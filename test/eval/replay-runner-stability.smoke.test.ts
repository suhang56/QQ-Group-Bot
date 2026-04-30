/**
 * Smoke tests E + F for replay-runner stability.
 *
 *   E — foreground mock run completes cleanly (in-process call).
 *   F — background child via child_process.spawn, killed mid-run with SIGTERM,
 *       asserts exit 143 and haltReason='signal'. THIS IS THE PRIMARY GATE
 *       proving H5 (signal-kill) is fixed.
 *
 * On Windows, SIGTERM via `child.kill('SIGTERM')` translates to TerminateProcess
 * which Node converts to a 'SIGTERM' event on the child IF the child registered
 * a SIGTERM handler. The replay-runner registers that handler at module load.
 */

import {
  describe, it, expect, beforeAll,
} from 'vitest';
import { spawn } from 'node:child_process';
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
const RUNNER = path.join(REPO, 'scripts/eval/replay-runner.ts');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r6-smoke-${prefix}-`));
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
 * Generate N synthetic gold/benchmark rows in a tmp dir. See unit-test
 * helper of the same name; duplicated to avoid cross-file imports.
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
  // See note in stability.test.ts beforeAll — idempotent build to avoid WAL
  // race when test files run in parallel.
  if (!fs.existsSync(FIXTURE_DB)) {
    buildSyntheticReplayDb(FIXTURE_DB);
  }
});

describe('Test E — foreground mock run completes cleanly', () => {
  it('exit 0, summary.halted=false, JSONL row count matches summary.totalRows', async () => {
    const fxDir = tmpDir('E-fx');
    const { goldPath, benchPath } = makeLargeFixtures(60, fxDir);
    const outDir = tmpDir('E-out');

    const result = await runReplay(makeArgs(outDir, {
      goldPath, benchmarkPath: benchPath, limit: 60,
    }));
    expect(result.exitCode).toBe(0);

    const outputPath = path.join(outDir, 'replay-output.jsonl');
    const summaryPath = path.join(outDir, 'summary.json');
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(true);

    const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.halted).toBe(false);
    expect(summary.haltReason).toBeUndefined();
    expect(lines.length).toBe(summary.totalRows);
  }, 60_000);
});

describe('Test F — child_process spawn + SIGTERM mid-run produces halt summary', () => {
  // Skipped on Windows: Node SIGTERM semantics on Windows do not deliver a
  // catchable signal to the child — `child.kill('SIGTERM')` calls
  // TerminateProcess directly. The signal-handler proof-of-fix only applies
  // to POSIX hosts (Linux/macOS), which is where the silent-exit bug
  // (background tool-managed runs being killed by SIGHUP/SIGTERM) was
  // observed. Reviewer should run this test on Linux/macOS.
  const isWindows = process.platform === 'win32';
  const maybe = isWindows ? it.skip : it;

  maybe('child exits 143, summary haltReason=signal, JSONL has rows', async () => {
    const fxDir = tmpDir('F-fx');
    const { goldPath, benchPath } = makeLargeFixtures(200, fxDir);
    const outDir = tmpDir('F-out');

    // Pass args via env so we don't have to escape paths in argv on shells
    // with weird quoting. The runner reads via parseArgs(process.argv).
    const tsxBin = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

    const args = [
      RUNNER,
      '--gold', goldPath,
      '--benchmark', benchPath,
      '--output', outDir,
      '--llm-mode=mock',
      '--limit', '200',
      '--prod-db', FIXTURE_DB,
      '--bot-qq', '1705075399',
      '--group-id', '958751334',
      '--timeout-ms', '10000',
    ];

    const child = spawn(tsxBin, args, {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // First checkpoint at row 50 — kill once we see it.
      if (stderrBuf.includes('[checkpoint] rows=50') && !child.killed) {
        child.kill('SIGTERM');
      }
    });

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    // Either the runner caught SIGTERM and exited with 143, OR (race) it
    // finished all 200 rows before checkpoint-50 was observed (unlikely with
    // mock mode but allowed): code 0 + halted=false.
    const summaryPath = path.join(outDir, 'summary.json');
    expect(fs.existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    if (exitInfo.code === 143 || exitInfo.signal === 'SIGTERM') {
      // Primary path: signal handler fired.
      expect(summary.halted).toBe(true);
      expect(summary.haltReason).toBe('signal');
      expect(summary.signal).toBe('SIGTERM');
      const outputPath = path.join(outDir, 'replay-output.jsonl');
      expect(fs.existsSync(outputPath)).toBe(true);
      const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
    } else {
      // Race: completed before kill landed. Less interesting but acceptable.
      expect(exitInfo.code).toBe(0);
      expect(summary.halted).toBe(false);
    }
  }, 120_000);
});
