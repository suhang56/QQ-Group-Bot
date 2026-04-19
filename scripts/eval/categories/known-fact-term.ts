import type { DatabaseSync } from 'node:sqlite';
import type { DbMessageRow } from '../types.js';

/**
 * Checks if any 2-gram or word token from the message content overlaps with
 * known active learned_facts canonical/aliases for the group.
 */
export function hasKnownFactTermInDb(
  db: DatabaseSync,
  row: DbMessageRow,
): boolean {
  const content = row.content.replace(/\[CQ:[^\]]*\]/g, ' ').trim();
  if (!content) return false;

  const tokens = extractTokensSimple(content);
  if (tokens.size === 0) return false;

  const groupId = row.group_id;

  for (const token of tokens) {
    if (token.length < 2) continue;
    const result = db.prepare(
      `SELECT 1 FROM learned_facts
       WHERE group_id = ? AND status = 'active'
         AND (canonical_form LIKE ? OR fact LIKE ?)
       LIMIT 1`
    ).get(groupId, `%${token}%`, `%${token}%`);
    if (result) return true;
  }
  return false;
}

function extractTokensSimple(content: string): Set<string> {
  const clean = content.replace(/\[CQ:[^\]]*\]/g, ' ').trim();
  const result = new Set<string>();
  const segments = clean
    .split(/[\s，。？！、…「」『』【】《》""''【】\u3000]+/)
    .filter(Boolean);
  for (const seg of segments) {
    if (/^[a-z0-9]+$/i.test(seg)) {
      const w = seg.toLowerCase();
      if (w.length > 1) result.add(w);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        result.add(seg.slice(i, i + 2));
      }
    }
  }
  return result;
}
