/**
 * PR1: sticker token output guard — pure predicate.
 *
 * `stripStickerTokens` is strip-only: it never substitutes replacement text.
 * Replacement policy (silent vs partial-strip) lives in the SendGuardChain
 * owner — keeping this module a pure predicate prevents future callers from
 * quietly introducing fallback strings.
 */

const STRIP_RE = /<?sticker:\d+>?/gu;
const TOKEN_ONLY_RE = /^\s*<?sticker:\d+>?\s*$/u;

export interface StripResult {
  stripped: string;
  hadToken: boolean;
  wasTokenOnly: boolean;
}

export function stripStickerTokens(text: string): StripResult {
  const wasTokenOnly = TOKEN_ONLY_RE.test(text);
  const hadToken = /<?sticker:\d+>?/u.test(text);
  const stripped = hadToken ? text.replace(STRIP_RE, '').trim() : text;
  return { stripped, hadToken, wasTokenOnly };
}
