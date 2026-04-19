import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat2(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  return db.prepare(`
    SELECT DISTINCT m.*
    FROM messages m
    JOIN learned_facts lf
      ON lf.group_id = m.group_id
      AND lf.status = 'active'
      AND (
        m.content LIKE '%' || lf.topic || '%'
        OR (lf.canonical_form IS NOT NULL AND m.content LIKE '%' || lf.canonical_form || '%')
      )
    WHERE m.group_id = ?
      AND m.deleted = 0
    ORDER BY m.id DESC
    LIMIT ?
  `).all(groupId, limit) as DbRow[];
}
