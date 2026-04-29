import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main,
  parseArgs,
  collectGitMeta,
  buildFilename,
  buildLabel,
  sanitizeLabel,
  type GitInfo,
  type GitShell,
  type SnapshotCliArgs,
} from '../../scripts/eval/snapshot.js';
import type { RunResult } from '../../scripts/eval/replay-runner.js';
import {
  type AggregatorRow,
  METRIC_NAMES,
  AGGREGATOR_VERSION,
} from '../../scripts/eval/aggregation/metrics.js';

// ----- Test infrastructure -----

const tmpDirs: string[] = [];

function makeTmp(prefix = 'snapshot-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function MINIMAL_ROW(over: Partial<AggregatorRow> = {}): AggregatorRow {
  return {
    sampleId: 's-01',
    category: 1,
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    factNeeded: false,
    resultKind: 'silent',
    violationTags: [],
    ...over,
  };
}

function writeDummyFile(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '');
  return p;
}

function makeFakeReplayOutput(dir: string, rows: readonly AggregatorRow[]): string {
  const outDir = join(dir, '.tmp', `run-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'replay-output.jsonl');
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return outPath;
}

function fakeRunReplay(outputPath: string, exitCode = 0): typeof import('../../scripts/eval/replay-runner.js').runReplay {
  return async (): Promise<RunResult> => ({
    exitCode,
    rowsWritten: 0,
    outputPath,
    summaryPath: outputPath ? outputPath.replace('.jsonl', '-summary.json') : '',
  });
}

function shellStub(map: Record<string, string | (() => string)>): GitShell {
  return (cmd: string): string => {
    for (const [pattern, response] of Object.entries(map)) {
      if (cmd.includes(pattern)) {
        return typeof response === 'function' ? response() : response;
      }
    }
    throw new Error(`shellStub: no match for ${cmd}`);
  };
}

const CLEAN_GIT_SHELL: GitShell = shellStub({
  'rev-parse --short HEAD': 'abc1234\n',
  'rev-parse --abbrev-ref HEAD': 'master\n',
  'rev-parse HEAD': 'abc1234567890abc1234567890abc1234567890ab\n',
  'status --porcelain': '',
  'rev-list --count': '0\n',
});

const FIXED_NOW = (): Date => new Date('2026-04-28T17:04:00.000Z');

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return fn().then(
    (result) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { result, stdout: out.join(''), stderr: err.join('') };
    },
    (e) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      throw e;
    },
  );
}

function findSnapshotFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function readSingleSnapshot(dir: string): {
  schema: string;
  label: string;
  createdAt: number;
  git: GitInfo;
  aggregate: Record<string, unknown>;
} {
  const files = findSnapshotFiles(dir);
  expect(files.length).toBe(1);
  const text = readFileSync(join(dir, files[0]!), 'utf8');
  return JSON.parse(text);
}

function buildBaseArgv(
  dir: string,
  over: { gold?: string; bench?: string; prodDb?: string; extra?: string[] } = {},
): string[] {
  return [
    '--gold', over.gold ?? writeDummyFile(dir, 'gold.jsonl'),
    '--benchmark', over.bench ?? writeDummyFile(dir, 'bench.jsonl'),
    '--prod-db', over.prodDb ?? writeDummyFile(dir, 'prod.db'),
    '--bot-qq', '12345',
    '--group-id', '67890',
    '--output-dir', dir,
    ...(over.extra ?? []),
  ];
}

// ----- Pure helper tests (sanity for the units main composes) -----

describe('snapshot pure helpers', () => {
  it('sanitizeLabel: preserves alphanumerics and dashes; collapses repeats', () => {
    expect(sanitizeLabel('Feature/My_Branch v2')).toBe('feature-my-branch-v2');
    expect(sanitizeLabel('---')).toBe('snapshot');
    expect(sanitizeLabel('master')).toBe('master');
  });

  it('buildLabel: prefers --label, then branch, then detached', () => {
    const git: GitInfo = { sha: 'x', shaFull: 'x', branch: 'main', dirty: false, ahead: 0 };
    const baseCli: SnapshotCliArgs = {
      goldPath: '', benchmarkPath: '', prodDbPath: '', botQQ: '', groupId: '',
      label: null, outputDir: '', llmMode: 'mock', perSampleTimeoutMs: 0, limit: null, dryRun: false,
    };
    expect(buildLabel({ ...baseCli, label: 'override' }, git)).toBe('override');
    expect(buildLabel(baseCli, git)).toBe('main');
    expect(buildLabel(baseCli, { ...git, branch: null })).toBe('detached');
  });

  it('buildFilename: clean vs dirty', () => {
    const now = new Date('2026-04-28T17:04:00.000Z');
    const clean: GitInfo = { sha: 'abc1234', shaFull: 'x', branch: 'master', dirty: false, ahead: 0 };
    expect(buildFilename('master', clean, now))
      .toBe('master-abc1234-2026-04-28T17-04-00-000Z.json');
    expect(buildFilename('master', { ...clean, dirty: true }, now))
      .toBe('master-dirty-abc1234-2026-04-28T17-04-00-000Z.json');
  });

  it('parseArgs: missing --gold returns descriptive error', () => {
    const r = parseArgs([
      '--benchmark', 'b', '--prod-db', 'p', '--bot-qq', '1', '--group-id', '2',
    ]);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/--gold/);
  });

  it('parseArgs: unknown flag rejected', () => {
    const r = parseArgs(['--bogus', 'x']);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/Unknown flag/);
  });

  it('collectGitMeta: fail-soft on every-call throw', () => {
    const failShell: GitShell = () => { throw new Error('git missing'); };
    const g = collectGitMeta(failShell);
    expect(g.sha).toBe('unknown');
    expect(g.shaFull).toBe('unknown');
    expect(g.branch).toBeNull();
    expect(g.dirty).toBe(false);
    expect(g.ahead).toBe(0);
  });
});

// ----- Required Designer §G tests t1..t8 -----

describe('snapshot main()', () => {
  it('t1: --dry-run prints JSON to stdout and writes no file', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const { result, stdout } = await captureStdio(() => main({
      argv: buildBaseArgv(dir, { extra: ['--dry-run'] }),
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schema).toBe('snapshot.v1');
    expect(parsed.git.sha).toBe('abc1234');
    expect(findSnapshotFiles(dir)).toEqual([]);
  });

  it('t2: clean tree writes file at expected path with correct SHA + dirty=false', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const { result } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const files = findSnapshotFiles(dir);
    expect(files).toEqual(['master-abc1234-2026-04-28T17-04-00-000Z.json']);
    const snap = readSingleSnapshot(dir);
    expect(snap.git.dirty).toBe(false);
    expect(snap.git.sha).toBe('abc1234');
    expect(snap.git.shaFull).toBe('abc1234567890abc1234567890abc1234567890ab');
    expect(snap.git.branch).toBe('master');
  });

  it('t3: dirty tree adds -dirty and warns on stderr', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const dirtyShell: GitShell = shellStub({
      'rev-parse --short HEAD': 'abc1234\n',
      'rev-parse --abbrev-ref HEAD': 'master\n',
      'rev-parse HEAD': 'abc1234567890abc1234567890abc1234567890ab\n',
      'status --porcelain': 'M src/foo.ts\n',
      'rev-list --count': '0\n',
    });
    const { result, stderr } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: dirtyShell,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const files = findSnapshotFiles(dir);
    expect(files.length).toBe(1);
    expect(files[0]!).toContain('-dirty-');
    expect(stderr).toMatch(/dirty/);
    const snap = readSingleSnapshot(dir);
    expect(snap.git.dirty).toBe(true);
  });

  it('t4: detached HEAD => branch null, label "detached"; --label overrides', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const detachedShell: GitShell = shellStub({
      'rev-parse --short HEAD': 'abc1234\n',
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
      'rev-parse HEAD': 'abc1234567890abc1234567890abc1234567890ab\n',
      'status --porcelain': '',
      'rev-list --count': '0\n',
    });
    const { result } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: detachedShell,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const snap = readSingleSnapshot(dir);
    expect(snap.git.branch).toBeNull();
    const files = findSnapshotFiles(dir);
    expect(files[0]!.startsWith('detached-')).toBe(true);

    // Sub-assertion: --label override wins
    const dir2 = makeTmp();
    const replayOut2 = makeFakeReplayOutput(dir2, [MINIMAL_ROW()]);
    const { result: r2 } = await captureStdio(() => main({
      argv: buildBaseArgv(dir2, { extra: ['--label', 'custom'] }),
      gitShell: detachedShell,
      runReplayFn: fakeRunReplay(replayOut2),
      now: FIXED_NOW,
    }));
    expect(r2).toBe(0);
    const files2 = findSnapshotFiles(dir2);
    expect(files2[0]!.startsWith('custom-')).toBe(true);
  });

  it('t5: missing --gold returns 1 with descriptive stderr; nonexistent path also 1', async () => {
    const dir = makeTmp();
    const { result, stderr } = await captureStdio(() => main({
      argv: [
        '--benchmark', writeDummyFile(dir, 'bench.jsonl'),
        '--prod-db', writeDummyFile(dir, 'prod.db'),
        '--bot-qq', '12345',
        '--group-id', '67890',
        '--output-dir', dir,
      ],
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay('unused'),
    }));
    expect(result).toBe(1);
    expect(stderr).toMatch(/--gold/);

    // Sub-assertion: nonexistent --gold path
    const dir2 = makeTmp();
    const ghost = join(dir2, 'does-not-exist.jsonl');
    const { result: r2, stderr: e2 } = await captureStdio(() => main({
      argv: [
        '--gold', ghost,
        '--benchmark', writeDummyFile(dir2, 'bench.jsonl'),
        '--prod-db', writeDummyFile(dir2, 'prod.db'),
        '--bot-qq', '12345',
        '--group-id', '67890',
        '--output-dir', dir2,
      ],
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay('unused'),
    }));
    expect(r2).toBe(1);
    expect(e2).toContain(ghost);
  });

  it('t6: replay returns non-zero => no file, exit propagates, tmp cleaned', async () => {
    const dir = makeTmp();
    const { result } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay('', 2),
    }));
    expect(result).toBe(2);
    expect(findSnapshotFiles(dir)).toEqual([]);
    // .tmp/run-<pid>/ cleaned up
    const entries = readdirSync(dir);
    if (entries.includes('.tmp')) {
      const tmpEntries = readdirSync(join(dir, '.tmp'));
      expect(tmpEntries).not.toContain(`run-${process.pid}`);
    }
  });

  it('t7: written snapshot.aggregate is a valid AggregatorOutput', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const { result } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: CLEAN_GIT_SHELL,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const snap = readSingleSnapshot(dir);
    const agg = snap.aggregate as Record<string, unknown>;
    expect(agg.aggregatorVersion).toBe(AGGREGATOR_VERSION);
    expect(typeof agg.totalRows).toBe('number');
    expect(typeof agg.generatedAt).toBe('number');
    expect(Array.isArray(agg.inputFiles)).toBe(true);
    expect((agg.inputFiles as unknown[]).length).toBeGreaterThan(0);
    expect(agg.comparison).toBeNull();
    expect(typeof agg.byViolationTag).toBe('object');
    expect(agg.byViolationTag).not.toBeNull();
    const metrics = agg.metrics as Record<string, unknown>;
    for (const name of METRIC_NAMES) {
      expect(metrics[name]).toBeDefined();
    }
  });

  it('t8: git unavailable (all calls throw) => fail-soft fields, snapshot still written', async () => {
    const dir = makeTmp();
    const replayOut = makeFakeReplayOutput(dir, [MINIMAL_ROW()]);
    const failShell: GitShell = () => { throw new Error('git not found'); };
    const { result } = await captureStdio(() => main({
      argv: buildBaseArgv(dir),
      gitShell: failShell,
      runReplayFn: fakeRunReplay(replayOut),
      now: FIXED_NOW,
    }));
    expect(result).toBe(0);
    const snap = readSingleSnapshot(dir);
    expect(snap.git.sha).toBe('unknown');
    expect(snap.git.shaFull).toBe('unknown');
    expect(snap.git.branch).toBeNull();
    expect(snap.git.dirty).toBe(false);
    expect(snap.git.ahead).toBe(0);
    expect(snap.label).toBe('detached');
  });
});
