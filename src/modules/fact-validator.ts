import { sanitizeForPrompt } from '../utils/prompt-sanitize.js';
import type { SearchResult } from './web-lookup.js';
import type { Logger } from 'pino';

export interface ValidatorDeps {
  groundingProvider?: { search(query: string): Promise<SearchResult[]> };
  logger: Logger;
}

export interface ValidateFactInput {
  term: string;
  meaning: string;
  speakerCount: number;
  contextCount: number;
  groupId: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STOPWORDS = new Set(['的', '是', '了', '在', '和', 'a', 'the', 'is', 'of']);

const _cache = new Map<string, { result: 'active' | 'pending'; expiresAt: number }>();

export function _resetCacheForTesting(): void {
  _cache.clear();
}

function _keywordOverlap(meaning: string, snippet: string): boolean {
  const lower = snippet.toLowerCase();
  const tokens = meaning.toLowerCase().split(/[\s，。！？!?,;；:：、\-—…()（）]+/).filter(t => t.length >= 2 && !STOPWORDS.has(t));
  return tokens.some(t => lower.includes(t));
}

export async function validateFactForActive(
  input: ValidateFactInput,
  deps: ValidatorDeps,
): Promise<'active' | 'pending'> {
  const { term, meaning, speakerCount, contextCount, groupId } = input;
  const cacheKey = `${groupId}:${term.toLowerCase()}`;

  const now = Date.now();
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    deps.logger.debug({ term, groupId, result: cached.result }, 'fact-validator: cache hit');
    return cached.result;
  }

  let groundingConfirms = false;

  if (deps.groundingProvider) {
    try {
      const sanitized = sanitizeForPrompt(term, 80);
      const query = `"${sanitized}"`;
      const results = await deps.groundingProvider.search(query);
      if (results.length > 0 && results[0]) {
        groundingConfirms = _keywordOverlap(meaning, results[0].snippet);
      }
    } catch {
      // fail-safe: fall through to Rule C
    }
  }

  let result: 'active' | 'pending';
  if (groundingConfirms) {
    result = 'active';
  } else if (speakerCount >= 3 && contextCount >= 2) {
    result = 'active';
  } else {
    result = 'pending';
  }

  deps.logger.info({ term, groupId, groundingConfirms, speakerCount, contextCount, result }, 'fact-validator: decision');
  _cache.set(cacheKey, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
