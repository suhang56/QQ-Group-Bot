import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat6(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // Bulk-fetch candidates then apply JS-side sliding window — avoids O(N²) correlated subquery
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const t = candidates[i]!.timestamp;
    let count = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (j !== i && Math.abs(candidates[j]!.timestamp - t) <= 15) count++;
    }
    // >= 4 other messages in ±15s window
    if (count >= 4) result.push(candidates[i]!);
  }
  return result;
}
