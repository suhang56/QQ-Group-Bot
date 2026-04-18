import { describe, it, expect } from 'vitest';
import { deriveFactTerm } from '../src/modules/fact-term-extractor.js';

describe('deriveFactTerm (cases 15a-15k)', () => {
  it('15a: trigger interrogative "ygfn是谁啊"', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: 'ygfn是谁啊', factText: null })).toBe('ygfn');
  });

  it('15b: trigger interrogative with space "xtt 是啥"', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: 'xtt 是啥', factText: null })).toBe('xtt');
  });

  it('15c: trigger with prefix word "请问ygfn是谁"', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: '请问ygfn是谁', factText: null })).toBe('ygfn');
  });

  it('15d: trigger with Chinese prefix "那个xtt是啥"', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: '那个xtt是啥', factText: null })).toBe('xtt');
  });

  it('15e: fact definition with "="', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: null, factText: 'ygfn=羊宫妃那那个声优' })).toBe('ygfn');
  });

  it('15f: fact definition with "在"', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: null, factText: 'xtt在波士顿读书' })).toBe('xtt');
  });

  it('15g: fact definition "ygfn是羊宫妃那..."', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: null, factText: 'ygfn是羊宫妃那那个声优' })).toBe('ygfn');
  });

  it('15h: CRITICAL regression — "ygfn的意思是..." extracts "ygfn" (longer delimiter first)', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: null, factText: 'ygfn的意思是羊宫妃那那个声优' })).toBe('ygfn');
  });

  it('15i: explicitTopic has valid structured suffix', () => {
    expect(deriveFactTerm({ explicitTopic: 'user-taught:xtt', trigger: null, factText: null })).toBe('xtt');
  });

  it('15j: all inputs null', () => {
    expect(deriveFactTerm({ explicitTopic: null, trigger: null, factText: null })).toBeNull();
  });

  it('15k: 50-char trigger without interrogative returns null', () => {
    const runaway = '这个是一段很长的没有任何疑问词的文字用来测试边界情况啊啊啊啊啊啊';
    expect(deriveFactTerm({ explicitTopic: null, trigger: runaway, factText: null })).toBeNull();
  });

  it('priority: explicitTopic wins over trigger', () => {
    expect(deriveFactTerm({
      explicitTopic: 'user-taught:xtt',
      trigger: 'ygfn是谁',
      factText: null,
    })).toBe('xtt');
  });

  it('priority: trigger wins over factText', () => {
    expect(deriveFactTerm({
      explicitTopic: null,
      trigger: 'ygfn是谁',
      factText: 'xtt=something',
    })).toBe('ygfn');
  });

  it('dirty explicitTopic falls through to trigger', () => {
    expect(deriveFactTerm({
      explicitTopic: 'user-taught:ygfn是谁啊',
      trigger: 'xtt是啥',
      factText: null,
    })).toBe('xtt');
  });
});
