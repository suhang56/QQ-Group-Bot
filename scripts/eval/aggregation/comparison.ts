/**
 * R7.2 Comparison module — pure functions, no I/O.
 *
 * Compares an AggregatorOutput baseline against one or more variants, classifies
 * each metric delta against a threshold and the per-metric direction, builds a
 * tag summary table, and renders a markdown report. The CLI wrapper
 * (../compare-metrics.ts) is responsible for file I/O and exit codes; this
 * module emits warnings as data on the result object instead of writing to
 * stderr/stdout.
 */

import {
  type AggregatorOutput,
  type MetricName,
  type MetricDirection,
  METRIC_NAMES,
  METRIC_DIRECTIONS,
} from './metrics.js';

export const DEFAULT_THRESHOLD = 0.01;
export const TAG_SUMMARY_TOP_N = 5;
export const RATE_PRECISION = 3;
const MINUS_SIGN = '−'; // U+2212 — Designer §B locked
const EM_DASH = '—'; // U+2014 — Designer §B locked

export type DeltaKind =
  | 'regression'
  | 'improvement'
  | 'neutral'
  | 'data-loss'
  | 'new'
  | 'both-null';

export interface MetricDelta {
  metric: MetricName;
  direction: MetricDirection;
  baselineRate: number | null;
  variantRate: number | null;
  delta: number | null;
  kind: DeltaKind;
}

export interface VariantComparison {
  file: string;
  totalRows: number;
  aggregatorVersion: string;
  metricDeltas: MetricDelta[];
  hasRegression: boolean;
  regressedMetrics: MetricName[];
}

export interface TagDeltaRow {
  tag: string;
  baselineRate: number | null;
  variantDeltas: Array<{ file: string; delta: number | null }>;
  maxAbsDelta: number;
}

export interface ComparisonResult {
  baselineFile: string;
  baselineTotalRows: number;
  baselineAggregatorVersion: string;
  threshold: number;
  variants: VariantComparison[];
  tagSummary: TagDeltaRow[];
  fullTags: boolean;
  warnings: string[];
  anyRegression: boolean;
}

export function classifyDelta(
  baselineRate: number | null,
  variantRate: number | null,
  direction: MetricDirection,
  threshold: number,
): { delta: number | null; kind: DeltaKind } {
  if (baselineRate === null && variantRate === null) {
    return { delta: null, kind: 'both-null' };
  }
  if (baselineRate === null && variantRate !== null) {
    return { delta: null, kind: 'new' };
  }
  if (baselineRate !== null && variantRate === null) {
    return { delta: null, kind: 'data-loss' };
  }
  // both non-null
  const delta = (variantRate as number) - (baselineRate as number);
  if (direction === 'lower-is-better') {
    if (delta > threshold) return { delta, kind: 'regression' };
    if (delta < -threshold) return { delta, kind: 'improvement' };
    return { delta, kind: 'neutral' };
  }
  // higher-is-better
  if (delta < -threshold) return { delta, kind: 'regression' };
  if (delta > threshold) return { delta, kind: 'improvement' };
  return { delta, kind: 'neutral' };
}

export function buildVariantComparison(
  baseline: AggregatorOutput,
  variant: AggregatorOutput,
  variantFile: string,
  threshold: number,
): VariantComparison {
  const metricDeltas: MetricDelta[] = [];
  const regressedMetrics: MetricName[] = [];
  for (const name of METRIC_NAMES) {
    const baseEntry = baseline.metrics?.[name];
    const varEntry = variant.metrics?.[name];
    const baselineRate = baseEntry?.rate ?? null;
    const variantRate = varEntry?.rate ?? null;
    const direction = METRIC_DIRECTIONS[name];
    const { delta, kind } = classifyDelta(baselineRate, variantRate, direction, threshold);
    metricDeltas.push({
      metric: name,
      direction,
      baselineRate,
      variantRate,
      delta,
      kind,
    });
    if (kind === 'regression') regressedMetrics.push(name);
  }
  return {
    file: variantFile,
    totalRows: variant.totalRows,
    aggregatorVersion: variant.aggregatorVersion,
    metricDeltas,
    hasRegression: regressedMetrics.length > 0,
    regressedMetrics,
  };
}

export function buildTagSummary(
  baseline: AggregatorOutput,
  variants: ReadonlyArray<{ file: string; output: AggregatorOutput }>,
  topN: number,
  fullTags: boolean,
): TagDeltaRow[] {
  const tagSet = new Set<string>();
  for (const tag of Object.keys(baseline.byViolationTag ?? {})) tagSet.add(tag);
  for (const v of variants) {
    for (const tag of Object.keys(v.output.byViolationTag ?? {})) tagSet.add(tag);
  }

  const rows: TagDeltaRow[] = [];
  for (const tag of tagSet) {
    const baseEntry = baseline.byViolationTag?.[tag as keyof typeof baseline.byViolationTag];
    const baselineRate = baseEntry?.rate ?? null;
    const variantDeltas: Array<{ file: string; delta: number | null }> = [];
    let maxAbsDelta = 0;
    for (const v of variants) {
      const vEntry = v.output.byViolationTag?.[tag as keyof typeof v.output.byViolationTag];
      const variantRate = vEntry?.rate ?? null;
      let delta: number | null;
      if (baselineRate === null || variantRate === null) {
        delta = null;
      } else {
        delta = variantRate - baselineRate;
        const abs = Math.abs(delta);
        if (abs > maxAbsDelta) maxAbsDelta = abs;
      }
      variantDeltas.push({ file: v.file, delta });
    }
    rows.push({ tag, baselineRate, variantDeltas, maxAbsDelta });
  }

  const allZero = rows.every((r) => r.maxAbsDelta === 0);
  rows.sort((a, b) => {
    if (allZero) {
      const ar = a.baselineRate ?? -Infinity;
      const br = b.baselineRate ?? -Infinity;
      if (ar !== br) return br - ar;
      return a.tag.localeCompare(b.tag);
    }
    if (a.maxAbsDelta !== b.maxAbsDelta) return b.maxAbsDelta - a.maxAbsDelta;
    const ar = a.baselineRate ?? -Infinity;
    const br = b.baselineRate ?? -Infinity;
    if (ar !== br) return br - ar;
    return a.tag.localeCompare(b.tag);
  });

  if (fullTags) return rows;
  return rows.slice(0, topN);
}

export interface CompareInput {
  baseline: AggregatorOutput;
  baselineFile: string;
  variants: ReadonlyArray<{ file: string; output: AggregatorOutput }>;
  threshold: number;
  fullTags: boolean;
}

export function compareAggregations(input: CompareInput): ComparisonResult {
  const warnings: string[] = [];
  for (const v of input.variants) {
    if (v.output.aggregatorVersion !== input.baseline.aggregatorVersion) {
      warnings.push(
        `aggregatorVersion mismatch: baseline=${input.baseline.aggregatorVersion}, variant=${v.output.aggregatorVersion} in ${v.file}`,
      );
    }
  }
  const variantComparisons = input.variants.map((v) =>
    buildVariantComparison(input.baseline, v.output, v.file, input.threshold),
  );
  for (const vc of variantComparisons) {
    for (const d of vc.metricDeltas) {
      if (d.kind === 'data-loss') {
        warnings.push(`data-loss: ${d.metric} in ${vc.file}`);
      }
    }
  }
  const tagSummary = buildTagSummary(
    input.baseline,
    input.variants,
    TAG_SUMMARY_TOP_N,
    input.fullTags,
  );
  const anyRegression = variantComparisons.some((v) => v.hasRegression);
  return {
    baselineFile: input.baselineFile,
    baselineTotalRows: input.baseline.totalRows,
    baselineAggregatorVersion: input.baseline.aggregatorVersion,
    threshold: input.threshold,
    variants: variantComparisons,
    tagSummary,
    fullTags: input.fullTags,
    warnings,
    anyRegression,
  };
}

export function formatRate(rate: number | null): string {
  if (rate === null) return EM_DASH;
  return rate.toFixed(RATE_PRECISION);
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '';
  const abs = Math.abs(delta);
  const fixed = abs.toFixed(RATE_PRECISION);
  // Treat tiny rounding negatives as +0 (Designer §B: zero collapses to +0.000)
  if (Number(fixed) === 0) return `(+${fixed})`;
  if (delta > 0) return `(+${fixed})`;
  return `(${MINUS_SIGN}${fixed})`;
}

export function formatCell(d: MetricDelta): string {
  switch (d.kind) {
    case 'both-null':
      return EM_DASH;
    case 'new':
      return `${formatRate(d.variantRate)} (new)`;
    case 'data-loss':
      return `⚠ ${EM_DASH}`;
    case 'neutral':
      return `${formatRate(d.variantRate)} ${formatDelta(d.delta)}`;
    case 'improvement': {
      const glyph = d.direction === 'lower-is-better' ? '▼' : '▲';
      return `${glyph} ${formatRate(d.variantRate)} ${formatDelta(d.delta)}`;
    }
    case 'regression':
      return `${formatRate(d.variantRate)} ${formatDelta(d.delta)} ⚠ REGRESSION`;
  }
}

function formatTagDelta(delta: number | null): string {
  if (delta === null) return EM_DASH;
  const abs = Math.abs(delta);
  const fixed = abs.toFixed(RATE_PRECISION);
  if (Number(fixed) === 0) return `+${fixed}`;
  if (delta > 0) return `+${fixed}`;
  return `${MINUS_SIGN}${fixed}`;
}

export interface RenderInput {
  comparison: ComparisonResult;
  showBaselineColumn: boolean;
  noFailOnRegression: boolean;
}

function pickTagSummaryAnchorVariant(comparison: ComparisonResult): string | null {
  if (comparison.variants.length === 0) return null;
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < comparison.variants.length; i++) {
    const v = comparison.variants[i];
    let score = 0;
    for (const d of v.metricDeltas) {
      if (d.kind === 'regression' && d.delta !== null) {
        score += Math.abs(d.delta);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return comparison.variants[bestIdx].file;
}

export function formatMarkdown(input: RenderInput): string {
  const c = input.comparison;
  const lines: string[] = [];

  // Header
  lines.push('# Metric Comparison');
  lines.push('');
  lines.push(`**Baseline:** ${c.baselineFile} (${c.baselineTotalRows} rows)`);
  const variantSegments = c.variants.map((v) => `${v.file} (${v.totalRows} rows)`);
  lines.push(`**Variants:** ${variantSegments.join(' · ')}`);
  lines.push(`**Threshold:** ${c.threshold}`);
  lines.push('');

  // Metrics table
  lines.push('## Metrics');
  lines.push('');
  const headerCols: string[] = ['Metric', 'Direction'];
  if (input.showBaselineColumn) headerCols.push('Baseline');
  for (const v of c.variants) headerCols.push(v.file);
  lines.push(`| ${headerCols.join(' | ')} |`);
  lines.push(`|${headerCols.map(() => '--------').join('|')}|`);

  // Build a baseline lookup from the FIRST variant's metricDeltas (every variant has baselineRate);
  // safer: pull from variants[0] when present, else just render '—'.
  const baselineRateByMetric = new Map<MetricName, number | null>();
  if (c.variants.length > 0) {
    for (const d of c.variants[0].metricDeltas) {
      baselineRateByMetric.set(d.metric, d.baselineRate);
    }
  } else {
    for (const name of METRIC_NAMES) baselineRateByMetric.set(name, null);
  }

  for (const name of METRIC_NAMES) {
    const direction = METRIC_DIRECTIONS[name];
    const dirLabel = direction === 'lower-is-better' ? '↓ lower' : '↑ higher';
    const row: string[] = [name, dirLabel];
    if (input.showBaselineColumn) {
      row.push(formatRate(baselineRateByMetric.get(name) ?? null));
    }
    for (const v of c.variants) {
      const d = v.metricDeltas.find((x) => x.metric === name);
      row.push(d ? formatCell(d) : EM_DASH);
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');

  // Tag summary section
  const anchorVariant = pickTagSummaryAnchorVariant(c);
  if (c.fullTags) {
    lines.push('## Violation Tag Summary (all tags)');
  } else {
    lines.push(
      `## Violation Tag Summary (top ${TAG_SUMMARY_TOP_N} by absolute delta vs baseline, ${anchorVariant ?? 'n/a'})`,
    );
  }
  lines.push('');
  if (c.tagSummary.length === 0) {
    lines.push('_(no violation tags reported)_');
    lines.push('');
  } else {
    const tagHeader: string[] = ['Tag', 'Baseline rate'];
    for (const v of c.variants) tagHeader.push(`${v.file} Δ`);
    lines.push(`| ${tagHeader.join(' | ')} |`);
    lines.push(`|${tagHeader.map(() => '--------').join('|')}|`);
    for (const row of c.tagSummary) {
      const cols: string[] = [row.tag, formatRate(row.baselineRate)];
      for (const v of c.variants) {
        const vd = row.variantDeltas.find((x) => x.file === v.file);
        cols.push(formatTagDelta(vd?.delta ?? null));
      }
      lines.push(`| ${cols.join(' | ')} |`);
    }
    lines.push('');
  }

  // Regressions section
  if (c.anyRegression) {
    lines.push('## Regressions');
    lines.push('');
    for (const v of c.variants) {
      if (!v.hasRegression) continue;
      const parts: string[] = [];
      for (const m of v.regressedMetrics) {
        const d = v.metricDeltas.find((x) => x.metric === m);
        if (!d || d.delta === null) continue;
        const sign = d.delta > 0 ? '+' : MINUS_SIGN;
        const abs = Math.abs(d.delta).toFixed(RATE_PRECISION);
        const thrFixed = c.threshold.toFixed(RATE_PRECISION);
        parts.push(`\`${m}\` (${sign}${abs} > ${thrFixed} threshold)`);
      }
      lines.push(`- **${v.file}** regressed on: ${parts.join(', ')}`);
    }
    lines.push('');
  }

  // Summary section
  lines.push('## Summary');
  lines.push('');
  if (!c.anyRegression) {
    lines.push('✅ No regressions. Exit 0.');
  } else if (input.noFailOnRegression) {
    lines.push('⚠ Regressions detected (--no-fail-on-regression active). Exit 0.');
  } else {
    const regCount = c.variants.filter((v) => v.hasRegression).length;
    lines.push(`❌ ${regCount} variant(s) with regressions. Exit 1.`);
  }
  lines.push('');

  return lines.join('\n');
}
