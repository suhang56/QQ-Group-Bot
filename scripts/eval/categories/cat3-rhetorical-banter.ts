import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat3(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.content LIKE '%啥情况%'
        OR m.content LIKE '%怎么回事%'
        OR m.content LIKE '%搞什么%'
        OR m.content LIKE '%这是%啊%'
        OR m.content LIKE '%什么鬼%'
        OR m.content LIKE '%wtf%'
        OR m.content LIKE '%服了%'
        OR m.content LIKE '%无语%'
        OR m.content LIKE '%离谱%'
        OR m.content LIKE '%哈哈%'
        OR m.content LIKE '%哈哈哈%'
        OR m.content LIKE '%笑死%'
      )
      AND m.content NOT LIKE '%[CQ:image%'
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
