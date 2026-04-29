import { describe, it, expect } from 'vitest';
import { HEDGE_RE as UTIL_HEDGE_RE } from '../../src/utils/hedge-pattern.js';
import { HEDGE_RE as JARGON_HEDGE_RE } from '../../src/modules/jargon-miner.js';

describe('HEDGE_RE shared util', () => {
  it('t1: byte-equal regression — jargon-miner re-exports the same regex literal', () => {
    expect(UTIL_HEDGE_RE.toString()).toBe(JARGON_HEDGE_RE.toString());
    expect(UTIL_HEDGE_RE).toBe(JARGON_HEDGE_RE);
  });

  it('t2: positive samples — hedge phrases match', () => {
    expect(UTIL_HEDGE_RE.test('无法判断这个梗的起源')).toBe(true);
    expect(UTIL_HEDGE_RE.test('需要更多上下文才能判断')).toBe(true);
    expect(UTIL_HEDGE_RE.test('UUID-标识')).toBe(true);
    expect(UTIL_HEDGE_RE.test('我不确定要不要去')).toBe(true);
  });

  it('t2: negative samples — clean phrases do NOT match', () => {
    expect(UTIL_HEDGE_RE.test('这个梗起源于群主的一次失误')).toBe(false);
    expect(UTIL_HEDGE_RE.test('最多或不确定的某事')).toBe(false);
  });
});
