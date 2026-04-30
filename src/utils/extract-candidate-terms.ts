import { extractTokens } from '../modules/honest-gaps.js';
import { hasJailbreakPattern } from './prompt-sanitize.js';

const MAX_CANDIDATES = 3;

// Pure-Chinese query patterns that `extractTokens` leaves as a single big
// token (no ASCII/CJK boundary to split on). Examples:
//   "羊宫妃那是谁"       → token "羊宫妃那是谁"        (should extract "羊宫妃那")
//   "小团体是啥"          → token "小团体是啥"           (should extract "小团体")
//   "羊宫妃那怎么样"   → token "羊宫妃那怎么样"     (should extract "羊宫妃那")
//   "你觉得拉神怎么样" → token "你觉得拉神怎么样"  (should extract "拉神")
// Without this pre-pass, Path A / findActiveByTopicTerm would miss the
// fact, and Path C would web-lookup the entire sentence as a "term".
const CJK_QUERY_SUFFIX_LIST =
  '是谁|是啥|是什么|的意思|什么意思|啥意思|是干啥|是干嘛|怎么样|咋样|如何|怎么说|是谁啊|是啥啊|这个人怎么样|这人怎么样';
const CJK_QUERY_PREFIX_LIST =
  '你觉得|你怎么看|如何评价|如何看待|怎么看待|怎么看|怎么评价|评价一下|点评|点评一下';

// Suffix-only match: 2-10 Han chars + recognised suffix (original shape).
const CJK_QUERY_SUFFIX_RE = new RegExp(
  `^(\\p{Script=Han}{2,10})(?:${CJK_QUERY_SUFFIX_LIST})$`, 'u',
);
// Prefix+term+suffix match: opinion-ask prefix + 2-10 Han chars + recognised
// suffix. Non-greedy on the term capture so the suffix can anchor; without a
// non-greedy quantifier, `\p{Script=Han}{2,10}` would eat into the suffix.
// We REQUIRE both prefix AND suffix to be present in this branch — opinion-ask
// queries without a suffix ("你觉得这条裙子真不错") are statements, not lookups,
// and would over-trigger findActiveByTopicTerm on arbitrary noun phrases.
const CJK_QUERY_PREFIX_SUFFIX_RE = new RegExp(
  `^(?:${CJK_QUERY_PREFIX_LIST})(\\p{Script=Han}{2,10}?)(?:${CJK_QUERY_SUFFIX_LIST})$`, 'u',
);

// Reject sentence-fragment Han terms after prefix-stripping. Tighter than
// fact-topic-prefixes' DIRTY_HAN_TOKEN_RE because we have stronger context
// (already inside an opinion-ask shape) — `怎么样|这个人|这人` are common
// false captures when the suffix happens to overlap a noun-phrase tail.
const DIRTY_HAN_FRAGMENT_RE =
  /(?:是谁|是啥|是什么|什么意思|的意思|牛逼|[吗啊呢嘛哦]|^在|的|这个|那个|怎么样|咋样|如何|怎么说|这个人|这人)/u;

function deriveCjkTerm(content: string): string | null {
  const trimmed = content.trim();
  // Try prefix+term+suffix FIRST so opinion-ask scaffolding (你觉得 / 如何评价 / ...)
  // is stripped before the term capture. Without this, the suffix-only regex
  // would greedy-match e.g. "你觉得拉神" (term) + "怎么样" (suffix) and return
  // a sentence-fragment "term" that fails findActiveByTopicTerm exact-match.
  const mPS = trimmed.match(CJK_QUERY_PREFIX_SUFFIX_RE);
  if (mPS?.[1]) {
    const term = mPS[1];
    if (!DIRTY_HAN_FRAGMENT_RE.test(term) && term.length >= 2) return term;
  }
  // Suffix-only (original supported shape — reached only when no opinion
  // prefix matched, so safe to fall through to greedy term capture).
  const mSuffix = trimmed.match(CJK_QUERY_SUFFIX_RE);
  if (mSuffix?.[1]) return mSuffix[1];
  return null;
}

const QUESTION_FRAGMENT_TERMS = new Set([
  '是啥',
  '是谁',
  '是什么',
  '什么是',
  '什么意思',
  '啥意思',
  '啥东西',
  '的意思',
  '谁啊',
  '啥啊',
  '什么啊',
  // Opinion / evaluation prefixes — if left in the candidate list they'd
  // trigger Path A lookup for meaningless fragments. "如何评价ygfn" should
  // reduce to ["ygfn"], not ["如何评价", "ygfn"].
  '如何评价',
  '如何看待',
  '怎么看',
  '怎么看待',
  '怎么评价',
  '怎么样',
  '你觉得',
  '你怎么看',
  '评价一下',
  '点评',
  '点评一下',
]);

const QUESTION_PREFIX_TERMS = new Set([
  '请问',
  '问下',
  '问一下',
  '顺便问',
  '刚才',
]);

const QUESTION_SCAFFOLDING_TOKEN_RE =
  /^(?:请问|问下|问一下|顺便问|刚才|那个|这个|所以|那)?(?:什么是|是啥|是谁|是什么|什么意思|啥意思|啥东西|的意思|谁啊|啥啊|什么啊|如何评价|如何看待|怎么看|怎么看待|怎么评价|你觉得|你怎么看|评价一下|点评|点评一下)$/u;

function isQuestionScaffolding(tok: string): boolean {
  const s = tok.trim();
  if (!s) return true;
  if (QUESTION_SCAFFOLDING_TOKEN_RE.test(s)) return true;
  if (QUESTION_FRAGMENT_TERMS.has(s)) return true;
  if (QUESTION_PREFIX_TERMS.has(s)) return true;
  return false;
}

export function extractCandidateTerms(content: string): string[] {
  const candidates: string[] = [];

  // Priority pass: pure-Chinese "X是谁 / X怎么样" style queries where the
  // tokenizer would leave the whole sentence as one token. Pull the term
  // out via suffix regex and seed candidates with it first.
  const cjkTerm = deriveCjkTerm(content);
  if (cjkTerm && !hasJailbreakPattern(cjkTerm)) {
    candidates.push(cjkTerm);
  }

  // Fallback pass: regular tokenization + scaffolding filter.
  const tokens = extractTokens(content);
  for (const tok of tokens) {
    if (candidates.includes(tok)) continue;
    if (isQuestionScaffolding(tok)) continue;
    if (hasJailbreakPattern(tok)) continue;
    candidates.push(tok);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
