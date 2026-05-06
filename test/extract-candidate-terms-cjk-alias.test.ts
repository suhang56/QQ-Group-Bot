import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { extractCandidateTerms } from '../src/utils/extract-candidate-terms.js';

function makeDb(): Database {
  return new Database(':memory:');
}

describe('extractCandidateTerms CJK alias canonicalization (C-3)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();

    // Row A: primary test entity with CJK typo variant + Latin shortform
    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '羊宫妃娜',
      variants: ['羊宫妃那', 'ygfn'],
      meaning: 'BanG Dream MyGO!!!!! VA',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 5,
      totalCount: 20,
      confidence: 0.95,
      status: 'active',
      embeddingVec: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Row B: collision entity — shares the CJK typo variant with Row A
    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '另一妃娜',
      variants: ['羊宫妃那'],
      meaning: 'collision test entity',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 1,
      totalCount: 2,
      confidence: 0.6,
      status: 'active',
      embeddingVec: null,
      createdAt: 1001,
      updatedAt: 1001,
    });

    // Learned fact for A1 full-retrieval test
    db.learnedFacts.insert({
      groupId: 'g1',
      topic: 'opus-classified:fandom:羊宫妃娜',
      fact: '羊宫妃娜是BanG Dream MyGO!!!!!的VA',
      canonicalForm: '羊宫妃娜',
      personaForm: null,
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
  });

  // A1: positive CJK-variant hit + full retrieval
  it('A1: 羊宫妃那是谁 -> candidates includes 羊宫妃娜; findActiveByTopicTerm returns fact', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃娜');
    const facts = db.learnedFacts.findActiveByTopicTerm('g1', '羊宫妃娜');
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  // A2: regression guard — exact canonical still returns fact
  it('A2: 羊宫妃娜是谁 -> candidates includes 羊宫妃娜; findActiveByTopicTerm returns fact', () => {
    const cands = extractCandidateTerms('羊宫妃娜是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃娜');
    const facts = db.learnedFacts.findActiveByTopicTerm('g1', '羊宫妃娜');
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  // A3-CJK-1: canonicals appear before raw typo-form in candidate list
  it('A3-CJK-1: 羊宫妃那是谁 -> 羊宫妃娜 and 另一妃娜 both appear before raw 羊宫妃那', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g1', db.memeGraph);
    const idxCanon = cands.indexOf('羊宫妃娜');
    const idxRaw = cands.indexOf('羊宫妃那');
    expect(idxCanon).toBeGreaterThanOrEqual(0);
    expect(idxRaw).toBeGreaterThanOrEqual(0);
    expect(idxCanon).toBeLessThan(idxRaw);
    expect(cands).toContain('另一妃娜');
  });

  // A3-CJK-2: collision — both Row A and Row B seeded; both canonicals pushed; no crash
  it('A3-CJK-2: collision — 羊宫妃那是谁 with both Row A and Row B -> candidates includes both 羊宫妃娜 AND 另一妃娜', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃娜');
    expect(cands).toContain('另一妃娜');
    expect(cands.length).toBeGreaterThanOrEqual(2);
  });

  // A3-CJK-3: no meme_graph row — raw cjkTerm pushed unchanged; no CJK canonical expansion
  it('A3-CJK-3: 小团体是谁 (no meme_graph row) -> findByVariant returns []; candidates includes 小团体; no CJK canonical injected', () => {
    const cands = extractCandidateTerms('小团体是谁', 'g1', db.memeGraph);
    expect(cands).toContain('小团体');
    // C-3 must not inject any CJK canonical when findByVariant returns []
    expect(cands).not.toContain('羊宫妃娜');
    expect(cands).not.toContain('另一妃娜');
  });

  // A3-CJK-4: different suffix still triggers deriveCjkTerm
  it('A3-CJK-4: 羊宫妃那怎么样 (怎么样 suffix) -> deriveCjkTerm fires; candidates includes 羊宫妃娜', () => {
    const cands = extractCandidateTerms('羊宫妃那怎么样', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃娜');
  });

  // A3-CJK-5: empty string -> []
  it('A3-CJK-5: empty string -> []', () => {
    const cands = extractCandidateTerms('', 'g1', db.memeGraph);
    expect(cands).toEqual([]);
  });

  // A3-CJK-6: single Han char -> deriveCjkTerm null; no expansion; extractTokens may return [] for single CJK char
  it('A3-CJK-6: 羊 (single Han) -> deriveCjkTerm null; no CJK expansion triggered; no crash', () => {
    expect(() => extractCandidateTerms('羊', 'g1', db.memeGraph)).not.toThrow();
    const cands = extractCandidateTerms('羊', 'g1', db.memeGraph);
    expect(cands).not.toContain('羊宫妃娜');
    expect(cands).not.toContain('另一妃娜');
  });

  // A3-CJK-7: Latin query with Row A seeded -> C-2 path; C-3 not triggered; single occurrence only
  it('A3-CJK-7: ygfn是谁 (Latin, Row A seeded) -> C-2 maps ygfn->羊宫妃娜; no duplicate; single 羊宫妃娜', () => {
    const cands = extractCandidateTerms('ygfn是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃娜');
    const count = cands.filter(c => c === '羊宫妃娜').length;
    expect(count).toBe(1);
  });

  // A3-CJK-8: exact canonical query -> dedup prevents double-push; result is ['羊宫妃娜']
  it('A3-CJK-8: 羊宫妃娜是谁 (exact canonical) -> dedup prevents double-push; 羊宫妃娜 appears exactly once', () => {
    const cands = extractCandidateTerms('羊宫妃娜是谁', 'g1', db.memeGraph);
    const count = cands.filter(c => c === '羊宫妃娜').length;
    expect(count).toBe(1);
  });

  // A3-CJK-9: cross-group isolation — Row A under g1; query with g2 returns no expansion
  it('A3-CJK-9: cross-group — Row A under g1; query g2 -> findByVariant(g2,...) returns []; candidates is ["羊宫妃那"]', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g2', db.memeGraph);
    expect(cands).not.toContain('羊宫妃娜');
    expect(cands).toContain('羊宫妃那');
  });

  // A3-CJK-10: typo-variant with no learned_facts row -> canonical pushed; findActiveByTopicTerm returns []; no crash
  it('A3-CJK-10: typo-variant with no learned_facts for 另一妃娜 -> expansion pushes canonical; findActiveByTopicTerm returns []', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g1', db.memeGraph);
    expect(cands).toContain('另一妃娜');
    const facts = db.learnedFacts.findActiveByTopicTerm('g1', '另一妃娜');
    expect(facts.length).toBe(0);
  });
});
