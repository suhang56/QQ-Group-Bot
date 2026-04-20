/**
 * Shared negative-emotive stem list — canonical source for is-emotive-phrase
 * (single-phrase predicate) and self-echo-guard (bot-self-amplification
 * sentinel). Keep this list conservative: it is used by a post-LLM sentinel
 * that REJECTS bot candidates containing any of these stems when bot history
 * already has 2/3 matches, so a false positive here costs a regeneration.
 */
export const EMOTIVE_STEMS = ['烦', '气', '累', '困', '崩', '麻', '无语', '哭'] as const;

/** Substring-match any EMOTIVE_STEM. Stateless; safe to reuse. */
export const EMOTIVE_RE: RegExp = new RegExp(EMOTIVE_STEMS.join('|'));

/**
 * Whole-string escape hatch: idioms/set phrases that LOOK emotive but read as
 * playful (笑死 = 'died laughing'). `isEmotivePhrase` checks this with
 * `.has(s)` BEFORE the structural regexes, and SelfEchoGuard predicate must
 * never flag a candidate whose full stripped form is in this set.
 */
export const EMOTIVE_ALLOWLIST: ReadonlySet<string> = new Set(['笑死', '笑死我', '死鬼']);
