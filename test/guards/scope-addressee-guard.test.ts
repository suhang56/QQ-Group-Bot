import { describe, it, expect } from 'vitest';
import { isBotNotAddresseeReplied } from '../../src/modules/guards/scope-addressee-guard.js';
import { isAddresseeScopeViolation } from '../../src/utils/sentinel.js';

describe('isBotNotAddresseeReplied — 4-bool predicate', () => {
  it('bot @-mentioned → false (silent-skip NOT triggered)', () => {
    expect(isBotNotAddresseeReplied(true, false, false, false)).toBe(false);
  });

  it('reply-to-bot → false', () => {
    expect(isBotNotAddresseeReplied(false, true, false, false)).toBe(false);
  });

  it('fact-term present → false', () => {
    expect(isBotNotAddresseeReplied(false, false, true, false)).toBe(false);
  });

  it('bot-status keyword present → false', () => {
    expect(isBotNotAddresseeReplied(false, false, false, true)).toBe(false);
  });

  it('none of the above → true (silent path fires)', () => {
    expect(isBotNotAddresseeReplied(false, false, false, false)).toBe(true);
  });

  it('multiple signals true → false (any one exempts)', () => {
    expect(isBotNotAddresseeReplied(true, true, true, true)).toBe(false);
    expect(isBotNotAddresseeReplied(true, false, true, false)).toBe(false);
    expect(isBotNotAddresseeReplied(false, true, false, true)).toBe(false);
  });
});

describe('isAddresseeScopeViolation — regression coverage reused via SF3', () => {
  it('你们几个真 + small scene (<3 speakers) → true', () => {
    // SPECTATOR_PATTERNS in sentinel.ts:688 has ^你们几个(?:又|真|怎么|在|...)
    expect(isAddresseeScopeViolation('你们几个真能折腾什么', 2)).toBe(true);
  });

  it('你们几个真 + large scene (≥3 speakers) → false', () => {
    expect(isAddresseeScopeViolation('你们几个真能折腾什么', 4)).toBe(false);
  });

  it('non-spectator text + any speaker count → false', () => {
    expect(isAddresseeScopeViolation('好的', 1)).toBe(false);
    expect(isAddresseeScopeViolation('好的', 5)).toBe(false);
  });

  it('spectator template in CJK whitespace form → still detected', () => {
    // Existing _stripCQForSentinel removes CQ, then compact removes spaces.
    expect(isAddresseeScopeViolation('你们 事 真多', 2)).toBe(true);
  });

  it('exactly 3 speakers → large scene (>=3) → false', () => {
    expect(isAddresseeScopeViolation('你们几个真能折腾什么', 3)).toBe(false);
  });
});
