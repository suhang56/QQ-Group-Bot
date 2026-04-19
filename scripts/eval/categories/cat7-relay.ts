import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

const RELAY_SET = new Set(['1', '2', '3', '扣1', '接龙', '+1', '！', '!', '冲']);

export function queryCat7(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // Bulk-fetch candidates then apply JS-side relay detection — avoids O(N²) correlated subquery
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const row = candidates[i]!;
    const trimmed = row.content.trim();

    // Fast path: known relay tokens
    if (RELAY_SET.has(trimmed)) {
      result.push(row);
      continue;
    }

    // Echo relay: same content appears >= 2 other times within ±30s
    if (trimmed.length >= 2) {
      let echoCount = 0;
      for (let j = 0; j < candidates.length; j++) {
        if (j !== i
          && candidates[j]!.content.trim() === trimmed
          && Math.abs(candidates[j]!.timestamp - row.timestamp) <= 30) {
          echoCount++;
          if (echoCount >= 2) break;
        }
      }
      if (echoCount >= 2) result.push(row);
    }
  }
  return result;
}
