/**
 * R7.2 compare-metrics — CLI wrapper.
 *
 * Loads 2+ AggregatorOutput JSON files (one designated baseline + 1+ variants),
 * compares variant metric rates against the baseline, prints a markdown report
 * and exits with a status code reflecting regression state.
 *
 * Pure comparison logic lives in ./aggregation/comparison.ts; this file owns
 * argv parsing, file I/O, and process exit codes.
 *
 * Exit codes: 0 / 1 / 2 / 3 per Designer §E.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type AggregatorOutput } from './aggregation/metrics.js';
import {
  DEFAULT_THRESHOLD,
  compareAggregations,
  formatMarkdown,
} from './aggregation/comparison.js';

const USAGE = `Usage: compare-metrics.ts <file...> [options]

Positional:
  <file...>                   2 or more AggregatorOutput JSON paths.
                              First file is implicit baseline unless --baseline is given.
                              Minimum 2 files required; exit 2 if fewer.

Options:
  --baseline <path>           Designate explicit baseline file. May or may not also appear
                              in positional list. If NOT in positional list, it is used only
                              as the reference (not rendered as a column). If IS in positional
                              list, it renders as the leftmost "Baseline" column (no delta).
  --output <path>             Write markdown to file instead of stdout (creates parent dirs).
  --threshold <number>        Regression threshold (default: ${DEFAULT_THRESHOLD}). Float >= 0.
                              threshold=0: delta=0 is NOT a regression (strict inequality).
  --fail-on-regression        Exit 1 if any regression detected (default).
  --no-fail-on-regression     Exit 0 even when regressions are detected; note in summary.
  --full-tags                 Show all violation tags in tag summary (default: top-5).
  --help, -h                  Print usage and exit 0.

Exit codes:
  0   No regressions detected, OR --no-fail-on-regression is active.
  1   One or more regressions detected and --fail-on-regression is active (default).
  2   Usage error: fewer than 2 positional files, unknown flag, bad --threshold value.
  3   File I/O error: file not found, unreadable, malformed JSON, or write error.`;

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

type LoadResult =
  | { ok: true; output: AggregatorOutput }
  | { ok: false; error: string };

function loadAggregatorOutput(filePath: string): LoadResult {
  if (!existsSync(filePath)) {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `read error in ${filePath}: ${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `JSON parse error in ${filePath}: ${msg}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: `${filePath} is not a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.aggregatorVersion !== 'string') {
    return { ok: false, error: `${filePath} missing/invalid aggregatorVersion` };
  }
  if (typeof obj.totalRows !== 'number' || !Number.isFinite(obj.totalRows)) {
    return { ok: false, error: `${filePath} missing/invalid totalRows` };
  }
  if (typeof obj.metrics !== 'object' || obj.metrics === null) {
    return { ok: false, error: `${filePath} missing/invalid metrics` };
  }
  if (typeof obj.byViolationTag !== 'object' || obj.byViolationTag === null) {
    return { ok: false, error: `${filePath} missing/invalid byViolationTag` };
  }
  // Finite-rate check on every metric
  const metrics = obj.metrics as Record<string, unknown>;
  for (const [name, entry] of Object.entries(metrics)) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: `invalid metric entry for ${name} in ${filePath}` };
    }
    const e = entry as Record<string, unknown>;
    const rate = e.rate;
    if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate))) {
      return {
        ok: false,
        error: `invalid rate value (NaN/Infinity) in metric ${name} in ${filePath}`,
      };
    }
  }
  return { ok: true, output: parsed as AggregatorOutput };
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

  if (parsed.inputs.length === 0) {
    process.stderr.write(`error: at least 2 input files required\n${USAGE}\n`);
    return 2;
  }
  if (parsed.inputs.length < 2 && parsed.baseline === null) {
    process.stderr.write(`error: at least 2 input files required\n${USAGE}\n`);
    return 2;
  }

  // Resolve baseline + variants per Designer §E
  let baselineFile: string;
  let variantFiles: string[];
  let showBaselineColumn: boolean;
  if (parsed.baseline !== null) {
    baselineFile = parsed.baseline;
    const inPositional = parsed.inputs.includes(baselineFile);
    variantFiles = parsed.inputs.filter((p) => p !== baselineFile);
    showBaselineColumn = inPositional;
  } else {
    baselineFile = parsed.inputs[0];
    variantFiles = parsed.inputs.slice(1);
    showBaselineColumn = true;
  }

  if (variantFiles.length < 1) {
    process.stderr.write(
      `error: at least 1 variant required (baseline excluded)\n${USAGE}\n`,
    );
    return 2;
  }

  const baselineLoad = loadAggregatorOutput(baselineFile);
  if (!baselineLoad.ok) {
    process.stderr.write(`error: ${baselineLoad.error}\n`);
    return 3;
  }

  const variants: Array<{ file: string; output: AggregatorOutput }> = [];
  for (const f of variantFiles) {
    const r = loadAggregatorOutput(f);
    if (!r.ok) {
      process.stderr.write(`error: ${r.error}\n`);
      return 3;
    }
    variants.push({ file: f, output: r.output });
  }

  const result = compareAggregations({
    baseline: baselineLoad.output,
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
