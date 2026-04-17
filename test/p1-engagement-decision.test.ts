import { describe, it, expect } from 'vitest';
import {
  makeEngagementDecision,
  MAX_CONSECUTIVE_BOT_REPLIES,
  type EngagementSignals,
} from '../src/modules/engagement-decision.js';
import { scoreComprehension, type ComprehensionContext } from '../src/services/comprehension-scorer.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BASE_SIGNALS: EngagementSignals = {
  isMention: false,
  isReplyToBot: false,
  participationScore: 0.8,
  minScore: 0.5,
  isShortAck: false,
  isMetaCommentary: false,
  isPicBotCommand: false,
  comprehensionScore: 0.7,
  isAdversarial: false,
  isPureAtMention: false,
  lastSpeechIgnored: false,
  consecutiveReplyCount: 0,
  activityLevel: 'normal',
  relevanceOverride: null,
  addresseeIsOther: false,
  awkwardVeto: false,
};

function signals(overrides: Partial<EngagementSignals>): EngagementSignals {
  return { ...BASE_SIGNALS, ...overrides };
}

// ── engagement-decision ────────────────────────────────────────────────

describe('makeEngagementDecision', () => {
  it('engage when score above threshold and comprehension OK', () => {
    const d = makeEngagementDecision(signals({}));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('skip when score below threshold', () => {
    const d = makeEngagementDecision(signals({ participationScore: 0.3 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  it('engage when direct mention regardless of score', () => {
    const d = makeEngagementDecision(signals({ isMention: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('engage when reply-to-bot regardless of score', () => {
    const d = makeEngagementDecision(signals({ isReplyToBot: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('skip for short ack (non-direct)', () => {
    const d = makeEngagementDecision(signals({ isShortAck: true }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  it('skip for meta-commentary', () => {
    const d = makeEngagementDecision(signals({ isMetaCommentary: true }));
    expect(d.shouldReply).toBe(false);
  });

  it('skip for pic-bot command', () => {
    const d = makeEngagementDecision(signals({ isPicBotCommand: true }));
    expect(d.shouldReply).toBe(false);
  });

  it('react for adversarial pattern', () => {
    const d = makeEngagementDecision(signals({ isAdversarial: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
  });

  it('react for pure @-mention', () => {
    const d = makeEngagementDecision(signals({ isPureAtMention: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
  });

  // Low comprehension cases
  it('skip when low comprehension and not direct', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.1, participationScore: 0.8 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('low comprehension');
  });

  it('react when low comprehension but @-mention', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.1, isMention: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
    expect(d.reason).toContain('low comprehension');
  });

  it('react when low comprehension but reply-to-bot', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.1, isReplyToBot: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
  });

  it('adversarial bypasses comprehension check', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.0, isAdversarial: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
    expect(d.reason).toContain('adversarial');
  });

  it('boundary: comprehension exactly at threshold (0.3) passes', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.3 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('boundary: comprehension just below threshold (0.29) fails', () => {
    const d = makeEngagementDecision(signals({ comprehensionScore: 0.29 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  // ── Gate 5.5: ignored-suppression (R3) ─────────────────────────────────
  it('skip when last speech ignored and not direct', () => {
    const d = makeEngagementDecision(signals({ lastSpeechIgnored: true, participationScore: 2.0 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('ignored');
  });

  it('direct @-mention overrides ignored-suppression', () => {
    const d = makeEngagementDecision(signals({ lastSpeechIgnored: true, isMention: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('direct reply-to-bot overrides ignored-suppression', () => {
    const d = makeEngagementDecision(signals({ lastSpeechIgnored: true, isReplyToBot: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('lastSpeechIgnored=false → normal scoring path', () => {
    const d = makeEngagementDecision(signals({ lastSpeechIgnored: false, participationScore: 1.2 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('ignored-suppression applied AFTER adversarial react (adversarial still reacts)', () => {
    // Adversarial gate runs at Gate 3 (before 5.5), so adversarial still reacts even when ignored.
    const d = makeEngagementDecision(signals({ lastSpeechIgnored: true, isAdversarial: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
  });

  // ── Gate 5.6 (M6.4): consecutive bot-reply cap ────────────────────────
  it('M6.4: skip when consecutive-reply cap reached and not direct', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES,
      participationScore: 2.0,
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('consecutive-reply cap');
    expect(d.reason).toContain(`${MAX_CONSECUTIVE_BOT_REPLIES}/${MAX_CONSECUTIVE_BOT_REPLIES}`);
  });

  it('M6.4: reason string exposes current count (e.g. 5/3)', () => {
    const d = makeEngagementDecision(signals({ consecutiveReplyCount: 5 }));
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toContain(`5/${MAX_CONSECUTIVE_BOT_REPLIES}`);
  });

  it('M6.4: direct @-mention bypasses consecutive-reply cap', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES,
      isMention: true,
      participationScore: 0,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M6.4: direct reply-to-bot bypasses consecutive-reply cap', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES,
      isReplyToBot: true,
      participationScore: 0,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M6.4: count below cap → normal scoring continues', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES - 1,
      participationScore: 1.2,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M6.4: boundary — count exactly at cap triggers skip', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES,
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  it('M6.4: boundary — count one below cap allows engage', () => {
    const d = makeEngagementDecision(signals({
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES - 1,
      participationScore: 2.0,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  // ── Gate 3.5a (M7.3): addressee graph ──────────────────────────────────
  it('M7.3: skip when addresseeIsOther and not direct', () => {
    const d = makeEngagementDecision(signals({ addresseeIsOther: true, participationScore: 2.0 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('addressee');
  });

  it('M7.3: direct @-mention bypasses addressee-is-other', () => {
    const d = makeEngagementDecision(signals({ addresseeIsOther: true, isMention: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M7.3: direct reply-to-bot bypasses addressee-is-other', () => {
    const d = makeEngagementDecision(signals({ addresseeIsOther: true, isReplyToBot: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M7.3: adversarial still reacts even when addressee is other (Gate 3 wins)', () => {
    const d = makeEngagementDecision(signals({ addresseeIsOther: true, isAdversarial: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('react');
  });

  // ── Gate 3.5b (M7.4): air-reading veto ─────────────────────────────────
  it('M7.4: skip when awkwardVeto and not direct', () => {
    const d = makeEngagementDecision(signals({ awkwardVeto: true, participationScore: 2.0 }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('air-reading');
  });

  it('M7.4: direct @-mention bypasses air-reading veto', () => {
    const d = makeEngagementDecision(signals({ awkwardVeto: true, isMention: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M7.4: direct reply-to-bot bypasses air-reading veto', () => {
    const d = makeEngagementDecision(signals({ awkwardVeto: true, isReplyToBot: true, participationScore: 0 }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  // ── Gate 3.5 order: addressee before air-reading ───────────────────────
  it('M7: gate order — addressee skip reason wins over air-reading when both set', () => {
    const d = makeEngagementDecision(signals({ addresseeIsOther: true, awkwardVeto: true }));
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toContain('addressee');
  });

  // ── Gate 3.5c (M7.1) + Gate 6: relevance override ──────────────────────
  it('M7.1: relevanceOverride=engage forces engage when score is below minScore', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'engage',
      participationScore: 0.1,
      minScore: 0.5,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
    expect(d.reason).toContain('pre-chat judge');
  });

  it('M7.1: relevanceOverride=skip + not direct → skip', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'skip',
      participationScore: 2.0,
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
    expect(d.reason).toContain('pre-chat judge');
  });

  it('M7.1: relevanceOverride=skip + direct → engage (direct bypass)', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'skip',
      isMention: true,
      participationScore: 0,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('M7.1: Gate 5.5 (ignored) wins over relevanceOverride=engage', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'engage',
      lastSpeechIgnored: true,
      participationScore: 0.1,
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toContain('ignored');
  });

  it('M7.1: Gate 5.6 (consecutive cap) wins over relevanceOverride=engage', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'engage',
      consecutiveReplyCount: MAX_CONSECUTIVE_BOT_REPLIES,
      participationScore: 0.1,
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toContain('consecutive-reply cap');
  });

  it('M7.1: relevanceOverride=null → fall through to normal scoring', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: null,
      participationScore: 0.3,
      minScore: 0.5,
    }));
    // non-direct + score 0.3 < 0.5 * 1.5 → skip
    expect(d.shouldReply).toBe(false);
  });

  it('M7.1: relevanceOverride=engage reason uses "pre-chat judge: engage"', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'engage',
      participationScore: 0.1,
    }));
    expect(d.reason).toBe('pre-chat judge: engage');
  });

  it('M7.1: relevanceOverride=skip reason uses "pre-chat judge: skip"', () => {
    const d = makeEngagementDecision(signals({
      relevanceOverride: 'skip',
    }));
    expect(d.reason).toBe('pre-chat judge: skip');
  });
});

// ── comprehension-scorer ───────────────────────────────────────────────

describe('scoreComprehension', () => {
  const emptyCtx: ComprehensionContext = {
    loreKeywords: new Set(),
    jargonTerms: [],
    aliasKeys: [],
  };

  const richCtx: ComprehensionContext = {
    loreKeywords: new Set(['roselia', 'ykn', 'bandori']),
    jargonTerms: ['打艺', '现地'],
    aliasKeys: ['凑友希那', 'ras'],
  };

  it('empty message returns 0', () => {
    expect(scoreComprehension('', emptyCtx)).toBe(0);
  });

  it('very short message (<=4 chars) returns >= 0.5', () => {
    expect(scoreComprehension('好的', emptyCtx)).toBeGreaterThanOrEqual(0.5);
    expect(scoreComprehension('嗯', emptyCtx)).toBeGreaterThanOrEqual(0.5);
    expect(scoreComprehension('在吗', emptyCtx)).toBeGreaterThanOrEqual(0.5);
  });

  it('normal everyday message with no domain terms scores >= 0.3', () => {
    expect(scoreComprehension('今天天气真好', emptyCtx)).toBeGreaterThanOrEqual(0.3);
    expect(scoreComprehension('吃饭了吗', emptyCtx)).toBeGreaterThanOrEqual(0.3);
    expect(scoreComprehension('hello world', emptyCtx)).toBeGreaterThanOrEqual(0.3);
    expect(scoreComprehension('你好啊怎么了', emptyCtx)).toBeGreaterThanOrEqual(0.3);
  });

  it('message with known domain terms scores high', () => {
    expect(scoreComprehension('roselia太好听了', richCtx)).toBeGreaterThanOrEqual(0.7);
    expect(scoreComprehension('打艺真的很有用', richCtx)).toBeGreaterThanOrEqual(0.7);
  });

  it('message with unknown abbreviation-like terms scores lower', () => {
    // "nsy" is separated by space and looks like an abbreviation but not in vocab
    const score = scoreComprehension('nsy 是什么意思', richCtx);
    // Should be lower than a known-vocab message
    expect(score).toBeLessThan(scoreComprehension('ykn 是什么意思', richCtx));
  });

  it('Case 2: "打艺" is known jargon, high comprehension', () => {
    const score = scoreComprehension('原来打艺这么有用', richCtx);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('message with katakana flags as domain-specific', () => {
    const score = scoreComprehension('バンドリ最高', emptyCtx);
    // Katakana should lower the score when not in vocab
    expect(score).toBeLessThan(0.7);
  });

  it('consonant-only abbreviation flags as domain-specific', () => {
    // "ykn" is consonant-only (no vowels) and not in common ASCII
    // Separated by space so tokenizer can isolate it
    const score = scoreComprehension('ykn 最棒了', emptyCtx);
    expect(score).toBeLessThan(0.7);
  });

  it('normal English word is NOT flagged as abbreviation', () => {
    const score = scoreComprehension('fire bird is cool', emptyCtx);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });
});

// ── M7.2: activity-driven threshold (Gate 6) ───────────────────────────
describe('makeEngagementDecision — M7.2 activity multiplier', () => {
  it('busy + non-direct + borderline score → skip (1.4x bump over 1.5x)', () => {
    // Non-direct base = 1.5x; busy adds 1.4x → effective = 2.1 * minScore = 1.05
    // Score 0.9 < 1.05 → skip. Pre-M7.2 (normal) this would also skip at 0.75,
    // so we pick a score that USED to pass normal but now fails busy.
    // normal threshold = 1.5 * 0.5 = 0.75. score 0.9 → normal pass, busy skip.
    const d = makeEngagementDecision(signals({
      participationScore: 0.9,
      minScore: 0.5,
      activityLevel: 'busy',
    }));
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  it('busy + non-direct + high enough score → engage', () => {
    // effective 2.1 * 0.5 = 1.05; score 1.2 ≥ 1.05
    const d = makeEngagementDecision(signals({
      participationScore: 1.2,
      minScore: 0.5,
      activityLevel: 'busy',
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('idle + non-direct + mid score → engage (0.75 softens bar)', () => {
    // non-direct idle = 1.5 * 0.75 = 1.125x; effective = 1.125 * 0.5 = 0.5625
    // score 0.6 < normal-bar (0.75) but ≥ idle-bar (0.5625) → engage only in idle
    const dNormal = makeEngagementDecision(signals({
      participationScore: 0.6,
      minScore: 0.5,
      activityLevel: 'normal',
    }));
    expect(dNormal.shouldReply).toBe(false);

    const dIdle = makeEngagementDecision(signals({
      participationScore: 0.6,
      minScore: 0.5,
      activityLevel: 'idle',
    }));
    expect(dIdle.shouldReply).toBe(true);
    expect(dIdle.strength).toBe('engage');
  });

  it('busy + direct trigger bypasses the multiplier (direct always engages)', () => {
    const d = makeEngagementDecision(signals({
      isMention: true,
      participationScore: 0,
      minScore: 0.5,
      activityLevel: 'busy',
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('normal activity matches pre-M7.2 behavior (regression guard)', () => {
    // Non-direct normal = 1.5x minScore = 0.75. Score 0.8 engages, 0.7 skips.
    const dPass = makeEngagementDecision(signals({
      participationScore: 0.8,
      minScore: 0.5,
      activityLevel: 'normal',
    }));
    expect(dPass.shouldReply).toBe(true);

    const dSkip = makeEngagementDecision(signals({
      participationScore: 0.7,
      minScore: 0.5,
      activityLevel: 'normal',
    }));
    expect(dSkip.shouldReply).toBe(false);
  });
});
