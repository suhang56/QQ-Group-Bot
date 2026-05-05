/**
 * CQ:at tag parsing helpers.
 *
 * Used by the addressee-other guard (chat.ts) to deterministically detect
 * whether a trigger is explicitly @-targeting a user that is NOT the bot.
 * Pure structural read — no LLM, no DB. Safe to call before any heavy work.
 *
 * Regex captures `qq=X` where X is any sequence of non-comma, non-`]` chars
 * so it tolerates extra fields like `name=...` after the qq value AND the
 * literal 'all' broadcast token.
 */

const AT_QQ_RE = /\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/g;

/**
 * Extract all @-target QQ values from a raw message.
 *
 * Deduplicated, insertion order preserved (handy for debug logs that show
 * "who was @-ed first"). Returns an empty array when no CQ:at tags exist.
 */
export function parseAtTargets(rawContent: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  AT_QQ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_QQ_RE.exec(rawContent)) !== null) {
    const qq = m[1]!;
    if (!seen.has(qq)) {
      seen.add(qq);
      out.push(qq);
    }
  }
  return out;
}

/**
 * True iff the raw message contains @-mentions, the @-set is exclusively
 * other users (NOT the bot, NOT @all), and botUserId is known.
 *
 * This folds the "bot is among targets" check IN — callers do not need a
 * separate `_isMention` check before reading this.
 *
 *   - botUserId === null → false (fail-open: unknown bot identity never silences)
 *   - @all present → false (broadcast, not directed at any single user)
 *   - bot is among targets → false (bot IS addressee, normal flow)
 *   - any other non-empty CQ:at set → true
 */
export function hasOnlyOtherUserAtMention(
  rawContent: string,
  botUserId: string | null,
): boolean {
  const targets = parseAtTargets(rawContent);
  if (targets.length === 0) return false;
  if (botUserId === null) return false;
  if (targets.includes('all')) return false;
  return !targets.includes(botUserId);
}

/**
 * True iff bot is among CQ:at targets in the raw message.
 *
 * Mirrors `_isMention` semantics; exported so other modules can avoid
 * coupling to ChatModule internals.
 */
export function botIsAtTarget(
  rawContent: string,
  botUserId: string | null,
): boolean {
  if (!botUserId) return false;
  return parseAtTargets(rawContent).includes(botUserId);
}
