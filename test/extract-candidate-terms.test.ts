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
});
