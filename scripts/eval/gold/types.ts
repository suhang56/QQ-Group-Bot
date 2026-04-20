/**
 * R6.2 gold-label CLI — type contracts.
 *
 * GoldLabel is the human-curated label persisted to data/eval/gold/*.jsonl.
 * Schema frozen per PLAN / DEV-READY §2.
 */

export type GoldAct =
  | 'direct_chat'
  | 'chime_in'
  | 'conflict_handle'
  | 'summarize'
  | 'bot_status_query'
  | 'relay'
  | 'meta_admin_status'
  | 'object_react'
  | 'silence';

export type GoldDecision = 'reply' | 'silent' | 'defer';

export interface GoldLabel {
  sampleId: string;
  goldAct: GoldAct;
  goldDecision: GoldDecision;
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;
  labeledAt: string;
}

export const GOLD_ACTS: readonly GoldAct[] = [
  'direct_chat',
  'chime_in',
  'conflict_handle',
  'summarize',
  'bot_status_query',
  'relay',
  'meta_admin_status',
  'object_react',
  'silence',
] as const;

export const GOLD_DECISIONS: readonly GoldDecision[] = ['reply', 'silent', 'defer'] as const;

export const NOTES_MAX_LEN = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateGoldLabel(raw: unknown): GoldLabel {
  if (!isPlainObject(raw)) {
    throw new Error('GoldLabel: expected object');
  }

  const { sampleId, goldAct, goldDecision, targetOk, factNeeded, allowBanter, allowSticker, notes, labeledAt } = raw;

  if (typeof sampleId !== 'string' || sampleId.length === 0) {
    throw new Error('GoldLabel: sampleId must be non-empty string');
  }
  if (typeof goldAct !== 'string' || !(GOLD_ACTS as readonly string[]).includes(goldAct)) {
    throw new Error(`GoldLabel: goldAct must be one of ${GOLD_ACTS.join('|')}`);
  }
  if (typeof goldDecision !== 'string' || !(GOLD_DECISIONS as readonly string[]).includes(goldDecision)) {
    throw new Error(`GoldLabel: goldDecision must be one of ${GOLD_DECISIONS.join('|')}`);
  }
  if (typeof targetOk !== 'boolean') throw new Error('GoldLabel: targetOk must be boolean');
  if (typeof factNeeded !== 'boolean') throw new Error('GoldLabel: factNeeded must be boolean');
  if (typeof allowBanter !== 'boolean') throw new Error('GoldLabel: allowBanter must be boolean');
  if (typeof allowSticker !== 'boolean') throw new Error('GoldLabel: allowSticker must be boolean');
  if (typeof labeledAt !== 'string' || labeledAt.length === 0) {
    throw new Error('GoldLabel: labeledAt must be non-empty ISO string');
  }
  if (notes !== undefined && typeof notes !== 'string') {
    throw new Error('GoldLabel: notes must be string or undefined');
  }

  const result: GoldLabel = {
    sampleId,
    goldAct: goldAct as GoldAct,
    goldDecision: goldDecision as GoldDecision,
    targetOk,
    factNeeded,
    allowBanter,
    allowSticker,
    labeledAt,
  };
  if (typeof notes === 'string' && notes.length > 0) {
    result.notes = notes;
  }
  return result;
}
