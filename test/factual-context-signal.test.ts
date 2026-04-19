import { describe, it, expect } from 'vitest';
import { buildFactualContextSignal, nonEmptyBlock } from '../src/modules/factual-context-signal.js';

describe('nonEmptyBlock', () => {
  it('returns false for null', () => expect(nonEmptyBlock(null)).toBe(false));
  it('returns false for undefined', () => expect(nonEmptyBlock(undefined)).toBe(false));
  it('returns false for empty string', () => expect(nonEmptyBlock('')).toBe(false));
  it('returns false for whitespace-only string', () => expect(nonEmptyBlock('   ')).toBe(false));
  it('returns true for non-empty string', () => expect(nonEmptyBlock('hello')).toBe(true));
  it('returns true for string with leading whitespace', () => expect(nonEmptyBlock('  x ')).toBe(true));
});

describe('buildFactualContextSignal', () => {
  it('returns false when all args are empty/false', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false,
      onDemandFactBlock: null,
      webLookupBlock: null,
      liveBlock: null,
    })).toBe(false);
  });

  it('KEY INVARIANT: injectedFactIds=[1,2,3], matchedFactIds=[], pinnedOnly=true → hasRealFactHit=false', () => {
    // Caller should pass matchedFactIds.length > 0 as factsBlockHasRealHit, not injectedFactIds
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false, // matchedFactIds=[] means no real hit
      onDemandFactBlock: null,
      webLookupBlock: null,
      liveBlock: null,
    })).toBe(false);
  });

  it('returns true when factsBlockHasRealHit=true', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: true,
      onDemandFactBlock: null,
      webLookupBlock: null,
      liveBlock: null,
    })).toBe(true);
  });

  it('returns true when onDemandFactBlock has content', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false,
      onDemandFactBlock: 'some fact',
      webLookupBlock: null,
      liveBlock: null,
    })).toBe(true);
  });

  it('returns true when webLookupBlock has content', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false,
      onDemandFactBlock: null,
      webLookupBlock: 'web content',
      liveBlock: null,
    })).toBe(true);
  });

  it('returns true when liveBlock has content', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false,
      onDemandFactBlock: null,
      webLookupBlock: null,
      liveBlock: 'live content',
    })).toBe(true);
  });

  it('returns false when onDemandFactBlock is whitespace-only', () => {
    expect(buildFactualContextSignal({
      factsBlockHasRealHit: false,
      onDemandFactBlock: '   ',
      webLookupBlock: null,
      liveBlock: null,
    })).toBe(false);
  });
});
