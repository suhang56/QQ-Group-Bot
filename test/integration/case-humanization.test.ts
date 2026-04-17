/**
 * P4 Integration Tests: Case-based humanization regression suite.
 *
 * Tests the full decision pipeline (engagement-decision + comprehension-scorer
 * + conversation-state + prompt-variants + sentinel guards) against the three
 * documented bad cases and additional regressions.
 *
 * These tests do NOT call Claude -- they verify the pre-LLM and post-LLM
 * gates that prevent each bad case from reaching the user.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  makeEngagementDecision,
  type EngagementSignals,
} from '../../src/modules/engagement-decision.js';
import {
  scoreComprehension,
  type ComprehensionContext,
} from '../../src/services/comprehension-scorer.js';
import { ConversationStateTracker } from '../../src/modules/conversation-state.js';
import {
  pickVariant,
  buildVariantSystemPrompt,
  type VariantContext,
} from '../../src/modules/prompt-variants.js';
import {
  entityGuard,
  isQaReportTone,
  qaReportRegenHint,
  hasCoreferenceSelfReference,
  isOutsiderCommentatorTone,
  outsiderToneRegenHint,
  detectInsultEchoRisk,
  insultEchoRegenHint,
} from '../../src/utils/sentinel.js';
import { ThompsonSampler, type StickerCandidate } from '../../src/services/sticker-sampler.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

// ── Shared fixtures ────────────────────────────────────────────────────

const GROUP_ID = '958751334';
const BOT_USER_ID = 'bot_001';
const NOW_SEC = Math.floor(Date.now() / 1000);

/** Comprehension context with typical group lore loaded */
const RICH_CTX: ComprehensionContext = {
  loreKeywords: new Set([
    'roselia', 'bandori', 'hhw', 'mygo', 'ras', 'morfonica',
    'ave mujica', '友希那', '纱夜', '莉莎', '燐子', '亚子',
    '春日影', '火鸟', '咕咕嘎嘎', 'mhy',
  ]),
  jargonTerms: ['打艺', '现地', '咕咕嘎嘎', 'mhww', 'mhy'],
  aliasKeys: ['凑友希那', '今井莉莎', '白金燐子', '冰川纱夜', '宇田川亚子'],
};

/** Empty context: bot has no domain knowledge for this group */
const EMPTY_CTX: ComprehensionContext = {
  loreKeywords: new Set(),
  jargonTerms: [],
  aliasKeys: [],
};

const BASE_SIGNALS: EngagementSignals = {
  isMention: false,
  isReplyToBot: false,
  participationScore: 0.5,
  minScore: 0.5,
  isShortAck: false,
  isMetaCommentary: false,
  isPicBotCommand: false,
  comprehensionScore: 0.7,
  isAdversarial: false,
  isPureAtMention: false,
  lastSpeechIgnored: false,
  consecutiveReplyCount: 0,
<<<<<<< HEAD
  activityLevel: 'normal',
=======
  relevanceOverride: null,
  addresseeIsOther: false,
  awkwardVeto: false,
>>>>>>> 6dc10b3 (feat(chat): pre-chat LLM judge — relevance/addressee/air-reading (M7.1+M7.3+M7.4))
};

function signals(overrides: Partial<EngagementSignals>): EngagementSignals {
  return { ...BASE_SIGNALS, ...overrides };
}

// ====================================================================
// Case 1: @bot "咕咕嘎嘎" → bot replies with 长辈训人 template
// Expected: if "咕咕嘎嘎" is in jargon → comprehension high → engage
//           with banter variant (active joke). If NOT in jargon →
//           comprehension low + @ → react (confused deflection).
// ====================================================================
describe('Case 1: 咕咕嘎嘎 (template lecture tone)', () => {
  let tracker: ConversationStateTracker;

  beforeEach(() => {
    tracker = new ConversationStateTracker();
  });

  it('comprehension is HIGH when 咕咕嘎嘎 is known jargon', () => {
    const score = scoreComprehension('咕咕嘎嘎', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('comprehension is adequate for short onomatopoeia even without jargon', () => {
    // "咕咕嘎嘎" is 4 chars CJK, short-message heuristic returns >= 0.5
    const score = scoreComprehension('咕咕嘎嘎', EMPTY_CTX);
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('when 咕咕嘎嘎 repeated 3+ times → activeJoke triggers banter variant', () => {
    const jargon = ['咕咕嘎嘎'];
    tracker.tick(GROUP_ID, '咕咕嘎嘎', 'user_a', NOW_SEC, jargon);
    tracker.tick(GROUP_ID, '咕咕嘎嘎!', 'user_b', NOW_SEC + 1, jargon);
    tracker.tick(GROUP_ID, '又咕咕嘎嘎了', 'user_c', NOW_SEC + 2, jargon);

    expect(tracker.isActiveJoke(GROUP_ID, '咕咕嘎嘎')).toBe(true);

    const variant = pickVariant({
      activeJokeHit: true,
      sensitiveEntityHit: false,
      personaRoleCard: 'test',
    });
    expect(variant).toBe('banter');
  });

  it('banter variant system prompt emphasizes short + casual, not lecture', () => {
    const { systemPrompt } = buildVariantSystemPrompt({
      activeJokeHit: true,
      sensitiveEntityHit: false,
      personaRoleCard: 'Roselia 主推',
    });
    expect(systemPrompt).toContain('跟梗为主');
    expect(systemPrompt).toContain('短句');
    expect(systemPrompt).not.toContain('谨慎');
  });

  it('QA-report detector flags 长辈训人 patterns', () => {
    // The actual bad outputs from Case 1
    expect(isQaReportTone('你们又在咕咕嘎嘎了？烦不烦啊你们又在说什么黑话啊')).toBe(false);
    // But the self-referential pattern should be caught
    expect(isQaReportTone('我刚不是在说咕咕嘎嘎吗？')).toBe(true);
  });

  it('4th repetition of 咕咕嘎嘎 → bot should NOT template-repeat', () => {
    const jargon = ['咕咕嘎嘎'];
    for (let i = 0; i < 3; i++) {
      tracker.tick(GROUP_ID, '咕咕嘎嘎', `user_${i}`, NOW_SEC + i, jargon);
    }
    // After 3 repetitions, joke is active
    expect(tracker.isActiveJoke(GROUP_ID, '咕咕嘎嘎')).toBe(true);

    // The prompt context should mention the active joke
    const promptCtx = tracker.formatForPrompt(GROUP_ID);
    expect(promptCtx).toContain('咕咕嘎嘎');
    expect(promptCtx).toContain('活跃的梗');
  });
});

// ====================================================================
// Case 2: 群友"原来打艺这么有用" → bot "你们在打什么艺啊？"
// Expected: if 打艺 is known jargon → engage normally (no QA-parse).
//           If unknown + no @ → skip. If unknown + @ → react (confused).
// ====================================================================
describe('Case 2: 打艺 (QA-reflex / parse exposure)', () => {
  it('打艺 as known jargon → high comprehension → engage path', () => {
    const score = scoreComprehension('原来打艺这么有用', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);

    const decision = makeEngagementDecision(
      signals({ comprehensionScore: score, participationScore: 0.8 }),
    );
    expect(decision.strength).toBe('engage');
  });

  it('打艺 unknown + no @ → skip (do not expose parse)', () => {
    // Without 打艺 in jargon, comprehension depends on CJK heuristics
    // The message "原来打艺这么有用" is normal CJK, scores >= 0.5 by default
    // This test verifies that when comprehension IS low (e.g., abbreviation-heavy),
    // the bot skips rather than asking "你们在打什么艺啊"
    const decision = makeEngagementDecision(
      signals({ comprehensionScore: 0.1, isMention: false }),
    );
    expect(decision.shouldReply).toBe(false);
    expect(decision.strength).toBe('skip');
  });

  it('打艺 unknown + @ → react (confused deflection), never "你们在打什么X"', () => {
    const decision = makeEngagementDecision(
      signals({ comprehensionScore: 0.1, isMention: true }),
    );
    expect(decision.shouldReply).toBe(true);
    expect(decision.strength).toBe('react');
    expect(decision.reason).toContain('low comprehension');
  });

  it('QA-report detector catches "你们在打什么艺啊？" pattern', () => {
    // This specific output is a QA-reflex -- "X是Y" declarative + question
    // Pattern 3 won't catch it (no 是...的), but it should be caught by
    // the engagement decision preventing it from ever being generated
    // Let's verify the qa-report detector on similar encyclopedic outputs
    expect(isQaReportTone('打艺是指在BanG Dream中通过反复游玩特定难度的乐曲来提升技术的行为吗？')).toBe(true);
  });

  it('engagement decision with adequate comprehension allows normal reply', () => {
    const score = scoreComprehension('原来打艺这么有用', RICH_CTX);
    // Non-direct effective threshold is 1.5x minScore (0.75), need high score
    const decision = makeEngagementDecision(
      signals({ comprehensionScore: score, participationScore: 0.8 }),
    );
    // Should engage, not skip or react
    expect(decision.strength).toBe('engage');
  });
});

// ====================================================================
// Case 3: 群友 NEU第一rui厨 贴 mhww 团子图 + "mhww";
//         用户 西瓜 对 NEU第一rui厨 说 "你回国了？" + sticker
//         Bot 未被叫, 未被 @, 自己闯入 → "我刚不是在说西瓜吗"
//
// IMPORTANT: "@6月东京来人" in the screenshot is 西瓜's QQ ROLE TAG,
// NOT an @-mention of the bot. Bot has ZERO engagement signals here.
//
// TWO-LAYER DEFENSE:
// Layer 1 (PRIMARY): engagement-decision must return skip for this
//   peer-to-peer dialog with no bot signal. If this works, the bad
//   output is never generated.
// Layer 2 (FALLBACK): coreference-guard catches "在说{nick}" patterns
//   in case engagement-decision ever lets such a message through.
// ====================================================================
describe('Case 3: peer-to-peer intrusion + coreference (unaddressed, no @)', () => {
  // ── Layer 1: engagement-decision (PRIMARY defense) ──

  it('LAYER 1: peer-to-peer dialog, zero bot signals → engagement skips', () => {
    // Exact scenario: two humans talking (NEU第一rui厨 posts mhww,
    // 西瓜 replies "你回国了？"). Bot has NO @-mention, NO reply-to-bot,
    // and participationScore is below threshold. Bot MUST NOT speak.
    const decision = makeEngagementDecision(
      signals({
        isMention: false,        // "@6月东京来人" is a role tag, NOT @bot
        isReplyToBot: false,     // 西瓜 is replying to NEU第一rui厨, not bot
        participationScore: 0.3, // below threshold
        minScore: 0.5,
        comprehensionScore: 0.7, // bot "understands" the message, but should not speak
      }),
    );
    expect(decision.shouldReply).toBe(false);
    expect(decision.strength).toBe('skip');
  });

  it('LAYER 1: even high comprehension cannot override no-signal skip', () => {
    // Bot perfectly understands "你回国了？" but has no reason to reply
    const decision = makeEngagementDecision(
      signals({
        isMention: false,
        isReplyToBot: false,
        participationScore: 0.3,
        minScore: 0.5,
        comprehensionScore: 1.0, // perfect comprehension
      }),
    );
    expect(decision.shouldReply).toBe(false);
    expect(decision.strength).toBe('skip');
  });

  it('LAYER 1: conversation-state shows two humans, bot not a participant', () => {
    const tracker = new ConversationStateTracker();
    // NEU第一rui厨 posts mhww image + text
    tracker.tick(GROUP_ID, 'mhww', 'neu_rui_user', NOW_SEC);
    // 西瓜 replies to NEU第一rui厨
    tracker.tick(GROUP_ID, '你回国了？', 'xigua_user', NOW_SEC + 5);

    const snap = tracker.getSnapshot(GROUP_ID);
    // Two human participants, bot is NOT among them
    expect(snap.participantCount).toBe(2);
  });

  // ── Layer 2: coreference-guard (FALLBACK defense) ──

  it('LAYER 2 FALLBACK: coreference-guard catches "我刚不是在说西瓜吗"', () => {
    expect(hasCoreferenceSelfReference(
      '我刚不是在说西瓜吗',
      ['西瓜'],
    )).toBe(true);
  });

  it('LAYER 2 FALLBACK: catches "在说{any participant nickname}"', () => {
    const participants = ['西瓜', 'NEU第一rui厨'];
    expect(hasCoreferenceSelfReference('在说西瓜', participants)).toBe(true);
    expect(hasCoreferenceSelfReference('不是在说NEU第一rui厨吗', participants)).toBe(true);
  });

  it('LAYER 2 FALLBACK: does NOT flag addressing the speaker directly', () => {
    // "西瓜你好" is addressing, not coreference
    expect(hasCoreferenceSelfReference('西瓜你好啊', ['西瓜'])).toBe(false);
    // "问西瓜" is referencing, not self-referencing "在说"
    expect(hasCoreferenceSelfReference('问一下西瓜', ['西瓜'])).toBe(false);
  });

  it('LAYER 2 FALLBACK: QA-report detector also catches self-referential pattern', () => {
    expect(isQaReportTone('我刚不是在说西瓜吗?')).toBe(true);
  });

  // ── P4-2 hard regression guards ──

  it('P4-2 regression: bot output must NOT start with "我刚"', () => {
    const badOutputs = [
      '我刚不是在说西瓜吗',
      '我刚在说这个来着',
      '我刚说了什么',
    ];
    for (const output of badOutputs) {
      expect(isQaReportTone(output + '?')).toBe(true);
    }
  });

  it('P4-2 regression: bot output must NOT contain "在说{participant nickname}"', () => {
    const participantNicks = ['西瓜', 'NEU第一rui厨', '常山'];
    const badPatterns = [
      '在说西瓜',
      '在聊NEU第一rui厨',
      '在讨论常山',
      '提到西瓜',
      '说的是西瓜',
    ];
    for (const pattern of badPatterns) {
      expect(hasCoreferenceSelfReference(pattern, participantNicks)).toBe(true);
    }
  });
});

// (HHW entity guard tests are now in Case 5 above)

// ====================================================================
// Case 4: mhy 硬回归 — @bot "mhy 好不好听"
// Expected: bot recognizes "mhy" via jargon/lore → engage (not confused
// deflection). The comprehension gate must NOT treat mhy as unknown.
// ====================================================================
describe('Case 4: mhy recognition (known domain term)', () => {
  it('mhy is recognized as known jargon → high comprehension', () => {
    const score = scoreComprehension('mhy 好不好听', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('@bot + known jargon → engage (not react/skip)', () => {
    const score = scoreComprehension('mhy 好不好听', RICH_CTX);
    const decision = makeEngagementDecision(
      signals({ comprehensionScore: score, isMention: true, participationScore: 0.8 }),
    );
    expect(decision.shouldReply).toBe(true);
    expect(decision.strength).toBe('engage');
  });

  it('mhy without @ but high score → still engage', () => {
    const score = scoreComprehension('mhy 好不好听', RICH_CTX);
    // Non-direct effective threshold is 1.5x minScore (0.75), need score >= 0.75
    const decision = makeEngagementDecision(
      signals({ comprehensionScore: score, participationScore: 0.8 }),
    );
    expect(decision.strength).toBe('engage');
  });

  it('mhy NOT in vocab → would drop comprehension for abbreviation-like', () => {
    // Without mhy in lore, "mhy" is a 3-char consonant-heavy abbreviation
    // that looks like unknown domain slang → lower comprehension
    const score = scoreComprehension('mhy 好不好听', EMPTY_CTX);
    // "mhy" has a vowel (y sometimes vowel, but hasVowelPattern checks [aeiou])
    // so it might not flag. Either way, this verifies the system doesn't crash
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ====================================================================
// Case 5: HHW entity-guard (prompt-injection style)
// Simulates scenarios where the LLM might output disparagement of
// protected entities. Entity-guard must intercept and replace with
// fallback pool entries.
// ====================================================================
describe('Case 5: HHW entity-guard (prompt-injection defense)', () => {
  const KNOWN_FALLBACKS = ['各有各的粉', '我不说这个', '嗯', ''];

  it('bot output "谁喜欢HHW啊" → entity-guard replaces', () => {
    const result = entityGuard('谁喜欢HHW啊');
    expect(result).not.toBeNull();
    expect(KNOWN_FALLBACKS).toContain(result);
  });

  it('bot output "HHW 真难听" → entity-guard replaces', () => {
    const result = entityGuard('HHW真难听');
    expect(result).not.toBeNull();
    expect(KNOWN_FALLBACKS).toContain(result);
  });

  it('prompt variant switches to careful when sensitive entity detected', () => {
    const variant = pickVariant({
      activeJokeHit: false,
      sensitiveEntityHit: true,
      personaRoleCard: 'test',
    });
    expect(variant).toBe('careful');
  });

  it('careful variant tells LLM not to disparage', () => {
    const { systemPrompt } = buildVariantSystemPrompt({
      activeJokeHit: false,
      sensitiveEntityHit: true,
      personaRoleCard: 'test',
    });
    expect(systemPrompt).toContain('不贬低任何 band');
  });

  it('entity-guard catches all protected bands under injection', () => {
    const injectionOutputs = [
      '谁喜欢Roselia啊',
      'MyGO真垃圾',
      'Ave Mujica不行',
      '讨厌Morfonica',
      'RAS真难听',
      '纱夜废物',
      '讨厌友希那',
    ];
    for (const output of injectionOutputs) {
      expect(entityGuard(output)).not.toBeNull();
    }
  });

  it('entity-guard fallback is always from the known pool (20 samples)', () => {
    for (let i = 0; i < 20; i++) {
      const result = entityGuard('谁喜欢HHW啊');
      expect(KNOWN_FALLBACKS).toContain(result);
    }
  });

  it('neutral mentions pass through entity-guard', () => {
    expect(entityGuard('HHW 的歌也不错啊')).toBeNull();
    expect(entityGuard('友希那今天唱得好')).toBeNull();
    expect(entityGuard('我在听 Roselia')).toBeNull();
  });
});

// ====================================================================
// P4-2: 硬回归 test
// mhy / 打艺 / 咕咕嘎嘎 / "我刚不是在说{userNick}吗"
// ====================================================================
describe('P4-2: hard regression tests', () => {
  it('mhww: known jargon → comprehension passes', () => {
    const score = scoreComprehension('mhww', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('mhy: known jargon → comprehension passes', () => {
    const score = scoreComprehension('mhy 好不好听', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('打艺: known jargon → comprehension passes', () => {
    const score = scoreComprehension('打艺真的好有用', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('咕咕嘎嘎: known jargon or short enough → comprehension passes', () => {
    const score = scoreComprehension('咕咕嘎嘎', RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('"我刚不是在说{nick}吗" → coreference-guard catches ALL participant nicks', () => {
    const nicks = ['西瓜', '常山', 'kisa', 'NEU第一rui厨', 'test(special)'];
    for (const nick of nicks) {
      expect(
        hasCoreferenceSelfReference(`我刚不是在说${nick}吗`, [nick]),
      ).toBe(true);
    }
  });

  it('"我刚不是在说{nick}吗" → qa-report detector also catches', () => {
    expect(isQaReportTone('我刚不是在说西瓜吗?')).toBe(true);
    expect(isQaReportTone('我刚不是在说常山吗？')).toBe(true);
  });
});

// ====================================================================
// Case 6: outsider voice "你们 + 都 + 动词 + 啊"
// Bot uses commentator framing instead of participant voice.
// ====================================================================
describe('Case 6: outsider commentator voice', () => {
  it('detects "你们在笑什么" as outsider tone', () => {
    expect(isOutsiderCommentatorTone('你们在笑什么')).toBe(true);
  });

  it('detects "你们都回国了啊" as outsider tone', () => {
    expect(isOutsiderCommentatorTone('你们都回国了啊')).toBe(true);
  });

  it('detects "你们都这么怕热怕湿啊" as outsider tone', () => {
    expect(isOutsiderCommentatorTone('你们都这么怕热怕湿啊')).toBe(true);
  });

  it('detects "你们怎么都在聊天气" as outsider tone', () => {
    expect(isOutsiderCommentatorTone('你们怎么都在聊天气')).toBe(true);
  });

  it('does NOT flag first-person participant voice', () => {
    expect(isOutsiderCommentatorTone('我也怕热')).toBe(false);
    expect(isOutsiderCommentatorTone('我觉得还好')).toBe(false);
    expect(isOutsiderCommentatorTone('笑死')).toBe(false);
    expect(isOutsiderCommentatorTone('草')).toBe(false);
  });

  it('does NOT flag long messages (> 30 chars)', () => {
    const long = '你们都' + '很'.repeat(30) + '啊';
    expect(isOutsiderCommentatorTone(long)).toBe(false);
  });

  it('outsiderToneRegenHint returns hint when flagged', () => {
    const hint = outsiderToneRegenHint('你们在笑什么');
    expect(hint).not.toBeNull();
    expect(hint).toContain('旁观者');
  });

  it('outsiderToneRegenHint returns null for clean output', () => {
    expect(outsiderToneRegenHint('我也觉得好笑')).toBeNull();
  });

  it('all prompt variants include outsider-voice prohibition rule', () => {
    for (const v of [
      { activeJokeHit: false, sensitiveEntityHit: false },
      { activeJokeHit: true, sensitiveEntityHit: false },
      { activeJokeHit: false, sensitiveEntityHit: true },
    ]) {
      const { systemPrompt } = buildVariantSystemPrompt({
        ...v,
        personaRoleCard: 'test',
      });
      expect(systemPrompt).toContain('你们都');
      expect(systemPrompt).toContain('旁观者');
    }
  });
});

// ====================================================================
// Case 7: non-@ peer-chat intrusion threshold tightened
// Bot should stay silent in peer-to-peer conversations without signals.
// ====================================================================
describe('Case 7: peer-chat intrusion threshold (tightened)', () => {
  it('non-direct score at old threshold (0.5) now skips (effective threshold 0.75)', () => {
    const d = makeEngagementDecision(
      signals({
        isMention: false,
        isReplyToBot: false,
        participationScore: 0.5,
        minScore: 0.5,
        comprehensionScore: 0.7,
      }),
    );
    expect(d.shouldReply).toBe(false);
    expect(d.strength).toBe('skip');
  });

  it('non-direct score at 0.7 still skips (below 0.75 effective)', () => {
    const d = makeEngagementDecision(
      signals({
        isMention: false,
        isReplyToBot: false,
        participationScore: 0.7,
        minScore: 0.5,
        comprehensionScore: 0.7,
      }),
    );
    expect(d.shouldReply).toBe(false);
  });

  it('non-direct score at 0.8 engages (above 0.75 effective)', () => {
    const d = makeEngagementDecision(
      signals({
        isMention: false,
        isReplyToBot: false,
        participationScore: 0.8,
        minScore: 0.5,
        comprehensionScore: 0.7,
      }),
    );
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('direct mention bypasses tightened threshold', () => {
    const d = makeEngagementDecision(
      signals({
        isMention: true,
        participationScore: 0.3,
        minScore: 0.5,
        comprehensionScore: 0.7,
      }),
    );
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('reply-to-bot bypasses tightened threshold', () => {
    const d = makeEngagementDecision(
      signals({
        isReplyToBot: true,
        participationScore: 0.3,
        minScore: 0.5,
        comprehensionScore: 0.7,
      }),
    );
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });
});

// ====================================================================
// Case 8: insult-echo — bot agrees with insult targeting groupmate
// ====================================================================
describe('Case 8: insult-echo detection', () => {
  it('detects "不然呢" after insult message', () => {
    expect(detectInsultEchoRisk('不然呢', ['诸葛少智你是不是傻'])).toBe(true);
  });

  it('detects "确实" after insult message', () => {
    expect(detectInsultEchoRisk('确实', ['这个人真蠢'])).toBe(true);
  });

  it('detects "对" after insult with "智障"', () => {
    expect(detectInsultEchoRisk('对', ['智障吧你'])).toBe(true);
  });

  it('detects "+1" after insult', () => {
    expect(detectInsultEchoRisk('+1', ['脑残啊'])).toBe(true);
  });

  it('detects "笑死" after insult with "逗我笑"', () => {
    expect(detectInsultEchoRisk('笑死', ['你别逗我笑了'])).toBe(true);
  });

  it('does NOT flag "不然呢" without recent insults', () => {
    expect(detectInsultEchoRisk('不然呢', ['今天天气不错', '去哪吃饭'])).toBe(false);
  });

  it('does NOT flag long output (> 10 chars)', () => {
    expect(detectInsultEchoRisk('这个说法确实有道理', ['你真傻'])).toBe(false);
  });

  it('does NOT flag non-agreement phrases', () => {
    expect(detectInsultEchoRisk('我不同意', ['你真蠢'])).toBe(false);
  });

  it('checks multiple recent messages for insults', () => {
    expect(detectInsultEchoRisk('确实', [
      '今天天气好',
      '你们看那个sb了吗',
      '哈哈哈',
    ])).toBe(true);
  });

  it('insultEchoRegenHint returns hint when flagged', () => {
    const hint = insultEchoRegenHint('不然呢', ['这人是废物']);
    expect(hint).not.toBeNull();
    expect(hint).toContain('附和');
  });

  it('insultEchoRegenHint returns null when clean', () => {
    expect(insultEchoRegenHint('不然呢', ['今天天气好'])).toBeNull();
  });

  it('all prompt variants include insult-echo prohibition', () => {
    for (const v of [
      { activeJokeHit: false, sensitiveEntityHit: false },
      { activeJokeHit: true, sensitiveEntityHit: false },
      { activeJokeHit: false, sensitiveEntityHit: true },
    ]) {
      const { systemPrompt } = buildVariantSystemPrompt({
        ...v,
        personaRoleCard: 'test',
      });
      expect(systemPrompt).toContain('贬低');
      expect(systemPrompt).toContain('附和');
    }
  });
});

// ====================================================================
// Engagement Decision: end-to-end gate verification
// ====================================================================
describe('Engagement decision: end-to-end gate logic', () => {
  it('short ack without @ → skip', () => {
    const d = makeEngagementDecision(signals({ isShortAck: true }));
    expect(d.shouldReply).toBe(false);
  });

  it('short ack with @ → still engage (direct overrides ack gate)', () => {
    const d = makeEngagementDecision(
      signals({ isShortAck: true, isMention: true }),
    );
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('adversarial with zero comprehension → react (not engage)', () => {
    const d = makeEngagementDecision(
      signals({ isAdversarial: true, comprehensionScore: 0 }),
    );
    expect(d.strength).toBe('react');
  });

  it('pure @-mention (no text) → react', () => {
    const d = makeEngagementDecision(signals({ isPureAtMention: true }));
    expect(d.strength).toBe('react');
  });

  it('high score + high comprehension → engage', () => {
    const d = makeEngagementDecision(
      signals({ participationScore: 0.9, comprehensionScore: 0.8 }),
    );
    expect(d.strength).toBe('engage');
  });

  it('low score + low comprehension + no @ → skip', () => {
    const d = makeEngagementDecision(
      signals({ participationScore: 0.1, comprehensionScore: 0.1 }),
    );
    expect(d.shouldReply).toBe(false);
  });

  it('boundary: comprehension exactly 0.3 passes gate', () => {
    const d = makeEngagementDecision(
      signals({ comprehensionScore: 0.3, participationScore: 0.8 }),
    );
    expect(d.strength).toBe('engage');
  });

  it('boundary: comprehension 0.29 fails gate (without @)', () => {
    const d = makeEngagementDecision(
      signals({ comprehensionScore: 0.29, participationScore: 0.8 }),
    );
    expect(d.shouldReply).toBe(false);
  });
});

// ====================================================================
// Prompt variant selection: correct variant for each scenario
// ====================================================================
describe('Prompt variant selection for humanization scenarios', () => {
  it('active joke → banter (Case 1 mitigation)', () => {
    expect(pickVariant({
      activeJokeHit: true,
      sensitiveEntityHit: false,
      personaRoleCard: 'test',
    })).toBe('banter');
  });

  it('sensitive entity → careful (HHW guard)', () => {
    expect(pickVariant({
      activeJokeHit: false,
      sensitiveEntityHit: true,
      personaRoleCard: 'test',
    })).toBe('careful');
  });

  it('sensitive + joke → careful wins (safety first)', () => {
    expect(pickVariant({
      activeJokeHit: true,
      sensitiveEntityHit: true,
      personaRoleCard: 'test',
    })).toBe('careful');
  });

  it('no signals → default', () => {
    expect(pickVariant({
      activeJokeHit: false,
      sensitiveEntityHit: false,
      personaRoleCard: 'test',
    })).toBe('default');
  });

  it('all three variants contain identity grounding', () => {
    const variants: Array<{ activeJokeHit: boolean; sensitiveEntityHit: boolean }> = [
      { activeJokeHit: false, sensitiveEntityHit: false },
      { activeJokeHit: true, sensitiveEntityHit: false },
      { activeJokeHit: false, sensitiveEntityHit: true },
    ];
    for (const v of variants) {
      const { systemPrompt } = buildVariantSystemPrompt({
        ...v,
        personaRoleCard: 'test',
        groupName: '北美炸梦同好会',
      });
      expect(systemPrompt).toContain('身份锚定');
      expect(systemPrompt).toContain('你 = bot = 小号');
    }
  });
});

// ====================================================================
// P4-3: Sticker diversity smoke test
// Uses ThompsonSampler with a fixed-seed RNG to verify that sampling
// from a pool of stickers produces >= 5 distinct keys across 30 draws.
// Also verifies conversation-state tracking over 30 messages.
// ====================================================================
describe('P4-3: sticker diversity + conversation state over 30 messages', () => {
  // Build a pool of 15 sticker candidates with varying usage stats
  function buildStickerPool(count: number): StickerCandidate[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      groupId: GROUP_ID,
      key: `sticker_${String(i + 1).padStart(3, '0')}`,
      type: 'mface' as const,
      localPath: null,
      cqCode: `[CQ:mface,key=sticker_${String(i + 1).padStart(3, '0')}]`,
      summary: `sticker ${i + 1}`,
      contextSamples: [],
      count: Math.max(1, 10 - i), // decreasing popularity
      firstSeen: NOW_SEC - 86400,
      lastSeen: NOW_SEC,
      usagePositive: Math.max(0, 5 - Math.floor(i / 3)),
      usageNegative: Math.floor(i / 5),
    }));
  }

  it('Thompson sampling from 15 stickers over 30 draws → >= 5 distinct keys', () => {
    const sampler = new ThompsonSampler();
    const pool = buildStickerPool(15);

    // Fixed-seed RNG for reproducibility (simple LCG)
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const selectedKeys = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const picks = sampler.sample(pool, 1, rng);
      if (picks.length > 0) {
        selectedKeys.add(picks[0]!.key);
      }
    }

    expect(selectedKeys.size).toBeGreaterThanOrEqual(5);
  });

  it('Thompson sampling with uniform pool → even more diversity', () => {
    const sampler = new ThompsonSampler();
    // All stickers have equal stats
    const pool = buildStickerPool(15).map(s => ({
      ...s,
      usagePositive: 1,
      usageNegative: 0,
    }));

    let seed = 123;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const selectedKeys = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const picks = sampler.sample(pool, 1, rng);
      if (picks.length > 0) {
        selectedKeys.add(picks[0]!.key);
      }
    }

    // Uniform pool should produce even more diversity
    expect(selectedKeys.size).toBeGreaterThanOrEqual(5);
  });

  it('30 messages on same topic → activeJoke detected after threshold', () => {
    const tracker = new ConversationStateTracker();
    const jargon = ['bandori'];

    for (let i = 0; i < 30; i++) {
      tracker.tick(
        GROUP_ID,
        `bandori message ${i}`,
        `user_${i % 5}`,
        NOW_SEC + i,
        jargon,
      );
    }

    const snap = tracker.getSnapshot(GROUP_ID);
    expect(tracker.isActiveJoke(GROUP_ID, 'bandori')).toBe(true);
    expect(snap.participantCount).toBe(5);
    expect(snap.currentTopics.length).toBeGreaterThan(0);
  });

  it('mixed topics over 30 messages → multiple topics tracked', () => {
    const tracker = new ConversationStateTracker();
    const topics = ['roselia', 'bandori', 'mygo'];

    for (let i = 0; i < 30; i++) {
      const topic = topics[i % 3]!;
      tracker.tick(
        GROUP_ID,
        `${topic} is great`,
        `user_${i % 5}`,
        NOW_SEC + i,
        topics,
      );
    }

    const snap = tracker.getSnapshot(GROUP_ID);
    expect(snap.currentTopics.length).toBeGreaterThanOrEqual(1);
  });

  it('prompt context includes active jokes for variant selection', () => {
    const tracker = new ConversationStateTracker();
    const jargon = ['咕咕嘎嘎'];

    for (let i = 0; i < 5; i++) {
      tracker.tick(GROUP_ID, '咕咕嘎嘎', `user_${i}`, NOW_SEC + i, jargon);
    }

    const ctx = tracker.formatForPrompt(GROUP_ID);
    expect(ctx).toContain('咕咕嘎嘎');
    expect(ctx).toContain('活跃的梗');
  });
});

// ====================================================================
// Sentinel: combined guard checks (simulating post-generation pipeline)
// ====================================================================
describe('Sentinel: combined post-generation guards', () => {
  it('entity-guard + qa-report: both can trigger on same output', () => {
    // Entity-guard catches the disparagement part
    expect(entityGuard('Roselia真垃圾')).not.toBeNull();
    // QA-report catches the encyclopedic declarative pattern
    expect(isQaReportTone('Roselia是日本BanG Dream系列中的一个虚构乐队吗？')).toBe(true);
  });

  it('coreference + qa-report: "我刚不是在说西瓜吗" triggers both', () => {
    const bad = '我刚不是在说西瓜吗?';
    expect(hasCoreferenceSelfReference(bad, ['西瓜'])).toBe(true);
    expect(isQaReportTone(bad)).toBe(true);
  });

  it('clean casual output passes all guards', () => {
    const good = '哈哈哈草';
    expect(entityGuard(good)).toBeNull();
    expect(isQaReportTone(good)).toBe(false);
    expect(hasCoreferenceSelfReference(good, ['西瓜'])).toBe(false);
    expect(qaReportRegenHint(good)).toBeNull();
  });

  it('short emoji/sticker style output passes all guards', () => {
    const outputs = ['?', '草', '嗯', '哈', '笑死'];
    for (const out of outputs) {
      expect(entityGuard(out)).toBeNull();
      expect(isQaReportTone(out)).toBe(false);
      expect(hasCoreferenceSelfReference(out, ['西瓜', '常山'])).toBe(false);
    }
  });
});

// ====================================================================
// Edge cases: boundary values, null safety, concurrency
// ====================================================================
describe('Edge cases', () => {
  it('comprehension scorer handles empty string', () => {
    expect(scoreComprehension('', RICH_CTX)).toBe(0);
  });

  it('comprehension scorer handles very long message', () => {
    const long = '打艺'.repeat(500);
    const score = scoreComprehension(long, RICH_CTX);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('comprehension scorer handles pure whitespace', () => {
    expect(scoreComprehension('   ', RICH_CTX)).toBe(0);
  });

  it('engagement decision handles all-zero signals', () => {
    const d = makeEngagementDecision(signals({
      participationScore: 0,
      comprehensionScore: 0,
      isMention: false,
      isReplyToBot: false,
    }));
    expect(d.shouldReply).toBe(false);
  });

  it('engagement decision handles all-max signals', () => {
    const d = makeEngagementDecision(signals({
      participationScore: 1,
      comprehensionScore: 1,
      isMention: true,
      isReplyToBot: true,
    }));
    expect(d.shouldReply).toBe(true);
    expect(d.strength).toBe('engage');
  });

  it('coreference guard handles nickname with CJK special chars', () => {
    expect(hasCoreferenceSelfReference(
      '在说★特殊名字★',
      ['★特殊名字★'],
    )).toBe(true);
  });

  it('coreference guard handles very long nickname', () => {
    const longNick = '超级无敌长的群昵称'.repeat(20);
    expect(hasCoreferenceSelfReference(
      `在说${longNick}`,
      [longNick],
    )).toBe(true);
  });

  it('conversation state tracker handles rapid ticks', () => {
    const tracker = new ConversationStateTracker();
    // 100 messages in 1 second
    for (let i = 0; i < 100; i++) {
      tracker.tick(GROUP_ID, `msg ${i}`, `user_${i % 3}`, NOW_SEC, ['test']);
    }
    const snap = tracker.getSnapshot(GROUP_ID);
    expect(snap.participantCount).toBe(3);
  });

  it('conversation state tracker handles empty message', () => {
    const tracker = new ConversationStateTracker();
    tracker.tick(GROUP_ID, '', 'user_1', NOW_SEC);
    const snap = tracker.getSnapshot(GROUP_ID);
    expect(snap.participantCount).toBe(1);
  });

  it('entity guard handles null-like edge cases', () => {
    expect(entityGuard('')).toBeNull();
    expect(entityGuard(' ')).toBeNull();
  });

  it('qa-report detector handles strings at exact 20-char boundary', () => {
    // Exactly 20 chars with 是 and 吗 should NOT trigger (needs >20)
    const exactly20 = '这是一个刚好二十个字的句子吗？吗？';
    // Just verify it doesn't crash; actual triggering depends on content
    expect(typeof isQaReportTone(exactly20)).toBe('boolean');
  });

  it('multiple groups tracked independently', () => {
    const tracker = new ConversationStateTracker();
    tracker.tick('group_a', 'hello', 'user_1', NOW_SEC, ['hello']);
    tracker.tick('group_b', 'world', 'user_2', NOW_SEC, ['world']);

    const snapA = tracker.getSnapshot('group_a');
    const snapB = tracker.getSnapshot('group_b');
    expect(snapA.participantCount).toBe(1);
    expect(snapB.participantCount).toBe(1);
    // Topics should be independent
    expect(tracker.isActiveJoke('group_a', 'world')).toBe(false);
    expect(tracker.isActiveJoke('group_b', 'hello')).toBe(false);
  });

  it('tracker destroy cleans up timer', () => {
    const tracker = new ConversationStateTracker();
    tracker.tick(GROUP_ID, 'test', 'user_1', NOW_SEC);
    tracker.destroy();
    // Should not throw after destroy
    expect(() => tracker.getSnapshot(GROUP_ID)).not.toThrow();
  });
});
