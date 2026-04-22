import { describe, it, expect } from 'vitest';
import { isVulgarDismissal } from '../../src/utils/is-vulgar-dismissal.js';

describe('isVulgarDismissal — MUST-FIRE (true)', () => {
  describe('懂个 + vulgar tail (with / without 你 prefix)', () => {
    it.each([
      '你懂个毛', '懂个毛',
      '你懂个屁', '懂个屁',
      '你懂个锤子', '懂个锤子',
      '你懂个鬼', '懂个鬼',
      '你懂个啥', '懂个啥',
      '你懂个蛋', '懂个蛋',
    ])('%s → true', (term) => {
      expect(isVulgarDismissal(term)).toBe(true);
    });
  });

  describe('你个 / 你才 + vulgar tail', () => {
    it.each(['你个屁', '你个毛', '你才屁', '你才傻', '你才二', '你个蠢'])('%s → true', (term) => {
      expect(isVulgarDismissal(term)).toBe(true);
    });
  });

  describe('fixed-phrase dismissals', () => {
    it.each(['去你的', '滚你的', '管你屁事'])('%s → true', (term) => {
      expect(isVulgarDismissal(term)).toBe(true);
    });
  });
});

describe('isVulgarDismissal — MUST-NOT-FIRE (false)', () => {
  describe('third-person subject — not-你 prefix must pass', () => {
    it.each(['他懂个屁', '她懂个毛'])('%s → false', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('non-vulgar 你/懂 shapes', () => {
    it.each(['我懂了', '你懂吗', '你知道吗', '我懂'])('%s → false', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('lore / fandom canonicals with 懂 or 二', () => {
    it.each(['懂者自懂', 'zdjd', '二次元', '二选一'])('%s → false', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('unrelated fandom initialisms / names', () => {
    it.each(['ykn', 'laplace'])('%s → false', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('PR2 harassment-gate terms — NOT this predicate scope', () => {
    // covered by the PR2 hard gate on the output side; must NOT double-fire here
    // (keeps family scopes clean per Designer Q4).
    it.each(['傻逼', 'sb'])('%s → false (not in vulgar-dismissal family)', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('long-sentence embed — ^…$ anchor rejects substring match', () => {
    it.each([
      '今天的演出真的懂个毛啊，是什么感觉',
      '你懂个毛啊我说的',
      '懂个毛线',
    ])('%s → false (long-sentence / extra-tail)', (term) => {
      expect(isVulgarDismissal(term)).toBe(false);
    });
  });

  describe('empty / whitespace', () => {
    it('empty string → false', () => {
      expect(isVulgarDismissal('')).toBe(false);
    });
    it('whitespace-only → false', () => {
      expect(isVulgarDismissal('   ')).toBe(false);
    });
  });

  describe('non-string inputs do not throw', () => {
    it('null → false', () => {
      expect(() => isVulgarDismissal(null)).not.toThrow();
      expect(isVulgarDismissal(null)).toBe(false);
    });
    it('undefined → false', () => {
      expect(() => isVulgarDismissal(undefined)).not.toThrow();
      expect(isVulgarDismissal(undefined)).toBe(false);
    });
    it('number → false', () => {
      expect(() => isVulgarDismissal(123)).not.toThrow();
      expect(isVulgarDismissal(123)).toBe(false);
    });
  });
});
