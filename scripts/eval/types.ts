#!/usr/bin/env tsx
/**
 * Shared types for the R6.1 evaluation sampling pipeline.
 */

export const CONTEXT_BEFORE = 5;
export const CONTEXT_AFTER = 3;

export type SamplingCategory =
  | 'direct_at_reply'
  | 'known_fact_term'
  | 'rhetorical_banter'
  | 'image_mface'
  | 'bot_status_context'
  | 'burst_non_direct'
  | 'relay_repeater'
  | 'conflict_heat'
  | 'normal_chime_candidate'
  | 'silence_candidate';

export const ALL_CATEGORIES: SamplingCategory[] = [
  'direct_at_reply',
  'known_fact_term',
  'rhetorical_banter',
  'image_mface',
  'bot_status_context',
  'burst_non_direct',
  'relay_repeater',
  'conflict_heat',
  'normal_chime_candidate',
  'silence_candidate',
];

export interface ContextMsg {
  messageId: string;
  userId: string;
  nickname: string;
  timestamp: number;
  content: string;
  rawContent: string;
}

export interface BenchmarkRow {
  id: string;
  groupId: string;
  messageId: string;
  userId: string;
  nickname: string;
  timestamp: number;
  content: string;
  rawContent: string;
  triggerContext: ContextMsg[];
  triggerContextAfter: ContextMsg[];
  category: SamplingCategory;
  samplingSeed: string;
}

export type ExpectedAct =
  | 'direct_chat'
  | 'chime_in'
  | 'conflict_handle'
  | 'summarize'
  | 'bot_status_query'
  | 'meta_admin_status'
  | 'object_react'
  | 'relay';

export type ExpectedDecision = 'reply' | 'silent' | 'defer';

export interface WeakReplayLabel {
  expectedAct: ExpectedAct;
  expectedDecision: ExpectedDecision;
  hasKnownFactTerm: boolean;
  hasRealFactHit: boolean;
  allowPluralYou: boolean;
  isObjectReact: boolean;
  isBotStatusContext: boolean;
  isBurst: boolean;
  isRelay: boolean;
  isDirect: boolean;
  riskFlags: string[];
}

export interface LabeledBenchmarkRow extends BenchmarkRow {
  label: WeakReplayLabel;
}

export interface CategoryStats {
  sampled: number;
  labeled: number;
  target: number;
}

export interface SummaryJson {
  generatedAt: string;
  samplingSeed: string;
  sourceDb: string;
  totalSampled: number;
  totalLabeled: number;
  perCategory: Record<SamplingCategory, CategoryStats>;
  duplicateRate: {
    byContentHash: number;
    duplicateCount: number;
  };
  dataQuality: {
    emptyContent: number;
    malformedRows: number;
    missingContext: number;
    missingContextAfter: number;
  };
  gaps: {
    undersampled: Array<{
      category: SamplingCategory;
      sampled: number;
      target: number;
      shortfall: number;
    }>;
  };
}

export interface SamplingConfig {
  seed: string;
  perCategoryTarget: number;
  outputDir: string;
  dbPath: string;
  botUserId?: string;
}

/** Row as returned directly from the DB messages query */
export interface DbMessageRow {
  id: number;
  group_id: string;
  user_id: string;
  nickname: string;
  content: string;
  raw_content: string | null;
  timestamp: number;
  source_message_id: string | null;
}
