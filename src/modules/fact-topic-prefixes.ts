/**
 * Canonical topic prefixes under which a learned_fact can be stored for a given
 * term. Single source of truth for structured-topic-only supersede.
 *
 * Order matters only for debug readability; SQL IN clause is unordered.
 */
export const LEARNED_FACT_TOPIC_PREFIXES: readonly string[] = [
  'user-taught',
  'opus-classified:slang',
  'opus-classified:fandom',
  'opus-rest-classified:slang',
  'opus-rest-classified:fandom',
  '群内黑话',
  'passive',
  'online-research',
  'ondemand-lookup',
  '群友别名',
];

// Reject sentence-fragment Han terms — grammatical particles + interrogative suffixes.
// `的` anywhere in a pure-Han term rejects (it's a grammatical particle, not a term
// identifier). `^在` rejects start-of-fact "在家里" but won't reject `xtt在波士顿`
// (the Latin-leading path handles that via isValidStructuredTerm Case 1).
const DIRTY_HAN_TOKEN_RE =
  /(?:是谁|是啥|是什么|什么意思|的意思|牛逼|[吗啊呢嘛哦]|^在|的|这个|那个)/u;

/**
 * Single source of truth for "is this a valid structured term suffix?".
 * Three mutually-exclusive cases; mixed-script rejects uniformly.
 *
 * CRITICAL: a naive `/[\p{L}\p{N}_]{2,20}/` would pass "ygfn是谁啊" because
 * \p{L} includes Han. This PR's whole point is to reject those. Bias toward
 * false-negative (topic=null → insert-only) over false-positive (bad supersede).
 */
export function isValidStructuredTerm(term: string): boolean {
  const s = term.trim();
  if (s.length < 2) return false;
  // Case 1: ASCII-leading initialism (ygfn, xtt, lsycx, x1, A_b)
  if (/^[A-Za-z][A-Za-z0-9_]{1,19}$/.test(s)) return true;
  // Case 2: pure alphanumeric/snake_case — ASCII only (120w, 7_11)
  if (/^[0-9A-Za-z_]{2,20}$/.test(s)) return true;
  // Case 3: pure Han 2-10 chars, no sentence-fragment tokens
  if (/^\p{Script=Han}{2,10}$/u.test(s)) {
    if (DIRTY_HAN_TOKEN_RE.test(s)) return false;
    return true;
  }
  return false;
}

/**
 * Returns the suffix term iff topic matches a known prefix AND the term
 * passes isValidStructuredTerm. Used at every read+write boundary.
 */
export function extractTermFromTopic(topic: string | null): string | null {
  if (!topic) return null;
  for (const p of LEARNED_FACT_TOPIC_PREFIXES) {
    if (topic.startsWith(p + ':')) {
      const term = topic.slice(p.length + 1);
      return isValidStructuredTerm(term) ? term : null;
    }
  }
  return null;
}

/**
 * Build the 9 exact topic strings for a given term. Returns [] for dirty terms.
 * findActiveByTopicTerm short-circuits on empty list.
 */
export function topicStringsForTerm(term: string): string[] {
  const s = term.trim();
  if (!isValidStructuredTerm(s)) return [];
  return LEARNED_FACT_TOPIC_PREFIXES.map(p => `${p}:${s}`);
}

/**
 * Trust ranking: lower = higher trust.
 *
 * CRITICAL: gates on extractTermFromTopic first — dirty suffixes like
 * "user-taught:ygfn是谁啊" do NOT get tier 0 just because startsWith matches.
 */
export function trustTierFromTopic(topic: string | null): number {
  if (!topic) return 10;
  if (!extractTermFromTopic(topic)) return 10;
  if (topic.startsWith('user-taught:')) return 0;
  if (topic.startsWith('opus-classified:slang:')) return 1;
  if (topic.startsWith('opus-classified:fandom:')) return 1;
  if (topic.startsWith('opus-rest-classified:slang:')) return 2;
  if (topic.startsWith('opus-rest-classified:fandom:')) return 2;
  if (topic.startsWith('passive:')) return 3;
  if (topic.startsWith('online-research:')) return 3;
  if (topic.startsWith('群内黑话:')) return 4;
  if (topic.startsWith('群友别名:')) return 4;
  if (topic.startsWith('ondemand-lookup:')) return 5;
  return 10;
}

/**
 * Structural interface — avoids reverse dep between db.ts and
 * fact-topic-prefixes.ts. LearnedFact satisfies it structurally.
 */
export interface TrustComparableFact {
  id: number;
  topic: string | null;
  confidence?: number | null;
}

/**
 * Tie-break: tier asc → confidence desc → id desc.
 * Used at both read paths (formatFactsForPrompt dedup + on-demand shortcut).
 */
export function compareFactsByTrust(a: TrustComparableFact, b: TrustComparableFact): number {
  const tierA = trustTierFromTopic(a.topic);
  const tierB = trustTierFromTopic(b.topic);
  if (tierA !== tierB) return tierA - tierB;
  const confA = a.confidence ?? 0;
  const confB = b.confidence ?? 0;
  if (confA !== confB) return confB - confA;
  return b.id - a.id;
}
