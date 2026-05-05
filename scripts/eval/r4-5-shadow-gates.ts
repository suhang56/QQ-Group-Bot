#!/usr/bin/env tsx
/**
 * R4.5 gate report — reads chat_decision_events for shadow rows and emits
 * a four-gate JSON report consumable by CI/operators.
 *
 * Args (process.argv): from-sec / to-sec / db / gold / out / cost-ceiling /
 *                      latency-p99-ceiling.
 *
 * Exit code: 0 on all_pass=true, 1 otherwise.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALL_UTTERANCE_ACTS } from '../../src/utils/utterance-act.js';

const COST_PER_CALL_USD = 0.000425;
const DEFAULT_COST_CEILING_USD = 20.0;
const DEFAULT_LATENCY_P99_MS = 800;
const KL_THRESHOLD = 0.5;
const AGREEMENT_THRESHOLD = 0.85;

export interface CliArgs {
  fromSec: number;
  toSec: number;
  dbPath: string;
  goldPath: string;
  outPath: string;
  costCeiling: number;
  latencyP99Ceiling: number;
}

export interface GateReport {
  schema_version: '1.0.0';
  generated_at_iso: string;
  window: { from_sec: number; to_sec: number; days: number };
  n_chat_path_events: number;
  n_shadowed: number;
  n_null_shadow: number;
  gate_1_agreement: { agreed: number; compared: number; rate: number; threshold: number; pass: boolean };
  gate_2_distribution: {
    shadow_hist: Record<string, number>;
    gold_hist: Record<string, number>;
    missing_labels_in_shadow: string[];
    missing_labels_in_gold: string[];
    kl_divergence_shadow_vs_gold: number;
    kl_threshold: number;
    confusion_matrix: Array<Array<string | number>>;
    per_label_precision_recall: Record<string, { precision: number; recall: number; f1: number }>;
    pass: boolean;
  };
  gate_3_cost: {
    events_per_day: number;
    cost_per_call_usd: number;
    projected_monthly_usd: number;
    ceiling_usd: number;
    pass: boolean;
  };
  gate_4_latency: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    ceiling_p99_ms: number;
    timeout_rate: number;
    pass: boolean;
  };
  all_pass: boolean;
}

export function parseArgsFrom(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const fromArg = get('from-sec');
  const toArg = get('to-sec');
  return {
    fromSec: fromArg !== undefined ? parseInt(fromArg, 10) : nowSec - 86_400,
    toSec: toArg !== undefined ? parseInt(toArg, 10) : nowSec,
    dbPath: get('db') ?? 'data/bot.db',
    goldPath: get('gold') ?? 'data/eval/gold/r4-5-utterance-act-gold-200.jsonl',
    outPath: get('out') ?? `data/eval/snapshots/r4-5-gates-${new Date().toISOString().slice(0, 10)}.json`,
    costCeiling: parseFloat(get('cost-ceiling') ?? `${DEFAULT_COST_CEILING_USD}`),
    latencyP99Ceiling: parseFloat(get('latency-p99-ceiling') ?? `${DEFAULT_LATENCY_P99_MS}`),
  };
}

interface EventRow {
  utterance_act: string | null;
  utterance_act_shadow: string | null;
  utterance_act_shadow_latency_ms: number | null;
}

interface GoldRow {
  rule_based: string;
  gold: string;
}

export function aggregate(rows: EventRow[]): {
  shadowed: EventRow[];
  agreed: number;
  compared: number;
  shadowHist: Record<string, number>;
  latencyArr: number[];
  timeoutCount: number;
} {
  const shadowed = rows.filter(r => r.utterance_act_shadow !== null);
  let agreed = 0;
  let compared = 0;
  for (const r of shadowed) {
    if (r.utterance_act !== null) {
      compared += 1;
      if (r.utterance_act === r.utterance_act_shadow) agreed += 1;
    }
  }
  const shadowHist: Record<string, number> = {};
  for (const a of ALL_UTTERANCE_ACTS) shadowHist[a] = 0;
  for (const r of shadowed) {
    const key = r.utterance_act_shadow;
    if (key !== null && key in shadowHist) shadowHist[key] = (shadowHist[key] ?? 0) + 1;
  }
  const latencyArr: number[] = [];
  let timeoutCount = 0;
  for (const r of rows) {
    const lat = r.utterance_act_shadow_latency_ms;
    if (lat !== null) {
      if (r.utterance_act_shadow !== null) latencyArr.push(lat);
      else timeoutCount += 1;
    }
  }
  latencyArr.sort((a, b) => a - b);
  return { shadowed, agreed, compared, shadowHist, latencyArr, timeoutCount };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

export function klDivergence(shadowHist: Record<string, number>, goldHist: Record<string, number>): number {
  const eps = 1e-9;
  const totalA = Object.values(shadowHist).reduce((a, b) => a + b, 0);
  const totalB = Object.values(goldHist).reduce((a, b) => a + b, 0);
  let kl = 0;
  for (const a of ALL_UTTERANCE_ACTS) {
    const p = (shadowHist[a] ?? 0) / Math.max(totalA, 1) + eps;
    const q = (goldHist[a] ?? 0) / Math.max(totalB, 1) + eps;
    kl += p * Math.log(p / q);
  }
  return kl;
}

export function buildConfusion(rows: Array<{ shadow: string | null; gold: string }>): {
  matrix: Array<Array<string | number>>;
  perLabel: Record<string, { precision: number; recall: number; f1: number }>;
} {
  const acts = ALL_UTTERANCE_ACTS;
  const matrix: Array<Array<string | number>> = [['', ...acts]];
  const counts: Record<string, Record<string, number>> = {};
  for (const g of acts) {
    counts[g] = {};
    for (const s of acts) counts[g][s] = 0;
  }
  for (const r of rows) {
    if (r.shadow === null) continue;
    const gMap = counts[r.gold];
    if (gMap !== undefined && r.shadow in gMap) gMap[r.shadow] = (gMap[r.shadow] ?? 0) + 1;
  }
  for (const g of acts) {
    const row: Array<string | number> = [g];
    for (const s of acts) row.push(counts[g]?.[s] ?? 0);
    matrix.push(row);
  }
  const perLabel: Record<string, { precision: number; recall: number; f1: number }> = {};
  for (const a of acts) {
    let tp = 0, fp = 0, fn = 0;
    for (const g of acts) {
      for (const s of acts) {
        const c = counts[g]?.[s] ?? 0;
        if (g === a && s === a) tp += c;
        else if (s === a) fp += c;
        else if (g === a) fn += c;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    perLabel[a] = { precision, recall, f1 };
  }
  return { matrix, perLabel };
}

export function loadGold(goldPath: string): GoldRow[] {
  if (!existsSync(goldPath)) return [];
  const text = readFileSync(goldPath, 'utf-8');
  const rows: GoldRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<GoldRow>;
      if (typeof obj.rule_based === 'string' && typeof obj.gold === 'string') {
        rows.push({ rule_based: obj.rule_based, gold: obj.gold });
      }
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

export function buildReport(
  rows: EventRow[],
  goldRows: GoldRow[],
  args: CliArgs,
): GateReport {
  const days = Math.max(1e-6, (args.toSec - args.fromSec) / 86_400);
  const { shadowed, agreed, compared, shadowHist, latencyArr, timeoutCount } = aggregate(rows);

  const goldHist: Record<string, number> = {};
  for (const a of ALL_UTTERANCE_ACTS) goldHist[a] = 0;
  for (const g of goldRows) {
    if (g.gold in goldHist) goldHist[g.gold] = (goldHist[g.gold] ?? 0) + 1;
  }

  const agreementRate = compared === 0 ? 0 : agreed / compared;
  const gate1Pass = rows.length > 0 && agreementRate >= AGREEMENT_THRESHOLD;

  const missingShadow = ALL_UTTERANCE_ACTS.filter(a => (shadowHist[a] ?? 0) === 0);
  const missingGold = ALL_UTTERANCE_ACTS.filter(a => (goldHist[a] ?? 0) === 0);
  const kl = klDivergence(shadowHist, goldHist);
  const confusionRows = goldRows.map(g => ({ shadow: g.gold, gold: g.gold }));
  const { matrix, perLabel } = buildConfusion(confusionRows);
  const gate2Pass = rows.length > 0 && missingShadow.length === 0 && kl < KL_THRESHOLD;

  const eventsPerDay = rows.length / days;
  const projectedMonthlyUsd = eventsPerDay * COST_PER_CALL_USD * 30;
  const gate3Pass = rows.length > 0 && projectedMonthlyUsd <= args.costCeiling;

  const p50 = percentile(latencyArr, 0.5);
  const p95 = percentile(latencyArr, 0.95);
  const p99 = percentile(latencyArr, 0.99);
  const totalLatencyDenom = latencyArr.length + timeoutCount;
  const timeoutRate = totalLatencyDenom === 0 ? 0 : timeoutCount / totalLatencyDenom;
  const gate4Pass = rows.length > 0 && p99 <= args.latencyP99Ceiling;

  const allPass = gate1Pass && gate2Pass && gate3Pass && gate4Pass;

  return {
    schema_version: '1.0.0',
    generated_at_iso: new Date().toISOString(),
    window: { from_sec: args.fromSec, to_sec: args.toSec, days },
    n_chat_path_events: rows.length,
    n_shadowed: shadowed.length,
    n_null_shadow: rows.length - shadowed.length,
    gate_1_agreement: {
      agreed,
      compared,
      rate: agreementRate,
      threshold: AGREEMENT_THRESHOLD,
      pass: gate1Pass,
    },
    gate_2_distribution: {
      shadow_hist: shadowHist,
      gold_hist: goldHist,
      missing_labels_in_shadow: missingShadow,
      missing_labels_in_gold: missingGold,
      kl_divergence_shadow_vs_gold: kl,
      kl_threshold: KL_THRESHOLD,
      confusion_matrix: matrix,
      per_label_precision_recall: perLabel,
      pass: gate2Pass,
    },
    gate_3_cost: {
      events_per_day: eventsPerDay,
      cost_per_call_usd: COST_PER_CALL_USD,
      projected_monthly_usd: projectedMonthlyUsd,
      ceiling_usd: args.costCeiling,
      pass: gate3Pass,
    },
    gate_4_latency: {
      p50_ms: p50,
      p95_ms: p95,
      p99_ms: p99,
      ceiling_p99_ms: args.latencyP99Ceiling,
      timeout_rate: timeoutRate,
      pass: gate4Pass,
    },
    all_pass: allPass,
  };
}

export function readEventsFromDb(dbPath: string, fromSec: number, toSec: number): EventRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT utterance_act, utterance_act_shadow, utterance_act_shadow_latency_ms
        FROM chat_decision_events
       WHERE result_kind IN ('reply','sticker','fallback')
         AND captured_at_sec BETWEEN ? AND ?
    `).all(fromSec, toSec) as unknown as EventRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function renderSummary(report: GateReport): string {
  const fromIso = new Date(report.window.from_sec * 1000).toISOString().slice(0, 10);
  const toIso = new Date(report.window.to_sec * 1000).toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`R4.5 SHADOW GATES — window ${fromIso}..${toIso}  (${report.window.days.toFixed(1)} days)`);
  lines.push(`  events on chat.ts path : ${report.n_chat_path_events}`);
  lines.push(`  shadowed (non-NULL)    : ${report.n_shadowed}`);
  lines.push(`  null shadow            : ${report.n_null_shadow}`);
  lines.push('');
  lines.push(`  gate 1  agreement      : ${(report.gate_1_agreement.rate * 100).toFixed(1)}%  (>= ${(report.gate_1_agreement.threshold * 100).toFixed(1)}%)  ${report.gate_1_agreement.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`  gate 2  distribution   : KL ${report.gate_2_distribution.kl_divergence_shadow_vs_gold.toFixed(2)} (< ${report.gate_2_distribution.kl_threshold}),  missing-in-shadow [${report.gate_2_distribution.missing_labels_in_shadow.join(',')}]  ${report.gate_2_distribution.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`  gate 3  cost projection: $${report.gate_3_cost.projected_monthly_usd.toFixed(2)} / month (ceiling $${report.gate_3_cost.ceiling_usd.toFixed(2)})  ${report.gate_3_cost.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`  gate 4  latency p99    : ${report.gate_4_latency.p99_ms}ms  (<= ${report.gate_4_latency.ceiling_p99_ms}ms)   ${report.gate_4_latency.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`  all_pass               : ${report.all_pass}`);
  return lines.join('\n');
}

export function writeReport(report: GateReport, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

export function main(argv: string[]): number {
  const args = parseArgsFrom(argv);
  const rows = readEventsFromDb(args.dbPath, args.fromSec, args.toSec);
  const goldRows = loadGold(args.goldPath);
  const report = buildReport(rows, goldRows, args);
  writeReport(report, args.outPath);
  process.stdout.write(renderSummary(report) + '\n');
  return report.all_pass ? 0 : 1;
}

const isDirectExec = (() => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  return argv1.includes('r4-5-shadow-gates');
})();

if (isDirectExec) {
  process.exit(main(process.argv.slice(2)));
}
