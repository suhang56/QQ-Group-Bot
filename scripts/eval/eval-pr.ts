/**
 * R7.3 eval-pr — replay JSONL → markdown comparison in one step.
 *
 * Wraps the R7.1 + R7.2 pipeline: each input JSONL is independently
 * parsed and aggregated via `computeAggregate`, then `compareAggregations`
 * + `formatMarkdown` produce the same markdown report compare-metrics.ts
 * would emit given the equivalent pre-aggregated JSON inputs.
 *
 * Pure aggregation + comparison logic lives in ./aggregation/*; this file
 * owns argv parsing, JSONL parsing, and process exit codes.
 *
 * Exit codes: 0 / 1 / 2 / 3 per Designer §B.
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type AggregatorOutput,
  type AggregatorRow,
  computeAggregate,
  isErrorRow,
} from './aggregation/metrics.js';
import {
  DEFAULT_THRESHOLD,
  compareAggregations,
  formatMarkdown,
} from './aggregation/comparison.js';

const RESULT_KINDS: ReadonlySet<string> = new Set([
  'reply',
  'sticker',
  'fallback',
  'silent',
  'defer',
  'error',
]);

const USAGE = `Usage: eval-pr.ts <file...> [options]

Positional:
  <file...>               2+ replay-output.jsonl paths.
                          First is implicit baseline unless --baseline is given.

Options:
  --baseline <path>       Override which JSONL file is treated as the baseline.
                          If also in positional list, deduplicated (same as compare-metrics).
  --output <path>         Write markdown to file instead of stdout (creates parent dirs).
  --threshold <number>    Regression threshold, default ${DEFAULT_THRESHOLD}. Float >= 0.
                          threshold=0: delta=0 is NOT a regression (strict >).
  --fail-on-regression    Exit 1 if any regression (default).
  --no-fail-on-regression Exit 0 even with regressions; noted in summary.
  --full-tags             Show all violation tags (default: top-5).
  --help, -h              Print usage and exit 0.

Exit codes:
  0   No regressions, or --no-fail-on-regression active.
  1   Regressions detected and --fail-on-regression active (default).
  2   Usage error: <2 files, unknown flag, bad --threshold, missing file, 0 valid rows.
  3   File unreadable, fatal I/O error, or write failure.`;

interface ParsedArgs {
  inputs: string[];
  baseline: string | null;
  output: string | null;
  threshold: number;
  failOnRegression: boolean;
  fullTags: boolean;
}

type ParseResult = ParsedArgs | { error: string };

function parseArgs(argv: readonly string[]): ParseResult {
  const inputs: string[] = [];
  let baseline: string | null = null;
  let output: string | null = null;
  let threshold = DEFAULT_THRESHOLD;
  let failOnRegression = true;
  let fullTags = false;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { error: '__help__' };
    } else if (a === '--baseline') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.startsWith('--')) {
        return { error: '--baseline requires a path' };
      }
      baseline = v;
      i += 2;
    } else if (a === '--output') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.startsWith('--')) {
        return { error: '--output requires a path' };
      }
      output = v;
      i += 2;
    } else if (a === '--threshold') {
      const v = argv[i + 1];
      if (typeof v !== 'string') {
        return { error: '--threshold requires a non-negative number' };
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return { error: '--threshold requires a non-negative number' };
      }
      threshold = n;
      i += 2;
    } else if (a === '--fail-on-regression') {
      failOnRegression = true;
      i += 1;
    } else if (a === '--no-fail-on-regression') {
      failOnRegression = false;
      i += 1;
    } else if (a === '--full-tags') {
      fullTags = true;
      i += 1;
    } else if (typeof a === 'string' && a.startsWith('--')) {
      return { error: `unknown flag: ${a}` };
    } else if (typeof a === 'string') {
      inputs.push(a);
      i += 1;
    } else {
      i += 1;
    }
  }

  return { inputs, baseline, output, threshold, failOnRegression, fullTags };
}

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

interface FileParseResult {
  rows: AggregatorRow[];
  malformedSkipped: number;
}

async function parseJSONLFile(path: string): Promise<FileParseResult> {
  const rows: AggregatorRow[] = [];
  let malformedSkipped = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  for await (const rawLine of rl) {
    lineNum++;
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[warn] invalid JSON at ${path}:${lineNum}: ${msg}\n`);
      malformedSkipped++;
      continue;
    }
    if (!isAggregatorRow(parsed)) {
      process.stderr.write(`[warn] skipping malformed row at ${path}:${lineNum}\n`);
      malformedSkipped++;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, malformedSkipped };
}

function aggregateOne(file: string, fp: FileParseResult): AggregatorOutput {
  let resultKindErrorCount = 0;
  for (const r of fp.rows) {
    if (isErrorRow(r)) resultKindErrorCount++;
  }
  const errorRows = fp.malformedSkipped + resultKindErrorCount;
  return computeAggregate({
    rows: fp.rows,
    inputFiles: [file],
    errorRows,
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === '__help__') {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    process.stderr.write(`error: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }

  if (parsed.inputs.length < 2 && parsed.baseline === null) {
    process.stderr.write(`error: at least 2 input files required (or --baseline + 1 positional)\n${USAGE}\n`);
    return 2;
  }
  if (parsed.inputs.length < 1) {
    process.stderr.write(`error: at least 1 positional input required\n${USAGE}\n`);
    return 2;
  }

  for (const p of parsed.inputs) {
    if (!existsSync(p)) {
      process.stderr.write(`error: file not found: ${p}\n`);
      return 2;
    }
  }
  if (parsed.baseline !== null && !existsSync(parsed.baseline)) {
    process.stderr.write(`error: file not found: ${parsed.baseline}\n`);
    return 2;
  }

  let baselineFile: string;
  let variantFiles: string[];
  const showBaselineColumn = true;
  if (parsed.baseline !== null) {
    baselineFile = parsed.baseline;
    variantFiles = parsed.inputs.filter((p) => p !== baselineFile);
  } else {
    baselineFile = parsed.inputs[0];
    variantFiles = parsed.inputs.slice(1);
  }

  if (variantFiles.length < 1) {
    process.stderr.write(`error: at least 1 variant required (baseline excluded)\n${USAGE}\n`);
    return 2;
  }

  const bp = await parseJSONLFile(baselineFile);
  if (bp.rows.length === 0) {
    process.stderr.write(`error: no valid rows in baseline: ${baselineFile}\n`);
    return 2;
  }
  const baselineOutput = aggregateOne(baselineFile, bp);

  const variants: Array<{ file: string; output: AggregatorOutput }> = [];
  for (const f of variantFiles) {
    const vp = await parseJSONLFile(f);
    if (vp.rows.length === 0) {
      process.stderr.write(`error: no valid rows in variant: ${f}\n`);
      return 2;
    }
    variants.push({ file: f, output: aggregateOne(f, vp) });
  }

  const result = compareAggregations({
    baseline: baselineOutput,
    baselineFile,
    variants,
    threshold: parsed.threshold,
    fullTags: parsed.fullTags,
  });

  for (const w of result.warnings) {
    process.stderr.write(`[warn] ${w}\n`);
  }

  const markdown = formatMarkdown({
    comparison: result,
    showBaselineColumn,
    noFailOnRegression: !parsed.failOnRegression,
  });

  if (parsed.output !== null) {
    try {
      mkdirSync(dirname(parsed.output), { recursive: true });
      writeFileSync(parsed.output, markdown);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`error: write failed: ${msg}\n`);
      return 3;
    }
  } else {
    process.stdout.write(markdown);
  }

  if (!result.anyRegression) return 0;
  if (!parsed.failOnRegression) return 0;
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
