import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGGREGATOR_VERSION,
  FALLBACK_MISUSE_GUARD_TAGS,
  METRIC_NAMES,
  computeAggregate,
  computeByViolationTag,
  computeAllMetrics,
  computeNiMen,
  computeFactHitSuccess,
  computeDeferCorrectness,
  computeFallbackMisuse,
  computeSelfStyleContamination,
  computeReplyCorrectionProxy,
  computeMetricDelta,
  rateOrNull,
  type AggregatorRow,
  type AggregatorOutput,
} from '../../scripts/eval/aggregation/metrics.js';
import { ALL_VIOLATION_TAGS } from '../../scripts/eval/violation-tags.js';

const REPO = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO, 'scripts/eval/aggregate-metrics.ts');

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

const FIXTURE_ROWS_10: AggregatorRow[] = [
  MINIMAL_ROW({
    sampleId: 'fix-01',
    category: 1,
    goldDecision: 'reply',
    resultKind: 'silent',
    violationTags: ['group-address-in-small-scene'],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-02',
    category: 3,
    goldDecision: 'reply',
    resultKind: 'silent',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-03',
    factNeeded: true,
    goldDecision: 'reply',
    resultKind: 'reply',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-04',
    factNeeded: true,
    goldDecision: 'reply',
    resultKind: 'reply',
    violationTags: ['fact-needed-no-fact'],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-05',
    goldDecision: 'reply',
    resultKind: 'fallback',
    violationTags: ['self-amplified-annoyance'],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-06',
    goldDecision: 'silent',
    resultKind: 'reply',
    violationTags: ['gold-silent-but-replied', 'persona-fabricated-in-output'],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-07',
    goldDecision: 'reply',
    resultKind: 'reply',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-08',
    goldDecision: 'defer',
    resultKind: 'defer',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-09',
    goldDecision: 'reply',
    resultKind: 'error',
    violationTags: [],
  }),
  MINIMAL_ROW({
    sampleId: 'fix-10',
    goldDecision: 'defer',
    resultKind: 'reply',
    violationTags: ['gold-defer-but-replied'],
  }),
];

const FIX_JSONL = (rows: AggregatorRow[]): string =>
  rows
    .map((r) =>
      JSON.stringify({
        sampleId: r.sampleId,
        category: r.category,
        goldAct: r.goldAct,
        goldDecision: r.goldDecision,
        factNeeded: r.factNeeded,
        allowBanter: true,
        allowSticker: true,
        resultKind: r.resultKind,
        reasonCode: null,
        utteranceAct: 'unknown',
        guardPath: null,
        targetMsgId: null,
        usedFactHint: null,
        matchedFactIds: null,
        injectedFactIds: null,
        replyText: null,
        promptVariant: null,
        violationTags: r.violationTags,
        errorMessage: null,
        durationMs: 100,
      }),
    )
    .join('\n');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[]): CliResult {
  const r = spawnSync('npx', ['tsx', CLI_PATH, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  };
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'r7-1-agg-'));
}

describe('R7.1 aggregator — pure metric functions', () => {
  it('t1: computeNiMen — fix-01 alone (cat=1, group-address-in-small-scene)', () => {
    const r = computeNiMen([FIXTURE_ROWS_10[0]]);
    expect(r).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
      direction: 'lower-is-better',
    });
  });

  it('t2: computeNiMen — fix-02 alone (cat=3) → denom=0, rate=null', () => {
    const r = computeNiMen([FIXTURE_ROWS_10[1]]);
    expect(r).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      direction: 'lower-is-better',
    });
  });

  it('t3: computeFactHitSuccess — fix-03 + fix-04 → 1/2', () => {
    const r = computeFactHitSuccess([FIXTURE_ROWS_10[2], FIXTURE_ROWS_10[3]]);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(2);
    expect(r.rate).toBe(0.5);
    expect(r.direction).toBe('higher-is-better');
  });

  it('t4: computeDeferCorrectness — fix-08 + fix-10 → 1/2', () => {
    const r = computeDeferCorrectness([FIXTURE_ROWS_10[7], FIXTURE_ROWS_10[9]]);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(2);
    expect(r.rate).toBe(0.5);
    expect(r.direction).toBe('higher-is-better');
  });

  it('t5: computeFallbackMisuse — fix-05 alone → 1/1', () => {
    const r = computeFallbackMisuse([FIXTURE_ROWS_10[4]]);
    expect(r).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
      direction: 'lower-is-better',
    });
  });

  it('t6: computeReplyCorrectionProxy — fix-06 alone (gold-silent + replied)', () => {
    const r = computeReplyCorrectionProxy([FIXTURE_ROWS_10[5]]);
    expect(r).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
      direction: 'lower-is-better',
    });
  });

  it('t7: computeSelfStyleContamination — fix-06 + fix-07 → 1/2', () => {
    const r = computeSelfStyleContamination([FIXTURE_ROWS_10[5], FIXTURE_ROWS_10[6]]);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(2);
    expect(r.rate).toBe(0.5);
    expect(r.direction).toBe('lower-is-better');
  });

  it('t8: computeAggregate(FIXTURE_ROWS_10) — full output shape', () => {
    const out = computeAggregate({
      rows: FIXTURE_ROWS_10,
      inputFiles: ['fixture.jsonl'],
      errorRows: 1,
      generatedAt: 1714300000,
    });
    expect(out.aggregatorVersion).toBe(AGGREGATOR_VERSION);
    expect(out.generatedAt).toBe(1714300000);
    expect(out.inputFiles).toEqual(['fixture.jsonl']);
    expect(out.totalRows).toBe(10);
    expect(out.errorRows).toBe(1);
    expect(out.comparison).toBeNull();

    const metricKeys = Object.keys(out.metrics);
    expect(metricKeys).toEqual([...METRIC_NAMES]);
    for (const name of METRIC_NAMES) {
      expect(out.metrics[name]).toBeDefined();
    }

    for (const tag of ALL_VIOLATION_TAGS) {
      expect(out.byViolationTag[tag]).toBeDefined();
    }
    expect(out.byViolationTag['group-address-in-small-scene'].count).toBe(1);
    expect(out.byViolationTag['gold-silent-but-replied'].count).toBe(1);
    expect(out.byViolationTag['persona-fabricated-in-output'].count).toBe(1);
    expect(out.byViolationTag['gold-defer-but-replied'].count).toBe(1);
    expect(out.byViolationTag['fact-needed-no-fact'].count).toBe(1);
    expect(out.byViolationTag['self-amplified-annoyance'].count).toBe(1);
    expect(out.byViolationTag['target-mismatch'].count).toBe(0);
  });

  it('t9: error-row exclusion — error row counted in errorRows, not in metric denoms', () => {
    const rows: AggregatorRow[] = [
      MINIMAL_ROW({ sampleId: 'r1', goldDecision: 'silent', resultKind: 'reply', violationTags: ['gold-silent-but-replied'] }),
      MINIMAL_ROW({ sampleId: 'r2', goldDecision: 'silent', resultKind: 'silent', violationTags: [] }),
      MINIMAL_ROW({ sampleId: 'r3', goldDecision: 'silent', resultKind: 'silent', violationTags: [] }),
      MINIMAL_ROW({ sampleId: 'r4', goldDecision: 'silent', resultKind: 'silent', violationTags: [] }),
      MINIMAL_ROW({ sampleId: 'r5', goldDecision: 'silent', resultKind: 'silent', violationTags: [] }),
      MINIMAL_ROW({ sampleId: 'r6', goldDecision: 'silent', resultKind: 'error', violationTags: [] }),
    ];
    const proxy = computeReplyCorrectionProxy(rows);
    expect(proxy.denominator).toBe(5);
    expect(proxy.numerator).toBe(1);
    const out = computeAggregate({
      rows,
      inputFiles: ['x'],
      errorRows: 1,
      generatedAt: 1,
    });
    expect(out.totalRows).toBe(6);
    expect(out.errorRows).toBe(1);
    expect(out.metrics['reply-correction-proxy'].denominator).toBe(5);
  });

  it('t10: computeMetricDelta matrix', () => {
    expect(computeMetricDelta(1.0, 0.98, 'lower-is-better')).toEqual({
      baseline: 1.0,
      current: 0.98,
      delta: -0.020000000000000018,
      regression: false,
    });
    const higher = computeMetricDelta(1.0, 0.98, 'higher-is-better');
    expect(higher.regression).toBe(true);
    expect(higher.delta).toBeLessThan(0);
    const nullBase = computeMetricDelta(null, 0.5, 'lower-is-better');
    expect(nullBase).toEqual({ baseline: null, current: 0.5, delta: null, regression: false });
    const reg = computeMetricDelta(1.0, 1.02, 'lower-is-better');
    expect(reg.regression).toBe(true);
    const justUnder = computeMetricDelta(1.0, 1.005, 'lower-is-better');
    expect(justUnder.regression).toBe(false);
  });

  it('t11: rateOrNull edges', () => {
    expect(rateOrNull(0, 0)).toBeNull();
    expect(rateOrNull(0, 5)).toBe(0);
    expect(rateOrNull(5, 5)).toBe(1);
    expect(rateOrNull(1, 4)).toBe(0.25);
  });

  it('t12: rowIds truncation at 1001 hits', () => {
    const rows: AggregatorRow[] = [];
    for (let i = 0; i < 1001; i++) {
      rows.push(
        MINIMAL_ROW({
          sampleId: `bulk-${i}`,
          goldDecision: 'silent',
          resultKind: 'reply',
          violationTags: ['gold-silent-but-replied'],
        }),
      );
    }
    const out = computeByViolationTag(rows);
    const entry = out['gold-silent-but-replied'];
    expect(entry.count).toBe(1001);
    expect(entry.truncated).toBe(true);
    expect(entry.rowIds).toEqual([]);
  });

  it('t13: FALLBACK_MISUSE_GUARD_TAGS lock — exact 10 tags', () => {
    expect([...FALLBACK_MISUSE_GUARD_TAGS]).toEqual([
      'repeated-low-info-direct-overreply',
      'self-amplified-annoyance',
      'group-address-in-small-scene',
      'bot-not-addressee-replied',
      'sticker-token-leak',
      'hard-gate-blocked',
      'persona-fabrication-blocked',
      'self-centered-scope-claim',
      'annoyed-template-consecutive',
      'persona-fabricated-in-output',
    ]);
  });

  it('computeAllMetrics returns 8 metrics in METRIC_NAMES order', () => {
    const m = computeAllMetrics(FIXTURE_ROWS_10);
    expect(Object.keys(m)).toEqual([...METRIC_NAMES]);
  });
});

describe('R7.1 aggregator — CLI', () => {
  it('t14: no args → exit 1, stderr Usage', { timeout: 60000 }, () => {
    const r = runCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Usage');
  });

  it('t15: nonexistent input → exit 1, stderr names path', { timeout: 60000 }, () => {
    const r = runCli(['/no/such/file-r71.jsonl']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('/no/such/file-r71.jsonl');
  });

  it('t16: empty JSONL only → exit 2', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const empty = path.join(dir, 'empty.jsonl');
    writeFileSync(empty, '');
    try {
      const r = runCli([empty]);
      expect(r.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('t17: roundtrip 10-row fixture → valid JSON, exit 0', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const fix = path.join(dir, 'fix.jsonl');
    writeFileSync(fix, FIX_JSONL(FIXTURE_ROWS_10));
    try {
      const r = runCli([fix]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as AggregatorOutput;
      expect(parsed.aggregatorVersion).toBe(AGGREGATOR_VERSION);
      expect(parsed.totalRows).toBe(10);
      expect(parsed.errorRows).toBe(1);
      expect(parsed.metrics['你们-violation-rate'].numerator).toBe(1);
      expect(parsed.metrics['你们-violation-rate'].denominator).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('t18: --output writes file, no stdout', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const fix = path.join(dir, 'fix.jsonl');
    const outPath = path.join(dir, 'sub', 'out.json');
    writeFileSync(fix, FIX_JSONL(FIXTURE_ROWS_10.slice(0, 3)));
    try {
      const r = runCli([fix, '--output', outPath]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(existsSync(outPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as AggregatorOutput;
      expect(parsed.aggregatorVersion).toBe(AGGREGATOR_VERSION);
      expect(parsed.totalRows).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('t20: --diff baseline populates comparison with regression flag', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const fix = path.join(dir, 'fix.jsonl');
    const basePath = path.join(dir, 'baseline.json');
    writeFileSync(
      fix,
      FIX_JSONL([FIXTURE_ROWS_10[7], FIXTURE_ROWS_10[9]]),
    );
    const baseline: AggregatorOutput = {
      generatedAt: 1,
      aggregatorVersion: AGGREGATOR_VERSION,
      inputFiles: ['old'],
      totalRows: 2,
      errorRows: 0,
      byViolationTag: {} as AggregatorOutput['byViolationTag'],
      metrics: {
        '你们-violation-rate': { numerator: 0, denominator: 0, rate: null, direction: 'lower-is-better' },
        'fact-hit-success-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
        'object-react-grounding-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
        'bot-status-act-accuracy': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
        'defer-correctness': { numerator: 2, denominator: 2, rate: 1.0, direction: 'higher-is-better' },
        'fallback-misuse-rate': { numerator: 0, denominator: 0, rate: null, direction: 'lower-is-better' },
        'self-style-contamination-rate': { numerator: 0, denominator: 0, rate: null, direction: 'lower-is-better' },
        'reply-correction-proxy': { numerator: 0, denominator: 0, rate: null, direction: 'lower-is-better' },
      },
      comparison: null,
    };
    writeFileSync(basePath, JSON.stringify(baseline));
    try {
      const r = runCli([fix, '--diff', basePath]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as AggregatorOutput;
      expect(parsed.comparison).not.toBeNull();
      const deltas = parsed.comparison!.metricDeltas;
      expect(deltas['defer-correctness']).toBeDefined();
      expect(deltas['defer-correctness']!.baseline).toBe(1.0);
      expect(deltas['defer-correctness']!.current).toBe(0.5);
      expect(deltas['defer-correctness']!.delta).toBe(-0.5);
      expect(deltas['defer-correctness']!.regression).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('t21: malformed JSON line warns and continues', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const fix = path.join(dir, 'mixed.jsonl');
    const validJsonl = FIX_JSONL([FIXTURE_ROWS_10[0]]);
    writeFileSync(fix, validJsonl + '\nnot-json{\n');
    try {
      const r = runCli([fix]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('[warn] invalid JSON');
      const parsed = JSON.parse(r.stdout) as AggregatorOutput;
      expect(parsed.errorRows).toBe(1);
      expect(parsed.totalRows).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('t22: unknown tag warns; not in byViolationTag', { timeout: 60000 }, () => {
    const dir = makeTmpDir();
    const fix = path.join(dir, 'unknown.jsonl');
    const row = MINIMAL_ROW({ sampleId: 'unk-1', violationTags: ['fake-tag'] });
    writeFileSync(fix, FIX_JSONL([row]));
    try {
      const r = runCli([fix]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('[warn] unknown tag');
      const parsed = JSON.parse(r.stdout) as AggregatorOutput;
      expect(Object.keys(parsed.byViolationTag)).not.toContain('fake-tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
