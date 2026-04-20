/**
 * R6.3 — Banter regex list for `banter-when-not-allowed` tag.
 *
 * Pure: no src/ imports. Tag semantics frozen regardless of pattern set;
 * this list is the R6.3 seed per DESIGN-NOTE §6. FP tolerance documented
 * in DESIGN-NOTE §6.2.
 */

export const BANTER_REGEXES: readonly RegExp[] = [
  // Laugh-density tokens
  /哈哈/,
  /嘿嘿/,
  /嘻嘻/,
  /呵呵/,
  /笑死/,
  /草+(?!泥)/,
  /233+/,

  // Exclamation density
  /[！!]{3,}/,

  // Casual-particle stacks
  /(啊|呀|呢|吧|哦|噢|嘛)\s*[！!。?？]*\s*(啊|呀|呢|吧|哦|噢|嘛)/,

  // Emoji burst
  /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]){3,}/u,

  // Meme stamps
  /\byyds\b/i,
  /绝绝子/,
  /nb啊/i,
  /绝了/,
  /芜湖/,
  /奥利给/,

  // Vowel stretch (e.g. 啊啊啊啊, hmmmm, 哈哈哈哈哈哈哈)
  /(.)\1{3,}/,

  // Bare single-char laugh standalone
  /^\s*(哈|嘻|嘿|呵|笑)\s*$/,
] as const;

export function matchesBanterRegex(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return BANTER_REGEXES.some(re => re.test(text));
}
