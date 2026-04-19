import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat8(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.content LIKE '%你他妈%'
        OR m.content LIKE '%草你%'
        OR m.content LIKE '%傻逼%'
        OR m.content LIKE '%废物%'
        OR m.content LIKE '%滚%'
        OR m.content LIKE '%你妈%'
        OR m.content LIKE '%cnm%'
        OR m.content LIKE '%nmsl%'
        OR m.content LIKE '%sb%'
        OR m.content LIKE '%蠢%'
        OR m.content LIKE '%脑子有病%'
        OR m.content LIKE '%找打%'
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
