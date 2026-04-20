#!/usr/bin/env tsx
/**
 * R6.2.3 gold sanity audit — read-only.
 *
 * Reads gold JSONL + matching benchmark-weak-labeled JSONL and prints four
 * sections to stderr: distributions, coverage, weak-vs-gold disagreement,
 * and five suspicious-row filters. Stdout is intentionally unused; a future
 * --json flag (DESIGN-NOTE §7) would emit a machine-readable digest there.
 *
 * Known non-bug: weak labels have no `silence` value in ExpectedAct, so gold
 * rows with goldAct=silence always appear as disagreement cells. This is
 * intentional — see DESIGN-NOTE §9.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { CATEGORY_LABELS } from './types.js';
import type { GoldLabel, GoldAct, GoldDecision } from './gold/types.js';
import { validateGoldLabel, GOLD_ACTS } from './gold/types.js';
import { readSamples, type SampleRecord } from './gold/reader.js';

// ---------- Types ----------

export interface JoinedRow {
  sampleId: string;
  sample: SampleRecord;
  gold: GoldLabel;
  category: number;
  categoryLabel: string;
}

export interface LoadResult {
  joined: JoinedRow[];
  orphanedGoldIds: string[];
  goldTotal: number;
  benchTotal: number;
}

export type FilterName =
  | 'bait_silent'
  | 'sticker_on_meta_act'
  | 'silent_with_nonsilence_act'
  | 'relay_mismatch'
  | 'cat2_fact_denied_reply';

export interface FilterHit {
  sampleId: string;
  snippet: string;
}

const FILTER_ORDER: FilterName[] = [
  'bait_silent',
  'sticker_on_meta_act',
  'silent_with_nonsilence_act',
  'relay_mismatch',
  'cat2_fact_denied_reply',
];

const PER_FILTER_CAP = 20;
const UNDER_THRESHOLD = 20;
const RULE = '\u2500'.repeat(78);

// ---------- Gold loader (§5.2) ----------

export async function loadGold(path: string): Promise<GoldLabel[]> {
  let stream;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch (e) {
    process.stderr.write(`[loadGold] cannot open ${path}: ${String(e)}\n`);
    process.exit(1);
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const bySampleId = new Map<string, GoldLabel>();
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[loadGold] malformed JSON at line ${lineNo} — skipped\n`);
        continue;
      }
      let validated: GoldLabel;
      try {
        validated = validateGoldLabel(parsed);
      } catch (e) {
        const sid =
          typeof parsed === 'object' && parsed !== null && typeof (parsed as { sampleId?: unknown }).sampleId === 'string'
            ? (parsed as { sampleId: string }).sampleId
            : '<no-id>';
        process.stderr.write(`[loadGold] invalid row (sampleId=${sid}) at line ${lineNo}: ${String(e)}\n`);
        continue;
      }
      bySampleId.set(validated.sampleId, validated);
    }
  } finally {
    rl.close();
    stream.close();
  }
  return [...bySampleId.values()];
}

// ---------- Join (§5.3) ----------

export function join(bench: SampleRecord[], gold: GoldLabel[]): LoadResult {
  const benchById = new Map<string, SampleRecord>();
  for (const s of bench) benchById.set(s.sampleId, s);
  const joined: JoinedRow[] = [];
  const orphanedGoldIds: string[] = [];
  for (const g of gold) {
    const s = benchById.get(g.sampleId);
    if (!s) {
      orphanedGoldIds.push(g.sampleId);
      continue;
    }
    const category = typeof (s as unknown as { category: unknown }).category === 'number'
      ? (s as unknown as { category: number }).category
      : 0;
    joined.push({
      sampleId: g.sampleId,
      sample: s,
      gold: g,
      category,
      categoryLabel: CATEGORY_LABELS[category - 1] ?? '?',
    });
  }
  return { joined, orphanedGoldIds, goldTotal: gold.length, benchTotal: bench.length };
}

// ---------- Snippet helper (§11.3) ----------

function stripCQ(raw: string): string {
  return raw.replace(/\[CQ:[^\]]+\]/g, '').trim();
}

export function makeSnippet(triggerContent: string): string {
  const stripped = stripCQ(triggerContent);
  const noNewline = stripped.replace(/\r?\n/g, '\u23ce');
  const collapsed = noNewline.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? collapsed.slice(0, 59) + '\u2026' : collapsed;
}

// ---------- Filter predicates (§11.1) ----------

export function isBaitSilent(r: JoinedRow): boolean {
  return r.category === 1 && r.gold.goldDecision === 'silent';
}

export function isStickerOnMetaAct(r: JoinedRow): boolean {
  return r.gold.allowSticker === true
    && (r.gold.goldAct === 'conflict_handle'
      || r.gold.goldAct === 'meta_admin_status'
      || r.gold.goldAct === 'bot_status_query');
}

export function isSilentWithNonsilenceAct(r: JoinedRow): boolean {
  return r.gold.goldDecision === 'silent' && r.gold.goldAct !== 'silence';
}

export function isRelayMismatch(r: JoinedRow): boolean {
  return r.gold.goldAct === 'relay' && r.sample.weakLabel.isRelay === false;
}

export function isCat2FactDeniedReply(r: JoinedRow): boolean {
  return r.category === 2 && r.gold.factNeeded === false && r.gold.goldDecision === 'reply';
}

const PREDICATES: Record<FilterName, (r: JoinedRow) => boolean> = {
  bait_silent: isBaitSilent,
  sticker_on_meta_act: isStickerOnMetaAct,
  silent_with_nonsilence_act: isSilentWithNonsilenceAct,
  relay_mismatch: isRelayMismatch,
  cat2_fact_denied_reply: isCat2FactDeniedReply,
};

// ---------- Section 1 — Distributions (§8) ----------

export function renderDistributions(joined: JoinedRow[]): string[] {
  const actCounts: Record<GoldAct, number> = {
    direct_chat: 0, chime_in: 0, conflict_handle: 0, summarize: 0,
    bot_status_query: 0, relay: 0, meta_admin_status: 0, object_react: 0, silence: 0,
  };
  const decisionCounts: Record<GoldDecision, number> = { reply: 0, silent: 0, defer: 0 };
  const bools = {
    factNeeded: { t: 0, f: 0 },
    allowBanter: { t: 0, f: 0 },
    allowSticker: { t: 0, f: 0 },
  };
  for (const r of joined) {
    actCounts[r.gold.goldAct]++;
    decisionCounts[r.gold.goldDecision]++;
    if (r.gold.factNeeded) bools.factNeeded.t++; else bools.factNeeded.f++;
    if (r.gold.allowBanter) bools.allowBanter.t++; else bools.allowBanter.f++;
    if (r.gold.allowSticker) bools.allowSticker.t++; else bools.allowSticker.f++;
  }

  const lines: string[] = ['SECTION 1 — DISTRIBUTIONS', ''];
  lines.push(' goldAct:');
  for (const act of GOLD_ACTS) {
    lines.push(`   ${act.padEnd(18)} ${String(actCounts[act])}`);
  }
  lines.push('');
  lines.push(' goldDecision:');
  const decisionOrder: GoldDecision[] = ['reply', 'silent', 'defer'];
  for (const dec of decisionOrder) {
    lines.push(`   ${dec.padEnd(18)} ${String(decisionCounts[dec])}`);
  }
  lines.push('');
  lines.push(' booleans (true / false):');
  lines.push(`   factNeeded         ${bools.factNeeded.t} / ${bools.factNeeded.f}`);
  lines.push(`   allowBanter        ${bools.allowBanter.t} / ${bools.allowBanter.f}`);
  lines.push(`   allowSticker       ${bools.allowSticker.t} / ${bools.allowSticker.f}`);
  return lines;
}

// ---------- Section 2 — Coverage (§9) ----------

export function renderCoverage(joined: JoinedRow[], orphanedCount: number): string[] {
  const perCat = new Array<number>(10).fill(0);
  for (const r of joined) {
    if (r.category >= 1 && r.category <= 10) perCat[r.category - 1]++;
  }
  const lines: string[] = ['SECTION 2 — COVERAGE MATRIX', ''];
  for (let c = 1; c <= 10; c++) {
    const n = perCat[c - 1]!;
    const catCol = c < 10 ? `cat ${c} ` : `cat${c} `;
    const label = (CATEGORY_LABELS[c - 1] ?? '?').padEnd(22);
    const nCol = `N=${String(n).padStart(4)}`;
    let status: string;
    if (n === 0) status = '!! UNCOVERED';
    else if (n < UNDER_THRESHOLD) status = '!! under';
    else status = 'ok';
    lines.push(` ${catCol} ${label} ${nCol}  ${status}`);
  }
  lines.push('');
  lines.push(`-- total labeled=${joined.length} orphaned=${orphanedCount}`);
  return lines;
}

// ---------- Section 3 — Disagreement (§10) ----------

export function sortDisagreementRows(
  rows: Array<{ weak: string; gold: string; count: number }>,
): Array<{ weak: string; gold: string; count: number }> {
  return [...rows].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.weak !== b.weak) return a.weak < b.weak ? -1 : 1;
    if (a.gold !== b.gold) return a.gold < b.gold ? -1 : 1;
    return 0;
  });
}

export function renderDisagreement(joined: JoinedRow[]): string[] {
  const counts = new Map<string, { weak: string; gold: string; count: number }>();
  for (const r of joined) {
    const weak = r.sample.weakLabel.expectedAct;
    const gold = r.gold.goldAct;
    const key = `${weak}\u0000${gold}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { weak, gold, count: 1 });
  }
  const sorted = sortDisagreementRows([...counts.values()]);
  const lines: string[] = ['SECTION 3 — WEAK vs GOLD DISAGREEMENT', ''];
  lines.push(' expectedAct     →  goldAct                 count');
  for (const row of sorted) {
    const weakCol = row.weak.padEnd(14);
    const goldCol = row.gold.padEnd(20);
    const countCol = String(row.count).padStart(6);
    lines.push(` ${weakCol} → ${goldCol} ${countCol}`);
  }
  const total = joined.length;
  const diag = sorted.filter(r => r.weak === r.gold).reduce((s, r) => s + r.count, 0);
  const pct = total === 0 ? '0.0' : ((diag / total) * 100).toFixed(1);
  lines.push('');
  lines.push(` agreement = ${diag} / ${total}  (${pct}%)`);
  return lines;
}

// ---------- Section 4 — Suspicious (§11) ----------

export function renderSuspicious(joined: JoinedRow[]): string[] {
  const lines: string[] = [
    'SECTION 4 — SUSPICIOUS ROWS (five filters; row may appear in >1)',
    '',
  ];
  let first = true;
  for (const name of FILTER_ORDER) {
    if (!first) lines.push('');
    first = false;
    const pred = PREDICATES[name];
    const hits: FilterHit[] = [];
    let total = 0;
    for (const r of joined) {
      if (!pred(r)) continue;
      total++;
      if (hits.length < PER_FILTER_CAP) {
        hits.push({ sampleId: r.sampleId, snippet: makeSnippet(r.sample.triggerContent) });
      }
    }
    lines.push(`[${name}]  N=${total}`);
    if (hits.length === 0) continue;
    const idWidth = hits.reduce((m, h) => Math.max(m, h.sampleId.length), 0);
    for (const h of hits) {
      lines.push(`  ${h.sampleId.padEnd(idWidth)}  ${h.snippet}`);
    }
    const extra = total - hits.length;
    if (extra > 0) lines.push(`  \u2026 +${extra} more`);
  }
  return lines;
}

// ---------- CLI ----------

interface CliArgs {
  gold: string;
  benchmark: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let gold = '';
  let benchmark = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--gold' && args[i + 1]) gold = args[++i]!;
    else if (a === '--benchmark' && args[i + 1]) benchmark = args[++i]!;
  }
  if (!gold) {
    process.stderr.write('Missing --gold\n');
    process.exit(1);
  }
  if (!benchmark) {
    process.stderr.write('Missing --benchmark\n');
    process.exit(1);
  }
  return { gold, benchmark };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const bench: SampleRecord[] = [];
  try {
    for await (const s of readSamples(args.benchmark)) bench.push(s);
  } catch (e) {
    process.stderr.write(`[readSamples] cannot read ${args.benchmark}: ${String(e)}\n`);
    process.exit(1);
  }

  const gold = await loadGold(args.gold);
  const { joined, orphanedGoldIds, goldTotal } = join(bench, gold);

  const orphanSuffix = orphanedGoldIds.length > 0 ? ` orphaned=${orphanedGoldIds.length}` : '';
  process.stderr.write(
    `SUMMARIZE-GOLD  gold=${args.gold}  benchmark=${args.benchmark}  rows=${joined.length}/${goldTotal}${orphanSuffix}\n`,
  );

  const sections: string[][] = [
    renderDistributions(joined),
    renderCoverage(joined, orphanedGoldIds.length),
    renderDisagreement(joined),
    renderSuspicious(joined),
  ];
  for (const lines of sections) {
    process.stderr.write('\n' + RULE + '\n');
    for (const ln of lines) process.stderr.write(ln + '\n');
  }
  process.exit(0);
}

const arg1 = process.argv[1] ?? '';
const isMain = arg1.endsWith('summarize-gold.ts') || arg1.endsWith('summarize-gold.js');
if (isMain) {
  main().catch(e => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
  });
}
