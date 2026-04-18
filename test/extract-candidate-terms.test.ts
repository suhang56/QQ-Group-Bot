import { describe, it, expect } from 'vitest';
import { extractCandidateTerms } from '../src/utils/extract-candidate-terms.js';

describe('extractCandidateTerms — knownFacts filter removed', () => {
  it('returns ygfn even when it was previously filtered by knownFacts', () => {
    // ygfn must be whitespace-separated so extractTokens can isolate it as a token
    const result = extractCandidateTerms('ygfn 是谁啊');
    expect(result).toContain('ygfn');
  });

  it('still filters COMMON_WORDS and STRUCTURAL_PARTICLES', () => {
    const result = extractCandidateTerms('的了吗就是');
    expect(result).toHaveLength(0);
  });

  it('filters question scaffolding around compact Chinese knowledge questions', () => {
    expect(extractCandidateTerms('xtt是啥')).toEqual(['xtt']);
    expect(extractCandidateTerms('xtt 是啥')).toEqual(['xtt']);
    expect(extractCandidateTerms('请问ygfn是谁')).toEqual(['ygfn']);
    expect(extractCandidateTerms('什么是xtt')).toEqual(['xtt']);
    expect(extractCandidateTerms('请问什么是xtt')).toEqual(['xtt']);
    expect(extractCandidateTerms('那个xtt是啥')).toEqual(['xtt']);
    expect(extractCandidateTerms('xtt什么意思')).toEqual(['xtt']);
  });
});
