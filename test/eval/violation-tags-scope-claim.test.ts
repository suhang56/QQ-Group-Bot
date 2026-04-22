import { describe, it, expect } from 'vitest';
import { computeViolationTags, ALL_VIOLATION_TAGS, DENOMINATOR_RULES, type ProjectedRow } from '../../scripts/eval/violation-tags.js';
import type { GoldLabel } from '../../scripts/eval/gold/types.js';

const BASE_GOLD: GoldLabel = {
  sampleId: 's1',
  goldDecision: 'reply',
  goldAct: 'other',
  factNeeded: false,
  allowSticker: true,
  allowBanter: true,
  allowMimic: null,
  policyVersion: 'v1',
  confidenceNotes: '',
  source: 'human',
  goldTarget: null,
  groundingTerms: [],
  mimicRecall: null,
} as unknown as GoldLabel;

function baseRow(overrides: Partial<ProjectedRow> = {}): ProjectedRow {
  return {
    category: 1,
    resultKind: 'silent',
    utteranceAct: 'none',
    targetMsgId: null,
    matchedFactIds: null,
    replyText: null,
    reasonCode: null,
    dampenerFired: false,
    selfEchoFired: false,
    scopeGuardFired: false,
    botNotAddresseeFired: false,
    stickerLeakFired: false,
    hardGateFired: false,
    harassmentEscalationFired: false,
    personaFabricationFired: false,
    personaFabricatedInOutput: false,
    selfCenteredScopeFired: false,
    templateFamilyFired: false,
    ...overrides,
  };
}

describe('R2.5.1 violation tags', () => {
  it('silent + selfCenteredScopeFired → emits self-centered-scope-claim', () => {
    const row = baseRow({ resultKind: 'silent', selfCenteredScopeFired: true, reasonCode: 'scope-claim-self-centered' });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).toContain('self-centered-scope-claim');
  });

  it('reply + selfCenteredScopeFired → does NOT emit (silent gate)', () => {
    const row = baseRow({ resultKind: 'reply', selfCenteredScopeFired: true, replyText: '又来了' });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).not.toContain('self-centered-scope-claim');
  });

  it('silent + templateFamilyFired → emits annoyed-template-consecutive', () => {
    const row = baseRow({ resultKind: 'silent', templateFamilyFired: true, reasonCode: 'template-family-cooldown' });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).toContain('annoyed-template-consecutive');
  });

  it('reply + templateFamilyFired → does NOT emit', () => {
    const row = baseRow({ resultKind: 'reply', templateFamilyFired: true, replyText: '烦死了' });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).not.toContain('annoyed-template-consecutive');
  });

  it('both Group B + TEMPLATE fire on same row → both tags emitted (non-short-circuit)', () => {
    const row = baseRow({
      resultKind: 'silent',
      selfCenteredScopeFired: true,
      templateFamilyFired: true,
    });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).toContain('self-centered-scope-claim');
    expect(tags).toContain('annoyed-template-consecutive');
  });

  it('ALL_VIOLATION_TAGS includes both new tags', () => {
    expect(ALL_VIOLATION_TAGS).toContain('self-centered-scope-claim');
    expect(ALL_VIOLATION_TAGS).toContain('annoyed-template-consecutive');
  });

  it('DENOMINATOR_RULES: final-send-filter semantics — any outcome qualifies', () => {
    const scSilent = baseRow({ resultKind: 'silent' });
    const scReply = baseRow({ resultKind: 'reply', replyText: 'x' });
    const tpReply = baseRow({ resultKind: 'reply', replyText: 'x' });
    expect(DENOMINATOR_RULES['self-centered-scope-claim']!(BASE_GOLD, scSilent)).toBe(true);
    expect(DENOMINATOR_RULES['self-centered-scope-claim']!(BASE_GOLD, scReply)).toBe(true);
    expect(DENOMINATOR_RULES['annoyed-template-consecutive']!(BASE_GOLD, tpReply)).toBe(true);
  });

  it('Group A plural-you reasonCode flows into scopeGuardFired (legacy group-address-in-small-scene tag)', () => {
    // This exercises the replay-runner-core derivation. We simulate the
    // post-derivation ProjectedRow directly (the derivation itself is
    // integration-tested elsewhere via replay-runner-mock).
    const row = baseRow({ resultKind: 'silent', scopeGuardFired: true });
    const tags = computeViolationTags(BASE_GOLD, row, 'trig-1');
    expect(tags).toContain('group-address-in-small-scene');
  });
});
