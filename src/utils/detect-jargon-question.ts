const CQ_RE = /\[CQ:[^\]]+\]/g;

// TERM capture group: 2-10 non-whitespace, non-bracket chars.
// ^ and $ anchors prevent partial-sentence matches.
// Trailing [啊呀？]? allows natural-language softeners without requiring them.
const PATTERNS: RegExp[] = [
  /^(?<term>[^\s\[]{2,10})是啥(意思|来的|东西)?[啊呀？]?$/u,
  /^(?<term>[^\s\[]{2,10})是什么(意思|东西)?[啊呀？]?$/u,
  /^啥是(?<term>[^\s\[]{2,10})[啊呀？]?$/u,
  /^(?<term>[^\s\[]{2,10})什么意思[啊呀？]?$/u,
  /^(?<term>[^\s\[]{2,10})是干嘛的[啊呀？]?$/u,
  /^(?<term>[^\s\[]{2,10})啥来的[啊呀？]?$/u,
  /^解释一下(?<term>[^\s\[]{2,10})[啊呀？]?$/u,
];

// Pre-seeded with common Chinese words that are not group jargon.
// Dev may expand this list based on false-positive reports from group testing.
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  '这个', '那个', '什么', '怎么', '哪里', '为什么', '谁', '哪个',
  '今天', '昨天', '明天', '东西', '东东', '事情', '这里', '那里',
]);

export function stripCqCodes(content: string): string {
  return content.replace(CQ_RE, '').trim();
}

/**
 * Returns the queried jargon term, or null.
 *
 * Null cases (documented intentionally — do not "fix"):
 * - No pattern matched: message is not a jargon question.
 * - Term is in COMMON_WORDS: everyday vocabulary, not group slang.
 * - Term is in knownTerms: already in learned_facts; existing fact-injection path handles it.
 * - CQ-only content: nothing left after strip.
 *
 * CJK word-boundary note: ^ and $ anchors plus [^\s\[]+ correctly bound
 * CJK terms because Chinese sentences have no inter-character spaces.
 * The 2-char minimum rejects single-character questions like "啥是的".
 * Pinyin mixed (e.g. "xtt是啥"): ASCII chars are matched by [^\s\[]+ normally.
 */
export function detectJargonQuestion(
  content: string,
  knownTerms: ReadonlySet<string>,
): string | null {
  const stripped = stripCqCodes(content);
  if (!stripped) return null;

  for (const pat of PATTERNS) {
    const m = pat.exec(stripped);
    if (m?.groups?.['term']) {
      const term = m.groups['term'];
      if (COMMON_WORDS.has(term)) return null;
      if (knownTerms.has(term)) return null;
      return term;
    }
  }
  return null;
}
