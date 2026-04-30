/**
 * R6.3 — Shared CLI argument parser for replay-runner.ts.
 *
 * Minimal, dependency-free `--name value` parser. Unknown flags → usage.
 * Missing required flag → usage + exit 1. Bad --llm-mode → exit 2 (spec
 * DEV-READY §7.1). Not-yet-implemented modes (`real`, `recorded`) exit 2
 * at top of runner, not here — this parser just validates enum membership.
 */

import type { ReplayerArgs } from './replay-types.js';

export interface ParsedArgs extends ReplayerArgs {}

export function usage(): never {
  process.stderr.write(
    [
      'Usage: tsx scripts/eval/replay-runner.ts \\',
      '         --gold <path>           gold JSONL (read-only)',
      '         --benchmark <path>      benchmark-weak-labeled JSONL (read-only)',
      '         --output-dir <dir>      output directory (replay-output.jsonl + summary.json)',
      '         --llm-mode <mode>       mock | real | recorded  (only mock implemented)',
      '         --prod-db <path>        path to source sqlite (tmp-copied)',
      '         --bot-qq <qq>           bot user id for ChatModule wiring',
      '         --group-id <gid>        groupId to use for replay (where benchmark was sampled)',
      '         [--limit <N>]           stop after N samples (default: all)',
      '         [--timeout-ms <ms>]     per-sample generateReply timeout (default 10000)',
      '         [--max-cost-usd <f>]    real-mode cost cap in USD (default $5.00 or REPLAY_MAX_COST_USD env)',
      '         [--rps <int>]           real-mode rate limit (default 3 or REPLAY_RATE_LIMIT_RPS env)',
      '         [--retry-max <int>]     real-mode 429/5xx retry count (default 3 or REPLAY_RETRY_MAX env)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Normalize `--name=value` → `--name`, `value`. Avoids per-flag boilerplate
  // and matches the form used by the smoke-test runbook (--llm-mode=real).
  const args: string[] = [];
  for (const a of argv.slice(2)) {
    if (a.startsWith('--') && a.includes('=')) {
      const eqIdx = a.indexOf('=');
      args.push(a.slice(0, eqIdx));
      args.push(a.slice(eqIdx + 1));
    } else {
      args.push(a);
    }
  }
  let goldPath = '';
  let benchmarkPath = '';
  let outputDir = '';
  let llmModeRaw = '';
  let prodDbPath = '';
  let botQQ = '';
  let groupId = '';
  let limit: number | null = null;
  let perSampleTimeoutMs = 10_000;
  let maxCostUsd: number | null = null;
  let rateLimitRps: number | null = null;
  let retryMax: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--gold' && next) { goldPath = next; i++; continue; }
    if (a === '--benchmark' && next) { benchmarkPath = next; i++; continue; }
    if (a === '--output-dir' && next) { outputDir = next; i++; continue; }
    if (a === '--output' && next) { outputDir = next; i++; continue; }
    if (a === '--llm-mode' && next) { llmModeRaw = next; i++; continue; }
    if (a === '--prod-db' && next) { prodDbPath = next; i++; continue; }
    if (a === '--bot-qq' && next) { botQQ = next; i++; continue; }
    if (a === '--group-id' && next) { groupId = next; i++; continue; }
    if (a === '--limit' && next) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`--limit must be non-negative integer (got ${next})\n`);
        process.exit(1);
      }
      limit = n;
      i++;
      continue;
    }
    if (a === '--timeout-ms' && next) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`--timeout-ms must be positive integer (got ${next})\n`);
        process.exit(1);
      }
      perSampleTimeoutMs = n;
      i++;
      continue;
    }
    if (a === '--max-cost-usd' && next) {
      const n = Number.parseFloat(next);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`--max-cost-usd must be non-negative number (got ${next})\n`);
        process.exit(1);
      }
      maxCostUsd = n;
      i++;
      continue;
    }
    if (a === '--rps' && next) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`--rps must be integer >= 1 (got ${next})\n`);
        process.exit(1);
      }
      rateLimitRps = n;
      i++;
      continue;
    }
    if (a === '--retry-max' && next) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`--retry-max must be integer >= 0 (got ${next})\n`);
        process.exit(1);
      }
      retryMax = n;
      i++;
      continue;
    }
    if (a === '--help' || a === '-h') usage();
    process.stderr.write(`Unknown argument: ${String(a)}\n`);
    usage();
  }

  if (!goldPath) { process.stderr.write('Missing --gold\n'); usage(); }
  if (!benchmarkPath) { process.stderr.write('Missing --benchmark\n'); usage(); }
  if (!outputDir) { process.stderr.write('Missing --output-dir\n'); usage(); }
  if (!llmModeRaw) { process.stderr.write('Missing --llm-mode\n'); usage(); }
  if (!prodDbPath) { process.stderr.write('Missing --prod-db\n'); usage(); }
  if (!botQQ) { process.stderr.write('Missing --bot-qq\n'); usage(); }
  if (!groupId) { process.stderr.write('Missing --group-id\n'); usage(); }

  if (llmModeRaw !== 'mock' && llmModeRaw !== 'real' && llmModeRaw !== 'recorded') {
    process.stderr.write(`--llm-mode must be mock|real|recorded (got ${llmModeRaw})\n`);
    process.exit(1);
  }

  return {
    goldPath,
    benchmarkPath,
    outputDir,
    llmMode: llmModeRaw as 'mock' | 'real' | 'recorded',
    limit,
    prodDbPath,
    botQQ,
    groupIdForReplay: groupId,
    perSampleTimeoutMs,
    maxCostUsd,
    rateLimitRps,
    retryMax,
  };
}
