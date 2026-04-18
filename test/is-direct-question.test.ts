import { describe, it, expect } from 'vitest';
import { isDirectQuestion, DIRECT_QUESTION_PATTERNS } from '../src/utils/is-direct-question.js';

describe('isDirectQuestion', () => {
  describe('positive cases (should return true)', () => {
    it('X是啥 pattern', () => {
      expect(isDirectQuestion('xtt是啥')).toBe(true);
    });
    it('什么是X pattern', () => {
      expect(isDirectQuestion('什么是 ygfn')).toBe(true);
    });
    it('X是谁 pattern', () => {
      expect(isDirectQuestion('mggm 是谁')).toBe(true);
    });
    it('X的意思 pattern', () => {
      expect(isDirectQuestion('xtt 的意思')).toBe(true);
    });
  });

  describe('negative cases (should return false)', () => {
    it('narrative with unknown term', () => {
      expect(isDirectQuestion('和 xtt 去 live 了')).toBe(false);
    });
    it('narrative statement', () => {
      expect(isDirectQuestion('我被 3xx 踢了')).toBe(false);
    });
    it('arrival statement', () => {
      expect(isDirectQuestion('ygfn 来了')).toBe(false);
    });
    it('opinion not definition-seeking', () => {
      expect(isDirectQuestion('群里那个 kisa 挺好看')).toBe(false);
    });
  });

  describe('CQ code stripping', () => {
    it('strips CQ codes before matching', () => {
      expect(isDirectQuestion('[CQ:at,qq=123]xtt是啥')).toBe(true);
    });
  });

  it('DIRECT_QUESTION_PATTERNS is exported as readonly array', () => {
    expect(Array.isArray(DIRECT_QUESTION_PATTERNS)).toBe(true);
    expect(DIRECT_QUESTION_PATTERNS.length).toBeGreaterThan(0);
  });
});
