import type { DbMessageRow } from '../types.js';

const BOT_AT_RE = /\[CQ:at,qq=(\d+)[^\]]*\]/g;
const REPLY_CQ_RE = /\[CQ:reply,/;

export function isDirectAtReply(
  row: DbMessageRow,
  botUserId: string,
): boolean {
  const c = row.raw_content ?? row.content;
  if (REPLY_CQ_RE.test(c) && BOT_AT_RE.test(c)) return true;
  BOT_AT_RE.lastIndex = 0;
  for (const match of c.matchAll(BOT_AT_RE)) {
    if (match[1] === botUserId) return true;
  }
  return false;
}
