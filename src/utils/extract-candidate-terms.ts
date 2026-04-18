import { extractTokens } from '../modules/honest-gaps.js';
import { hasJailbreakPattern } from './prompt-sanitize.js';

const MAX_CANDIDATES = 3;

/**
 * Extract up to 3 unknown proper-noun-like candidates from a message.
 * Uses extractTokens (same pipeline as honest-gaps) for tokenization, then
 * filters out terms already in learnedFacts (knownFacts set) and rejects
 * jailbreak-pattern tokens for safety.
 *
 * Returns [] when content is empty, CQ-only, or all tokens are known.
 */
export function extractCandidateTerms(
  content: string,
  knownFacts: ReadonlySet<string>,
): string[] {
  const tokens = extractTokens(content);
  const candidates: string[] = [];
  for (const tok of tokens) {
    if (knownFacts.has(tok)) continue;
    if (hasJailbreakPattern(tok)) continue;
    candidates.push(tok);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
