/**
 * Shared types for R6.1 / R6.1a evaluation sampling pipeline.
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

/**
 * R6.1b: matches the 7 recall sources scanned by queryCat2 (cat2-known-fact-term).
 * `null` when no source matched. Priority when multiple sources match:
 *   topic > canonical > persona > fact > meme > jargon > phrase.
 */
export type KnownFactSource =
  | 'topic'
  | 'canonical'
  | 'persona'
  | 'fact'
  | 'meme'
  | 'jargon'
  | 'phrase'
  | null;

export interface WeakReplayLabel {
  expectedAct: ExpectedAct;
  expectedDecision: ExpectedDecision;
  hasKnownFactTerm: boolean;
  /** R6.1b: which of the 7 cat2 recall sources matched, or null. */
  knownFactSource: KnownFactSource;
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
  /** R6.2.2: raw_content column for CQ-aware display; null when not backfilled. */
  rawContent: string | null;
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
  contextHash: string;              // sha256(trigger.content + context.before[].content.join).slice(0,16)
}

export interface WeakLabeledRow extends SampledRow {
  label: WeakReplayLabel;
}

export interface OrganicFactShortfall {
  expected: number;
  actual: number;
  gap: number;
}

export interface CategorySummary {
  category: number;
  label: string;
  sampled: number;
  target: number;
  gap: number;
  /** Only present for cat2 (known_fact_term) */
  organicFactShortfall?: OrganicFactShortfall;
}

export interface DuplicateMetric {
  count: number;
  rate: number;
}

export interface EmptySplit {
  emptyBecauseMediaOnly: number;
  emptyWithoutMedia: number;
}

/** R6.1a: overlap matrix — how many msgs in catA would also have matched catB (before primary-priority assignment). */
export type CategoryOverlapMatrix = Record<number, Record<number, number>>;

export interface SummaryJson {
  generatedAt: number;          // epoch seconds
  seed: number;
  perCategoryTarget: number;
  totalSampled: number;
  totalLabeled: number;
  categories: CategorySummary[];
  /** R6.1a: replaces old duplicateCount/duplicateRate */
  duplicates: {
    sameMessageId: DuplicateMetric;
    sameContentHash: DuplicateMetric;
    sameContextHash: DuplicateMetric;
  };
  /** R6.1a: empty content split */
  empty: EmptySplit;
  malformedCount: number;
  /** R6.1a: category overlap matrix (before primary-priority dedupe) */
  categoryOverlap: CategoryOverlapMatrix;
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

/** Priority order for primary-category assignment (index 0 = highest priority). */
export const CATEGORY_PRIORITY_ORDER: number[] = [1, 5, 2, 4, 7, 8, 6, 3, 9, 10];

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
