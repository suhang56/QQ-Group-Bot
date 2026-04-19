import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat9(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // Bulk-fetch candidates then apply JS-side distinct-speaker window — avoids O(N³) correlated subquery
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
      AND raw_content NOT LIKE '%[CQ:at%'
      AND content NOT LIKE '%[CQ:image%'
      AND LENGTH(content) >= 5
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const row = candidates[i]!;
    const windowStart = row.timestamp - 120;
    const windowEnd = row.timestamp + 30;
    const speakers = new Set<string>();
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j]!;
      if (c.timestamp >= windowStart && c.timestamp <= windowEnd) {
        speakers.add(c.user_id);
      }
    }
    if (speakers.size >= 3) result.push(row);
  }
  return result;
}
