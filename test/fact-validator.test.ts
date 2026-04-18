import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateFactForActive, _resetCacheForTesting } from '../src/modules/fact-validator.js';
import type { SearchResult } from '../src/modules/web-lookup.js';

function makeProvider(results: SearchResult[]) {
  return { search: vi.fn().mockResolvedValue(results) };
}

function makeProvider_throws() {
  return { search: vi.fn().mockRejectedValue(new Error('network error')) };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any;
}

const base = { term: 'xtt', meaning: '希那', speakerCount: 1, contextCount: 1, groupId: 'g1' };

beforeEach(() => _resetCacheForTesting());

describe('validateFactForActive', () => {
  it('grounding_confirms_returns_active', async () => {
    const provider = makeProvider([{ snippet: '希那是凑友希那的缩写', url: 'https://example.com' }]);
    const result = await validateFactForActive(base, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('active');
  });

  it('grounding_dissents_no_keyword_overlap_returns_pending', async () => {
    const provider = makeProvider([{ snippet: '完全无关的内容关于别的话题', url: 'https://example.com' }]);
    const result = await validateFactForActive(base, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('pending');
  });

  it('grounding_null_three_speakers_returns_active', async () => {
    const provider = makeProvider([]);
    const input = { ...base, term: 'ygfn', meaning: '羊宫妃那', speakerCount: 3, contextCount: 2 };
    const result = await validateFactForActive(input, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('active');
  });

  it('grounding_null_two_speakers_returns_pending', async () => {
    const provider = makeProvider([]);
    const input = { ...base, term: 'ygfn', meaning: '羊宫妃那', speakerCount: 2, contextCount: 1 };
    const result = await validateFactForActive(input, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('pending');
  });

  it('grounding_throws_failsafe_returns_pending', async () => {
    const provider = makeProvider_throws();
    const result = await validateFactForActive(base, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('pending');
  });

  it('cache_hit_skips_grounding_on_second_call', async () => {
    const provider = makeProvider([{ snippet: '希那相关内容', url: 'https://example.com' }]);
    const logger = makeLogger();
    await validateFactForActive(base, { groundingProvider: provider, logger });
    await validateFactForActive(base, { groundingProvider: provider, logger });
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('grounding_empty_after_retries_three_speakers_returns_active', async () => {
    const provider = makeProvider([]);
    const input = { ...base, term: 'ygfn', meaning: '羊宫妃那', speakerCount: 3, contextCount: 2 };
    const result = await validateFactForActive(input, { groundingProvider: provider, logger: makeLogger() });
    expect(result).toBe('active');
  });
});
