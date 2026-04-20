/**
 * R6.3 — Violation tag computation.
 *
 * Pure: no src/ imports, no I/O. Consumes a post-classification projection
 * of a ChatResult alongside the GoldLabel for the sample. Emits 0..10 tags
 * in declaration order (no short-circuit; tags are independent).
 *
 * See DEV-READY §6 and DESIGN-NOTE §4 for the frozen predicate table.
 */

import type { GoldLabel } from './gold/types.js';
import type { ReplayResultKind, UtteranceAct } from './replay-types.js';
import { matchesBanterRegex } from './banter-regex.js';

export type ViolationTag =
  | 'gold-silent-but-replied'
  | 'gold-defer-but-replied'
  | 'direct-at-silenced'
  | 'direct-at-silenced-by-timing'
  | 'direct-at-silenced-by-abuse'
  | 'direct-at-silenced-by-guard'
  | 'fact-needed-no-fact'
  | 'fact-not-needed-used-fact'
  | 'sticker-when-not-allowed'
  | 'banter-when-not-allowed'
  | 'object-react-missed'
  | 'meta-status-misclassified'
  | 'target-mismatch'
  // R2.5 — per-guard silence-success tags (symmetric with direct-at-silenced
  // cause-split). Fire on resultKind==='silent' with the matching row flag.
  | 'repeated-low-info-direct-overreply'
  | 'self-amplified-annoyance'
  | 'group-address-in-small-scene'
  | 'bot-not-addressee-replied';

export const ALL_VIOLATION_TAGS: readonly ViolationTag[] = [
  'gold-silent-but-replied',
  'gold-defer-but-replied',
  'direct-at-silenced',
  'direct-at-silenced-by-timing',
  'direct-at-silenced-by-abuse',
  'direct-at-silenced-by-guard',
  'fact-needed-no-fact',
  'fact-not-needed-used-fact',
  'sticker-when-not-allowed',
  'banter-when-not-allowed',
  'object-react-missed',
  'meta-status-misclassified',
  'target-mismatch',
  'repeated-low-info-direct-overreply',
  'self-amplified-annoyance',
  'group-address-in-small-scene',
  'bot-not-addressee-replied',
] as const;

export interface ProjectedRow {
  category: number;
  resultKind: ReplayResultKind;
  utteranceAct: UtteranceAct;
  targetMsgId: string | null;
  matchedFactIds: number[] | null;
  replyText: string | null;
  /** R2a: per-result reasonCode used by cause-split direct-at-silenced sub-tags. */
  reasonCode: string | null;
  /** R2.5: SF1 direct-low-info dampener fired this turn. */
  dampenerFired: boolean;
  /** R2.5: SF2 self-amplified-annoyance sentinel rejected the candidate. */
  selfEchoFired: boolean;
  /** R2.5: SF3 你们-in-small-scene spectator filter fired. */
  scopeGuardFired: boolean;
  /** R2.5: SF3 bot-not-addressee silent path fired. */
  botNotAddresseeFired: boolean;
}

function isOutputted(k: ReplayResultKind): boolean {
  return k === 'reply' || k === 'sticker' || k === 'fallback';
}

/**
 * Compute frozen-order violation tags for a single row.
 *
 * `triggerMessageId` is the message-id the bot was supposed to respond to
 * (from the benchmark SampledRow). `target-mismatch` compares that against
 * `row.targetMsgId` — fires only when row targetMsgId is non-null,
 * non-empty, AND differs from the trigger.
 */
export function computeViolationTags(
  gold: GoldLabel,
  row: ProjectedRow,
  triggerMessageId: string,
): ViolationTag[] {
  const tags: ViolationTag[] = [];
  const outputted = isOutputted(row.resultKind);
  const factCount = row.matchedFactIds?.length ?? 0;

  if (gold.goldDecision === 'silent' && outputted) tags.push('gold-silent-but-replied');
  if (gold.goldDecision === 'defer' && outputted) tags.push('gold-defer-but-replied');
  if (row.category === 1 && row.resultKind === 'silent') {
    // R2a: aggregate tag kept for overview; cause-split sub-tags are the
    // per-layer KPIs. Only one of by-timing / by-abuse / by-guard fires per
    // row (they partition on disjoint reasonCode values).
    tags.push('direct-at-silenced');
    if (row.reasonCode === 'timing') tags.push('direct-at-silenced-by-timing');
    else if (row.reasonCode === 'bot-triggered') tags.push('direct-at-silenced-by-abuse');
    else if (row.reasonCode === 'guard') tags.push('direct-at-silenced-by-guard');
  }
  if (gold.factNeeded && row.resultKind === 'reply' && factCount === 0) {
    tags.push('fact-needed-no-fact');
  }
  if (gold.factNeeded === false && row.resultKind === 'reply' && factCount > 0) {
    tags.push('fact-not-needed-used-fact');
  }
  if (gold.allowSticker === false && row.resultKind === 'sticker') {
    tags.push('sticker-when-not-allowed');
  }
  if (
    gold.allowBanter === false &&
    row.resultKind === 'reply' &&
    matchesBanterRegex(row.replyText ?? '')
  ) {
    tags.push('banter-when-not-allowed');
  }
  if (gold.goldAct === 'object_react' && row.resultKind === 'reply') {
    tags.push('object-react-missed');
  }
  if (
    gold.goldAct === 'meta_admin_status' &&
    row.resultKind === 'reply' &&
    row.utteranceAct !== 'meta_admin_status'
  ) {
    tags.push('meta-status-misclassified');
  }
  if (
    outputted &&
    row.targetMsgId != null &&
    row.targetMsgId !== '' &&
    row.targetMsgId !== triggerMessageId
  ) {
    tags.push('target-mismatch');
  }

  // R2.5 — per-guard silence-success tags. Fire when the specific guard
  // recorded its firing flag AND the final outcome was silent (silence
  // succeeded). Symmetric with direct-at-silenced-by-timing: we're counting
  // CORRECTLY-silenced rows per cause to track guard prevalence.
  if (row.resultKind === 'silent' && row.dampenerFired) {
    tags.push('repeated-low-info-direct-overreply');
  }
  if (row.resultKind === 'silent' && row.selfEchoFired) {
    tags.push('self-amplified-annoyance');
  }
  if (row.resultKind === 'silent' && row.scopeGuardFired) {
    tags.push('group-address-in-small-scene');
  }
  if (row.resultKind === 'silent' && row.botNotAddresseeFired) {
    tags.push('bot-not-addressee-replied');
  }

  return tags;
}

/**
 * Denominator predicate per tag — rows included in the per-tag rate
 * calculation. See DEV-READY §6.5 / DESIGN-NOTE §2.1.
 */
export const DENOMINATOR_RULES: Record<ViolationTag, (gold: GoldLabel, row: ProjectedRow) => boolean> = {
  'gold-silent-but-replied':   (g) => g.goldDecision === 'silent',
  'gold-defer-but-replied':    (g) => g.goldDecision === 'defer',
  'direct-at-silenced':        (_g, r) => r.category === 1,
  'direct-at-silenced-by-timing': (_g, r) => r.category === 1,
  'direct-at-silenced-by-abuse':  (_g, r) => r.category === 1,
  'direct-at-silenced-by-guard':  (_g, r) => r.category === 1,
  'fact-needed-no-fact':       (g, r) => g.factNeeded === true && r.resultKind === 'reply',
  'fact-not-needed-used-fact': (g, r) => g.factNeeded === false && r.resultKind === 'reply',
  'sticker-when-not-allowed':  (g) => g.allowSticker === false,
  'banter-when-not-allowed':   (g, r) => g.allowBanter === false && r.resultKind === 'reply',
  'object-react-missed':       (g) => g.goldAct === 'object_react',
  'meta-status-misclassified': (g, r) => g.goldAct === 'meta_admin_status' && r.resultKind === 'reply',
  'target-mismatch':           (_g, r) => isOutputted(r.resultKind),
  // R2.5: direct-path guards' denominators mirror direct-at-silenced (category 1).
  'repeated-low-info-direct-overreply': (_g, r) => r.category === 1,
  'bot-not-addressee-replied':          (_g, r) => r.category === 1,
  'group-address-in-small-scene':       (_g, r) => r.category === 1,
  // SF2 runs post-LLM on any reply-or-silent outcome — denominator widens.
  'self-amplified-annoyance':           (_g, r) => r.resultKind === 'reply' || r.resultKind === 'silent',
};
