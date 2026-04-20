/**
 * R2.5 SF3 — Bot-not-addressee guard.
 *
 * Predicate only — no state, no regex. Caller supplies four booleans
 * derived from the incoming trigger context, and this function says whether
 * the bot should silently step away because the trigger is NOT addressed to
 * it and has no bot-relevant content:
 *   - not @'d (no CQ:at,qq=<botUserId>)
 *   - not reply-to-bot (no CQ:reply whose target is a recent bot msg)
 *   - no fact term the bot could contribute (no known structured term)
 *   - no bot-status keyword (no "bot 在吗 / 你醒了吗"-style poke)
 *
 * The 你们-in-small-scene filter (existing SF3 companion) reuses
 * `isAddresseeScopeViolation` from `../../utils/sentinel.ts:696` directly —
 * Dev should NOT duplicate that logic here.
 */
export function isBotNotAddresseeReplied(
  isBotAt: boolean,
  isReplyToBot: boolean,
  hasFactTerm: boolean,
  hasBotStatusKeyword: boolean,
): boolean {
  return !isBotAt && !isReplyToBot && !hasFactTerm && !hasBotStatusKeyword;
}
