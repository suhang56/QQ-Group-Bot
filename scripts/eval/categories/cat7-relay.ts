import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

const RELAY_SET = new Set(['1', '2', '3', '扣1', '接龙', '+1', '！', '!', '冲']);

/**
 * R6.1b: narrow echo-relay detection to the 5-message trigger-context window
 * (the same window weak-label.isRelayPattern scans). Previously we scanned
 * ±30s across the entire bulk buffer, which flagged rows that weak-label
 * subsequently marked isRelay=false.
 *
 * Fast-path relay tokens ('1', '扣1', etc.) remain single-row matches.
 */
export function queryCat7(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  // Sort ASC by id for context-window lookups (we need the 5 msgs with id < row.id).
  const byIdAsc = [...candidates].sort((a, b) => a.id - b.id);
  const indexOfId = new Map<number, number>();
  for (let i = 0; i < byIdAsc.length; i++) indexOfId.set(byIdAsc[i]!.id, i);

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const row = candidates[i]!;
    const trimmed = row.content.trim();

    // Fast path: known relay tokens — always qualify.
    if (RELAY_SET.has(trimmed)) {
      result.push(row);
      continue;
    }

    if (trimmed.length < 2) continue;

    // Echo relay: the 5-msg trigger context contains >= 2 rows whose content === trimmed.
    // This matches weak-label.isRelayPattern's contextMatches >= 2 check.
    const ascIdx = indexOfId.get(row.id);
    if (ascIdx === undefined) continue;
    const windowStart = Math.max(0, ascIdx - 5);
    let echoCount = 0;
    for (let j = windowStart; j < ascIdx; j++) {
      if (byIdAsc[j]!.content.trim() === trimmed) {
        echoCount++;
        if (echoCount >= 2) break;
      }
    }
    if (echoCount >= 2) result.push(row);
  }
  return result;
}
