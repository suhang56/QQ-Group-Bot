import { describe, it, expect } from 'vitest';
import {
  computeViolationTags,
  ALL_VIOLATION_TAGS,
  DENOMINATOR_RULES,
  type ProjectedRow,
} from '../../scripts/eval/violation-tags.js';
import type { GoldLabel } from '../../scripts/eval/gold/types.js';

function gold(overrides: Partial<GoldLabel> = {}): GoldLabel {
  return {
    sampleId: '958751334:1',
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    targetOk: true,
    factNeeded: false,
    allowBanter: true,
    allowSticker: false,
    labeledAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

function row(overrides: Partial<ProjectedRow> = {}): ProjectedRow {
  return {
    category: 1,
    resultKind: 'reply',
    utteranceAct: 'unknown',
    targetMsgId: 'M1',
    matchedFactIds: [],
    replyText: '好的',
    reasonCode: 'engaged',
    dampenerFired: false,
    selfEchoFired: false,
    scopeGuardFired: false,
    botNotAddresseeFired: false,
    ...overrides,
  };
}

const TRIGGER_ID = 'M1';

describe('computeViolationTags — gold-silent-but-replied', () => {
  it('positive: gold silent + bot replied → fires', () => {
    const g = gold({ goldDecision: 'silent' });
    const r = row({ resultKind: 'reply' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('gold-silent-but-replied');
  });
  it('negative: gold silent + bot silent → no fire', () => {
    const g = gold({ goldDecision: 'silent' });
    const r = row({ resultKind: 'silent' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('gold-silent-but-replied');
  });
});

describe('computeViolationTags — gold-defer-but-replied', () => {
  it('positive: gold defer + bot sticker → fires (sticker outputted)', () => {
    const g = gold({ goldDecision: 'defer' });
    const r = row({ resultKind: 'sticker' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('gold-defer-but-replied');
  });
  it('negative: gold defer + bot silent → no fire (silent is compliant)', () => {
    const g = gold({ goldDecision: 'defer' });
    const r = row({ resultKind: 'silent' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('gold-defer-but-replied');
  });
});

describe('computeViolationTags — direct-at-silenced (aggregate)', () => {
  it('positive: cat1 + bot silent → fires', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'timing' });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).toContain('direct-at-silenced');
  });
  it('negative: cat5 + bot silent → no fire', () => {
    const r = row({ category: 5, resultKind: 'silent', reasonCode: 'timing' });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).not.toContain('direct-at-silenced');
  });
});

describe('computeViolationTags — direct-at-silenced cause split (R2a)', () => {
  it('reasonCode=timing → by-timing (not by-abuse, not by-guard)', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'timing' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('direct-at-silenced');
    expect(out).toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-abuse');
    expect(out).not.toContain('direct-at-silenced-by-guard');
  });
  it('reasonCode=bot-triggered → by-abuse', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'bot-triggered' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('direct-at-silenced');
    expect(out).toContain('direct-at-silenced-by-abuse');
    expect(out).not.toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-guard');
  });
  it('reasonCode=guard → by-guard', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'guard' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('direct-at-silenced');
    expect(out).toContain('direct-at-silenced-by-guard');
    expect(out).not.toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-abuse');
  });
  it('reasonCode=confabulation (other) → aggregate fires, no sub-tag', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'confabulation' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('direct-at-silenced');
    expect(out).not.toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-abuse');
    expect(out).not.toContain('direct-at-silenced-by-guard');
  });
  it('cat5 + silent + reasonCode=timing → NO fire (category gate)', () => {
    const r = row({ category: 5, resultKind: 'silent', reasonCode: 'timing' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).not.toContain('direct-at-silenced');
    expect(out).not.toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-abuse');
    expect(out).not.toContain('direct-at-silenced-by-guard');
  });
  it('cat1 + reply (not silent) → no fire', () => {
    const r = row({ category: 1, resultKind: 'reply', reasonCode: 'timing' });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).not.toContain('direct-at-silenced');
    expect(out).not.toContain('direct-at-silenced-by-timing');
  });
  it('reasonCode=null → aggregate only, no sub-tag', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: null });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('direct-at-silenced');
    expect(out).not.toContain('direct-at-silenced-by-timing');
    expect(out).not.toContain('direct-at-silenced-by-abuse');
    expect(out).not.toContain('direct-at-silenced-by-guard');
  });
});

describe('computeViolationTags — fact-needed-no-fact', () => {
  it('positive: factNeeded + reply + no matched → fires', () => {
    const g = gold({ factNeeded: true });
    const r = row({ resultKind: 'reply', matchedFactIds: [] });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('fact-needed-no-fact');
  });
  it('negative: factNeeded + reply + has matched → no fire', () => {
    const g = gold({ factNeeded: true });
    const r = row({ resultKind: 'reply', matchedFactIds: [42] });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('fact-needed-no-fact');
  });
});

describe('computeViolationTags — fact-not-needed-used-fact', () => {
  it('positive: !factNeeded + reply + matched>0 → fires', () => {
    const g = gold({ factNeeded: false });
    const r = row({ resultKind: 'reply', matchedFactIds: [1] });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('fact-not-needed-used-fact');
  });
  it('negative: !factNeeded + reply + no matched → no fire', () => {
    const g = gold({ factNeeded: false });
    const r = row({ resultKind: 'reply', matchedFactIds: [] });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('fact-not-needed-used-fact');
  });
});

describe('computeViolationTags — sticker-when-not-allowed', () => {
  it('positive: !allowSticker + sticker → fires', () => {
    const g = gold({ allowSticker: false });
    const r = row({ resultKind: 'sticker' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('sticker-when-not-allowed');
  });
  it('negative: allowSticker + sticker → no fire', () => {
    const g = gold({ allowSticker: true });
    const r = row({ resultKind: 'sticker' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('sticker-when-not-allowed');
  });
});

describe('computeViolationTags — banter-when-not-allowed', () => {
  it('positive: !allowBanter + reply with 哈哈 → fires', () => {
    const g = gold({ allowBanter: false });
    const r = row({ resultKind: 'reply', replyText: '哈哈' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('banter-when-not-allowed');
  });
  it('negative: !allowBanter + reply without banter → no fire', () => {
    const g = gold({ allowBanter: false });
    const r = row({ resultKind: 'reply', replyText: '好的' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('banter-when-not-allowed');
  });
});

describe('computeViolationTags — object-react-missed', () => {
  it('positive: goldAct object_react + reply → fires', () => {
    const g = gold({ goldAct: 'object_react' });
    const r = row({ resultKind: 'reply' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('object-react-missed');
  });
  it('negative: goldAct object_react + sticker → no fire', () => {
    const g = gold({ goldAct: 'object_react', allowSticker: true });
    const r = row({ resultKind: 'sticker' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('object-react-missed');
  });
});

describe('computeViolationTags — meta-status-misclassified', () => {
  it('positive: meta_admin_status + reply + unknown utteranceAct → fires', () => {
    const g = gold({ goldAct: 'meta_admin_status' });
    const r = row({ resultKind: 'reply', utteranceAct: 'unknown' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('meta-status-misclassified');
  });
  it('negative: meta_admin_status + reply + meta_admin_status utteranceAct → no fire', () => {
    const g = gold({ goldAct: 'meta_admin_status' });
    const r = row({ resultKind: 'reply', utteranceAct: 'meta_admin_status' });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('meta-status-misclassified');
  });
});

describe('computeViolationTags — target-mismatch', () => {
  it('positive: reply + targetMsgId != triggerMessageId → fires', () => {
    const r = row({ resultKind: 'reply', targetMsgId: 'OTHER' });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).toContain('target-mismatch');
  });
  it('negative: targetMsgId === triggerMessageId → no fire', () => {
    const r = row({ resultKind: 'reply', targetMsgId: TRIGGER_ID });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).not.toContain('target-mismatch');
  });
  it('negative: targetMsgId null → no fire', () => {
    const r = row({ resultKind: 'reply', targetMsgId: null });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).not.toContain('target-mismatch');
  });
  it('negative: targetMsgId empty string → no fire (defer edge)', () => {
    const r = row({ resultKind: 'reply', targetMsgId: '' });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).not.toContain('target-mismatch');
  });
  it('negative: bot silent → no fire even with mismatch', () => {
    const r = row({ resultKind: 'silent', targetMsgId: 'OTHER' });
    expect(computeViolationTags(gold(), r, TRIGGER_ID)).not.toContain('target-mismatch');
  });
});

describe('computeViolationTags — edge cases', () => {
  it('error-kind row → no tags', () => {
    const r = row({ resultKind: 'error' });
    const out = computeViolationTags(gold({ goldDecision: 'silent' }), r, TRIGGER_ID);
    expect(out).toEqual([]);
  });
  it('multiple predicates fire → all present in declaration order', () => {
    const g = gold({ goldDecision: 'silent', factNeeded: true, allowBanter: false });
    const r = row({ resultKind: 'reply', matchedFactIds: [], replyText: '哈哈' });
    const out = computeViolationTags(g, r, TRIGGER_ID);
    // Check order follows ALL_VIOLATION_TAGS
    const expectedOrder = ALL_VIOLATION_TAGS.filter(t => out.includes(t));
    expect(out).toEqual(expectedOrder);
    expect(out).toContain('gold-silent-but-replied');
    expect(out).toContain('fact-needed-no-fact');
    expect(out).toContain('banter-when-not-allowed');
  });
  it('matchedFactIds null + reply + factNeeded → fires (treated as 0 length)', () => {
    const g = gold({ factNeeded: true });
    const r = row({ resultKind: 'reply', matchedFactIds: null });
    expect(computeViolationTags(g, r, TRIGGER_ID)).toContain('fact-needed-no-fact');
  });
  it('matchedFactIds null + silent → fact tag does not fire', () => {
    const g = gold({ factNeeded: true });
    const r = row({ resultKind: 'silent', matchedFactIds: null });
    expect(computeViolationTags(g, r, TRIGGER_ID)).not.toContain('fact-needed-no-fact');
  });
});

describe('DENOMINATOR_RULES coverage', () => {
  it('exports rule for every tag', () => {
    for (const t of ALL_VIOLATION_TAGS) {
      expect(typeof DENOMINATOR_RULES[t]).toBe('function');
    }
  });
  it('exposes exactly 18 tags (10 base + 3 R2a cause-split + 4 R2.5 guards + 1 PR1 sticker-leak)', () => {
    expect(ALL_VIOLATION_TAGS.length).toBe(18);
  });
});

describe('computeViolationTags — R2.5 guard cause-split', () => {
  it('positive: cat1 + silent + dampenerFired → fires repeated-low-info-direct-overreply', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'dampener', dampenerFired: true });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .toContain('repeated-low-info-direct-overreply');
  });
  it('negative: cat1 + reply + dampenerFired → no fire (silence-success gate)', () => {
    const r = row({ category: 1, resultKind: 'reply', dampenerFired: true });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .not.toContain('repeated-low-info-direct-overreply');
  });

  it('positive: silent + selfEchoFired → fires self-amplified-annoyance', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'self-echo', selfEchoFired: true });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .toContain('self-amplified-annoyance');
  });
  it('negative: reply + selfEchoFired=false → no fire', () => {
    const r = row({ resultKind: 'reply', selfEchoFired: false });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .not.toContain('self-amplified-annoyance');
  });

  it('positive: silent + scopeGuardFired → fires group-address-in-small-scene', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'scope', scopeGuardFired: true });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .toContain('group-address-in-small-scene');
  });

  it('positive: silent + botNotAddresseeFired → fires bot-not-addressee-replied', () => {
    const r = row({ category: 1, resultKind: 'silent', reasonCode: 'scope', botNotAddresseeFired: true });
    expect(computeViolationTags(gold(), r, TRIGGER_ID))
      .toContain('bot-not-addressee-replied');
  });

  it('multiple guards fire independently + all present in declaration order', () => {
    const r = row({
      category: 1, resultKind: 'silent', reasonCode: 'scope',
      scopeGuardFired: true, botNotAddresseeFired: true,
    });
    const out = computeViolationTags(gold(), r, TRIGGER_ID);
    expect(out).toContain('group-address-in-small-scene');
    expect(out).toContain('bot-not-addressee-replied');
    const iScope = out.indexOf('group-address-in-small-scene');
    const iBot = out.indexOf('bot-not-addressee-replied');
    expect(iScope).toBeLessThan(iBot);
  });

  it('denominator — SF1 guard denominator gates on category===1', () => {
    expect(DENOMINATOR_RULES['repeated-low-info-direct-overreply'](gold(), row({ category: 1 })))
      .toBe(true);
    expect(DENOMINATOR_RULES['repeated-low-info-direct-overreply'](gold(), row({ category: 5 })))
      .toBe(false);
  });

  it('denominator — SF2 (self-amplified) denominator wider: reply OR silent', () => {
    expect(DENOMINATOR_RULES['self-amplified-annoyance'](gold(), row({ resultKind: 'reply' })))
      .toBe(true);
    expect(DENOMINATOR_RULES['self-amplified-annoyance'](gold(), row({ resultKind: 'silent' })))
      .toBe(true);
    expect(DENOMINATOR_RULES['self-amplified-annoyance'](gold(), row({ resultKind: 'sticker' })))
      .toBe(false);
  });
});
