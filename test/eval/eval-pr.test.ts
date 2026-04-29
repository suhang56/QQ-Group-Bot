import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AggregatorRow } from '../../scripts/eval/aggregation/metrics.js';

const REPO = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO, 'scripts/eval/eval-pr.ts');

const tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'eval-pr-test-'));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', CLI_PATH, ...args], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function MINIMAL_ROW(over: Partial<AggregatorRow> = {}): AggregatorRow {
  return {
    sampleId: 'minimal',
    category: 2,
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    factNeeded: false,
    resultKind: 'silent',
    violationTags: [],
    ...over,
  };
}

function rowsToJSONL(rows: readonly AggregatorRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function writeJSONL(dir: string, name: string, rows: readonly AggregatorRow[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, rowsToJSONL(rows));
  return p;
}

// ---- Locked synthetic row sets per Architect §3.3 ----

const baselineRows: AggregatorRow[] = [
  MINIMAL_ROW({
    sampleId: 'b-01',
    category: 1,
    goldDecision: 'reply',
    resultKind: 'reply',
    violationTags: ['group-address-in-small-scene'],
  }),
  MINIMAL_ROW({
    sampleId: 'b-02',
    category: 1,
    goldDecision: 'reply',
    resultKind: 'reply',
    violationTags: ['group-address-in-small-scene'],
  }),
  MINIMAL_ROW({
    sampleId: 'b-03',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'b-04',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'b-05',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'b-06',
    goldDecision: 'defer',
    resultKind: 'silent',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'b-07',
    goldDecision: 'silent',
    resultKind: 'reply',
    violationTags: ['gold-silent-but-replied'],
  }),
  MINIMAL_ROW({
    sampleId: 'b-08',
    goldDecision: 'reply',
    resultKind: 'fallback',
    violationTags: ['repeated-low-info-direct-overreply'],
  }),
];

const improvementRows: AggregatorRow[] = baselineRows.map((r) =>
  r.violationTags.includes('group-address-in-small-scene')
    ? { ...r, violationTags: [] }
    : r,
);

const regressionRows: AggregatorRow[] = [
  ...baselineRows,
  MINIMAL_ROW({
    sampleId: 'r-09',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: ['fact-needed-no-fact'],
  }),
  MINIMAL_ROW({
    sampleId: 'r-10',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: ['fact-needed-no-fact'],
  }),
];

// regression-strict: 1 extra fact-needed row WITH fact-needed-no-fact tag.
// baseline fact-hit-success-rate = 3/3 = 1.0 (3 fact-needed rows, none tagged).
// variant fact-hit-success-rate = 3/4 = 0.75 → delta = -0.25 (regression on higher-is-better).
const regressionStrictRows: AggregatorRow[] = [
  ...baselineRows,
  MINIMAL_ROW({
    sampleId: 's-09',
    category: 2,
    goldDecision: 'reply',
    resultKind: 'reply',
    factNeeded: true,
    violationTags: ['fact-needed-no-fact'],
  }),
];

describe('eval-pr CLI', () => {
  it('t1: 2 valid JSONL, no regression → exit 0 + markdown table', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const v = writeJSONL(dir, 'improvement.jsonl', improvementRows);
    const r = runCli([b, v]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| Metric ');
    expect(r.stdout).toContain('# Metric Comparison');
  });

  it('t2: regression variant → exit 1 + REGRESSION in markdown', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const v = writeJSONL(dir, 'regression.jsonl', regressionRows);
    const r = runCli([b, v]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('REGRESSION');
  });

  it('t3: regression + --no-fail-on-regression → exit 0', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const v = writeJSONL(dir, 'regression.jsonl', regressionRows);
    const r = runCli([b, v, '--no-fail-on-regression']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REGRESSION');
    expect(r.stdout).toContain('--no-fail-on-regression active');
  });

  it('t4: 3 inputs (baseline + improvement + regression) → exit 1; both variants in columns', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const i = writeJSONL(dir, 'improvement.jsonl', improvementRows);
    const reg = writeJSONL(dir, 'regression.jsonl', regressionRows);
    const r = runCli([b, i, reg]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(i);
    expect(r.stdout).toContain(reg);
  });

  it('t5: --threshold 0 with extra group-address row → exit 1', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const v = writeJSONL(dir, 'regression-strict.jsonl', regressionStrictRows);
    const r = runCli([b, v, '--threshold', '0']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('REGRESSION');
  });

  it('t6: malformed JSONL line → [warn] on stderr; valid rows still aggregate', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const malformedPath = path.join(dir, 'malformed.jsonl');
    const validRows = baselineRows.slice(0, 4);
    const validJSONL = rowsToJSONL(validRows);
    // Insert a malformed line at the top
    writeFileSync(malformedPath, 'not-valid-json{\n' + validJSONL);
    const r = runCli([b, malformedPath, '--no-fail-on-regression']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[warn]');
    expect(r.stderr).toContain('invalid JSON');
    expect(r.stdout).toContain('# Metric Comparison');
  });

  it('t7: all-malformed variant → exit 2 + "no valid rows in variant"', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const bad = path.join(dir, 'all-bad.jsonl');
    writeFileSync(bad, 'not json\nstill not json\nbroken{\n');
    const r = runCli([b, bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no valid rows in variant');
  });

  it('t8: --output to nonexistent subdir → dir created, file written', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const i = writeJSONL(dir, 'improvement.jsonl', improvementRows);
    const outPath = path.join(dir, 'sub', 'nested', 'out.md');
    const r = runCli([b, i, '--output', outPath]);
    expect(r.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, 'utf8');
    expect(written).toContain('# Metric Comparison');
    expect(written).toContain('| Metric ');
  });

  it('t9: --baseline swaps baseline/variant assignment', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const i = writeJSONL(dir, 'improvement.jsonl', improvementRows);
    // With --baseline <i>: improvement is baseline, baseline.jsonl is variant.
    // baseline.jsonl as variant vs improvement: 你们-rate 0.0 → 1.0 → regression on lower-is-better.
    // Use --no-fail-on-regression to keep exit 0 while still verifying swap.
    const r = runCli([b, i, '--baseline', i, '--no-fail-on-regression']);
    expect(r.status).toBe(0);
    // Baseline header should reference improvement file
    const m = r.stdout.match(/\*\*Baseline:\*\* (\S+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(i);
    // Variant column should reference baseline.jsonl
    expect(r.stdout).toContain(`**Variants:** ${b}`);
  });

  it('t10: nonexistent input file → exit 2', () => {
    const dir = makeTmp();
    const b = writeJSONL(dir, 'baseline.jsonl', baselineRows);
    const ghost = path.join(dir, 'does-not-exist.jsonl');
    const r = runCli([b, ghost]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('file not found');
  });

  it('--help prints usage and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: eval-pr.ts');
    expect(r.stdout).toContain('Exit codes:');
  });

  it('no args → exit 2 with usage', () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: eval-pr.ts');
  });
});
