/**
 * R6.3 — Replay runner core (testable without CLI).
 *
 * Exports:
 *   withTimeout(p, ms)       — Promise.race + setTimeout, t.unref?.() safe
 *   constructChatModule(...) — builds a ChatModule against tmp-copy DB
 *   buildReplayRow(...)      — single source of truth for ReplayRow shape
 *   runReplayRow(...)        — one-sample generate + tag + row build
 *   aggregateSummary(rows)   — rows → ReplaySummary
 *
 * See DEV-READY §2.2, §3.2, §3.3.
 */

import { ChatModule } from '../../src/modules/chat.js';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type { ChatResult } from '../../src/utils/chat-result.js';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import { CATEGORY_LABELS } from './types.js';
import type { GoldAct, GoldLabel } from './gold/types.js';
import { GOLD_ACTS } from './gold/types.js';
import {
  type ComplianceMetric,
  type PerCategoryBreakdown,
  type RateMetric,
  type ReplayerArgs,
  type ReplayResultKind,
  type ReplayRow,
  type ReplaySummary,
  type UtteranceAct,
  RUNNER_VERSION,
} from './replay-types.js';
import {
  ALL_VIOLATION_TAGS,
  DENOMINATOR_RULES,
  computeViolationTags,
  type ProjectedRow,
  type ViolationTag,
} from './violation-tags.js';
import { classifyUtterance } from './classify-utterance.js';

const RESULT_KINDS: ReplayResultKind[] = ['reply', 'sticker', 'fallback', 'silent', 'defer', 'error'];
const UTTERANCE_ACTS: UtteranceAct[] = [...GOLD_ACTS, 'unknown', 'none'];

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeoutP]).finally(() => {
    if (t) clearTimeout(t);
  });
}

/**
 * Build a ChatModule wired for replay: real IClaudeClient stub, real Database
 * (caller supplies a tmp-copy path — NEVER pass the prod DB directly), and
 * every writer-facing source left null. Background timers disabled.
 *
 * DEV-READY §3.2 enumerates the write surfaces stubbed by construction.
 */
export function constructChatModule(args: {
  tmpDbPath: string;
  botQQ: string;
  mockClaude: IClaudeClient;
}): { chat: ChatModule; db: Database } {
  if (!args.tmpDbPath.includes('.tmp') && !args.tmpDbPath.includes('synthetic')) {
    throw new Error(
      `constructChatModule refuses to open a DB path that does not look tmp/synthetic: ${args.tmpDbPath}`,
    );
  }
  const db = new Database(args.tmpDbPath);
  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
  return { chat, db };
}

interface BuildReplayRowArgs {
  sampleId: string;
  category: number;
  gold: GoldLabel;
  triggerMessageId: string;
  result: ChatResult | { kind: 'error'; errorMessage: string };
  durationMs: number;
  violationTags: ViolationTag[];
  utteranceAct: UtteranceAct;
}

/**
 * Single source of truth for ReplayRow shape. Every result-kind branch
 * produces the full ReplayRow with explicit nulls per the §2.1 table. Key
 * order inside the returned object mirrors the interface declaration for
 * stable JSON.stringify diffs.
 */
export function buildReplayRow(args: BuildReplayRowArgs): ReplayRow {
  const {
    sampleId, category, gold, triggerMessageId, result,
    durationMs, violationTags, utteranceAct,
  } = args;

  const base = {
    sampleId,
    category,
    goldAct: gold.goldAct,
    goldDecision: gold.goldDecision,
    factNeeded: gold.factNeeded,
    allowBanter: gold.allowBanter,
    allowSticker: gold.allowSticker,
  };

  if (result.kind === 'error') {
    return {
      ...base,
      resultKind: 'error',
      reasonCode: null,
      utteranceAct: 'none',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: null,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: result.errorMessage,
      durationMs,
    };
  }

  if (result.kind === 'reply') {
    return {
      ...base,
      resultKind: 'reply',
      reasonCode: result.reasonCode,
      utteranceAct,
      guardPath: result.meta.guardPath ?? null,
      targetMsgId: triggerMessageId,
      usedFactHint: result.meta.usedFactHint,
      matchedFactIds: [...result.meta.matchedFactIds],
      injectedFactIds: [...result.meta.injectedFactIds],
      replyText: result.text,
      promptVariant: result.meta.promptVariant ?? null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  if (result.kind === 'sticker') {
    return {
      ...base,
      resultKind: 'sticker',
      reasonCode: result.reasonCode,
      utteranceAct: 'object_react',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: result.cqCode,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  if (result.kind === 'fallback') {
    return {
      ...base,
      resultKind: 'fallback',
      reasonCode: result.reasonCode,
      utteranceAct: 'unknown',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: result.text,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  // silent | defer
  return {
    ...base,
    resultKind: result.kind,
    reasonCode: result.reasonCode,
    utteranceAct: 'none',
    guardPath: null,
    targetMsgId: triggerMessageId,
    usedFactHint: null,
    matchedFactIds: null,
    injectedFactIds: null,
    replyText: null,
    promptVariant: null,
    violationTags: [...violationTags],
    errorMessage: null,
    durationMs,
  };
}

interface RunReplayRowArgs {
  chat: ChatModule;
  groupId: string;
  triggerMessage: GroupMessage;
  recentMessages: GroupMessage[];
  gold: GoldLabel;
  category: number;
  perSampleTimeoutMs: number;
}

/**
 * Run a single replay sample end-to-end: generate via ChatModule, catch any
 * error/timeout, classify, tag, build ReplayRow. Returns the row.
 */
export async function runReplayRow(args: RunReplayRowArgs): Promise<ReplayRow> {
  const start = Date.now();
  let result: ChatResult | { kind: 'error'; errorMessage: string };
  try {
    result = await withTimeout(
      args.chat.generateReply(args.groupId, args.triggerMessage, args.recentMessages),
      args.perSampleTimeoutMs,
    );
  } catch (err) {
    result = { kind: 'error', errorMessage: err instanceof Error ? err.message : String(err) };
  }
  const durationMs = Date.now() - start;

  const utteranceAct: UtteranceAct =
    result.kind === 'error' ? 'none' : classifyUtterance(result);

  const projected: ProjectedRow = {
    category: args.category,
    resultKind: result.kind,
    utteranceAct,
    targetMsgId: result.kind === 'error' ? args.triggerMessage.messageId : args.triggerMessage.messageId,
    matchedFactIds:
      result.kind === 'reply' ? [...result.meta.matchedFactIds] : null,
    replyText:
      result.kind === 'reply' || result.kind === 'fallback'
        ? result.text
        : result.kind === 'sticker'
          ? result.cqCode
          : null,
  };

  const violationTags = computeViolationTags(args.gold, projected, args.triggerMessage.messageId);

  return buildReplayRow({
    sampleId: args.gold.sampleId,
    category: args.category,
    gold: args.gold,
    triggerMessageId: args.triggerMessage.messageId,
    result,
    durationMs,
    violationTags,
    utteranceAct,
  });
}

// ---------- Summary aggregation ----------

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function emptyComplianceMetric(): ComplianceMetric {
  return { denominator: 0, compliant: 0, rate: 0 };
}

function emptyViolationCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ALL_VIOLATION_TAGS) out[t] = 0;
  return out;
}

function emptyActConfusion(): Record<GoldAct, Record<UtteranceAct, number>> {
  const out = {} as Record<GoldAct, Record<UtteranceAct, number>>;
  for (const g of GOLD_ACTS) {
    const inner = {} as Record<UtteranceAct, number>;
    for (const u of UTTERANCE_ACTS) inner[u] = 0;
    out[g] = inner;
  }
  return out;
}

function emptyResultKindDist(): Record<ReplayResultKind, number> {
  const out = {} as Record<ReplayResultKind, number>;
  for (const k of RESULT_KINDS) out[k] = 0;
  return out;
}

function emptyUtteranceActDist(): Record<UtteranceAct, number> {
  const out = {} as Record<UtteranceAct, number>;
  for (const u of UTTERANCE_ACTS) out[u] = 0;
  return out;
}

/**
 * Aggregate a materialized list of ReplayRows into a ReplaySummary.
 * Pure — doesn't touch fs. `goldByKey` is an index of sampleId → GoldLabel
 * built by the runner; used to apply per-tag denominator predicates
 * without needing gold re-read.
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
      const projected: ProjectedRow = {
        category: r.category,
        resultKind: r.resultKind,
        utteranceAct: r.utteranceAct,
        targetMsgId: r.targetMsgId,
        matchedFactIds: r.matchedFactIds,
        replyText: r.replyText,
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

// kept unused exports to satisfy coverage on emptyComplianceMetric (used in tests)
export const __internals = { emptyComplianceMetric };
export type { ReplayerArgs };
