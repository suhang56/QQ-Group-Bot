/**
 * R2.5 SF1 — Low-info direct-reply dampener (per-(groupId, userId)).
 *
 * State + pure predicate. Runs pre-LLM on the direct path (after pure-@ early
 * return, before vision/LLM). Dampens short repeated @bot/reply-to-bot pokes
 * from the same user within 60s when the new content is ≤6 chars and barely
 * differs from the last trigger — avoids "empathy-echo" loops where the bot
 * keeps saying 烦死了 in response to repeated 不要烦 / 烦啥 pokes.
 *
 * Admin/command hard-bypass is upstream (core/router.ts isSlashCommand gate)
 * BEFORE ChatModule.generateReply is invoked, so SF1 predicates do NOT
 * re-check admin: the caller asserts only peer-chat triggers reach here.
 */
import { BoundedMap } from '../utils/bounded-map.js';

export interface DirectCooldownEntry {
  readonly lastReplyAtSec: number;
  readonly lastContent: string;
}

const DEFAULT_CAPACITY = 500;

export class DirectCooldown {
  private readonly _map: BoundedMap<string, DirectCooldownEntry>;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this._map = new BoundedMap<string, DirectCooldownEntry>(capacity);
  }

  private _key(groupId: string, userId: string): string {
    return `${groupId}:${userId}`;
  }

  get(groupId: string, userId: string): DirectCooldownEntry | undefined {
    return this._map.get(this._key(groupId, userId));
  }

  record(groupId: string, userId: string, content: string, nowSec: number): void {
    this._map.set(this._key(groupId, userId), {
      lastReplyAtSec: nowSec,
      lastContent: content,
    });
  }
}

export interface DampenerOpts {
  windowSec?: number;
  maxLen?: number;
  minDiffChars?: number;
}

const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_MAX_LEN = 6;
const DEFAULT_MIN_DIFF_CHARS = 3;

/**
 * Set-symmetric-difference char count over two short strings. Cheap, no
 * tokenizer. '你好' vs '你好啊' → 1; '烦死了' vs '不要烦' → 4; '你好' vs 'ykn 新单' → 6.
 */
function charDiff(a: string, b: string): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let diff = 0;
  for (const c of setA) if (!setB.has(c)) diff++;
  for (const c of setB) if (!setA.has(c)) diff++;
  return diff;
}

/**
 * Pure. True iff this trigger should be dampened (silent or neutral-ack) per
 * SF1 rules:
 *   - prior direct-reply exists for (groupId, userId)
 *   - nowSec - entry.lastReplyAtSec < windowSec (default 60)
 *   - strippedContent.length ≤ maxLen (default 6)
 *   - charDiff(strippedContent, entry.lastContent) < minDiffChars (default 3)
 *
 * Caller asserts: strippedContent is CQ-stripped and trimmed; admin/command
 * path already returned upstream (no admin re-check here). SF1 is NOT applied
 * when hasFactTerm or isDirectQuestion — caller enforces those exceptions.
 */
export function isRepeatedLowInfoDirectOverreply(
  strippedContent: string,
  entry: DirectCooldownEntry | undefined,
  nowSec: number,
  opts?: DampenerOpts,
): boolean {
  if (!entry) return false;
  const windowSec = opts?.windowSec ?? DEFAULT_WINDOW_SEC;
  const maxLen = opts?.maxLen ?? DEFAULT_MAX_LEN;
  const minDiff = opts?.minDiffChars ?? DEFAULT_MIN_DIFF_CHARS;
  if (nowSec - entry.lastReplyAtSec >= windowSec) return false;
  if (strippedContent.length > maxLen) return false;
  if (charDiff(strippedContent, entry.lastContent) >= minDiff) return false;
  return true;
}

export const NEUTRAL_ACK_POOL = ['嗯', '在', '?', '咋了', '啥'] as const;

export function pickNeutralAck(): string {
  const pool = NEUTRAL_ACK_POOL;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
