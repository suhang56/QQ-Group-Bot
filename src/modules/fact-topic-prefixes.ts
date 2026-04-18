/**
 * The six canonical topic prefixes under which a learned_fact can be stored
 * for a given term. Every term-scoped lookup (findActiveByTopicTerm) and the
 * miner candidate validator import from here — single source of truth.
 *
 * Order matters only for debug readability; SQL IN clause is unordered.
 */
export const LEARNED_FACT_TOPIC_PREFIXES = [
  'user-taught',
  'opus-classified:slang',
  'opus-classified:fandom',
  'opus-rest-classified:slang',
  'opus-rest-classified:fandom',
  '群内黑话',
] as const;

export type LearnedFactTopicPrefix = typeof LEARNED_FACT_TOPIC_PREFIXES[number];

/** Build the 6 exact topic strings for a given term (suffix = term, no mutation). */
export function topicStringsForTerm(
  term: string,
): [string, string, string, string, string, string] {
  return LEARNED_FACT_TOPIC_PREFIXES.map(p => `${p}:${term}`) as
    [string, string, string, string, string, string];
}
