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
  reasonCode: 'hard-gate-blocked',
  dampenerFired: false,
  selfEchoFired: false,
  scopeGuardFired: false,
  botNotAddresseeFired: false,
  stickerLeakFired: false,
  hardGateFired: true,
  harassmentEscalationFired: false,
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

describe('hard-gate-blocked tag', () => {
  it('silent + hardGateFired → emits hard-gate-blocked', () => {
    const tags = computeViolationTags(baseGold(), baseRow(), 'm1');
    expect(tags).toContain('hard-gate-blocked');
  });

  it('non-silent outcome with hardGateFired=true → no tag (unreachable in practice)', () => {
    const row = baseRow({ resultKind: 'reply', hardGateFired: true });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('hard-gate-blocked');
  });

  it('silent + reasonCode != hard-gate-blocked → no tag', () => {
    const row = baseRow({ reasonCode: 'guard', hardGateFired: false });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('hard-gate-blocked');
  });

  it('ALL_VIOLATION_TAGS contains hard-gate-blocked', () => {
    expect(ALL_VIOLATION_TAGS).toContain('hard-gate-blocked');
  });

  it('DENOMINATOR_RULES[hard-gate-blocked] accepts any outcome', () => {
    const rule = DENOMINATOR_RULES['hard-gate-blocked'];
    expect(rule).toBeDefined();
    expect(rule(baseGold(), baseRow({ resultKind: 'reply' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'silent' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'sticker' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'fallback' }))).toBe(true);
  });
});

describe('harassment-escalation tag', () => {
  it('reply + harassmentEscalationFired → emits harassment-escalation', () => {
    const row = baseRow({
      resultKind: 'reply',
      reasonCode: 'engaged',
      replyText: '怡你妈',
      hardGateFired: false,
      harassmentEscalationFired: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).toContain('harassment-escalation');
  });

  it('fallback + harassmentEscalationFired → emits harassment-escalation', () => {
    const row = baseRow({
      resultKind: 'fallback',
      reasonCode: 'pure-at',
      replyText: '闭嘴',
      hardGateFired: false,
      harassmentEscalationFired: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).toContain('harassment-escalation');
  });

  it('silent outcome never emits harassment-escalation', () => {
    const row = baseRow({
      resultKind: 'silent',
      harassmentEscalationFired: true,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('harassment-escalation');
  });

  it('reply but flag false → no tag', () => {
    const row = baseRow({
      resultKind: 'reply',
      reasonCode: 'engaged',
      replyText: 'hi',
      hardGateFired: false,
      harassmentEscalationFired: false,
    });
    const tags = computeViolationTags(baseGold(), row, 'm1');
    expect(tags).not.toContain('harassment-escalation');
  });

  it('ALL_VIOLATION_TAGS contains harassment-escalation', () => {
    expect(ALL_VIOLATION_TAGS).toContain('harassment-escalation');
  });

  it('DENOMINATOR_RULES excludes silent rows', () => {
    const rule = DENOMINATOR_RULES['harassment-escalation'];
    expect(rule).toBeDefined();
    expect(rule(baseGold(), baseRow({ resultKind: 'reply' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'sticker' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'fallback' }))).toBe(true);
    expect(rule(baseGold(), baseRow({ resultKind: 'silent' }))).toBe(false);
    expect(rule(baseGold(), baseRow({ resultKind: 'defer' }))).toBe(false);
  });
});
