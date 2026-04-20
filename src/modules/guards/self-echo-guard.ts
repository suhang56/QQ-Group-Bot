/**
 * R2.5 SF2 — Self-amplification guard (per-groupId bot-output emotive history).
 *
 * Runs as a post-LLM sentinel. Rejects a new bot candidate containing an
 * EMOTIVE_STEM when ≥2 of the last 3 bot outputs (within a 5-min window)
 * also contain a stem. Mirrors the addressee-scope guard regen-once-then-
 * silent pattern in chat.ts.
 *
 * Echo exemption (Architect Q1): if `candidate` is a substring-echo of the
 * user's trigger content (or the first 3 chars of `candidate` appear inside
 * the trigger), the bot is just echoing the user's phrase — NOT a self-
 * amplification loop. The trigger-side copy keeps the guard from flagging
 * legitimate empathy-quote replies.
 *
 * State footprint: capacity 200 groups × 3 entries = ~600 entries max. Prune
 * happens on read (drops entries older than BOT_EMOTIVE_WINDOW_SEC before
 * returning); record is a plain append + 3-element trim.
 */
import { BoundedMap } from '../../utils/bounded-map.js';
import { EMOTIVE_RE, EMOTIVE_ALLOWLIST } from '../../utils/emotive-stems.js';

export interface BotEmotiveEntry {
  readonly text: string;
  /** unix seconds */
  readonly ts: number;
}

const DEFAULT_CAPACITY = 200;
const MAX_ENTRIES_PER_GROUP = 3;
const BOT_EMOTIVE_WINDOW_SEC = 300; // 5 minutes

export class SelfEchoGuard {
  private readonly _map: BoundedMap<string, BotEmotiveEntry[]>;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this._map = new BoundedMap<string, BotEmotiveEntry[]>(capacity);
  }

  /**
   * Prune-on-read: drops entries older than 5min before returning. Returns
   * the most recent up-to-3 entries (empty if none valid). Never mutates the
   * stored array: we replace it with the pruned copy so later reads skip the
   * expired entries cheaply.
   */
  getRecent(groupId: string, nowSec: number): readonly BotEmotiveEntry[] {
    const arr = this._map.get(groupId);
    if (!arr || arr.length === 0) return [];
    const pruned = arr.filter(e => nowSec - e.ts <= BOT_EMOTIVE_WINDOW_SEC);
    if (pruned.length === arr.length) return arr.slice(-MAX_ENTRIES_PER_GROUP);
    if (pruned.length === 0) {
      this._map.delete(groupId);
      return [];
    }
    this._map.set(groupId, pruned);
    return pruned.slice(-MAX_ENTRIES_PER_GROUP);
  }

  record(groupId: string, text: string, nowSec: number): void {
    const prior = this._map.get(groupId) ?? [];
    const next = [...prior, { text, ts: nowSec }];
    // Retain only the most recent MAX_ENTRIES_PER_GROUP — the guard only
    // inspects the last 3 anyway, so keeping older entries wastes memory.
    const trimmed = next.length > MAX_ENTRIES_PER_GROUP
      ? next.slice(-MAX_ENTRIES_PER_GROUP)
      : next;
    this._map.set(groupId, trimmed);
  }
}

/**
 * Substring-echo check (AQ1). True iff user literally just said this
 * candidate (exact or first-3-char prefix match). Length threshold 3 avoids
 * matching single-character overlaps like just '烦' in a long message — we
 * want to catch "user said 累死了, bot says 累死" kind of echoes.
 */
function isSubstringEchoOfUser(candidate: string, userTrigger: string): boolean {
  if (candidate.length === 0 || userTrigger.length === 0) return false;
  if (userTrigger.includes(candidate)) return true;
  if (candidate.length >= 3 && userTrigger.includes(candidate.slice(0, 3))) return true;
  return false;
}

/**
 * Pure. True iff the candidate should be rejected as self-amplified
 * annoyance:
 *   - candidate matches EMOTIVE_RE
 *   - candidate full string NOT in EMOTIVE_ALLOWLIST (笑死/笑死我/死鬼)
 *   - candidate NOT a substring-echo of the user trigger (AQ1 exemption)
 *   - ≥2 of the last 3 botHistory texts match EMOTIVE_RE
 */
export function isSelfAmplifiedAnnoyance(
  candidate: string,
  botHistory: readonly BotEmotiveEntry[],
  userTriggerContent: string,
): boolean {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (EMOTIVE_ALLOWLIST.has(trimmed)) return false;
  if (!EMOTIVE_RE.test(trimmed)) return false;
  if (isSubstringEchoOfUser(trimmed, userTriggerContent)) return false;
  const last3 = botHistory.slice(-3);
  if (last3.length < 2) return false;
  let matches = 0;
  for (const entry of last3) {
    if (EMOTIVE_RE.test(entry.text)) matches++;
  }
  return matches >= 2;
}
