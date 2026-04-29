/**
 * R7.4 — Snapshot recorder.
 *
 * Runs replay (via direct runReplay() import) on gold+benchmark, aggregates
 * the resulting JSONL, and writes a single snapshot JSON file under
 * data/eval/snapshots/. Producer-only: does not read or validate snapshots.
 *
 * Filename: <label>(-dirty)?-<sha7>-<iso>.json where iso uses ':'/'.' replaced
 * by '-'. label defaults to current branch (sanitized) or 'detached'.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AggregatorOutput,
  type AggregatorRow,
  computeAggregate,
  isErrorRow,
} from './aggregation/metrics.js';
import { runReplay, type RunResult } from './replay-runner.js';
import type { ReplayerArgs } from './replay-types.js';

// ----- Types -----

export interface GitInfo {
  sha: string;
  shaFull: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
}

export interface SnapshotFile {
  schema: 'snapshot.v1';
  label: string;
  createdAt: number;
  git: GitInfo;
  aggregate: AggregatorOutput;
}

export interface SnapshotCliArgs {
  goldPath: string;
  benchmarkPath: string;
  prodDbPath: string;
  botQQ: string;
  groupId: string;
  label: string | null;
  outputDir: string;
  llmMode: 'mock' | 'real' | 'recorded';
  perSampleTimeoutMs: number;
  limit: number | null;
  dryRun: boolean;
}

export type GitShell = (cmd: string) => string;

export interface MainOpts {
  argv: readonly string[];
  gitShell?: GitShell;
  runReplayFn?: typeof runReplay;
  cwd?: string;
  now?: () => Date;
}

// ----- Argument parsing -----

const VALID_LLM_MODES: ReadonlySet<string> = new Set(['mock', 'real', 'recorded']);

const USAGE = [
  'Usage: tsx scripts/eval/snapshot.ts \\',
  '         --gold <path>           gold JSONL (read-only)',
  '         --benchmark <path>      benchmark-weak-labeled JSONL (read-only)',
  '         --prod-db <path>        path to source sqlite',
  '         --bot-qq <qq>           bot user id',
  '         --group-id <gid>        groupId for replay',
  '         [--label <s>]           override label (default: current branch)',
  '         [--output-dir <path>]   default: data/eval/snapshots',
  '         [--llm-mode <mode>]     mock | real | recorded (default: mock)',
  '         [--timeout-ms <n>]      per-sample timeout (default: 10000)',
  '         [--limit <n>]           cap samples',
  '         [--dry-run]             print snapshot JSON to stdout, write nothing',
  '',
].join('\n');

export function parseArgs(argv: readonly string[]): SnapshotCliArgs | { error: string } {
  let goldPath: string | null = null;
  let benchmarkPath: string | null = null;
  let prodDbPath: string | null = null;
  let botQQ: string | null = null;
  let groupId: string | null = null;
  let label: string | null = null;
  let outputDir = 'data/eval/snapshots';
  let llmMode: SnapshotCliArgs['llmMode'] = 'mock';
  let perSampleTimeoutMs = 10000;
  let limit: number | null = null;
  let dryRun = false;

  const need = (i: number, name: string): string | { error: string } => {
    if (i + 1 >= argv.length) return { error: `Missing value for ${name}` };
    return argv[i + 1] ?? '';
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      return { error: '__help__' };
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--gold') {
      const v = need(i, '--gold'); if (typeof v !== 'string') return v;
      goldPath = v; i++; continue;
    }
    if (a === '--benchmark') {
      const v = need(i, '--benchmark'); if (typeof v !== 'string') return v;
      benchmarkPath = v; i++; continue;
    }
    if (a === '--prod-db') {
      const v = need(i, '--prod-db'); if (typeof v !== 'string') return v;
      prodDbPath = v; i++; continue;
    }
    if (a === '--bot-qq') {
      const v = need(i, '--bot-qq'); if (typeof v !== 'string') return v;
      botQQ = v; i++; continue;
    }
    if (a === '--group-id') {
      const v = need(i, '--group-id'); if (typeof v !== 'string') return v;
      groupId = v; i++; continue;
    }
    if (a === '--label') {
      const v = need(i, '--label'); if (typeof v !== 'string') return v;
      label = v; i++; continue;
    }
    if (a === '--output-dir') {
      const v = need(i, '--output-dir'); if (typeof v !== 'string') return v;
      outputDir = v; i++; continue;
    }
    if (a === '--llm-mode') {
      const v = need(i, '--llm-mode'); if (typeof v !== 'string') return v;
      if (!VALID_LLM_MODES.has(v)) return { error: `Invalid --llm-mode: ${v}` };
      llmMode = v as SnapshotCliArgs['llmMode']; i++; continue;
    }
    if (a === '--timeout-ms') {
      const v = need(i, '--timeout-ms'); if (typeof v !== 'string') return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `Invalid --timeout-ms: ${v}` };
      perSampleTimeoutMs = n; i++; continue;
    }
    if (a === '--limit') {
      const v = need(i, '--limit'); if (typeof v !== 'string') return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `Invalid --limit: ${v}` };
      limit = n; i++; continue;
    }
    return { error: `Unknown flag: ${a}` };
  }

  if (goldPath === null) return { error: 'Missing --gold: required path' };
  if (benchmarkPath === null) return { error: 'Missing --benchmark: required path' };
  if (prodDbPath === null) return { error: 'Missing --prod-db: required path' };
  if (botQQ === null) return { error: 'Missing --bot-qq: required value' };
  if (groupId === null) return { error: 'Missing --group-id: required value' };

  return {
    goldPath,
    benchmarkPath,
    prodDbPath,
    botQQ,
    groupId,
    label,
    outputDir,
    llmMode,
    perSampleTimeoutMs,
    limit,
    dryRun,
  };
}

// ----- Git -----

function defaultGitShell(cwd: string): GitShell {
  return (cmd: string): string =>
    execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      timeout: 5000,
    }).toString();
}

export function collectGitMeta(shell: GitShell): GitInfo {
  let shaFull = 'unknown';
  let sha = 'unknown';
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;

  try { shaFull = shell('git rev-parse HEAD').trim() || 'unknown'; } catch { /* fail-soft */ }
  try { sha = shell('git rev-parse --short HEAD').trim() || 'unknown'; } catch { /* fail-soft */ }
  try {
    const b = shell('git rev-parse --abbrev-ref HEAD').trim();
    branch = b === '' || b === 'HEAD' ? null : b;
  } catch { /* fail-soft */ }
  try {
    const status = shell('git status --porcelain');
    dirty = status.length > 0;
  } catch { /* fail-soft */ }
  try {
    const out = shell('git rev-list --count @{u}..HEAD').trim();
    const n = parseInt(out, 10);
    ahead = Number.isFinite(n) && !Number.isNaN(n) ? n : 0;
  } catch { ahead = 0; }

  return { sha, shaFull, branch, dirty, ahead };
}

// ----- Label / filename -----

export function sanitizeLabel(raw: string): string {
  const out = raw.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return out === '' ? 'snapshot' : out;
}

export function buildLabel(cli: SnapshotCliArgs, git: GitInfo): string {
  if (cli.label !== null) return sanitizeLabel(cli.label);
  if (git.branch !== null) return sanitizeLabel(git.branch);
  return 'detached';
}

export function buildFilename(label: string, git: GitInfo, now: Date): string {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const dirtyTag = git.dirty ? '-dirty' : '';
  return `${label}${dirtyTag}-${git.sha}-${iso}.json`;
}

// ----- JSONL parsing -----

const RESULT_KINDS: ReadonlySet<string> = new Set([
  'reply', 'sticker', 'fallback', 'silent', 'defer', 'error',
]);

function isAggregatorRow(x: unknown): x is AggregatorRow {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.sampleId !== 'string') return false;
  if (typeof o.category !== 'number') return false;
  if (typeof o.goldAct !== 'string') return false;
  if (typeof o.goldDecision !== 'string') return false;
  if (typeof o.factNeeded !== 'boolean') return false;
  if (typeof o.resultKind !== 'string' || !RESULT_KINDS.has(o.resultKind)) return false;
  if (!Array.isArray(o.violationTags)) return false;
  for (const t of o.violationTags) {
    if (typeof t !== 'string') return false;
  }
  return true;
}

function parseJSONLToRows(jsonlPath: string): { rows: AggregatorRow[]; errorRows: number } {
  const text = readFileSync(jsonlPath, 'utf8');
  const lines = text.split('\n');
  const rows: AggregatorRow[] = [];
  let malformedSkipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAggregatorRow(parsed)) {
        rows.push(parsed);
      } else {
        malformedSkipped++;
      }
    } catch {
      malformedSkipped++;
    }
  }
  let resultKindErrorCount = 0;
  for (const r of rows) if (isErrorRow(r)) resultKindErrorCount++;
  return { rows, errorRows: malformedSkipped + resultKindErrorCount };
}

// ----- Replay args -----

function buildReplayerArgs(cli: SnapshotCliArgs, tmpDir: string): ReplayerArgs {
  return {
    goldPath: cli.goldPath,
    benchmarkPath: cli.benchmarkPath,
    outputDir: tmpDir,
    llmMode: cli.llmMode,
    limit: cli.limit,
    prodDbPath: cli.prodDbPath,
    botQQ: cli.botQQ,
    groupIdForReplay: cli.groupId,
    perSampleTimeoutMs: cli.perSampleTimeoutMs,
  };
}

// ----- Main -----

export async function main(opts: MainOpts): Promise<number> {
  const parsed = parseArgs(opts.argv);
  if ('error' in parsed) {
    if (parsed.error === '__help__') return 0;
    process.stderr.write(parsed.error + '\n');
    return 1;
  }
  const cli = parsed;

  for (const [flag, p] of [
    ['--gold', cli.goldPath],
    ['--benchmark', cli.benchmarkPath],
    ['--prod-db', cli.prodDbPath],
  ] as const) {
    if (!existsSync(p)) {
      process.stderr.write(`${flag} path does not exist: ${p}\n`);
      return 1;
    }
  }

  const cwd = opts.cwd ?? process.cwd();
  const snapshotDir = resolve(cwd, cli.outputDir);
  if (existsSync(snapshotDir) && statSync(snapshotDir).isFile()) {
    process.stderr.write(`--output-dir is a file, not a directory: ${snapshotDir}\n`);
    return 1;
  }
  mkdirSync(snapshotDir, { recursive: true });

  const tmpRunDir = join(snapshotDir, '.tmp', `run-${process.pid}`);
  mkdirSync(tmpRunDir, { recursive: true });

  const gitShell = opts.gitShell ?? defaultGitShell(cwd);
  const git = collectGitMeta(gitShell);
  if (git.dirty) {
    process.stderr.write('warning: working tree is dirty; snapshot label will include -dirty\n');
  }

  const label = buildLabel(cli, git);
  const runReplayFn = opts.runReplayFn ?? runReplay;

  try {
    const replayerArgs = buildReplayerArgs(cli, tmpRunDir);
    let runResult: RunResult;
    try {
      runResult = await runReplayFn(replayerArgs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`replay-runner threw: ${msg}\n`);
      return 1;
    }
    if (runResult.exitCode !== 0) {
      process.stderr.write(`replay-runner failed with exit ${runResult.exitCode}\n`);
      return runResult.exitCode;
    }
    const { rows, errorRows } = parseJSONLToRows(runResult.outputPath);
    if (rows.length === 0) {
      process.stderr.write('warning: 0 valid rows from replay; aggregate metrics will all be null\n');
    }
    const aggregate = computeAggregate({
      rows,
      inputFiles: [runResult.outputPath],
      errorRows,
    });
    const now = (opts.now ?? ((): Date => new Date()))();
    const snapshot: SnapshotFile = {
      schema: 'snapshot.v1',
      label,
      createdAt: Math.floor(now.getTime() / 1000),
      git,
      aggregate,
    };
    if (cli.dryRun) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
      return 0;
    }
    const filename = buildFilename(label, git, now);
    const outPath = join(snapshotDir, filename);
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    process.stdout.write(outPath + '\n');
    return 0;
  } finally {
    try { rmSync(tmpRunDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ----- CLI shim -----

const isMain = ((): boolean => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.replace(/\\/g, '/').endsWith('scripts/eval/snapshot.ts');
  } catch { return false; }
})();

if (isMain) {
  main({ argv: process.argv.slice(2) }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
