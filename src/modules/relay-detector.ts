import type { Message } from '../storage/db.js';

export interface RelayDetection {
  kind: 'echo' | 'vote' | 'claim';
  content: string;
  chainLength: number;
}

const VOTE_RE = /^[\+＋][1１]$|^支持$|^同意$|^顶$|^扣1$|^1$/;
const CLAIM_RE = /^(抢|来了|\d+楼|先来|占楼)$/;
const TRAILING_PUNCT_RE = /[.!?,。！？，、]+$/;

function normalizeFullWidth(s: string): string {
  return s.replace(/１/g, '1').replace(/＋/g, '+');
}

function normalize(content: string): string {
  const trimmed = content.trim();
  // Do not strip punctuation from pure-emoji strings (no ASCII/CJK letters)
  const isPureEmoji = !/[\p{L}\p{N}]/u.test(trimmed);
  if (isPureEmoji) return trimmed;
  return trimmed.replace(TRAILING_PUNCT_RE, '');
}

function mostFrequent(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best = items[0];
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) { best = item; bestCount = count; }
  }
  return best;
}

export function detectRelay(
  recentPeerMessages: Message[],
  botSelfUserId: string,
): RelayDetection | null {
  // Filter bot's own messages, then cap to last 10
  const peers = recentPeerMessages
    .filter(m => m.userId !== botSelfUserId)
    .slice(-10);

  if (peers.length < 3) return null;

  const last3 = peers.slice(-3);
  const raw3 = last3.map(m => m.content);
  const norm3 = raw3.map(normalize);

  // Vote detection: checked before echo — vote patterns take priority
  const normFW3 = norm3.map(normalizeFullWidth);
  if (normFW3.every(s => VOTE_RE.test(s))) {
    return { kind: 'vote', content: mostFrequent(raw3), chainLength: 3 };
  }

  // Claim detection: checked before echo — claim patterns take priority
  if (norm3.every(s => CLAIM_RE.test(s))) {
    return { kind: 'claim', content: mostFrequent(raw3), chainLength: 3 };
  }

  // Echo detection: last 3 normalized all equal, 1-2 chars (short tokens only)
  if (norm3[0] === norm3[1] && norm3[1] === norm3[2]) {
    const len = norm3[0].length;
    if (len >= 1 && len <= 2) {
      return { kind: 'echo', content: norm3[0], chainLength: 3 };
    }
  }

  return null;
}
