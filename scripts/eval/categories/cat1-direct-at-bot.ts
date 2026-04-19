import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat1(db: DatabaseSync, groupId: string, botQQ: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.content LIKE '%[CQ:at,qq=' || ? || '%'
        OR m.raw_content LIKE '%[CQ:at,qq=' || ? || '%'
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, botQQ, botQQ, limit) as DbRow[];
}
