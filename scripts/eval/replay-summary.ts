/**
 * R6.3 — ReplaySummary aggregation (pure; no src/ imports).
 *
 * Split from replay-runner-core.ts per DEV-READY §11 LoC budget. Consumes a
 * materialized list of ReplayRows plus a sampleId → GoldLabel index (for
 * per-tag denominator predicates) and emits the frozen ReplaySummary shape
 * documented in DESIGN-NOTE §2.
 */

import { CATEGORY_LABELS } from './types.js';
import type { GoldAct, GoldLabel } from './gold/types.js';
import { GOLD_ACTS } from './gold/types.js';
import {
  ALL_VIOLATION_TAGS,
  DENOMINATOR_RULES,
  type ProjectedRow,
} from './violation-tags.js';
import {
  type ComplianceMetric,
  type PerCategoryBreakdown,
  type RateMetric,
  type ReplayResultKind,
  type ReplayRow,
  type ReplaySummary,
  type UtteranceAct,
  RUNNER_VERSION,
} from './replay-types.js';

const RESULT_KINDS: ReplayResultKind[] = ['reply', 'sticker', 'fallback', 'silent', 'defer', 'error'];
const UTTERANCE_ACTS: UtteranceAct[] = [...GOLD_ACTS, 'unknown', 'none'];

export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

export function emptyComplianceMetric(): ComplianceMetric {
  return { denominator: 0, compliant: 0, rate: 0 };
}

export function emptyViolationCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ALL_VIOLATION_TAGS) out[t] = 0;
  return out;
}

export function emptyActConfusion(): Record<GoldAct, Record<UtteranceAct, number>> {
  const out = {} as Record<GoldAct, Record<UtteranceAct, number>>;
  for (const g of GOLD_ACTS) {
    const inner = {} as Record<UtteranceAct, number>;
    for (const u of UTTERANCE_ACTS) inner[u] = 0;
    out[g] = inner;
  }
  return out;
}

export function emptyResultKindDist(): Record<ReplayResultKind, number> {
  const out = {} as Record<ReplayResultKind, number>;
  for (const k of RESULT_KINDS) out[k] = 0;
  return out;
}

export function emptyUtteranceActDist(): Record<UtteranceAct, number> {
  const out = {} as Record<UtteranceAct, number>;
  for (const u of UTTERANCE_ACTS) out[u] = 0;
  return out;
}

/**
 * Aggregate a materialized list of ReplayRows into a ReplaySummary.
 * Pure — doesn't touch fs. `goldByKey` is an index of sampleId → GoldLabel
 * built by the runner; used to apply per-tag denominator predicates without
 * re-reading gold.
 */
export function aggregateSummary(args: {
  rows: ReplayRow[];
  goldByKey: Map<string, GoldLabel>;
  llmMode: 'mock' | 'real' | 'recorded';
  goldPath: string;
  benchmarkPath: string;
}): ReplaySummary {
  const { rows, goldByKey, llmMode, goldPath, benchmarkPath } = args;
  const totalRows = rows.length;
  const errorRows = rows.filter(r => r.resultKind === 'error').length;

  // ---- silenceDeferCompliance (DEV-READY §6.6, excludes error) ----
  const sdRows = rows.filter(r => {
    if (r.resultKind === 'error') return false;
    return r.goldDecision === 'silent' || r.goldDecision === 'defer';
  });
  const sdDen = sdRows.length;
  const sdCompliant = sdRows.filter(r => r.resultKind === 'silent' || r.resultKind === 'defer').length;
  const silenceDeferCompliance: ComplianceMetric = {
    denominator: sdDen,
    compliant: sdCompliant,
    rate: round4(sdDen === 0 ? 0 : sdCompliant / sdDen),
  };

  // ---- violationCounts ----
  const violationCounts = emptyViolationCounts();
  for (const r of rows) {
    for (const t of r.violationTags) {
      if (t in violationCounts) violationCounts[t] = (violationCounts[t] ?? 0) + 1;
    }
  }

  // ---- violationRates (per-tag denominator) ----
  const violationRates: Record<string, RateMetric> = {};
  for (const tag of ALL_VIOLATION_TAGS) {
    const rule = DENOMINATOR_RULES[tag];
    let denom = 0;
    let hits = 0;
    for (const r of rows) {
      const gold = goldByKey.get(r.sampleId);
      if (!gold) continue;
      // R2.5: reconstruct per-guard fired flags from stored reasonCode /
      // guardPath (same derivation as replay-runner-core's live projection).
      const rc = r.reasonCode ?? null;
      const gp = r.guardPath ?? null;
      const projected: ProjectedRow = {
        category: r.category,
        resultKind: r.resultKind,
        utteranceAct: r.utteranceAct,
        targetMsgId: r.targetMsgId,
        matchedFactIds: r.matchedFactIds,
        replyText: r.replyText,
        reasonCode: rc,
        dampenerFired: rc === 'dampener' || rc === 'dampener-ack',
        selfEchoFired: rc === 'self-echo' || gp === 'self-echo-regen',
        scopeGuardFired: rc === 'scope' && gp === 'addressee-regen',
        botNotAddresseeFired: rc === 'scope' && gp !== 'addressee-regen',
      };
      if (!rule(gold, projected)) continue;
      denom++;
      if (r.violationTags.includes(tag)) hits++;
    }
    violationRates[tag] = {
      denominator: denom,
      hits,
      rate: round4(denom === 0 ? 0 : hits / denom),
    };
  }

  // ---- distributions ----
  const resultKindDist = emptyResultKindDist();
  const utteranceActDist = emptyUtteranceActDist();
  const guardPathDist: Record<string, number> = {};
  const reasonCodeDist: Record<string, number> = {};
  for (const r of rows) {
    resultKindDist[r.resultKind]++;
    utteranceActDist[r.utteranceAct]++;
    const gkey = r.guardPath ?? 'none';
    guardPathDist[gkey] = (guardPathDist[gkey] ?? 0) + 1;
    const rkey = r.reasonCode ?? 'none';
    reasonCodeDist[rkey] = (reasonCodeDist[rkey] ?? 0) + 1;
  }

  // ---- actConfusion ----
  const actConfusion = emptyActConfusion();
  for (const r of rows) {
    actConfusion[r.goldAct][r.utteranceAct]++;
  }

  // ---- perCategory ----
  const perCategoryMap = new Map<number, ReplayRow[]>();
  for (const r of rows) {
    const arr = perCategoryMap.get(r.category) ?? [];
    arr.push(r);
    perCategoryMap.set(r.category, arr);
  }
  const perCategory: PerCategoryBreakdown[] = [];
  const sortedCats = [...perCategoryMap.keys()].sort((a, b) => a - b);
  for (const cat of sortedCats) {
    const catRows = perCategoryMap.get(cat) ?? [];
    const catSdRows = catRows.filter(r => {
      if (r.resultKind === 'error') return false;
      return r.goldDecision === 'silent' || r.goldDecision === 'defer';
    });
    const catSdDen = catSdRows.length;
    const catSdCompliant = catSdRows.filter(
      r => r.resultKind === 'silent' || r.resultKind === 'defer',
    ).length;
    const catVc = emptyViolationCounts();
    for (const r of catRows) {
      for (const t of r.violationTags) {
        if (t in catVc) catVc[t] = (catVc[t] ?? 0) + 1;
      }
    }
    perCategory.push({
      category: cat,
      label: CATEGORY_LABELS[cat - 1] ?? '?',
      rowCount: catRows.length,
      silenceDeferCompliance: {
        denominator: catSdDen,
        compliant: catSdCompliant,
        rate: round4(catSdDen === 0 ? 0 : catSdCompliant / catSdDen),
      },
      violationCounts: catVc,
    });
  }

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    runnerVersion: RUNNER_VERSION,
    llmMode,
    goldPath,
    benchmarkPath,
    totalRows,
    errorRows,
    silenceDeferCompliance,
    violationCounts,
    violationRates,
    resultKindDist,
    utteranceActDist,
    guardPathDist,
    reasonCodeDist,
    actConfusion,
    perCategory,
  };
}
