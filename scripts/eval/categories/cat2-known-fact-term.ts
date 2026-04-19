import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

export function queryCat2(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // ORDER BY updated_at DESC: prefer recently-active facts over oldest rows,
  // avoiding coverage bias from default table order on 5k+ fact corpus.
  const terms = db.prepare(`
    SELECT topic, canonical_form FROM learned_facts
    WHERE group_id = ? AND status = 'active'
    ORDER BY updated_at DESC LIMIT 500
  `).all(groupId) as Array<{ topic: string; canonical_form: string | null }>;

  if (terms.length === 0) return [];

  // Build one OR clause per term — avoids the O(N×M) correlated JOIN
  // ESCAPE '!': escape !, %, _ in topic strings so they match literally
  function escapeLike(s: string): string {
    return s.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
  }

  const patterns: string[] = [];
  const bindings: string[] = [];
  for (const t of terms) {
    if (t.topic) {
      patterns.push("m.content LIKE ? ESCAPE '!'");
      bindings.push('%' + escapeLike(t.topic) + '%');
    }
    if (t.canonical_form) {
      patterns.push("m.content LIKE ? ESCAPE '!'");
      bindings.push('%' + escapeLike(t.canonical_form) + '%');
    }
  }

  if (patterns.length === 0) return [];

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
