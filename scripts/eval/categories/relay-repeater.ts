import type { DbMessageRow, ContextMsg } from '../types.js';

const RELAY_WINDOW_SEC = 30;
const RELAY_MIN_PEERS = 2;
const VOTE_RE = /^[\+＋1１]$|^支持$|^同意$|^顶$|^扣1$|^1$/;
const CLAIM_RE = /^(抢|来了|\d+楼|先来|占楼)$/;
const TRAILING_PUNCT_RE = /[.!?,。！？，、]+$/;

function normalize(s: string): string {
  return s.replace(/\[CQ:[^\]]*\]/g, '').trim().replace(TRAILING_PUNCT_RE, '');
}

export function isRelayRepeater(
  row: DbMessageRow,
  context: ContextMsg[],
): boolean {
  const thisCleaned = normalize(row.content);
  if (!thisCleaned) return false;

  const windowStart = row.timestamp - RELAY_WINDOW_SEC;
  const recent = context.filter(c => c.timestamp >= windowStart);

  if (VOTE_RE.test(thisCleaned)) {
    const peers = recent.filter(c => VOTE_RE.test(normalize(c.content)));
    return peers.length >= RELAY_MIN_PEERS;
  }
  if (CLAIM_RE.test(thisCleaned)) {
    const peers = recent.filter(c => CLAIM_RE.test(normalize(c.content)));
    return peers.length >= RELAY_MIN_PEERS;
  }

  const len = thisCleaned.length;
  if (len >= 1 && len <= 4) {
    const matches = recent.filter(c => normalize(c.content) === thisCleaned);
    return matches.length >= RELAY_MIN_PEERS;
  }
  return false;
}
