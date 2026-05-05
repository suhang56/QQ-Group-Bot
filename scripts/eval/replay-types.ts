/**
 * R6.3 Replay Runner — canonical type definitions.
 *
 * Source of truth for ReplayRow, ReplaySummary, UtteranceAct, ViolationTag,
 * and CLI args. All downstream code types against these — no inline object
 * literals for ReplayRow elsewhere. See DEV-READY §2.
 */

import type { GoldAct, GoldDecision, GoldLabel } from './gold/types.js';
import type { SampledRow } from './types.js';
import type { ChatResult } from '../../src/utils/chat-result.js';

export type { GoldAct, GoldDecision, GoldLabel, SampledRow, ChatResult };

export type ReplayResultKind =
  | 'reply'
  | 'sticker'
  | 'fallback'
  | 'silent'
  | 'defer'
  | 'error';

export type UtteranceAct =
  | GoldAct
  | 'unknown'
  | 'none';

export interface ReplayRow {
  // identity
  sampleId: string;
  category: number;

  // gold echo
  goldAct: GoldAct;
  goldDecision: GoldDecision;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;

  // replay result
  resultKind: ReplayResultKind;
  reasonCode: string | null;
  utteranceAct: UtteranceAct;
  guardPath: string | null;
  targetMsgId: string | null;

  // fact / retrieval signals
  usedFactHint: boolean | null;
  matchedFactIds: number[] | null;
  injectedFactIds: number[] | null;

  // content
  replyText: string | null;
  promptVariant: string | null;

  // diagnostics
  violationTags: string[];
  /**
   * R9 directive layer signal. `null` ONLY on error rows (no ChatResult.meta).
   * `'no-planner-skipped'` literal: env flag OFF, bot-self trigger, or
   * scope-skipped. `'llm-planner'`: Planner returned a validated Directive.
   * `'rule-fallback'`: Planner ran but returned null/invalid → rule fallback.
   */
  plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null;
  errorMessage: string | null;
  durationMs: number;

  // r6.4 — llm token usage (null in mock mode, on error rows where complete()
  // was never reached, or when the runner ran without a real client)
  llmInputTokens: number | null;
  llmOutputTokens: number | null;
  llmCostUsd: number | null;
}

export interface ComplianceMetric {
  denominator: number;
  compliant: number;
  rate: number;
}

export interface RateMetric {
  denominator: number;
  hits: number;
  rate: number;
}

export interface PerCategoryBreakdown {
  category: number;
  label: string;
  rowCount: number;
  silenceDeferCompliance: ComplianceMetric;
  violationCounts: Record<string, number>;
}

export interface ReplaySummary {
  generatedAt: number;
  runnerVersion: string;
  llmMode: 'mock' | 'real' | 'recorded';
  goldPath: string;
  benchmarkPath: string;
  totalRows: number;
  errorRows: number;
  silenceDeferCompliance: ComplianceMetric;
  violationCounts: Record<string, number>;
  violationRates: Record<string, RateMetric>;
  resultKindDist: Record<ReplayResultKind, number>;
  utteranceActDist: Record<UtteranceAct, number>;
  guardPathDist: Record<string, number>;
  reasonCodeDist: Record<string, number>;
  actConfusion: Record<GoldAct, Record<UtteranceAct, number>>;
  perCategory: PerCategoryBreakdown[];

  // r6.4 — real-llm cost summary section. `realLlm: false` for mock/recorded
  // runs; downstream snapshot diffs can suppress drift on real-mode reruns
  // (Gemini is non-deterministic; expect 5-10% violation-rate drift between
  // back-to-back invocations).
  realLlm: boolean;
  totalLlmInputTokens: number;
  totalLlmOutputTokens: number;
  totalLlmCostUsd: number;
  llmErrorCount: number;

  // halt taxonomy: undefined haltReason → ran to completion;
  // 'cost-cap' → real-llm budget hit; 'unhandled-error' → process-level
  // rejection/exception; 'signal' → SIGTERM/SIGHUP/SIGINT;
  // 'retry-budget-exhausted' → consecutive-error cap reached in row loop.
  halted: boolean;
  haltReason?: 'cost-cap' | 'unhandled-error' | 'signal' | 'retry-budget-exhausted';
  // Required: every final summary states completeness explicitly. true on all
  // halt paths; false when the loop completes naturally. Checkpoint summaries
  // (intermediate writes) do not carry this field.
  incomplete: boolean;
  error?: string;     // present when haltReason === 'unhandled-error'
  signal?: string;    // present when haltReason === 'signal'
}

export interface ReplayerArgs {
  goldPath: string;
  benchmarkPath: string;
  outputDir: string;
  llmMode: 'mock' | 'real' | 'recorded';
  limit: number | null;
  prodDbPath: string;
  botQQ: string;
  groupIdForReplay: string;
  perSampleTimeoutMs: number;

  // r6.4 — real-llm overrides (null = use env / config default)
  maxCostUsd: number | null;
  rateLimitRps: number | null;
  retryMax: number | null;

  // r7 — halt run after N consecutive resultKind='error' rows. null = disabled.
  // Default 5 set in parseArgs. Counter resets on first non-error row.
  maxConsecutiveErrors: number | null;
}

export interface IReplayCounters {
  processed: number;
  errors: number;
  compliantSoFar: number;
  silentDeferDenomSoFar: number;
}

export const RUNNER_VERSION = 'r6.4.0';
