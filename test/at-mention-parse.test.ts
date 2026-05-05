/**
 * at-mention-parse.test.ts
 *
 * Unit tests for the CQ:at parsing helpers used by the addressee-other
 * guard in chat.ts. Pure functions — no DB, no Claude, no module wiring.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAtTargets,
  hasOnlyOtherUserAtMention,
  botIsAtTarget,
} from '../src/utils/at-mention-parse.js';

describe('parseAtTargets', () => {
  it('T1: returns empty array on empty input', () => {
    expect(parseAtTargets('')).toEqual([]);
  });

  it('T2: extracts a single qq target', () => {
    expect(parseAtTargets('[CQ:at,qq=12345]')).toEqual(['12345']);
  });

  it('T3: dedupes repeated targets, preserves insertion order', () => {
    expect(parseAtTargets('[CQ:at,qq=111] [CQ:at,qq=222] [CQ:at,qq=111]'))
      .toEqual(['111', '222']);
  });

  it('T4: ignores trailing fields after qq= value', () => {
    expect(parseAtTargets('[CQ:at,qq=12345,name=foo] hi'))
      .toEqual(['12345']);
  });

  it('T5: extracts the literal "all" broadcast token', () => {
    expect(parseAtTargets('[CQ:at,qq=all]')).toEqual(['all']);
  });

  it('T6: ignores non-at CQ tags', () => {
    expect(parseAtTargets('[CQ:reply,id=99] hello')).toEqual([]);
  });
});

describe('hasOnlyOtherUserAtMention', () => {
  it('T7: true when only other-user is @-targeted', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=999] hi', '123')).toBe(true);
  });

  it('T8: false when bot is the @-target', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=123]', '123')).toBe(false);
  });

  it('T9: false on @all (broadcast, not directed)', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=all]', '123')).toBe(false);
  });

  it('T10: false when no @-mention exists', () => {
    expect(hasOnlyOtherUserAtMention('', '123')).toBe(false);
  });

  it('T11: false when botUserId is null (fail-open)', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=999]', null)).toBe(false);
  });

  it('T11b: false when bot AND other are both @-targeted (mixed)', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=123][CQ:at,qq=999]', '123')).toBe(false);
  });

  it('T11c: true on multi-other-target without bot', () => {
    expect(hasOnlyOtherUserAtMention('[CQ:at,qq=999][CQ:at,qq=888]', '123')).toBe(true);
  });
});

describe('botIsAtTarget', () => {
  it('T12: true when bot is among targets', () => {
    expect(botIsAtTarget('[CQ:at,qq=123] hi', '123')).toBe(true);
  });

  it('T13: false when bot is not among targets', () => {
    expect(botIsAtTarget('[CQ:at,qq=999] hi', '123')).toBe(false);
  });

  it('T13b: false when botUserId is null', () => {
    expect(botIsAtTarget('[CQ:at,qq=123]', null)).toBe(false);
  });
});

describe('regex /g lastIndex statefulness', () => {
  it('repeated calls with the same input yield identical results', () => {
    const raw = '[CQ:at,qq=111] [CQ:at,qq=222]';
    const first = parseAtTargets(raw);
    const second = parseAtTargets(raw);
    const third = parseAtTargets(raw);
    expect(first).toEqual(['111', '222']);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
