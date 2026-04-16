/**
 * Comprehension Scorer: estimates how well the bot "understands" a message
 * before deciding whether to engage. Score 0-1 where higher = more understood.
 *
 * Signals used:
 * - Jargon/lore/alias hit count from known vocabulary
 * - Message length heuristic (very short = ambiguous, mid-length = normal)
 * - CJK character ratio (gibberish detection)
 *
 * Does NOT use embedding similarity (too slow for pre-decision gate).
 * Kept simple and synchronous for minimal latency.
 */

import { createLogger } from '../utils/logger.js';
import { tokenizeLore } from '../utils/text-tokenize.js';

const logger = createLogger('comprehension-scorer');

export interface ComprehensionContext {
  /** Known lore keywords for this group */
  readonly loreKeywords: ReadonlySet<string>;
  /** Known jargon terms for this group */
  readonly jargonTerms: ReadonlyArray<string>;
  /** Alias map keys for this group */
  readonly aliasKeys: ReadonlyArray<string>;
}

/**
 * Score how well the bot can comprehend a message given group context.
 * Returns 0-1 where:
 * - 0.0 = completely unknown content (gibberish/undefined slang)
 * - 0.3 = threshold below which we consider "low comprehension"
 * - 1.0 = fully recognized vocabulary
 *
 * Design principle: DEFAULT IS HIGH COMPREHENSION (0.7). The score only
 * drops below 0.3 when the message contains tokens that positively look
 * like group-specific slang/abbreviations that aren't in any dictionary.
 * Normal everyday messages always pass the gate.
 *
 * Positive indicators of "unknown domain term":
 * - Short ASCII abbreviations (2-6 chars) not in vocabulary
 * - Katakana strings (anime/game terms)
 * - Tokens that appear in the group's jargon_candidates with is_jargon=0
 *   (miner saw it but couldn't classify it)
 */
export function scoreComprehension(
  messageContent: string,
  context: ComprehensionContext,
): number {
  const content = messageContent.trim();
  if (!content) return 0;

  // Very short messages (<=4 chars) are always comprehensible enough
  if (content.length <= 4) return 0.6;

  const tokens = tokenizeLore(content);
  if (tokens.size === 0) return 0.5;

  let domainHits = 0;
  let unknownDomainLike = 0;

  for (const token of tokens) {
    const lower = token.toLowerCase();

    // Check all domain vocabularies
    const isDomainKnown =
      context.loreKeywords.has(lower) ||
      context.loreKeywords.has(token) ||
      context.jargonTerms.some(j => j === lower || lower.includes(j) || j.includes(lower)) ||
      context.aliasKeys.some(a => a === lower || lower.includes(a) || a.includes(lower));

    if (isDomainKnown) {
      domainHits++;
      continue;
    }

    // Only flag as "unknown domain" if the token looks like slang/abbreviation:
    // 1. Short ASCII abbreviation (2-4 consonant-heavy chars) — catches "ykn", "ras", "mjk"
    //    but NOT normal English words like "fire", "bird", "chat" which contain vowels
    // 2. Contains katakana (Japanese loanword / game term)
    const isAscii24 = /^[a-zA-Z]{2,4}$/.test(token);
    const looksLikeAbbr = isAscii24 && !COMMON_ASCII.has(lower) && !hasVowelPattern(lower);
    const hasKatakana = /[\u30A0-\u30FF]/.test(token);
    if (looksLikeAbbr || hasKatakana) {
      unknownDomainLike++;
    }
    // CJK tokens are NOT flagged — too many false positives on everyday words
  }

  // Default: high comprehension
  if (unknownDomainLike === 0) {
    return domainHits > 0 ? 1.0 : 0.7;
  }

  // Scale down based on ratio of unknown to known domain terms
  const unknownRatio = unknownDomainLike / Math.max(1, domainHits + unknownDomainLike);
  const score = Math.max(0, 1.0 - unknownRatio * 1.2);

  const gibberishPenalty = hasGibberishPattern(content) ? 0.4 : 0;
  const finalScore = Math.max(0, Math.min(1, score - gibberishPenalty));

  logger.debug({
    content: content.slice(0, 50),
    domainHits,
    unknownDomainLike,
    score: +finalScore.toFixed(2),
  }, 'comprehension scored');

  return finalScore;
}

/**
 * Safe wrapper around scoreComprehension: catches any unexpected error
 * (e.g. from future embedding integration or bad tokenizer input) and
 * returns a skip-favoring default (0.3) so the engagement gate fails safe.
 */
export function scoreComprehensionSafe(
  messageContent: string,
  context: ComprehensionContext,
): { score: number; reason?: string } {
  try {
    return { score: scoreComprehension(messageContent, context) };
  } catch (err) {
    logger.warn({ err }, 'comprehension scoring failed, defaulting to low');
    return { score: 0.3, reason: 'scoring-error' };
  }
}

// Common short ASCII words that are NOT domain abbreviations.
// Keep this conservative — only add words that would cause false positives
// in the "unknown domain slang" detection.
const COMMON_ASCII = new Set([
  'ok', 'no', 'yes', 'hi', 'lol', 'omg', 'wtf', 'gg', 'qq', 'ww',
  'haha', 'hehe', 'orz', 'qaq', 'ovo', 'uwu', 'qwq', 'emm', 'hmm',
  // Common English 2-4 letter words
  'the', 'is', 'it', 'to', 'in', 'on', 'at', 'so', 'oh', 'my',
  'too', 'get', 'but', 'not', 'can', 'how', 'why', 'who', 'what',
  'for', 'are', 'was', 'you', 'had', 'has', 'him', 'her', 'its',
  'let', 'may', 'new', 'now', 'old', 'our', 'out', 'own', 'say',
  'she', 'two', 'way', 'all', 'any', 'day', 'did', 'few', 'got',
  'his', 'man', 'one', 'see', 'use', 'do', 'go', 'if', 'me', 'up',
  'an', 'as', 'be', 'by', 'he', 'or', 'us', 'we', 'am',
  'and', 'the', 'for', 'are', 'but', 'not', 'you', 'all', 'her',
  'was', 'one', 'our', 'out', 'then', 'them', 'this', 'that',
  'with', 'have', 'from', 'they', 'been', 'said', 'each', 'some',
  'here', 'than', 'into', 'just', 'like', 'long', 'make', 'many',
  'much', 'over', 'such', 'take', 'only', 'come', 'made', 'find',
  'more', 'will', 'them', 'very', 'when', 'what', 'your', 'also',
  'back', 'been', 'call', 'know', 'look', 'most', 'part', 'than',
  'time', 'turn', 'want', 'well', 'work', 'year', 'good', 'give',
  'keep', 'last', 'life', 'need', 'same', 'tell', 'help', 'talk',
  'sure', 'nice', 'cool', 'yeah', 'nah', 'nope', 'yep', 'yup',
  // Internet / chat slang
  'bot', 'ai', 'app', 'url', 'api', 'css', 'img', 'pdf', 'doc',
  'lmao', 'bruh', 'pls', 'thx', 'ty', 'np', 'rn', 'imo', 'idk',
  'msg', 'pic', 'vid', 'dm', 'pm', 'op', 'tldr', 'aka', 'etc',
]);

/**
 * Check if an ASCII string looks like a real word (has vowels in expected positions)
 * vs an abbreviation (consonant-only like "ykn", "mjk", "ras").
 * Most real English words 2-4 chars long contain at least one vowel.
 */
function hasVowelPattern(s: string): boolean {
  return /[aeiou]/i.test(s);
}

/**
 * Detect gibberish patterns: repeated characters, random ASCII, etc.
 * These indicate messages the bot definitely shouldn't try to parse.
 */
function hasGibberishPattern(text: string): boolean {
  // Repeated char 4+ times (e.g. "啊啊啊啊啊")
  if (/(.)\1{3,}/.test(text)) return false; // repeated chars are emotive, not gibberish

  // Mostly non-CJK, non-ASCII printable (random byte sequences)
  const cjkRatio = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / text.length;
  const asciiRatio = (text.match(/[a-zA-Z0-9]/g) || []).length / text.length;
  if (cjkRatio < 0.1 && asciiRatio < 0.3 && text.length > 5) return true;

  return false;
}
