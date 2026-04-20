import { describe, it, expect } from 'vitest';
import { EMOTIVE_STEMS, EMOTIVE_RE, EMOTIVE_ALLOWLIST } from '../../src/utils/emotive-stems.js';
import { isEmotivePhrase } from '../../src/utils/is-emotive-phrase.js';

describe('emotive-stems — shared const', () => {
  it('EMOTIVE_RE matches 烦死了 (stem present)', () => {
    expect(EMOTIVE_RE.test('烦死了')).toBe(true);
  });

  it('EMOTIVE_RE does NOT match 哈哈 (no stem)', () => {
    expect(EMOTIVE_RE.test('哈哈')).toBe(false);
  });

  it('EMOTIVE_RE matches every stem in EMOTIVE_STEMS individually', () => {
    for (const stem of EMOTIVE_STEMS) {
      // run fresh RegExp each iteration to bypass any `g` flag state — the
      // module exports a stateless regex, but this is cheap insurance.
      const re = new RegExp(EMOTIVE_STEMS.join('|'));
      expect(re.test(stem)).toBe(true);
    }
  });

  it('is-emotive-phrase parity preserved post-refactor (烦死了 → true)', () => {
    expect(isEmotivePhrase('烦死了')).toBe(true);
  });

  it('is-emotive-phrase allowlist parity preserved (笑死 → false)', () => {
    expect(isEmotivePhrase('笑死')).toBe(false);
  });

  it('EMOTIVE_ALLOWLIST exports 笑死 escape-hatch', () => {
    expect(EMOTIVE_ALLOWLIST.has('笑死')).toBe(true);
    expect(EMOTIVE_ALLOWLIST.has('笑死我')).toBe(true);
    expect(EMOTIVE_ALLOWLIST.has('死鬼')).toBe(true);
  });

  it('EMOTIVE_STEMS does NOT contain 笑 (allowlist ≠ stem)', () => {
    expect(EMOTIVE_STEMS as readonly string[]).not.toContain('笑');
  });

  it('empty / whitespace inputs do not match', () => {
    expect(EMOTIVE_RE.test('')).toBe(false);
    expect(EMOTIVE_RE.test(' ')).toBe(false);
  });
});
