import type { DbMessageRow, ContextMsg } from '../types.js';

const BURST_WINDOW_SEC = 15;
const BURST_MIN_COUNT = 5;

/** True if ≥5 messages (including this one) fell in a 15s window, and message is NOT a @bot direct. */
export function isBurstNonDirect(
  row: DbMessageRow,
  context: ContextMsg[],
  botUserId: string,
): boolean {
  const raw = row.raw_content ?? row.content;
  if (raw.includes(`[CQ:at,qq=${botUserId}`)) return false;

  const windowStart = row.timestamp - BURST_WINDOW_SEC;
  const inWindow = context.filter(c => c.timestamp >= windowStart);
  return inWindow.length + 1 >= BURST_MIN_COUNT;
}
