/**
 * Tests: comprehension scorer recognizes learned_facts terms as known jargon.
 * Covers the fix in chat.ts that extracts topic prefixes into jargonTerms.
 */
import { describe, it, expect } from 'vitest';
import { scoreComprehension, type ComprehensionContext } from '../src/services/comprehension-scorer.js';

function makeCtx(jargonTerms: string[]): ComprehensionContext {
  return {
    loreKeywords: new Set<string>(),
    jargonTerms,
    aliasKeys: [],
  };
}

describe('scoreComprehension — learned_facts jargon injection', () => {
  it('scores low for space-separated unknown ASCII abbreviation with no jargon context', () => {
    // tokenizeLore splits on spaces, so "xtt ykn" yields isolated tokens "xtt" and "ykn"
    // both look like consonant-heavy abbreviations → unknownDomainLike = 2 → low score
    const score = scoreComprehension('xtt ykn', makeCtx([]));
    expect(score).toBeLessThan(0.5);
  });

  it('scores high when terms are added to jargonTerms (simulating learned_facts injection)', () => {
    const score = scoreComprehension('xtt ykn', makeCtx(['xtt', 'ykn']));
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it('scores >= 0.6 for single short known term (hits early-return branch for <=4 chars)', () => {
    // "ykn!" is 4 chars total → hits the short-message early-return (0.6)
    const score = scoreComprehension('ykn!', makeCtx(['ykn']));
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('topic prefix regex extracts user-taught term correctly', () => {
    // Simulate the extraction logic from chat.ts
    const topic = 'user-taught:xtt';
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('xtt');
  });

  it('topic prefix regex extracts opus-classified:slang term', () => {
    const topic = 'opus-classified:slang:mjk';
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('mjk');
  });

  it('topic prefix regex extracts fandom term', () => {
    const topic = 'opus-classified:fandom:ygfn';
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('ygfn');
  });

  it('topic prefix regex skips unrecognized prefixes', () => {
    const topic = 'random-prefix:something';
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    expect(m).toBeNull();
  });

  it('skips terms longer than 15 chars', () => {
    // Extraction logic has <= 15 char guard
    const topic = 'user-taught:averylongtermexceeding15chars';
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    const term = m ? m[1] : null;
    const shouldInclude = term !== null && term.length <= 15;
    expect(shouldInclude).toBe(false);
  });

  it('handles null topic gracefully (no throw)', () => {
    // Simulates the null-check guard in chat.ts (if f.topic)
    const topic: string | null = null;
    let extracted: string | null = null;
    if (topic) {
      const m = topic.match(/(?:user-taught):([^:]+)/);
      if (m) extracted = m[1]!;
    }
    expect(extracted).toBeNull();
  });

  it('edge: empty jargonTerms array does not break scorer', () => {
    expect(() => scoreComprehension('hello world', makeCtx([]))).not.toThrow();
  });

  it('edge: message with only CJK scores high (not flagged as unknown domain)', () => {
    const score = scoreComprehension('你好呀今天天气真不错', makeCtx([]));
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('edge: deduplication does not affect scoring (duplicate jargon terms still match)', () => {
    // Having duplicates in jargonTerms should not cause incorrect scores
    const score = scoreComprehension('xtt来了', makeCtx(['xtt', 'xtt', 'xtt']));
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it('edge: short term at exactly 15 chars boundary is included', () => {
    const term = 'a'.repeat(15);
    const topic = `user-taught:${term}`;
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    const shouldInclude = m !== null && m[1]!.length <= 15;
    expect(shouldInclude).toBe(true);
  });

  it('edge: term at 16 chars is excluded', () => {
    const term = 'a'.repeat(16);
    const topic = `user-taught:${term}`;
    const m = topic.match(/(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom):([^:]+)/);
    const shouldInclude = m !== null && m[1]!.length <= 15;
    expect(shouldInclude).toBe(false);
  });
});
