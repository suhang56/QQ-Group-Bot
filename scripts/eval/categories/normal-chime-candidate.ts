import type { DbMessageRow, ContextMsg } from '../types.js';

const IMAGE_CQ_RE = /\[CQ:(?:image|mface|face)[^\]]*\]/;
const MIN_SPEAKERS = 2;

/** Multi-speaker conversation not matching any hotter category — chime-in candidate. */
export function isNormalChimeCandidate(
  row: DbMessageRow,
  context: ContextMsg[],
): boolean {
  const c = row.content.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!c || IMAGE_CQ_RE.test(row.raw_content ?? row.content)) return false;
  const speakerIds = new Set(context.map(m => m.userId));
  speakerIds.add(row.user_id);
  return speakerIds.size >= MIN_SPEAKERS;
}
