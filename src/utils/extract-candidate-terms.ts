import { extractTokens } from '../modules/honest-gaps.js';
import { hasJailbreakPattern } from './prompt-sanitize.js';

const MAX_CANDIDATES = 3;

export function extractCandidateTerms(content: string): string[] {
  const tokens = extractTokens(content);
  const candidates: string[] = [];
  for (const tok of tokens) {
    if (hasJailbreakPattern(tok)) continue;
    candidates.push(tok);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
