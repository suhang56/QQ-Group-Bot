/**
 * Shared types for R6.1 evaluation sampling pipeline.
 *
 * hasRealFactHit: In R6.1, equals hasKnownFactTerm. Full retrieval (semantic + BM25 ranking)
 * is deferred to R6.3 replay runner — at that point this field will be replaced with the
 * actual output of the retrieval pipeline on the replayed row.
 */

export type ExpectedAct =
  | 'direct_chat'
  | 'chime_in'
  | 'conflict_handle'
  | 'summarize'
  | 'bot_status_query'
  | 'relay'
  | 'meta_admin_status'
  | 'object_react';

export type ExpectedDecision = 'reply' | 'silent' | 'defer';

export interface WeakReplayLabel {
  expectedAct: ExpectedAct;
  expectedDecision: ExpectedDecision;
  hasKnownFactTerm: boolean;
  /** R6.1: set equal to hasKnownFactTerm; true retrieval deferred to R6.3 */
  hasRealFactHit: boolean;
  allowPluralYou: boolean;
  isObjectReact: boolean;
  isBotStatusContext: boolean;
  isBurst: boolean;
  isRelay: boolean;
  isDirect: boolean;
  riskFlags: string[];
}

export interface ContextMessage {
  id: number;
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;
}

export interface SampledRow {
  id: string;                       // `${groupId}:${messageId}` — stable across reruns
  groupId: string;
  messageId: number;                // messages.id
  sourceMessageId: string | null;   // messages.source_message_id
  userId: string;
  nickname: string;
  timestamp: number;                // epoch seconds
  content: string;
  rawContent: string | null;
  triggerContext: ContextMessage[];      // 5 messages preceding (ASC)
  triggerContextAfter: ContextMessage[]; // 3 messages following (ASC)
  category: number;                 // 1–10
  categoryLabel: string;            // human-readable name
  samplingSeed: number;             // the --seed value used
  contentHash: string;              // sha256(content).slice(0,16) — duplicate detection
}

export interface WeakLabeledRow extends SampledRow {
  label: WeakReplayLabel;
}

export interface CategorySummary {
  category: number;
  label: string;
  sampled: number;
  target: number;
  gap: number;
}

export interface SummaryJson {
  generatedAt: number;          // epoch seconds
  seed: number;
  perCategoryTarget: number;
  totalSampled: number;
  categories: CategorySummary[];
  duplicateCount: number;       // rows sharing contentHash with another row
  duplicateRate: number;        // duplicateCount / totalSampled
  emptyContentCount: number;
  malformedCount: number;
}

export const CATEGORY_LABELS: string[] = [
  'direct_at_bot',
  'known_fact_term',
  'rhetorical_banter',
  'image_mface',
  'bot_status_context',
  'burst_nondirect',
  'relay',
  'conflict_heat',
  'normal_chimein',
  'silence_candidate',
];

export interface DbRow {
  id: number;
  group_id: string;
  user_id: string;
  nickname: string;
  content: string;
  raw_content: string | null;
  timestamp: number;
  source_message_id: string | null;
}
