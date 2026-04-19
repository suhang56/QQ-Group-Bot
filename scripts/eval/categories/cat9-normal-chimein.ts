import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

// Pure-interjection / single-character-repeat junk that SQL can't cheaply
// express (multi-char Unicode char-class). Applied only to SQL-prefiltered rows.
const JUNK_RE = /^[?！!。,、呵哦啊嗯哈嘿嗨g+_\-~～\s]+$/i;
const CQ_STRIP_RE = /\[CQ:[^\]]*\]/g;

/**
 * R6.1b: junk filter pushed into SQL where feasible (reviewer preference —
 * avoids materializing junk rows into JS).
 *
 * SQL gates:
 *  - raw_content NOT LIKE '%[CQ:at%' — non-direct chime-in
 *  - content NOT LIKE '%[CQ:image%' — image rows belong to cat4
 *  - content NOT LIKE '/%' — slash commands
 *  - content NOT LIKE '!%' / '！%' — bang commands
 *  - LENGTH(content) >= 5 — minimum raw length
 *
 * JS post-filter (narrow — only what SQL can't do cheaply):
 *  - CQ-stripped length >= 5 (CQ codes inflate raw LENGTH; [CQ:face,id=0]g
 *    passes SQL gate but stripped content is 'g')
 *  - JUNK_RE: multi-char Unicode interjection/repeat patterns
 */
export function queryCat9(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
      AND raw_content NOT LIKE '%[CQ:at%'
      AND content NOT LIKE '%[CQ:image%'
      AND content NOT LIKE '/%'
      AND content NOT LIKE '!%'
      AND content NOT LIKE '！%'
      AND LENGTH(content) >= 5
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const row = candidates[i]!;

    const stripped = row.content.replace(CQ_STRIP_RE, '').trim();
    if (stripped.length < 5) continue;
    if (JUNK_RE.test(stripped)) continue;

    const windowStart = row.timestamp - 120;
    const windowEnd = row.timestamp + 30;
    const speakers = new Set<string>();
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j]!;
      if (c.timestamp >= windowStart && c.timestamp <= windowEnd) {
        speakers.add(c.user_id);
      }
    }
    if (speakers.size >= 3) result.push(row);
  }
  return result;
}
