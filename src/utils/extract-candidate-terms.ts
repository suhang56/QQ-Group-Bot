import { extractTokens } from '../modules/honest-gaps.js';
import { hasJailbreakPattern } from './prompt-sanitize.js';

const MAX_CANDIDATES = 3;

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
  '怎么评价',
  '怎么样',
  '你觉得',
  '你怎么看',
]);

const QUESTION_PREFIX_TERMS = new Set([
  '请问',
  '问下',
  '问一下',
  '顺便问',
  '刚才',
]);

const QUESTION_SCAFFOLDING_TOKEN_RE =
  /^(?:请问|问下|问一下|顺便问|刚才|那个|这个|所以|那)?(?:什么是|是啥|是谁|是什么|什么意思|啥意思|啥东西|的意思|谁啊|啥啊|什么啊|如何评价|如何看待|怎么看|怎么评价|你觉得|你怎么看)$/u;

function isQuestionScaffolding(tok: string): boolean {
  const s = tok.trim();
  if (!s) return true;
  if (QUESTION_SCAFFOLDING_TOKEN_RE.test(s)) return true;
  if (QUESTION_FRAGMENT_TERMS.has(s)) return true;
  if (QUESTION_PREFIX_TERMS.has(s)) return true;
  return false;
}

export function extractCandidateTerms(content: string): string[] {
  const tokens = extractTokens(content);
  const candidates: string[] = [];
  for (const tok of tokens) {
    if (isQuestionScaffolding(tok)) continue;
    if (hasJailbreakPattern(tok)) continue;
    candidates.push(tok);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
