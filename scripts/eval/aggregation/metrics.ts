/**
 * R7.1 Violation Aggregator — pure metric computation.
 *
 * Reads the canonical ReplayRow shape (subset) and emits the locked
 * AggregatorOutput JSON shape. No I/O, no src/ imports, no Date.now()
 * outside `computeAggregate` (and only when `input.generatedAt` not given).
 * Tag-to-metric map and locked guard list live verbatim per Designer §A/§F.
 */

import { ALL_VIOLATION_TAGS, type ViolationTag } from '../violation-tags.js';
import type { ReplayRow } from '../replay-types.js';

export const AGGREGATOR_VERSION = 'r7.1.0' as const;

export type AggregatorRow = Readonly<Pick<
  ReplayRow,
  'sampleId'
  | 'category'
  | 'goldAct'
  | 'goldDecision'
  | 'factNeeded'
  | 'resultKind'
  | 'violationTags'
>>;

export type MetricName =
  | '你们-violation-rate'
  | 'fact-hit-success-rate'
  | 'object-react-grounding-rate'
  | 'bot-status-act-accuracy'
  | 'defer-correctness'
  | 'fallback-misuse-rate'
  | 'self-style-contamination-rate'
  | 'reply-correction-proxy';

export type MetricDirection = 'higher-is-better' | 'lower-is-better';

export const METRIC_NAMES: readonly MetricName[] = [
  '你们-violation-rate',
  'fact-hit-success-rate',
  'object-react-grounding-rate',
  'bot-status-act-accuracy',
  'defer-correctness',
  'fallback-misuse-rate',
  'self-style-contamination-rate',
  'reply-correction-proxy',
] as const;

export const METRIC_DIRECTIONS: Readonly<Record<MetricName, MetricDirection>> = {
  '你们-violation-rate': 'lower-is-better',
  'fact-hit-success-rate': 'higher-is-better',
  'object-react-grounding-rate': 'higher-is-better',
  'bot-status-act-accuracy': 'higher-is-better',
  'defer-correctness': 'higher-is-better',
  'fallback-misuse-rate': 'lower-is-better',
  'self-style-contamination-rate': 'lower-is-better',
  'reply-correction-proxy': 'lower-is-better',
} as const;

export interface ViolationTagEntry {
  count: number;
  rate: number | null;
  denominator: number;
  rowIds: string[];
  truncated?: true;
}

export interface MetricEntry {
  numerator: number;
  denominator: number;
  rate: number | null;
  direction: MetricDirection;
}

export interface MetricDelta {
  baseline: number | null;
  current: number | null;
  delta: number | null;
  regression: boolean;
}

export interface ComparisonBlock {
  baselineFile: string;
  baselineTotalRows: number;
  metricDeltas: Partial<Record<MetricName, MetricDelta>>;
}

export interface AggregatorOutput {
  generatedAt: number;
  aggregatorVersion: string;
  inputFiles: string[];
  totalRows: number;
  errorRows: number;
  byViolationTag: Record<ViolationTag, ViolationTagEntry>;
  metrics: Record<MetricName, MetricEntry>;
  comparison: ComparisonBlock | null;
}

export const FALLBACK_MISUSE_GUARD_TAGS: readonly ViolationTag[] = [
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
] as const;

const ROW_IDS_TRUNCATE_THRESHOLD = 1000;
const REGRESSION_DELTA_THRESHOLD = 0.01;

export function rateOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function isErrorRow(row: AggregatorRow): boolean {
  return row.resultKind === 'error';
}

export function producedOutput(row: AggregatorRow): boolean {
  return row.resultKind === 'reply' || row.resultKind === 'sticker' || row.resultKind === 'fallback';
}

export function hasTag(row: AggregatorRow, tag: ViolationTag): boolean {
  return row.violationTags.includes(tag);
}

export function hasAnyTag(row: AggregatorRow, tags: readonly ViolationTag[]): boolean {
  for (const t of tags) {
    if (row.violationTags.includes(t)) return true;
  }
  return false;
}

function buildEntry(name: MetricName, numerator: number, denominator: number): MetricEntry {
  return {
    numerator,
    denominator,
    rate: rateOrNull(numerator, denominator),
    direction: METRIC_DIRECTIONS[name],
  };
}

export function computeNiMen(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (row.category !== 1) continue;
    denominator++;
    if (hasTag(row, 'group-address-in-small-scene')) numerator++;
  }
  return buildEntry('你们-violation-rate', numerator, denominator);
}

export function computeFactHitSuccess(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (!(row.factNeeded === true && row.resultKind === 'reply')) continue;
    denominator++;
    if (!hasTag(row, 'fact-needed-no-fact')) numerator++;
  }
  return buildEntry('fact-hit-success-rate', numerator, denominator);
}

export function computeObjectReactGrounding(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (row.goldAct !== 'object_react') continue;
    denominator++;
    if (!hasTag(row, 'object-react-missed')) numerator++;
  }
  return buildEntry('object-react-grounding-rate', numerator, denominator);
}

export function computeBotStatusActAccuracy(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (!(row.goldAct === 'meta_admin_status' && row.resultKind === 'reply')) continue;
    denominator++;
    if (!hasTag(row, 'meta-status-misclassified')) numerator++;
  }
  return buildEntry('bot-status-act-accuracy', numerator, denominator);
}

export function computeDeferCorrectness(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (row.goldDecision !== 'defer') continue;
    denominator++;
    if (!hasTag(row, 'gold-defer-but-replied')) numerator++;
  }
  return buildEntry('defer-correctness', numerator, denominator);
}

export function computeFallbackMisuse(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (row.resultKind !== 'fallback') continue;
    denominator++;
    if (hasAnyTag(row, FALLBACK_MISUSE_GUARD_TAGS)) numerator++;
  }
  return buildEntry('fallback-misuse-rate', numerator, denominator);
}

export function computeSelfStyleContamination(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (!producedOutput(row)) continue;
    denominator++;
    if (hasTag(row, 'persona-fabricated-in-output')) numerator++;
  }
  return buildEntry('self-style-contamination-rate', numerator, denominator);
}

export function computeReplyCorrectionProxy(rows: readonly AggregatorRow[]): MetricEntry {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (isErrorRow(row)) continue;
    if (row.goldDecision !== 'silent') continue;
    denominator++;
    if (hasTag(row, 'gold-silent-but-replied')) numerator++;
  }
  return buildEntry('reply-correction-proxy', numerator, denominator);
}

export function computeAllMetrics(
  rows: readonly AggregatorRow[],
): Record<MetricName, MetricEntry> {
  return {
    '你们-violation-rate': computeNiMen(rows),
    'fact-hit-success-rate': computeFactHitSuccess(rows),
    'object-react-grounding-rate': computeObjectReactGrounding(rows),
    'bot-status-act-accuracy': computeBotStatusActAccuracy(rows),
    'defer-correctness': computeDeferCorrectness(rows),
    'fallback-misuse-rate': computeFallbackMisuse(rows),
    'self-style-contamination-rate': computeSelfStyleContamination(rows),
    'reply-correction-proxy': computeReplyCorrectionProxy(rows),
  };
}

export function computeByViolationTag(
  rows: readonly AggregatorRow[],
): Record<ViolationTag, ViolationTagEntry> {
  // Why: tag denominator = totalRows - errorRows (all non-error rows).
  // Aggregator does not have GoldLabel, so we cannot use violation-tags.ts
  // DENOMINATOR_RULES (which need GoldLabel). Per Architect §File1 + Planner
  // Must-NOT-fire #4: aggregator stays gold-data-independent.
  let nonErrorCount = 0;
  for (const row of rows) {
    if (!isErrorRow(row)) nonErrorCount++;
  }

  const out = {} as Record<ViolationTag, ViolationTagEntry>;
  for (const tag of ALL_VIOLATION_TAGS) {
    out[tag] = {
      count: 0,
      rate: rateOrNull(0, nonErrorCount),
      denominator: nonErrorCount,
      rowIds: [],
    };
  }

  for (const row of rows) {
    if (isErrorRow(row)) continue;
    for (const tag of row.violationTags) {
      const entry = out[tag as ViolationTag];
      if (!entry) continue;
      entry.count++;
      entry.rowIds.push(row.sampleId);
    }
  }

  for (const tag of ALL_VIOLATION_TAGS) {
    const entry = out[tag];
    entry.rate = rateOrNull(entry.count, entry.denominator);
    if (entry.rowIds.length > ROW_IDS_TRUNCATE_THRESHOLD) {
      out[tag] = {
        count: entry.count,
        rate: entry.rate,
        denominator: entry.denominator,
        rowIds: [],
        truncated: true,
      };
    }
  }

  return out;
}

export function computeMetricDelta(
  baseline: number | null,
  current: number | null,
  direction: MetricDirection,
): MetricDelta {
  if (baseline === null || current === null) {
    return { baseline, current, delta: null, regression: false };
  }
  const delta = current - baseline;
  const regression =
    direction === 'lower-is-better'
      ? delta > REGRESSION_DELTA_THRESHOLD
      : delta < -REGRESSION_DELTA_THRESHOLD;
  return { baseline, current, delta, regression };
}

export function computeComparison(
  current: Record<MetricName, MetricEntry>,
  baseline: AggregatorOutput,
  baselineFile: string,
): ComparisonBlock {
  const metricDeltas: Partial<Record<MetricName, MetricDelta>> = {};
  for (const name of METRIC_NAMES) {
    const cur = current[name];
    const base = baseline.metrics?.[name];
    if (!cur || !base) continue;
    metricDeltas[name] = computeMetricDelta(base.rate, cur.rate, METRIC_DIRECTIONS[name]);
  }
  return {
    baselineFile,
    baselineTotalRows: baseline.totalRows,
    metricDeltas,
  };
}

export interface ComputeAggregateInput {
  rows: readonly AggregatorRow[];
  inputFiles: readonly string[];
  errorRows: number;
  generatedAt?: number;
  baseline?: AggregatorOutput | null;
  baselineFile?: string;
}

export function computeAggregate(input: ComputeAggregateInput): AggregatorOutput {
  const byViolationTag = computeByViolationTag(input.rows);
  const metrics = computeAllMetrics(input.rows);
  const generatedAt = input.generatedAt ?? Math.floor(Date.now() / 1000);

  let comparison: ComparisonBlock | null = null;
  if (input.baseline && input.baselineFile) {
    comparison = computeComparison(metrics, input.baseline, input.baselineFile);
  }

  // totalRows = rows.length + malformedSkipped — but this fn only sees rows
  // already pushed to accumulator, so caller is responsible for adding the
  // malformedSkipped count via input.errorRows + (rows.length here). We
  // expose totalRows = rows.length passed in; CLI passes pre-merged rows.
  // Per Architect spec: totalRows = rows.length + malformedSkipped is owned
  // by the CLI. This module sees rows.length only. To preserve the locked
  // shape, CLI computes totalRows itself and passes it. But the type signature
  // does not include totalRows — Architect locked the formula here as
  // rows.length, with malformedSkipped folded into errorRows by the CLI.
  // Per Architect §File2 step 7: totalRows = rows.length + malformedSkipped.
  // This means CLI must wrap: we include malformed count in rows.length view.
  // Resolution: aggregator's totalRows field = rows.length + (errorRows -
  // count(resultKind==='error' in rows)). That matches Architect step 7.
  let resultKindErrorCount = 0;
  for (const r of input.rows) {
    if (isErrorRow(r)) resultKindErrorCount++;
  }
  const malformedSkipped = input.errorRows - resultKindErrorCount;
  const totalRows = input.rows.length + Math.max(0, malformedSkipped);

  return {
    generatedAt,
    aggregatorVersion: AGGREGATOR_VERSION,
    inputFiles: [...input.inputFiles],
    totalRows,
    errorRows: input.errorRows,
    byViolationTag,
    metrics,
    comparison,
  };
}
