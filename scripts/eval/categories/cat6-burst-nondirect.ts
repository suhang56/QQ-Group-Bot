import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat6(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND m.id IN (
        SELECT m2.id
        FROM messages m2
        WHERE m2.group_id = ?
          AND m2.deleted = 0
          AND (
            SELECT COUNT(*) FROM messages m3
            WHERE m3.group_id = m2.group_id
              AND m3.deleted = 0
              AND m3.timestamp BETWEEN m2.timestamp - 15 AND m2.timestamp + 15
              AND m3.id != m2.id
          ) >= 4
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, groupId, limit) as DbRow[];
}
