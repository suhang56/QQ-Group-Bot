import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat5(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (
        m.content LIKE '%禁言%'
        OR m.content LIKE '%解禁%'
        OR m.content LIKE '%策略%'
        OR m.content LIKE '%小号%'
        OR m.content LIKE '%机器人%'
        OR m.content LIKE '%bot%'
        OR m.content LIKE '%屏蔽%'
        OR m.content LIKE '%沉默%'
        OR m.content LIKE '%为什么不说话%'
        OR m.content LIKE '%你死了%'
        OR m.content LIKE '%你怎么不回%'
      )
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
