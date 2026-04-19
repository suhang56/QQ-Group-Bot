import { describe, it, expect } from 'vitest';
import { isDirectQuestion, isGroundedOpinionQuestion, DIRECT_QUESTION_PATTERNS, GROUNDED_OPINION_PATTERNS } from '../src/utils/is-direct-question.js';

describe('isDirectQuestion — expanded patterns', () => {
  describe('definition true cases', () => {
    it('X 是啥', () => expect(isDirectQuestion('xtt是啥')).toBe(true));
    it('X 是干啥的', () => expect(isDirectQuestion('xtt是干啥的')).toBe(true));
    it('X 啥梗 — entity present', () => expect(isDirectQuestion('ygfn啥梗')).toBe(true));
    it('X 什么梗 — entity present', () => expect(isDirectQuestion('ygfn什么梗')).toBe(true));
    it('X 啥来头', () => expect(isDirectQuestion('xtt啥来头')).toBe(true));
    it('X 什么来头', () => expect(isDirectQuestion('xtt什么来头')).toBe(true));
    it('X 咋回事', () => expect(isDirectQuestion('这事咋回事')).toBe(true));
    it('什么是 X prefix form', () => expect(isDirectQuestion('什么是ygfn')).toBe(true));
    it('啥是 X prefix form', () => expect(isDirectQuestion('啥是xtt')).toBe(true));
    it('standalone 啥意思 — no entity needed', () => expect(isDirectQuestion('啥意思')).toBe(true));
    it('whitespace tolerance — X 啥梗 with space', () => expect(isDirectQuestion('ygfn 啥梗')).toBe(true));
    it('whitespace tolerance — X 咋回事 with space', () => expect(isDirectQuestion('这事 咋回事')).toBe(true));
    it('CQ code stripping', () => expect(isDirectQuestion('[CQ:at,qq=123]xtt是啥')).toBe(true));
  });

  describe('definition false cases', () => {
    it('standalone 啥梗 without entity → false', () => expect(isDirectQuestion('啥梗')).toBe(false));
    it('standalone 咋回事 without entity → false', () => expect(isDirectQuestion('咋回事')).toBe(false));
    it('pronoun entity 你 咋回事 → false', () => expect(isDirectQuestion('你咋回事')).toBe(false));
    it('pronoun entity 你们 是啥 → false', () => expect(isDirectQuestion('你们是啥')).toBe(false));
    it('pronoun entity 今天 是啥 → false', () => expect(isDirectQuestion('今天是啥')).toBe(false));
    it('pronoun entity 大家 是干啥的 → false', () => expect(isDirectQuestion('大家是干啥的')).toBe(false));
    it('plain statement — no pattern', () => expect(isDirectQuestion('我去live了')).toBe(false));
    it('opinion form 怎么样 is NOT direct', () => expect(isDirectQuestion('xtt怎么样')).toBe(false));
    it('opinion form 如何 is NOT direct', () => expect(isDirectQuestion('xtt如何')).toBe(false));
  });

  describe('DIRECT_QUESTION_PATTERNS array is exported', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(DIRECT_QUESTION_PATTERNS)).toBe(true);
      expect(DIRECT_QUESTION_PATTERNS.length).toBeGreaterThan(7);
    });
  });
});

describe('isGroundedOpinionQuestion — expanded patterns', () => {
  describe('opinion true cases', () => {
    it('X 怎么样 — non-pronoun entity', () => expect(isGroundedOpinionQuestion('xtt怎么样')).toBe(true));
    it('X 咋样 — non-pronoun entity', () => expect(isGroundedOpinionQuestion('xtt咋样')).toBe(true));
    it('X 如何 — non-pronoun entity', () => expect(isGroundedOpinionQuestion('xtt如何')).toBe(true));
    it('X 怎么说 — non-pronoun entity', () => expect(isGroundedOpinionQuestion('xtt怎么说')).toBe(true));
    it('如何评价 X prefix', () => expect(isGroundedOpinionQuestion('如何评价ygfn')).toBe(true));
    it('怎么看 X prefix', () => expect(isGroundedOpinionQuestion('怎么看xtt')).toBe(true));
    it('whitespace in prefix form', () => expect(isGroundedOpinionQuestion('如何评价 ygfn')).toBe(true));
    it('点评 X prefix', () => expect(isGroundedOpinionQuestion('点评xtt')).toBe(true));
  });

  describe('opinion false cases (pronoun guard)', () => {
    it('你 怎么样 → false (pronoun)', () => expect(isGroundedOpinionQuestion('你怎么样')).toBe(false));
    it('你们 如何 → false (pronoun)', () => expect(isGroundedOpinionQuestion('你们如何')).toBe(false));
    it('今天 怎么样 → false (pronoun)', () => expect(isGroundedOpinionQuestion('今天怎么样')).toBe(false));
    it('最近 咋样 → false (pronoun)', () => expect(isGroundedOpinionQuestion('最近咋样')).toBe(false));
    it('大家 怎么说 → false (pronoun)', () => expect(isGroundedOpinionQuestion('大家怎么说')).toBe(false));
  });

  describe('mutual exclusion — opinion forms are NOT direct', () => {
    it('xtt怎么样 is opinion but NOT direct', () => {
      expect(isGroundedOpinionQuestion('xtt怎么样')).toBe(true);
      expect(isDirectQuestion('xtt怎么样')).toBe(false);
    });
    it('xtt如何 is opinion but NOT direct', () => {
      expect(isGroundedOpinionQuestion('xtt如何')).toBe(true);
      expect(isDirectQuestion('xtt如何')).toBe(false);
    });
  });

  describe('GROUNDED_OPINION_PATTERNS array is exported', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(GROUNDED_OPINION_PATTERNS)).toBe(true);
      expect(GROUNDED_OPINION_PATTERNS.length).toBeGreaterThan(6);
    });
  });
});
