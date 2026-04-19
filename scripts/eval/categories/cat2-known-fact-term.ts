import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat2(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  const terms = db.prepare(`
    SELECT topic, canonical_form FROM learned_facts
    WHERE group_id = ? AND status = 'active'
    LIMIT 200
  `).all(groupId) as Array<{ topic: string; canonical_form: string | null }>;

  if (terms.length === 0) return [];

  // Build one OR clause per term — avoids the O(N×M) correlated JOIN
  const patterns: string[] = [];
  const bindings: string[] = [];
  for (const t of terms) {
    patterns.push('m.content LIKE ?');
    bindings.push('%' + t.topic + '%');
    if (t.canonical_form) {
      patterns.push('m.content LIKE ?');
      bindings.push('%' + t.canonical_form + '%');
    }
  }

  const sql = `
    SELECT m.* FROM messages m
    WHERE m.group_id = ?
      AND m.deleted = 0
      AND (${patterns.join(' OR ')})
    ORDER BY m.id DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(groupId, ...bindings, limit) as DbRow[];
}
