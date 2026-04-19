import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat7(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.content IN ('1', '2', '3', '扣1', '接龙', '+1', '！', '!', '冲')
        OR (
          SELECT COUNT(*) FROM messages m2
          WHERE m2.group_id = m.group_id
            AND m2.deleted = 0
            AND m2.content = m.content
            AND ABS(m2.timestamp - m.timestamp) <= 30
            AND m2.id != m.id
            AND LENGTH(m.content) >= 2
        ) >= 2
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
