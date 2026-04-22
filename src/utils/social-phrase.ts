/**
 * R2.5.1 — social-phrase predicate.
 *
 * Distinct from `isEmotivePhrase` (emotive exclamations like 烦/累). These are
 * SOCIAL-gesture phrases that accumulate noise in learned_facts when the slang
 * classifier mis-labels them as group jargon:
 *   - greeting/farewell: 晚安 / 早安 / 晚上好
 *   - affection: 我喜欢你 / 贴贴 / 么么哒 / 抱抱
 *   - address: 宝宝 (fandom-context-specific; exempt when topic is lore)
 *
 * Caller (purge script) pairs this with a lore-topic exemption so e.g. the
 * `宝宝` entry in `data/lore/958751334.md:19` stays active even though it
 * surface-matches this predicate.
 */

export const SOCIAL_PHRASE_ALLOWLIST: ReadonlySet<string> = new Set([
  '我喜欢你',
  '宝宝',
  '晚安',
  '早安',
  '晚上好',
  '贴贴',
  '么么哒',
  '抱抱',
]);

const SOCIAL_PHRASE_RE = /^(?:我喜欢你|宝宝|晚安|早安|晚上好|贴贴|么么哒|抱抱)$/u;

/** True iff `term` is exactly a social-phrase (no substring, no prefix). */
export function isSocialPhrase(term: unknown): boolean {
  if (typeof term !== 'string') return false;
  if (term.length === 0) return false;
  return SOCIAL_PHRASE_RE.test(term);
}
