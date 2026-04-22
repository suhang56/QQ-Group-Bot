import { describe, it, expect } from 'vitest';
import { isSocialPhrase, SOCIAL_PHRASE_ALLOWLIST } from '../../src/utils/social-phrase.js';

describe('isSocialPhrase', () => {
  it('fires on each allowlist entry (exact match only)', () => {
    for (const term of SOCIAL_PHRASE_ALLOWLIST) {
      expect(isSocialPhrase(term)).toBe(true);
    }
  });

  it('fires: 贴贴', () => expect(isSocialPhrase('贴贴')).toBe(true));
  it('fires: 宝宝', () => expect(isSocialPhrase('宝宝')).toBe(true));
  it('fires: 晚安', () => expect(isSocialPhrase('晚安')).toBe(true));
  it('fires: 早安', () => expect(isSocialPhrase('早安')).toBe(true));
  it('fires: 晚上好', () => expect(isSocialPhrase('晚上好')).toBe(true));
  it('fires: 我喜欢你', () => expect(isSocialPhrase('我喜欢你')).toBe(true));
  it('fires: 么么哒', () => expect(isSocialPhrase('么么哒')).toBe(true));
  it('fires: 抱抱', () => expect(isSocialPhrase('抱抱')).toBe(true));

  it('does NOT fire: ykn (fandom alias)', () => expect(isSocialPhrase('ykn')).toBe(false));
  it('does NOT fire: Roselia', () => expect(isSocialPhrase('Roselia')).toBe(false));
  it('does NOT fire: empty', () => expect(isSocialPhrase('')).toBe(false));
  it('does NOT fire: whitespace', () => expect(isSocialPhrase('  ')).toBe(false));
  it('does NOT fire: non-string', () => {
    expect(isSocialPhrase(null)).toBe(false);
    expect(isSocialPhrase(undefined)).toBe(false);
    expect(isSocialPhrase(123)).toBe(false);
  });

  // Exact-match semantics: prefix / suffix / embed must NOT match.
  it('does NOT fire: 晚安啊 (trailing particle)', () => expect(isSocialPhrase('晚安啊')).toBe(false));
  it('does NOT fire: 好的晚安 (leading content)', () => expect(isSocialPhrase('好的晚安')).toBe(false));
  it('does NOT fire: 宝宝们 (plural suffix)', () => expect(isSocialPhrase('宝宝们')).toBe(false));
  it('does NOT fire: 大宝宝 (prefix)', () => expect(isSocialPhrase('大宝宝')).toBe(false));
  it('does NOT fire: 我喜欢你呀 (trailing)', () => expect(isSocialPhrase('我喜欢你呀')).toBe(false));
});
