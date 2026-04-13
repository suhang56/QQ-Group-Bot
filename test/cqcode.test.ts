import { describe, it, expect } from 'vitest';
import { parseAtMentions, resolveAtTarget } from '../src/utils/cqcode.js';

describe('parseAtMentions', () => {
  it('extracts single CQ:at UID', () => {
    expect(parseAtMentions('[CQ:at,qq=1301931012]')).toEqual(['1301931012']);
  });

  it('extracts multiple CQ:at UIDs in order', () => {
    expect(parseAtMentions('[CQ:at,qq=111][CQ:at,qq=222]')).toEqual(['111', '222']);
  });

  it('returns empty array when no CQ:at present', () => {
    expect(parseAtMentions('/mimic_on @nickname')).toEqual([]);
  });

  it('handles CQ:at with extra fields', () => {
    expect(parseAtMentions('[CQ:at,qq=9999,name=Alice]')).toEqual(['9999']);
  });

  it('is idempotent across multiple calls (regex lastIndex reset)', () => {
    const raw = '[CQ:at,qq=123]';
    expect(parseAtMentions(raw)).toEqual(['123']);
    expect(parseAtMentions(raw)).toEqual(['123']);
  });
});

describe('resolveAtTarget', () => {
  it('CQ:at code takes priority over args', () => {
    expect(resolveAtTarget('[CQ:at,qq=1301931012]', ['@sometext'])).toBe('1301931012');
  });

  it('falls back to plain numeric UID in args when no CQ code', () => {
    expect(resolveAtTarget('/mimic_on 1301931012', ['1301931012'])).toBe('1301931012');
  });

  it('falls back to @-prefixed arg when no CQ code and no plain UID', () => {
    expect(resolveAtTarget('/mimic_on @alice', ['@alice'])).toBe('alice');
  });

  it('returns null when no target found', () => {
    expect(resolveAtTarget('/mimic_on', [])).toBeNull();
  });

  it('uses first CQ:at match when multiple present', () => {
    expect(resolveAtTarget('[CQ:at,qq=111][CQ:at,qq=222]', [])).toBe('111');
  });
});
