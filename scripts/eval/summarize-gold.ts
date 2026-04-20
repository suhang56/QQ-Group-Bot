#!/usr/bin/env tsx
/**
 * R6.2.3 Gold Sanity Script.
 *
 * Read-only audit of weak benchmark + human gold labels. Zero src/ edits.
 *
 * Usage:
 *   npx tsx scripts/eval/summarize-gold.ts \
 *     --gold data/eval/gold/gold-smoke-50.jsonl \
 *     --benchmark data/eval/benchmark-weak-labeled.jsonl \
 *     [--under-cover-threshold 20] [--no-color] [--json]
 *
 * Exit codes: 0 ok, 1 missing/invalid args, 2 file read error, 3 no gold rows labeled.
 */

import { promises as fsp } from 'node:fs';
import type { WeakLabeledRow } from './types.js';
import { CATEGORY_LABELS } from './types.js';
import type { GoldLabel } from './gold/types.js';
import { validateGoldLabel, GOLD_ACTS, GOLD_DECISIONS } from './gold/types.js';

// ---------- Types ----------

export interface JoinedRecord {
  sampleId: string;
  weak: WeakLabeledRow;
  gold: GoldLabel | null;
}

export type FilterId =
  | 'bait_direct_silent'
  | 'sticker_on_non_conversational'
  | 'silent_decision_non_silence_act'
  | 'relay_act_weak_not_relay'
  | 'factterm_no_fact_reply';

export interface FilterHit {
  filterId: FilterId;
  sampleId: string;
  snippet: string;
}

export interface Distributions {
  goldAct: Record<string, number>;
  goldDecision: Record<string, number>;
  factNeeded: { true: number; false: number };
  allowBanter: { true: number; false: number };
  allowSticker: { true: number; false: number };
  totalLabeled: number;
  totalBenchmark: number;
}

export interface CategoryCoverage {
  category: number;
  label: string;
  benchmark: number;
  labeled: number;
  status: 'ok' | 'under' | 'uncovered';
}

export interface ConfusionRow {
  weakAct: string;
  goldAct: string;
  count: number;
}

export interface SummarizeReport {
  distributions: Distributions;
  coverage: CategoryCoverage[];
  confusion: ConfusionRow[];
  suspicious: Record<FilterId, FilterHit[]>;
}

const FILTER_IDS: FilterId[] = [
  'bait_direct_silent',
  'sticker_on_non_conversational',
  'silent_decision_non_silence_act',
  'relay_act_weak_not_relay',
  'factterm_no_fact_reply',
];

const FILTER_HIT_CAP = 20;

// ---------- Loaders (§9) ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceWeakRow(raw: unknown): WeakLabeledRow | null {
  if (!isPlainObject(raw)) return null;
  const { id, category, label, content } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof category !== 'number') return null;
  if (typeof content !== 'string') return null;
  if (!isPlainObject(label)) return null;
  if (typeof label.isRelay !== 'boolean') return null;
  if (typeof label.expectedAct !== 'string') return null;
  return raw as unknown as WeakLabeledRow;
}

export async function loadBenchmark(path: string): Promise<WeakLabeledRow[]> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (e) {
    process.stderr.write(`loadBenchmark: cannot read ${path}: ${String(e)}\n`);
    process.exit(2);
  }
  const out: WeakLabeledRow[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`loadBenchmark: skip malformed JSON at line ${i + 1}\n`);
      continue;
    }
    const row = coerceWeakRow(obj);
    if (!row) {
      process.stderr.write(`loadBenchmark: skip missing required keys at line ${i + 1}\n`);
      continue;
    }
    out.push(row);
  }
  return out;
}

export async function loadGold(path: string): Promise<GoldLabel[]> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (e) {
    process.stderr.write(`loadGold: cannot read ${path}: ${String(e)}\n`);
    process.exit(2);
  }
  const bySampleId = new Map<string, GoldLabel>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`loadGold: skip malformed JSON at line ${i + 1}\n`);
      continue;
    }
    let validated: GoldLabel;
    try {
      validated = validateGoldLabel(obj);
    } catch (e) {
      process.stderr.write(`loadGold: skip invalid row at line ${i + 1}: ${String(e)}\n`);
      continue;
    }
    // Dedup by sampleId, last wins (matches label-gold CLI writer).
    bySampleId.set(validated.sampleId, validated);
  }
  return [...bySampleId.values()];
}

// ---------- Join (§5.2) ----------

export function joinRecords(
  weak: WeakLabeledRow[],
  gold: GoldLabel[],
): JoinedRecord[] {
  const goldMap = new Map<string, GoldLabel>();
  for (const g of gold) goldMap.set(g.sampleId, g);
  return weak.map(w => ({
    sampleId: w.id,
    weak: w,
    gold: goldMap.get(w.id) ?? null,
  }));
}

// ---------- Distributions (§5.3) ----------

function emptyBoolCount(): { true: number; false: number } {
  return { true: 0, false: 0 };
}

export function computeDistributions(joined: JoinedRecord[]): Distributions {
  const goldAct: Record<string, number> = {};
  const goldDecision: Record<string, number> = {};
  const factNeeded = emptyBoolCount();
  const allowBanter = emptyBoolCount();
  const allowSticker = emptyBoolCount();
  let totalLabeled = 0;
  const totalBenchmark = joined.length;

  for (const j of joined) {
    if (j.gold === null) continue;
    totalLabeled++;
    goldAct[j.gold.goldAct] = (goldAct[j.gold.goldAct] ?? 0) + 1;
    goldDecision[j.gold.goldDecision] = (goldDecision[j.gold.goldDecision] ?? 0) + 1;
    if (j.gold.factNeeded) factNeeded.true++; else factNeeded.false++;
    if (j.gold.allowBanter) allowBanter.true++; else allowBanter.false++;
    if (j.gold.allowSticker) allowSticker.true++; else allowSticker.false++;
  }

  return {
    goldAct,
    goldDecision,
    factNeeded,
    allowBanter,
    allowSticker,
    totalLabeled,
    totalBenchmark,
  };
}

// ---------- Coverage (§5.4) ----------

export function computeCoverage(
  joined: JoinedRecord[],
  underThreshold: number,
): CategoryCoverage[] {
  const benchmark = new Array(10).fill(0);
  const labeled = new Array(10).fill(0);
  for (const j of joined) {
    const c = j.weak.category;
    if (c >= 1 && c <= 10) {
      benchmark[c - 1]++;
      if (j.gold !== null) labeled[c - 1]++;
    }
  }
  const out: CategoryCoverage[] = [];
  for (let c = 1; c <= 10; c++) {
    const lb = labeled[c - 1];
    let status: 'ok' | 'under' | 'uncovered';
    if (lb === 0) status = 'uncovered';
    else if (lb < underThreshold) status = 'under';
    else status = 'ok';
    out.push({
      category: c,
      label: CATEGORY_LABELS[c - 1] ?? `cat${c}`,
      benchmark: benchmark[c - 1],
      labeled: lb,
      status,
    });
  }
  return out;
}

// ---------- Confusion (§5.5) ----------

export function computeConfusion(joined: JoinedRecord[]): ConfusionRow[] {
  const counts = new Map<string, number>();
  for (const j of joined) {
    if (j.gold === null) continue;
    const key = `${j.weak.label.expectedAct}\u0000${j.gold.goldAct}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows: ConfusionRow[] = [];
  for (const [key, count] of counts) {
    const [weakAct, goldAct] = key.split('\u0000');
    rows.push({ weakAct: weakAct!, goldAct: goldAct!, count });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

// ---------- Filter predicates (§6) ----------

export function isBaitDirectSilent(j: JoinedRecord): boolean {
  return j.gold !== null
    && j.weak.category === 1
    && j.gold.goldDecision === 'silent';
}

export function isStickerOnNonConversational(j: JoinedRecord): boolean {
  return j.gold !== null
    && j.gold.allowSticker === true
    && (j.gold.goldAct === 'conflict_handle'
      || j.gold.goldAct === 'meta_admin_status'
      || j.gold.goldAct === 'bot_status_query');
}

export function isSilentDecisionNonSilenceAct(j: JoinedRecord): boolean {
  return j.gold !== null
    && j.gold.goldDecision === 'silent'
    && j.gold.goldAct !== 'silence';
}

export function isRelayActWeakNotRelay(j: JoinedRecord): boolean {
  return j.gold !== null
    && j.gold.goldAct === 'relay'
    && j.weak.label.isRelay === false;
}

export function isFacttermNoFactReply(j: JoinedRecord): boolean {
  return j.gold !== null
    && j.weak.category === 2
    && j.gold.factNeeded === false
    && j.gold.goldDecision === 'reply';
}

const PREDICATES: Record<FilterId, (j: JoinedRecord) => boolean> = {
  bait_direct_silent: isBaitDirectSilent,
  sticker_on_non_conversational: isStickerOnNonConversational,
  silent_decision_non_silence_act: isSilentDecisionNonSilenceAct,
  relay_act_weak_not_relay: isRelayActWeakNotRelay,
  factterm_no_fact_reply: isFacttermNoFactReply,
};

export function snippet(raw: string | null | undefined, content: string): string {
  const src = (raw && raw.length > 0 ? raw : content) ?? '';
  const oneline = src.replace(/\s+/g, ' ').trim();
  return oneline.length > 60 ? oneline.slice(0, 57) + '\u2026' : oneline;
}

export function applyFilters(joined: JoinedRecord[]): Record<FilterId, FilterHit[]> {
  const out: Record<FilterId, FilterHit[]> = {
    bait_direct_silent: [],
    sticker_on_non_conversational: [],
    silent_decision_non_silence_act: [],
    relay_act_weak_not_relay: [],
    factterm_no_fact_reply: [],
  };
  for (const j of joined) {
    for (const id of FILTER_IDS) {
      if (out[id].length >= FILTER_HIT_CAP) continue;
      if (PREDICATES[id](j)) {
        out[id].push({
          filterId: id,
          sampleId: j.sampleId,
          snippet: snippet(j.weak.rawContent, j.weak.content),
        });
      }
    }
  }
  return out;
}

// ---------- Report (§5.8) ----------

export function buildReport(
  joined: JoinedRecord[],
  underThreshold: number,
): SummarizeReport {
  return {
    distributions: computeDistributions(joined),
    coverage: computeCoverage(joined, underThreshold),
    confusion: computeConfusion(joined),
    suspicious: applyFilters(joined),
  };
}

// ---------- Renderers (§5.9, §7) ----------

const C_RESET = '\x1b[0m';
const C_HEADER = '\x1b[1;37m';
const C_OK = '\x1b[32m';
const C_UNDER = '\x1b[33m';
const C_UNCOV = '\x1b[31m';
const C_FILTER_HEAD = '\x1b[1;33m';
const C_SAMPLE = '\x1b[36m';

function color(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${C_RESET}` : s;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function sortedEntries(dist: Record<string, number>): Array<[string, number]> {
  return Object.entries(dist).sort((a, b) => b[1] - a[1]);
}

function renderDistTable(
  title: string,
  dist: Record<string, number>,
  total: number,
  useColor: boolean,
): string {
  const lines: string[] = [color(useColor, C_HEADER, `  ${title}`)];
  for (const [label, count] of sortedEntries(dist)) {
    lines.push(`    ${label.padEnd(22)} : ${String(count).padStart(5)} (${pct(count, total)})`);
  }
  return lines.join('\n') + '\n';
}

function renderBoolDist(
  title: string,
  b: { true: number; false: number },
  total: number,
  useColor: boolean,
): string {
  const lines: string[] = [color(useColor, C_HEADER, `  ${title}`)];
  lines.push(`    true                   : ${String(b.true).padStart(5)} (${pct(b.true, total)})`);
  lines.push(`    false                  : ${String(b.false).padStart(5)} (${pct(b.false, total)})`);
  return lines.join('\n') + '\n';
}

export function renderHumanReport(r: SummarizeReport, useColor: boolean): string {
  const d = r.distributions;
  const parts: string[] = [];

  // 1. Header
  parts.push(color(useColor, C_HEADER, '== Gold Sanity Summary =='));
  parts.push(
    `Labeled ${d.totalLabeled} / ${d.totalBenchmark} benchmark rows (${pct(d.totalLabeled, d.totalBenchmark)})`
  );
  parts.push('');

  // 2. Distributions
  parts.push(color(useColor, C_HEADER, '[distributions]'));
  parts.push(renderDistTable('goldAct', d.goldAct, d.totalLabeled, useColor));
  parts.push(renderDistTable('goldDecision', d.goldDecision, d.totalLabeled, useColor));
  parts.push(renderBoolDist('factNeeded', d.factNeeded, d.totalLabeled, useColor));
  parts.push(renderBoolDist('allowBanter', d.allowBanter, d.totalLabeled, useColor));
  parts.push(renderBoolDist('allowSticker', d.allowSticker, d.totalLabeled, useColor));

  // 3. Coverage
  parts.push(color(useColor, C_HEADER, '[coverage]'));
  parts.push('  cat  label                      benchmark  labeled  status');
  for (const row of r.coverage) {
    const code = row.status === 'ok' ? C_OK : row.status === 'under' ? C_UNDER : C_UNCOV;
    const statusText = color(useColor, code, row.status);
    parts.push(
      `  ${String(row.category).padStart(2)}   ${row.label.padEnd(24)}   ${String(row.benchmark).padStart(8)}   ${String(row.labeled).padStart(6)}  ${statusText}`
    );
  }
  parts.push('');

  // 4. Confusion
  parts.push(color(useColor, C_HEADER, '[confusion]'));
  parts.push('  weakAct                goldAct                count');
  if (r.confusion.length === 0) {
    parts.push('  (no labeled rows)');
  } else {
    for (const row of r.confusion) {
      parts.push(
        `  ${row.weakAct.padEnd(22)} ${row.goldAct.padEnd(22)} ${String(row.count).padStart(5)}`
      );
    }
  }
  parts.push('');

  // 5. Suspicious
  parts.push(color(useColor, C_HEADER, '[suspicious]'));
  for (const id of FILTER_IDS) {
    const hits = r.suspicious[id];
    const header = `  [${id}] \u2014 ${hits.length} hits`;
    parts.push(color(useColor, C_FILTER_HEAD, header));
    for (const h of hits) {
      parts.push(`    ${color(useColor, C_SAMPLE, h.sampleId)}  ${h.snippet}`);
    }
    if (hits.length === FILTER_HIT_CAP) {
      parts.push(`    \u2026 capped at ${FILTER_HIT_CAP}; re-run with --json for full list`);
    }
  }

  return parts.join('\n') + '\n';
}

export function renderJsonReport(r: SummarizeReport): string {
  return JSON.stringify(r, null, 2);
}

// ---------- CLI ----------

interface CliArgs {
  gold: string;
  benchmark: string;
  underThreshold: number;
  noColor: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let gold = '';
  let benchmark = '';
  let underThreshold = 20;
  let noColor = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--gold' && args[i + 1]) gold = args[++i]!;
    else if (a === '--benchmark' && args[i + 1]) benchmark = args[++i]!;
    else if (a === '--under-cover-threshold' && args[i + 1]) underThreshold = parseInt(args[++i]!, 10);
    else if (a === '--no-color') noColor = true;
    else if (a === '--json') json = true;
  }

  if (!gold) {
    process.stderr.write('Missing --gold\n');
    process.exit(1);
  }
  if (!benchmark) {
    process.stderr.write('Missing --benchmark\n');
    process.exit(1);
  }
  if (!Number.isFinite(underThreshold) || underThreshold < 0) {
    process.stderr.write('--under-cover-threshold must be non-negative integer\n');
    process.exit(1);
  }

  return { gold, benchmark, underThreshold, noColor, json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const weak = await loadBenchmark(args.benchmark);
  const gold = await loadGold(args.gold);
  if (gold.length === 0) {
    process.stderr.write('No gold rows \u2014 nothing to audit.\n');
    process.exit(3);
  }
  const joined = joinRecords(weak, gold);
  const report = buildReport(joined, args.underThreshold);

  const useColor = !args.noColor && !!process.stderr.isTTY;

  // stderr human view unless caller asked for json-only pipe mode.
  const stderrSilent = args.json && args.noColor;
  if (!stderrSilent) {
    process.stderr.write(renderHumanReport(report, useColor));
  }
  if (args.json) {
    process.stdout.write(renderJsonReport(report) + '\n');
  }
  process.exit(0);
}

// Keep these exports callable from tests; avoid dead-code elimination complaints.
export const _allFilterIds = FILTER_IDS;
export const _allActs = GOLD_ACTS;
export const _allDecisions = GOLD_DECISIONS;

const arg1 = process.argv[1] ?? '';
const isMain = arg1.endsWith('summarize-gold.ts') || arg1.endsWith('summarize-gold.js');
if (isMain) {
  main().catch(e => {
    process.stderr.write(String(e) + '\n');
    process.exit(2);
  });
}
