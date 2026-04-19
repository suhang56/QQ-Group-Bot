import type { DatabaseSync } from 'node:sqlite';
import type { DbRow } from '../types.js';

const CQ_STRIP_RE = /\[CQ:[^\]]*\]/g;
// Pure-interjection / single-character-repeat junk that the SQL LENGTH>=5 gate
// can't catch after CQ stripping. Note: this is deliberately a heuristic —
// R6.2 gold labelling will refine.
const JUNK_RE = /^[?！!。,、呵哦啊嗯哈嘿嗨g+_\-~～\s]+$/i;

function isJunk(content: string): boolean {
  const stripped = content.replace(CQ_STRIP_RE, '').trim();
  if (stripped.length < 5) return true;
  if (/^[\/!！]/.test(stripped)) return true;           // slash/bang commands
  if (JUNK_RE.test(stripped)) return true;              // pure interjection
  return false;
}

export function queryCat9(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // R6.1b: SQL prefilter keeps LENGTH(content) >= 5, but we re-check post-strip in JS
  // because [CQ:...] codes inflate content length (e.g. '[CQ:face,id=0]g' passes SQL
  // LENGTH but stripped content is 'g').
  const candidates = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND deleted = 0
      AND raw_content NOT LIKE '%[CQ:at%'
      AND content NOT LIKE '%[CQ:image%'
      AND LENGTH(content) >= 5
    ORDER BY id DESC LIMIT ?
  `).all(groupId, limit * 20) as DbRow[];

  const result: DbRow[] = [];
  for (let i = 0; i < candidates.length && result.length < limit; i++) {
    const row = candidates[i]!;
    if (isJunk(row.content)) continue;

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
