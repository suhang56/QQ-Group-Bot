import { isValidStructuredTerm, extractTermFromTopic } from './fact-topic-prefixes.js';

/**
 * IMPORTANT: longer alternatives FIRST — "那个" before "那" so "那个羊宫"
 * strips correctly instead of leaving "个羊宫".
 */
const PREFIX_WORDS_RE = /^(?:请问|问一下|问下|所以|那个|这个|顺便问|刚才|那)/u;

/** Prefer trailing ASCII initialism in mixed zh-Latin input ("请问ygfn" → "ygfn"). */
const TRAILING_LATIN_RE = /([A-Za-z][A-Za-z0-9_]{1,19})$/;

/**
 * Trigger interrogative — lazy capture + longer delimiters FIRST.
 * Allows whitespace between term and interrogative ("xtt 是啥").
 * Lazy {2,40}? + "什么意思" / "是什么" / "的意思" BEFORE bare "是谁" / "是啥"
 * prevents "ygfn的意思" being sliced as "ygfn的意思" + "是...".
 */
const TRIGGER_INTERROGATIVE_RE =
  /([\p{L}\p{N}_ ]{2,40}?)\s*(?:什么意思|是什么|的意思|是谁|是啥)/u;

/**
 * Fact definition pattern — lazy + longer delimiters FIRST.
 * "在" included so "xtt在波士顿读书" → "xtt".
 * Lazy {2,20}? + "的意思是" / "就是" BEFORE bare "是" prevents
 * "ygfn的意思是..." being sliced as "ygfn的意思" + "是...".
 */
const FACT_DEFINITION_RE = /^([\p{L}\p{N}_]{2,20}?)\s*(?:的意思是|就是|=|即|指|在|是)/u;

function cleanCandidateTerm(raw: string): string | null {
  let s = raw.trim();
  // If there's a trailing ASCII token, take it — mixed "请问ygfn" → "ygfn".
  const latin = s.match(TRAILING_LATIN_RE);
  if (latin?.[1] && isValidStructuredTerm(latin[1])) return latin[1];
  // Strip common Chinese prefix words once (longer alternatives first in regex).
  s = s.replace(PREFIX_WORDS_RE, '').trim();
  return isValidStructuredTerm(s) ? s : null;
}

/**
 * Derive the best stable term from LLM topic, trigger message, or fact text.
 * Returns null when caller should fall back to topic=null (insert-only).
 *
 * Priority:
 *  1. explicitTopic already has valid structured suffix (from LLM)
 *  2. trigger matches interrogative pattern ("X是谁"/"X 是啥"/"X的意思")
 *  3. factText matches definition pattern ("X=..."/"X是..."/"X在...")
 *  4. null (caller uses topic=null → insert-only, no supersession)
 *
 * Never uses .split(/\s/)[0] — unsafe for Chinese facts with no spaces.
 */
export function deriveFactTerm(args: {
  explicitTopic: string | null;
  trigger: string | null;
  factText: string | null;
}): string | null {
  // Priority 1: LLM already returned a recognized prefix:term
  if (args.explicitTopic) {
    const extracted = extractTermFromTopic(args.explicitTopic);
    if (extracted) return extracted;
  }

  // Priority 2: trigger interrogative
  if (args.trigger) {
    const m = args.trigger.match(TRIGGER_INTERROGATIVE_RE);
    if (m?.[1]) {
      const cleaned = cleanCandidateTerm(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Priority 3: fact definition pattern
  if (args.factText) {
    const m = args.factText.match(FACT_DEFINITION_RE);
    if (m?.[1]) {
      const cleaned = cleanCandidateTerm(m[1]);
      if (cleaned) return cleaned;
    }
  }

  return null;
}
