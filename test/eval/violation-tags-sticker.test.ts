import { describe, it, expect } from 'vitest';
import {
  computeViolationTags,
  ALL_VIOLATION_TAGS,
  DENOMINATOR_RULES,
  type ProjectedRow,
} from '../../scripts/eval/violation-tags.js';
import type { GoldLabel } from '../../scripts/eval/gold/types.js';

const baseRow = (overrides: Partial<ProjectedRow> = {}): ProjectedRow => ({
  category: 1,
  resultKind: 'silent',
  utteranceAct: 'none',
  targetMsgId: null,
  matchedFactIds: null,
  replyText: null,
  reasonCode: 'sticker-leak-stripped',
  dampenerFired: false,
  selfEchoFired: false,
  scopeGuardFired: false,
  botNotAddresseeFired: false,
  stickerLeakFired: true,
  ...overrides,
});

const baseGold = (overrides: Partial<GoldLabel> = {}): GoldLabel => ({
  goldDecision: 'silent',
  goldAct: 'none',
  factNeeded: false,
  allowSticker: true,
  allowBanter: true,
  ...overrides,
} as GoldLabel);

describe('sticker-token-leak tag', () => {
  it('silent + stickerLeakFired → emits sticker-token-leak', () => {
    const tags = computeViolationTags(baseGold(), baseRow(), 'm1');
    expect(tags).toContain('sticker-token-leak');
  });

  it('reasonCode != sticker-leak-stripped (guard) → no sticker-token-leak tag', () => {
    const row = baseRow({ reasonCode: 'guard', stickerLeakFired: false });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('sticker-token-leak');
  });

  it('reasonCode dampener → no sticker-token-leak tag', () => {
    const row = baseRow({ reasonCode: 'dampener', stickerLeakFired: false, dampenerFired: true });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('sticker-token-leak');
  });

  it('reasonCode scope → no sticker-token-leak tag', () => {
    const row = baseRow({ reasonCode: 'scope', stickerLeakFired: false });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('sticker-token-leak');
  });

  it('non-silent outcome with stickerLeakFired=true → no tag (should be unreachable)', () => {
    const row = baseRow({ resultKind: 'reply', stickerLeakFired: true });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('sticker-token-leak');
  });

  it('ALL_VIOLATION_TAGS contains sticker-token-leak', () => {
    expect(ALL_VIOLATION_TAGS).toContain('sticker-token-leak');
  });

  it('DENOMINATOR_RULES has sticker-token-leak = always true (any outcome)', () => {
    expect(DENOMINATOR_RULES['sticker-token-leak']).toBeDefined();
    const rule = DENOMINATOR_RULES['sticker-token-leak'];
    expect(rule(baseGold(), baseRow({ resultKind: 'reply' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'silent' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'sticker' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'fallback' }))).toBe(true);
  });
});
