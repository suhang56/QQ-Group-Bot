import { describe, it, expect } from 'vitest';
import type { IMemeGraphRepo } from '../src/storage/db.js';
import { extractCandidateTerms } from '../src/utils/extract-candidate-terms.js';

const noopMemeGraph: IMemeGraphRepo = {
  insert: () => 0,
  update: () => {},
  findByCanonical: () => null,
  findByVariant: () => [],
  listActive: () => [],
  findSimilarActive: () => [],
  listActiveWithEmbeddings: () => [],
  listNullEmbedding: () => [],
  listAllNullEmbedding: () => [],
  findById: () => null,
  adminEdit: () => {},
};

describe('extractCandidateTerms — knownFacts filter removed', () => {
  it('returns ygfn even when it was previously filtered by knownFacts', () => {
    // ygfn must be whitespace-separated so extractTokens can isolate it as a token
    const result = extractCandidateTerms('ygfn 是谁啊', 'g1', noopMemeGraph);
    expect(result).toContain('ygfn');
  });

  it('still filters COMMON_WORDS and STRUCTURAL_PARTICLES', () => {
    const result = extractCandidateTerms('的了吗就是', 'g1', noopMemeGraph);
    expect(result).toHaveLength(0);
  });

  it('filters question scaffolding around compact Chinese knowledge questions', () => {
    expect(extractCandidateTerms('xtt是啥', 'g1', noopMemeGraph)).toEqual(['xtt']);
    expect(extractCandidateTerms('xtt 是啥', 'g1', noopMemeGraph)).toEqual(['xtt']);
    expect(extractCandidateTerms('请问ygfn是谁', 'g1', noopMemeGraph)).toEqual(['ygfn']);
    expect(extractCandidateTerms('什么是xtt', 'g1', noopMemeGraph)).toEqual(['xtt']);
    expect(extractCandidateTerms('请问什么是xtt', 'g1', noopMemeGraph)).toEqual(['xtt']);
    expect(extractCandidateTerms('那个xtt是啥', 'g1', noopMemeGraph)).toEqual(['xtt']);
    expect(extractCandidateTerms('xtt什么意思', 'g1', noopMemeGraph)).toEqual(['xtt']);
  });
});
