import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyDelta,
  compareAggregations,
  formatMarkdown,
  formatRate,
  formatDelta,
  formatCell,
  buildTagSummary,
  DEFAULT_THRESHOLD,
  type MetricDelta,
} from '../../scripts/eval/aggregation/comparison.js';
import {
  AGGREGATOR_VERSION,
  METRIC_NAMES,
  type AggregatorOutput,
} from '../../scripts/eval/aggregation/metrics.js';

const REPO = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO, 'scripts/eval/compare-metrics.ts');

// ---- Inline AggregatorOutput fixtures (Designer §D, no on-disk fixture files) ----

function emptyTagMap(): AggregatorOutput['byViolationTag'] {
  return {} as AggregatorOutput['byViolationTag'];
}

const FIXTURE_BASELINE: AggregatorOutput = {
  generatedAt: 1714300000,
  aggregatorVersion: AGGREGATOR_VERSION,
  inputFiles: ['baseline.jsonl'],
  totalRows: 100,
  errorRows: 2,
  byViolationTag: emptyTagMap(),
  metrics: {
    '你们-violation-rate': { numerator: 12, denominator: 100, rate: 0.12, direction: 'lower-is-better' },
    'fact-hit-success-rate': { numerator: 80, denominator: 100, rate: 0.80, direction: 'higher-is-better' },
    'object-react-grounding-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
    'bot-status-act-accuracy': { numerator: 45, denominator: 50, rate: 0.90, direction: 'higher-is-better' },
    'defer-correctness': { numerator: 20, denominator: 20, rate: 1.0, direction: 'higher-is-better' },
    'fallback-misuse-rate': { numerator: 5, denominator: 100, rate: 0.05, direction: 'lower-is-better' },
    'self-style-contamination-rate': { numerator: 3, denominator: 100, rate: 0.03, direction: 'lower-is-better' },
    'reply-correction-proxy': { numerator: 10, denominator: 100, rate: 0.10, direction: 'lower-is-better' },
  },
  comparison: null,
};

const FIXTURE_IMPROVEMENT: AggregatorOutput = {
  generatedAt: 1714300100,
  aggregatorVersion: AGGREGATOR_VERSION,
  inputFiles: ['variant-a.jsonl'],
  totalRows: 98,
  errorRows: 1,
  byViolationTag: emptyTagMap(),
  metrics: {
    '你们-violation-rate': { numerator: 10, denominator: 100, rate: 0.10, direction: 'lower-is-better' },
    'fact-hit-success-rate': { numerator: 85, denominator: 100, rate: 0.85, direction: 'higher-is-better' },
    'object-react-grounding-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
    'bot-status-act-accuracy': { numerator: 48, denominator: 50, rate: 0.95, direction: 'higher-is-better' },
    'defer-correctness': { numerator: 20, denominator: 20, rate: 1.0, direction: 'higher-is-better' },
    'fallback-misuse-rate': { numerator: 4, denominator: 100, rate: 0.04, direction: 'lower-is-better' },
    'self-style-contamination-rate': { numerator: 2, denominator: 100, rate: 0.02, direction: 'lower-is-better' },
    'reply-correction-proxy': { numerator: 9, denominator: 100, rate: 0.09, direction: 'lower-is-better' },
  },
  comparison: null,
};

const FIXTURE_REGRESSION: AggregatorOutput = {
  generatedAt: 1714300200,
  aggregatorVersion: AGGREGATOR_VERSION,
  inputFiles: ['variant-b.jsonl'],
  totalRows: 102,
  errorRows: 3,
  byViolationTag: emptyTagMap(),
  metrics: {
    '你们-violation-rate': { numerator: 15, denominator: 100, rate: 0.15, direction: 'lower-is-better' },
    'fact-hit-success-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
    'object-react-grounding-rate': { numerator: 0, denominator: 0, rate: null, direction: 'higher-is-better' },
    'bot-status-act-accuracy': { numerator: 43, denominator: 50, rate: 0.86, direction: 'higher-is-better' },
    'defer-correctness': { numerator: 18, denominator: 20, rate: 0.90, direction: 'higher-is-better' },
    'fallback-misuse-rate': { numerator: 8, denominator: 100, rate: 0.08, direction: 'lower-is-better' },
    'self-style-contamination-rate': { numerator: 3, denominator: 100, rate: 0.03, direction: 'lower-is-better' },
    'reply-correction-proxy': { numerator: 11, denominator: 100, rate: 0.11, direction: 'lower-is-better' },
  },
  comparison: null,
};

// ---- Pure-function tests ----

describe('classifyDelta', () => {
  it('tc4: threshold=0, lower-is-better, delta>0 (tiny) is regression', () => {
    const r = classifyDelta(0.05, 0.051, 'lower-is-better', 0);
    expect(r.kind).toBe('regression');
    expect(r.delta).toBeGreaterThan(0);
  });

  it('tc5: threshold=0, equal rates, delta=0 is neutral', () => {
    const r = classifyDelta(0.05, 0.05, 'lower-is-better', 0);
    expect(r.kind).toBe('neutral');
    expect(r.delta).toBe(0);
  });

  it('tc7: null baseline + concrete variant => kind="new", delta=null', () => {
    const r = classifyDelta(null, 0.5, 'higher-is-better', 0.01);
    expect(r.kind).toBe('new');
    expect(r.delta).toBeNull();
  });

  it('tc15: lower-is-better metric with negative delta beyond threshold => improvement', () => {
    const r = classifyDelta(0.12, 0.08, 'lower-is-better', 0.01);
    expect(r.kind).toBe('improvement');
    expect(r.delta).toBeCloseTo(-0.04, 10);
    const cellDelta: MetricDelta = {
      metric: '你们-violation-rate',
      direction: 'lower-is-better',
      baselineRate: 0.12,
      variantRate: 0.08,
      delta: -0.04,
      kind: 'improvement',
    };
    expect(formatCell(cellDelta).startsWith('▼ ')).toBe(true);
  });

  it('threshold=0.01 with delta exactly 0.01 (lower-is-better) is neutral, NOT regression', () => {
    const r = classifyDelta(0.10, 0.11, 'lower-is-better', 0.01);
    expect(r.kind).toBe('neutral');
  });
});

describe('compareAggregations', () => {
  it('tc1: 2 inputs, no regression in improvement variant', () => {
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'variant-a.json', output: FIXTURE_IMPROVEMENT }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    expect(result.anyRegression).toBe(false);
    expect(result.variants[0].hasRegression).toBe(false);
  });

  it('tc2: regression fixture flags 4 regressed metrics', () => {
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'variant-b.json', output: FIXTURE_REGRESSION }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    expect(result.anyRegression).toBe(true);
    const regressed = result.variants[0].regressedMetrics;
    expect(regressed).toContain('你们-violation-rate');
    expect(regressed).toContain('bot-status-act-accuracy');
    expect(regressed).toContain('defer-correctness');
    expect(regressed).toContain('fallback-misuse-rate');
  });

  it('tc6: 2 variants — improvement clean, regression flagged', () => {
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [
        { file: 'a.json', output: FIXTURE_IMPROVEMENT },
        { file: 'b.json', output: FIXTURE_REGRESSION },
      ],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    expect(result.variants.length).toBe(2);
    expect(result.variants[0].hasRegression).toBe(false);
    expect(result.variants[1].hasRegression).toBe(true);
  });

  it('tc8: data-loss metric emits warning + cell, not flagged as regression', () => {
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'variant-b.json', output: FIXTURE_REGRESSION }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    const factHit = result.variants[0].metricDeltas.find(
      (d) => d.metric === 'fact-hit-success-rate',
    );
    expect(factHit?.kind).toBe('data-loss');
    expect(result.warnings).toContain('data-loss: fact-hit-success-rate in variant-b.json');
    expect(result.variants[0].regressedMetrics).not.toContain('fact-hit-success-rate');
  });

  it('tc9: aggregatorVersion mismatch emits warning, comparison continues', () => {
    const oldVariant: AggregatorOutput = {
      ...FIXTURE_IMPROVEMENT,
      aggregatorVersion: 'r7.0.0',
    };
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'variant-a.json', output: oldVariant }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    expect(
      result.warnings.some((w) =>
        w.includes('aggregatorVersion mismatch') &&
        w.includes('baseline=r7.1.0') &&
        w.includes('variant=r7.0.0') &&
        w.includes('variant-a.json'),
      ),
    ).toBe(true);
  });

  it('tc14: empty byViolationTag in both => tag summary empty array, no throw', () => {
    expect(() =>
      buildTagSummary(FIXTURE_BASELINE, [{ file: 'v.json', output: FIXTURE_IMPROVEMENT }], 5, false),
    ).not.toThrow();
    const summary = buildTagSummary(
      FIXTURE_BASELINE,
      [{ file: 'v.json', output: FIXTURE_IMPROVEMENT }],
      5,
      false,
    );
    expect(summary.length).toBe(0);
  });

  it('format helpers: formatRate / formatDelta render minus sign U+2212 and em dash U+2014', () => {
    expect(formatRate(null)).toBe('—'); // U+2014
    expect(formatRate(0.5)).toBe('0.500');
    expect(formatDelta(0)).toBe('(+0.000)');
    expect(formatDelta(0.02)).toBe('(+0.020)');
    // Verify minus sign is U+2212, not hyphen-minus U+002D
    const negDelta = formatDelta(-0.02);
    expect(negDelta).toBe('(−' + '0.020)');
    expect(negDelta.charCodeAt(1)).toBe(0x2212);
  });

  it('full result for METRIC_NAMES order matches metricDeltas length', () => {
    const result = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'v.json', output: FIXTURE_REGRESSION }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    expect(result.variants[0].metricDeltas.length).toBe(METRIC_NAMES.length);
    for (let i = 0; i < METRIC_NAMES.length; i++) {
      expect(result.variants[0].metricDeltas[i].metric).toBe(METRIC_NAMES[i]);
    }
  });
});

// ---- CLI spawn tests ----

describe('compare-metrics CLI', () => {
  let tmp: string;
  let baselinePath: string;
  let regressionPath: string;
  let badJsonPath: string;
  let nanRatePath: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'r72-cli-'));
    baselinePath = path.join(tmp, 'baseline.json');
    regressionPath = path.join(tmp, 'regression.json');
    badJsonPath = path.join(tmp, 'bad.json');
    nanRatePath = path.join(tmp, 'nan-rate.json');
    writeFileSync(baselinePath, JSON.stringify(FIXTURE_BASELINE, null, 2) + '\n');
    writeFileSync(regressionPath, JSON.stringify(FIXTURE_REGRESSION, null, 2) + '\n');
    writeFileSync(badJsonPath, '{invalid');
    // tc13: rate as string "NaN" (JSON spec disallows raw NaN literals)
    const nanContent = JSON.stringify(FIXTURE_BASELINE, null, 2).replace(
      '"rate": 0.12',
      '"rate": "NaN"',
    );
    writeFileSync(nanRatePath, nanContent);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('npx', ['tsx', CLI_PATH, ...args], {
      cwd: tmp,
      encoding: 'utf8',
      shell: true,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('tc3: --no-fail-on-regression with regression fixture exits 0 + suppression note', () => {
    const r = runCli(['baseline.json', 'regression.json', '--no-fail-on-regression']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠ Regressions detected (--no-fail-on-regression active). Exit 0.');
  });

  it('tc10: malformed JSON => exit 3; stderr names file', () => {
    const r = runCli(['baseline.json', 'bad.json']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('bad.json');
    expect(r.stderr.toLowerCase()).toContain('json');
  });

  it('tc11: single positional arg => exit 2 + USAGE on stderr', () => {
    const r = runCli(['baseline.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/at least \d+ (input files|variant) required/);
    expect(r.stderr).toContain('Usage: compare-metrics.ts');
  });

  it('tc13: NaN string rate => exit 3 with metric+file in error', () => {
    const r = runCli(['baseline.json', path.basename(nanRatePath)]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('invalid rate value');
    expect(r.stderr).toContain('你们-violation-rate');
    expect(r.stderr).toContain('nan-rate.json');
  });

  it('tc12: golden markdown snapshot for baseline + regression at default threshold', () => {
    const r = runCli(['baseline.json', 'regression.json']);
    expect(r.status).toBe(1);
    const expected = [
      '# Metric Comparison',
      '',
      '**Baseline:** baseline.json (100 rows)',
      '**Variants:** regression.json (102 rows)',
      '**Threshold:** 0.01',
      '',
      '## Metrics',
      '',
      '| Metric | Direction | Baseline | regression.json |',
      '|--------|--------|--------|--------|',
      '| 你们-violation-rate | ↓ lower | 0.120 | 0.150 (+0.030) ⚠ REGRESSION |',
      '| fact-hit-success-rate | ↑ higher | 0.800 | ⚠ — |',
      '| object-react-grounding-rate | ↑ higher | — | — |',
      '| bot-status-act-accuracy | ↑ higher | 0.900 | 0.860 (−0.040) ⚠ REGRESSION |',
      '| defer-correctness | ↑ higher | 1.000 | 0.900 (−0.100) ⚠ REGRESSION |',
      '| fallback-misuse-rate | ↓ lower | 0.050 | 0.080 (+0.030) ⚠ REGRESSION |',
      '| self-style-contamination-rate | ↓ lower | 0.030 | 0.030 (+0.000) |',
      '| reply-correction-proxy | ↓ lower | 0.100 | 0.110 (+0.010) |',
      '',
      '## Violation Tag Summary (top 5 by absolute delta vs baseline, regression.json)',
      '',
      '_(no violation tags reported)_',
      '',
      '## Regressions',
      '',
      '- **regression.json** regressed on: `你们-violation-rate` (+0.030 > 0.010 threshold), `bot-status-act-accuracy` (−0.040 > 0.010 threshold), `defer-correctness` (−0.100 > 0.010 threshold), `fallback-misuse-rate` (+0.030 > 0.010 threshold)',
      '',
      '## Summary',
      '',
      '❌ 1 variant(s) with regressions. Exit 1.',
      '',
    ].join('\n');
    expect(r.stdout).toBe(expected);
  });
});

// formatMarkdown anchor: ensure the renderer is exercised at module level too
describe('formatMarkdown', () => {
  it('renders summary with no-fail-on-regression note when active', () => {
    const cmp = compareAggregations({
      baseline: FIXTURE_BASELINE,
      baselineFile: 'baseline.json',
      variants: [{ file: 'b.json', output: FIXTURE_REGRESSION }],
      threshold: DEFAULT_THRESHOLD,
      fullTags: false,
    });
    const md = formatMarkdown({ comparison: cmp, showBaselineColumn: true, noFailOnRegression: true });
    expect(md).toContain('⚠ Regressions detected (--no-fail-on-regression active). Exit 0.');
  });
});
