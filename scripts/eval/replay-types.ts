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
  errorMessage: string | null;
  durationMs: number;
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
}

export interface IReplayCounters {
  processed: number;
  errors: number;
  compliantSoFar: number;
  silentDeferDenomSoFar: number;
}

export const RUNNER_VERSION = 'r6.3.0';
