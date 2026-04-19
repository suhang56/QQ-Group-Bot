import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat10(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND m.raw_content NOT LIKE '%[CQ:at%'
      AND (
        LENGTH(m.content) <= 4
        OR m.content IN ('好', '嗯', '哦', 'ok', 'OK', '收到', '了解', '哦哦', '好的', '嗯嗯', 'hm', 'hmm', '啊', '哈')
        OR (
          SELECT COUNT(*) FROM messages m2
          WHERE m2.group_id = m.group_id
            AND m2.deleted = 0
            AND m2.timestamp > m.timestamp
            AND m2.timestamp <= m.timestamp + 300
        ) = 0
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
