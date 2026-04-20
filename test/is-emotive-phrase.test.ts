import { describe, it, expect } from 'vitest';
import { isEmotivePhrase } from '../src/utils/is-emotive-phrase.js';

describe('isEmotivePhrase — REJECT (true)', () => {
  describe('EXCLAMATION: root + suffix', () => {
    it.each(['烦死了', '气死了', '累死了'])('%s → true', (term) => {
      expect(isEmotivePhrase(term)).toBe(true);
    });
    it.each(['崩了', '麻了'])('%s → true (root-form)', (term) => {
      expect(isEmotivePhrase(term)).toBe(true);
    });
  });

  describe('INTENSIFIER: degree prefix + root', () => {
    it.each(['好烦', '真累', '太无语'])('%s → true', (term) => {
      expect(isEmotivePhrase(term)).toBe(true);
    });
  });

  describe('IMPERATIVE: negation + emotive root', () => {
    it.each(['不要烦', '别吵', '不准烦'])('%s → true', (term) => {
      expect(isEmotivePhrase(term)).toBe(true);
    });
  });
});

describe('isEmotivePhrase — PASS (false)', () => {
  describe('ALLOWLIST hard-pass (must precede regex)', () => {
    it.each(['笑死', '笑死我', '死鬼'])('%s → false (allowlisted)', (term) => {
      expect(isEmotivePhrase(term)).toBe(false);
    });
  });

  describe('fandom false-positive edges (emotive-adjacent leading char)', () => {
    it.each(['崩坏', '麻弥'])('%s → false (not over-matching)', (term) => {
      expect(isEmotivePhrase(term)).toBe(false);
    });
  });

  describe('non-emotive jargon shapes', () => {
    it.each(['ykn', 'lsycx', '宿傩', '120w'])('%s → false', (term) => {
      expect(isEmotivePhrase(term)).toBe(false);
    });
  });
});

describe('isEmotivePhrase — boundary / non-string inputs', () => {
  it('empty string → false', () => {
    expect(isEmotivePhrase('')).toBe(false);
  });
  it('whitespace-only → false', () => {
    expect(isEmotivePhrase('   ')).toBe(false);
  });
  it('null → false (no throw)', () => {
    expect(() => isEmotivePhrase(null as unknown as string)).not.toThrow();
    expect(isEmotivePhrase(null as unknown as string)).toBe(false);
  });
  it('undefined → false (no throw)', () => {
    expect(() => isEmotivePhrase(undefined as unknown as string)).not.toThrow();
    expect(isEmotivePhrase(undefined as unknown as string)).toBe(false);
  });
  it('non-string (number) → false (no throw)', () => {
    expect(() => isEmotivePhrase(42 as unknown as string)).not.toThrow();
    expect(isEmotivePhrase(42 as unknown as string)).toBe(false);
  });
});
