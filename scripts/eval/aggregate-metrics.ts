/**
 * R7.1 Violation Aggregator — CLI wrapper.
 *
 * Streams replay-output.jsonl rows, validates row shape, calls pure
 * computeAggregate, emits AggregatorOutput JSON. No business logic here —
 * all formulas live in ./aggregation/metrics.ts.
 *
 * Usage:
 *   npx tsx scripts/eval/aggregate-metrics.ts <file...> [--output <path>]
 *     [--baseline|--diff <path>]
 *
 * Exit codes: 0 success | 1 bad args / missing file | 2 zero rows total
 *             | 3 write error
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type AggregatorOutput,
  type AggregatorRow,
  computeAggregate,
  isErrorRow,
} from './aggregation/metrics.js';
import { ALL_VIOLATION_TAGS } from './violation-tags.js';

const ALL_VIOLATION_TAGS_SET: ReadonlySet<string> = new Set(ALL_VIOLATION_TAGS);

const RESULT_KINDS: ReadonlySet<string> = new Set([
  'reply',
  'sticker',
  'fallback',
  'silent',
  'defer',
  'error',
]);

const USAGE = `Usage: aggregate-metrics.ts <file...> [--output <path>] [--baseline|--diff <path>]
  <file...>           one or more replay-output.jsonl paths (merged before aggregation)
  --output <path>     write JSON to file instead of stdout (creates parent dirs)
  --baseline <path>   path to prior aggregator JSON; populates \`comparison\`
  --diff <path>       alias for --baseline (last-wins)
Exit codes: 0 success | 1 bad args / missing file | 2 zero rows total | 3 write error`;

interface ParsedArgs {
  inputs: string[];
  output: string | null;
  baseline: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const inputs: string[] = [];
  let output: string | null = null;
  let baseline: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { error: '__help__' };
    } else if (a === '--output') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.startsWith('--')) {
        return { error: '--output requires a path' };
      }
      output = v;
      i += 2;
    } else if (a === '--baseline' || a === '--diff') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.startsWith('--')) {
        return { error: `${a} requires a path` };
      }
      baseline = v;
      i += 2;
    } else if (typeof a === 'string' && a.startsWith('--')) {
      return { error: `unknown flag: ${a}` };
    } else if (typeof a === 'string') {
      inputs.push(a);
      i += 1;
    } else {
      i += 1;
    }
  }
  return { inputs, output, baseline };
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

function describeMissingField(x: unknown): string {
  if (typeof x !== 'object' || x === null) return 'not an object';
  const o = x as Record<string, unknown>;
  if (typeof o.sampleId !== 'string') return 'missing/invalid sampleId';
  if (typeof o.category !== 'number') return 'missing/invalid category';
  if (typeof o.goldAct !== 'string') return 'missing/invalid goldAct';
  if (typeof o.goldDecision !== 'string') return 'missing/invalid goldDecision';
  if (typeof o.factNeeded !== 'boolean') return 'missing/invalid factNeeded';
  if (typeof o.resultKind !== 'string' || !RESULT_KINDS.has(o.resultKind)) {
    return 'missing/invalid resultKind';
  }
  if (!Array.isArray(o.violationTags)) return 'missing/invalid violationTags';
  return 'unknown';
}

interface FileParseResult {
  rows: AggregatorRow[];
  malformedSkipped: number;
}

async function parseFile(path: string): Promise<FileParseResult> {
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
      console.error(`[warn] invalid JSON at ${path}:${lineNum}: ${msg}`);
      malformedSkipped++;
      continue;
    }
    if (!isAggregatorRow(parsed)) {
      console.error(
        `[warn] skipping malformed row at ${path}:${lineNum}: ${describeMissingField(parsed)}`,
      );
      malformedSkipped++;
      continue;
    }
    const sampleId = parsed.sampleId;
    for (const tag of parsed.violationTags) {
      if (!ALL_VIOLATION_TAGS_SET.has(tag)) {
        console.error(`[warn] unknown tag in row ${sampleId}: ${tag}`);
      }
    }
    rows.push(parsed);
  }
  return { rows, malformedSkipped };
}

function loadBaseline(path: string): AggregatorOutput | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { error: `baseline read error: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const parsed = JSON.parse(raw) as AggregatorOutput;
    if (typeof parsed !== 'object' || parsed === null) {
      return { error: 'baseline is not a JSON object' };
    }
    return parsed;
  } catch (e) {
    return { error: `baseline JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
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
    return 1;
  }
  if (parsed.inputs.length === 0) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  for (const p of parsed.inputs) {
    if (!existsSync(p)) {
      process.stderr.write(`input file not found: ${p}\n`);
      return 1;
    }
  }
  if (parsed.baseline !== null && !existsSync(parsed.baseline)) {
    process.stderr.write(`baseline file not found: ${parsed.baseline}\n`);
    return 1;
  }

  const allRows: AggregatorRow[] = [];
  let totalMalformed = 0;
  for (const p of parsed.inputs) {
    const r = await parseFile(p);
    allRows.push(...r.rows);
    totalMalformed += r.malformedSkipped;
  }

  if (allRows.length === 0) {
    process.stderr.write(`no rows parsed from input files (malformed=${totalMalformed})\n`);
    return 2;
  }

  let baseline: AggregatorOutput | null = null;
  if (parsed.baseline !== null) {
    const loaded = loadBaseline(parsed.baseline);
    if ('error' in loaded) {
      process.stderr.write(`${loaded.error}\n`);
      return 1;
    }
    baseline = loaded;
  }

  let resultKindErrorCount = 0;
  for (const r of allRows) {
    if (isErrorRow(r)) resultKindErrorCount++;
  }
  const errorRows = totalMalformed + resultKindErrorCount;

  const output = computeAggregate({
    rows: allRows,
    inputFiles: parsed.inputs,
    errorRows,
    baseline,
    baselineFile: parsed.baseline ?? undefined,
  });

  const json = JSON.stringify(output, null, 2);
  if (parsed.output !== null) {
    try {
      mkdirSync(dirname(parsed.output), { recursive: true });
      writeFileSync(parsed.output, json + '\n');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`output write error: ${msg}\n`);
      return 3;
    }
  } else {
    process.stdout.write(json + '\n');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
