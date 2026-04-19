import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat4(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.raw_content LIKE '%[CQ:image%'
        OR m.raw_content LIKE '%[CQ:mface%'
        OR m.raw_content LIKE '%[CQ:face%'
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
