import { extractTokens } from '../modules/honest-gaps.js';
import { hasJailbreakPattern } from './prompt-sanitize.js';

const MAX_CANDIDATES = 3;

const QUESTION_FRAGMENT_TERMS = new Set([
  '是啥',
  '是谁',
  '是什么',
  '什么意思',
  '啥意思',
  '啥东西',
  '的意思',
  '谁啊',
  '啥啊',
  '什么啊',
]);

const QUESTION_PREFIX_TERMS = new Set([
  '请问',
  '问下',
  '问一下',
  '顺便问',
  '刚才',
]);

function isQuestionScaffolding(tok: string): boolean {
  const s = tok.trim();
  if (!s) return true;
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
