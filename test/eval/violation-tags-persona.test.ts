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
  reasonCode: 'persona-fabricated',
  dampenerFired: false,
  selfEchoFired: false,
  scopeGuardFired: false,
  botNotAddresseeFired: false,
  stickerLeakFired: false,
  hardGateFired: false,
  harassmentEscalationFired: false,
  personaFabricationFired: true,
  personaFabricatedInOutput: false,
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

describe('persona-fabrication-blocked tag', () => {
  it('silent + personaFabricationFired → emits persona-fabrication-blocked', () => {
    const tags = computeViolationTags(baseGold(), baseRow(), 'm1');
    expect(tags).toContain('persona-fabrication-blocked');
  });

  it('non-silent outcome with personaFabricationFired=true → no tag', () => {
    const row = baseRow({ resultKind: 'reply', personaFabricationFired: true });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('persona-fabrication-blocked');
  });

  it('silent + personaFabricationFired=false → no tag', () => {
    const row = baseRow({ reasonCode: 'guard', personaFabricationFired: false });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('persona-fabrication-blocked');
  });

  it('ALL_VIOLATION_TAGS contains persona-fabrication-blocked', () => {
    expect(ALL_VIOLATION_TAGS).toContain('persona-fabrication-blocked');
  });

  it('DENOMINATOR_RULES[persona-fabrication-blocked] accepts any outcome', () => {
    const rule = DENOMINATOR_RULES['persona-fabrication-blocked'];
    expect(rule).toBeDefined();
    expect(rule(baseGold(), baseRow({ resultKind: 'reply' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'silent' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'sticker' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'fallback' }))).toBe(true);
  });
});

describe('persona-fabricated-in-output tag', () => {
  it('reply + personaFabricatedInOutput → emits persona-fabricated-in-output', () => {
    const row = baseRow({
      resultKind: 'reply',
      reasonCode: 'engaged',
      replyText: '我22岁',
      personaFabricationFired: false,
      personaFabricatedInOutput: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).toContain('persona-fabricated-in-output');
  });

  it('fallback + personaFabricatedInOutput → emits persona-fabricated-in-output', () => {
    const row = baseRow({
      resultKind: 'fallback',
      reasonCode: 'pure-at',
      replyText: '女的22岁',
      personaFabricationFired: false,
      personaFabricatedInOutput: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).toContain('persona-fabricated-in-output');
  });

  it('silent never emits persona-fabricated-in-output', () => {
    const row = baseRow({
      resultKind: 'silent',
      personaFabricatedInOutput: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('persona-fabricated-in-output');
  });

  it('reply flag false → no tag', () => {
    const row = baseRow({
      resultKind: 'reply',
      reasonCode: 'engaged',
      replyText: 'hi',
      personaFabricationFired: false,
      personaFabricatedInOutput: false,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('persona-fabricated-in-output');
  });

  it('ALL_VIOLATION_TAGS contains persona-fabricated-in-output', () => {
    expect(ALL_VIOLATION_TAGS).toContain('persona-fabricated-in-output');
  });

  it('DENOMINATOR_RULES excludes silent and defer', () => {
    const rule = DENOMINATOR_RULES['persona-fabricated-in-output'];
    expect(rule).toBeDefined();
    expect(rule(baseGold(), baseRow({ resultKind: 'reply' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'sticker' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'fallback' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'silent' }))).toBe(false);
    expect(rule(baseGold(), baseRow({ resultKind: 'defer' }))).toBe(false);
  });
});
