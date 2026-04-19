/** True iff string is non-null and has non-whitespace content. */
export const nonEmptyBlock = (s: string | null | undefined): boolean => !!s?.trim();

export interface FactualContextArgs {
  /**
   * Pass: formatted.matchedFactIds.length > 0
   * NOT !!formatted.text — pinned-newest + recency fallback populate text without a query hit.
   * NOT injectedFactIds.length > 0 — injectedFactIds includes all pinned/recency rows too.
   */
  factsBlockHasRealHit: boolean;
  onDemandFactBlock: string | null;
  webLookupBlock: string | null;
  liveBlock: string | null;
}

/**
 * Returns true when any factual source has real content this turn.
 * All consumers (sticker bypass, voice maxSamples, addressee regen downgrade,
 * confabulation fallback, entityGuard) MUST use this helper — never !!factsBlock.
 */
export function buildFactualContextSignal(args: FactualContextArgs): boolean {
  return args.factsBlockHasRealHit
    || nonEmptyBlock(args.onDemandFactBlock)
    || nonEmptyBlock(args.webLookupBlock)
    || nonEmptyBlock(args.liveBlock);
}
