import { describe, it, expect } from 'vitest';
import { expandDateTokens } from '../../src/utils/query-date-expand.js';

describe('expandDateTokens', () => {
  it('T1: 618 → alternates [6月18号, 6月18日, 6月]; baseQuery preserved', () => {
    const out = expandDateTokens('618');
    expect(out.baseQuery).toBe('618');
    expect(out.alternates).toEqual(['6月18号', '6月18日', '6月']);
  });

  it('T2: 6/18 → same alternates; baseQuery preserved', () => {
    const out = expandDateTokens('6/18');
    expect(out.baseQuery).toBe('6/18');
    expect(out.alternates).toEqual(['6月18号', '6月18日', '6月']);
  });

  it('T3: 6-18 → same alternates; baseQuery preserved', () => {
    const out = expandDateTokens('6-18');
    expect(out.baseQuery).toBe('6-18');
    expect(out.alternates).toEqual(['6月18号', '6月18日', '6月']);
  });

  it('T4: motivating live case — baseQuery preserved verbatim, alternates contain canonicals', () => {
    const out = expandDateTokens('618附近有哪些live');
    expect(out.baseQuery).toBe('618附近有哪些live');
    expect(out.alternates).toContain('6月18号');
    expect(out.alternates).toContain('6月18日');
    expect(out.alternates).toContain('6月');
  });

  it('T5: idempotent — query already canonical 6月18号 returns empty alternates', () => {
    const out = expandDateTokens('6月18号有什么活动');
    expect(out.baseQuery).toBe('6月18号有什么活动');
    expect(out.alternates).toEqual([]);
  });

  it('T6: invalid day — 999 (month=9, day=99) returns empty alternates', () => {
    const out = expandDateTokens('999');
    expect(out.baseQuery).toBe('999');
    expect(out.alternates).toEqual([]);
  });

  it('T7: 4-digit leading-zero form — 0618 expands to 6/18 alternates', () => {
    const out = expandDateTokens('0618');
    expect(out.alternates).toContain('6月18号');
    expect(out.alternates).toContain('6月18日');
    expect(out.alternates).toContain('6月');
  });

  it('T8: phone number false-positive guard — 13800138000 returns empty alternates', () => {
    const out = expandDateTokens('13800138000');
    expect(out.baseQuery).toBe('13800138000');
    expect(out.alternates).toEqual([]);
  });

  it('T9: max-boundary date — 12/31 expands to 12月31号 12月31日 12月', () => {
    const out = expandDateTokens('12/31');
    expect(out.baseQuery).toBe('12/31');
    expect(out.alternates).toEqual(['12月31号', '12月31日', '12月']);
  });

  it('T10: mixed canonical + new — 6月18号 还有 6/19 only emits 6/19 alternates', () => {
    const out = expandDateTokens('6月18号 还有 6/19');
    expect(out.alternates).toContain('6月19号');
    expect(out.alternates).toContain('6月19日');
    // 6月18 already canonical — must NOT appear in alternates
    expect(out.alternates).not.toContain('6月18号');
    expect(out.alternates).not.toContain('6月18日');
  });

  it('T11: multiple compact tokens — 618 1231 expands both', () => {
    const out = expandDateTokens('618 1231');
    expect(out.alternates).toContain('6月18号');
    expect(out.alternates).toContain('12月31号');
    expect(out.alternates).toContain('12月');
  });

  it('T12 (edge): empty string returns empty baseQuery and empty alternates', () => {
    const out = expandDateTokens('');
    expect(out.baseQuery).toBe('');
    expect(out.alternates).toEqual([]);
  });

  it('T13: invalid month/day — 13/40 and 0/0 return empty alternates', () => {
    expect(expandDateTokens('13/40').alternates).toEqual([]);
    expect(expandDateTokens('0/0').alternates).toEqual([]);
  });

  it('T14 (edge): MAX_DATES cap — 5+ distinct dates only first 4 expand (12 alternates total)', () => {
    // Five distinct dates: 1/1, 2/2, 3/3, 4/4, 5/5
    const out = expandDateTokens('1/1 2/2 3/3 4/4 5/5');
    expect(out.alternates).toContain('1月1号');
    expect(out.alternates).toContain('2月2号');
    expect(out.alternates).toContain('3月3号');
    expect(out.alternates).toContain('4月4号');
    // 5th date must NOT be expanded
    expect(out.alternates).not.toContain('5月5号');
    expect(out.alternates).not.toContain('5月5日');
    // 4 dates × 3 forms each = 12 alternates
    expect(out.alternates).toHaveLength(12);
  });
});
