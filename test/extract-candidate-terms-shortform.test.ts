import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { extractCandidateTerms } from '../src/utils/extract-candidate-terms.js';

function makeDb(): Database {
  return new Database(':memory:');
}

describe('extractCandidateTerms shortform expansion', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();

    // Seed meme_graph rows via db.memeGraph directly (mirrors callers using this.db.memeGraph)
    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '羊宫妃那',
      variants: ['ygfn'],
      meaning: 'BanG Dream fandom idol',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 3,
      totalCount: 10,
      confidence: 0.9,
      status: 'active',
      embeddingVec: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '小团体',
      variants: ['xtt'],
      meaning: 'BanG Dream sub-group',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 5,
      totalCount: 20,
      confidence: 0.85,
      status: 'active',
      embeddingVec: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '花园中毒',
      variants: ['hhw'],
      meaning: 'band slang',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 2,
      totalCount: 5,
      confidence: 0.7,
      status: 'active',
      embeddingVec: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Seed learned_facts row for A1 full-retrieval test
    db.learnedFacts.insert({
      groupId: 'g1',
      topic: 'opus-classified:fandom:羊宫妃那',
      fact: '羊宫妃那是BanG Dream的偶像角色',
      canonicalForm: '羊宫妃那',
      personaForm: null,
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
  });

  // A1: positive shortform hit + full retrieval
  it('A1: ygfn 是谁 -> candidates includes 羊宫妃那 and findActiveByTopicTerm returns fact', () => {
    const cands = extractCandidateTerms('ygfn 是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
    const facts = db.learnedFacts.findActiveByTopicTerm('g1', '羊宫妃那');
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  // A2: CJK path unbroken
  it('A2: 羊宫妃那是谁 -> candidates[0] === 羊宫妃那 (C-1 path)', () => {
    const cands = extractCandidateTerms('羊宫妃那是谁', 'g1', db.memeGraph);
    expect(cands[0]).toBe('羊宫妃那');
  });

  // A3-edge-1: bare ygfn expands
  it('A3-edge-1: ygfn (bare) -> candidates includes 羊宫妃那', () => {
    const cands = extractCandidateTerms('ygfn', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
  });

  // A3-edge-2: all-caps YGFN -> toLowerCase normalization hits
  it('A3-edge-2: YGFN (all-caps) -> candidates includes 羊宫妃那', () => {
    const cands = extractCandidateTerms('YGFN', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
  });

  // A3-edge-3: ygfn with question tail
  it('A3-edge-3: ygfn 是谁 (with tail) -> includes 羊宫妃那 and ygfn', () => {
    const cands = extractCandidateTerms('ygfn 是谁', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
    expect(cands).toContain('ygfn');
  });

  // A3-edge-4: xtt glued with CJK tail (no space) - confirms extractTokens CJK/ASCII split
  it('A3-edge-4: xtt是啊 (glued, no space) -> candidates includes 小团体', () => {
    const cands = extractCandidateTerms('xtt是啊', 'g1', db.memeGraph);
    expect(cands).toContain('小团体');
  });

  // A3-edge-5: HHW all-caps maps to 花园中毒
  it('A3-edge-5: HHW (all-caps) -> candidates includes 花园中毒', () => {
    const cands = extractCandidateTerms('HHW', 'g1', db.memeGraph);
    expect(cands).toContain('花园中毒');
  });

  // A3-edge-6: single char 'a' -> no CJK expansion
  it('A3-edge-6: a (single char) -> no CJK in candidates', () => {
    const cands = extractCandidateTerms('a', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // A3-edge-7: 'live' no meme_graph match -> no CJK, includes 'live'
  it('A3-edge-7: live (4-char, no match) -> no CJK, includes live', () => {
    const cands = extractCandidateTerms('live', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
    expect(cands).toContain('live');
  });

  // A3-edge-8: 如何评价ygfn -> ygfn extracted and expanded
  it('A3-edge-8: 如何评价ygfn -> candidates includes 羊宫妃那', () => {
    const cands = extractCandidateTerms('如何评价ygfn', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
  });

  // A3-edge-9: empty string -> []
  it('A3-edge-9: empty string -> []', () => {
    const cands = extractCandidateTerms('', 'g1', db.memeGraph);
    expect(cands).toEqual([]);
  });

  // A4-1: non-shortform 'live ticket' -> no CJK
  it('A4-1: live ticket -> no CJK candidates', () => {
    const cands = extractCandidateTerms('live ticket', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // A4-2: foo-bar -> no CJK (hyphen splits, 'foo' and 'bar' have no meme_graph match)
  it('A4-2: foo-bar -> no CJK candidates', () => {
    const cands = extractCandidateTerms('foo-bar', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // A5-1: all punctuation -> no crash
  it('A5-1: !@#$% -> no crash, no CJK', () => {
    expect(() => extractCandidateTerms('!@#$%', 'g1', db.memeGraph)).not.toThrow();
    const cands = extractCandidateTerms('!@#$%', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // A5-2: single digit -> no CJK, no crash
  it('A5-2: 9 (single digit) -> no CJK, no crash', () => {
    expect(() => extractCandidateTerms('9', 'g1', db.memeGraph)).not.toThrow();
    const cands = extractCandidateTerms('9', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // collision: xtt maps to two active rows -> both canonicals in candidates
  it('collision: xtt with two active meme_graph rows -> both canonicals in candidates', () => {
    db.memeGraph.insert({
      groupId: 'g1',
      canonical: '另一团体',
      variants: ['xtt'],
      meaning: 'collision test entity',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 1,
      totalCount: 1,
      confidence: 0.6,
      status: 'active',
      embeddingVec: null,
      createdAt: 1001,
      updatedAt: 1001,
    });
    const cands = extractCandidateTerms('xtt', 'g1', db.memeGraph);
    expect(cands).toContain('小团体');
    expect(cands).toContain('另一团体');
  });

  // case-mixed: Ygfn -> expands via toLowerCase
  it('case-mixed: Ygfn -> candidates includes 羊宫妃那', () => {
    const cands = extractCandidateTerms('Ygfn', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
  });

  // DESIGN §3 row 14: single digit '9'
  it('DESIGN row 14: single digit 9 -> no expansion', () => {
    const cands = extractCandidateTerms('9', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // DESIGN §3 row 20: r18 (has digit) -> no expansion
  it('DESIGN row 20: r18 (has digit) -> no CJK expansion', () => {
    const cands = extractCandidateTerms('r18', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
    expect(cands).toContain('r18');
  });

  // DESIGN §3 row 21: server (6 chars all-alpha) -> findByVariant returns [], no expansion
  it('DESIGN row 21: server (6-char all-alpha, no match) -> no CJK', () => {
    const cands = extractCandidateTerms('server', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
    expect(cands).toContain('server');
  });

  // DESIGN §3 row 18: 'on' (2-char all-alpha common word) -> no match, no expansion
  it('DESIGN row 18: on (2-char common word, no match) -> no expansion', () => {
    const cands = extractCandidateTerms('on', 'g1', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });

  // DESIGN §3 row 19: stored ygfn, query Ygfn -> hits via toLowerCase
  it('DESIGN row 19: Ygfn mixed-case -> expands to 羊宫妃那', () => {
    const cands = extractCandidateTerms('Ygfn', 'g1', db.memeGraph);
    expect(cands).toContain('羊宫妃那');
  });

  // DESIGN §3 row 17: canonical pushed before raw Latin token
  it('expansion inserts CJK canonical before raw Latin token in candidate order', () => {
    const cands = extractCandidateTerms('ygfn', 'g1', db.memeGraph);
    const ygfnIdx = cands.indexOf('ygfn');
    const cjkIdx = cands.indexOf('羊宫妃那');
    expect(cjkIdx).toBeGreaterThanOrEqual(0);
    expect(ygfnIdx).toBeGreaterThanOrEqual(0);
    expect(cjkIdx).toBeLessThan(ygfnIdx);
  });

  // DESIGN §3 row 3: bare ygfn -> ["羊宫妃那", "ygfn"]
  it('DESIGN row 3: bare ygfn -> exact candidates [羊宫妃那, ygfn]', () => {
    const cands = extractCandidateTerms('ygfn', 'g1', db.memeGraph);
    expect(cands[0]).toBe('羊宫妃那');
    expect(cands[1]).toBe('ygfn');
  });

  // DESIGN §3 row 7: HHW -> ["花园中毒", "HHW"]
  it('DESIGN row 7: HHW -> exact candidates [花园中毒, HHW]', () => {
    const cands = extractCandidateTerms('HHW', 'g1', db.memeGraph);
    expect(cands[0]).toBe('花园中毒');
    expect(cands[1]).toBe('HHW');
  });

  // cross-group isolation: ygfn lookup in g2 should not return g1 row
  it('cross-group: ygfn in different groupId returns no expansion', () => {
    const cands = extractCandidateTerms('ygfn', 'g2', db.memeGraph);
    const hasCjk = cands.some(c => /\p{Script=Han}/u.test(c));
    expect(hasCjk).toBe(false);
  });
});
