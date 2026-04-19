import type { DbMessageRow, ContextMsg } from '../types.js';

const MIN_SINGLE_SPEAKER_WINDOW = 5;

/** Single-speaker monologue or no entities present — silence is appropriate. */
export function isSilenceCandidate(
  row: DbMessageRow,
  context: ContextMsg[],
): boolean {
  const c = row.content.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!c) return true;
  const speakerIds = new Set(context.map(m => m.userId));
  if (speakerIds.size === 0) return true;
  if (speakerIds.size === 1 && context.length >= MIN_SINGLE_SPEAKER_WINDOW) return true;
  return false;
}
