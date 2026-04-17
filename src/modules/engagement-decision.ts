/**
 * Engagement Decision Module: determines WHETHER and HOW to respond
 * BEFORE calling Claude. Replaces the old pattern of "call Claude first,
 * then check participationScore and maybe discard."
 *
 * Strength levels:
 * - skip:   do not respond at all
 * - lurk:   silently observe (same as skip for now, reserved for future)
 * - react:  respond with a short deflection (no Claude call)
 * - engage: full Claude generation
 */

export type EngagementStrength = 'skip' | 'lurk' | 'react' | 'engage';

/**
 * M6.4: hard cap on the number of consecutive bot replies without an
 * intervening peer message. Re-exported so chat.ts and tests share a single
 * source of truth.
 */
export const MAX_CONSECUTIVE_BOT_REPLIES = 3;

export interface EngagementDecision {
  readonly shouldReply: boolean;
  readonly strength: EngagementStrength;
  readonly reason: string;
}

export interface EngagementSignals {
  /** True if message @-mentions the bot */
  readonly isMention: boolean;
  /** True if message is a reply-quote to a bot message */
  readonly isReplyToBot: boolean;
  /** The weighted participation score from existing scoring logic */
  readonly participationScore: number;
  /** The minimum score threshold for participation */
  readonly minScore: number;
  /** True if message is a short acknowledgment (ok/嗯/好的) */
  readonly isShortAck: boolean;
  /** True if message is admin meta-commentary about the bot */
  readonly isMetaCommentary: boolean;
  /** True if message is a pic-bot command directed at another bot */
  readonly isPicBotCommand: boolean;
  /** Comprehension score 0-1 from comprehension-scorer */
  readonly comprehensionScore: number;
  /** True if message matched an adversarial pattern (probe/task/inject/harass) */
  readonly isAdversarial: boolean;
  /** True if the trigger message is purely an @-mention with no text */
  readonly isPureAtMention: boolean;
  /**
   * True if the bot's last proactive reply was ignored by the group: bot spoke
   * recently, ≥3 messages have passed, and none of them addressed the bot
   * (@, reply-to-bot, or implicit bot reference). Non-direct messages under
   * this condition get suppressed by Gate 5.5.
   */
  readonly lastSpeechIgnored: boolean;
  /**
   * M6.4: number of consecutive bot replies since the last peer message in
   * this group. Bot-side counter maintained by chat.ts — resets on any peer
   * message. Gate 5.6 suppresses non-direct replies when this reaches
   * MAX_CONSECUTIVE_BOT_REPLIES.
   */
  readonly consecutiveReplyCount: number;
}

/**
 * Core decision function: given signals, determine engagement level.
 *
 * Decision priority:
 * 1. Pure @-mention (no text) → react (at_only deflection, handled by caller)
 * 2. Short ack / meta-commentary / pic-bot → skip
 * 3. Adversarial patterns → react (deflection, handled by caller)
 * 4. Low comprehension + no direct signal → skip
 * 5. Low comprehension + @-mention/reply → react (confused deflection)
 * 5.5 Last speech ignored by group + not direct → skip (Gate 5.5, R3)
 * 5.6 Consecutive bot-reply cap reached + not direct → skip (Gate 5.6, M6.4)
 * 6. Normal scoring: score >= minScore or isDirect → engage
 * 7. Otherwise → skip
 */
export function makeEngagementDecision(signals: EngagementSignals): EngagementDecision {
  const isDirect = signals.isMention || signals.isReplyToBot;

  // Gate 1: pure @-mention with no text
  if (signals.isPureAtMention) {
    return { shouldReply: true, strength: 'react', reason: 'pure @-mention, no text' };
  }

  // Gate 2: skip conditions (independent of comprehension)
  if (signals.isShortAck && !isDirect) {
    return { shouldReply: false, strength: 'skip', reason: 'short acknowledgment' };
  }
  if (signals.isMetaCommentary) {
    return { shouldReply: false, strength: 'skip', reason: 'admin meta-commentary' };
  }
  if (signals.isPicBotCommand) {
    return { shouldReply: false, strength: 'skip', reason: 'pic-bot command' };
  }

  // Gate 3: adversarial patterns bypass comprehension check
  if (signals.isAdversarial) {
    return { shouldReply: true, strength: 'react', reason: 'adversarial pattern detected' };
  }

  // Gate 4-5: comprehension-based decision
  const LOW_COMPREHENSION_THRESHOLD = 0.3;
  if (signals.comprehensionScore < LOW_COMPREHENSION_THRESHOLD) {
    if (isDirect) {
      return {
        shouldReply: true,
        strength: 'react',
        reason: `low comprehension (${signals.comprehensionScore.toFixed(2)}) but direct trigger`,
      };
    }
    return {
      shouldReply: false,
      strength: 'skip',
      reason: `low comprehension (${signals.comprehensionScore.toFixed(2)}) and not direct`,
    };
  }

  // Gate 5.5: last speech ignored by group — mute proactive chat, but direct
  // triggers (mention / reply-to-bot) bypass this gate. Rationale (R3):
  // when the bot's last reply got no engagement over 3+ messages, it's
  // intruding on a conversation that doesn't want it — shut up until
  // someone actually addresses the bot.
  if (signals.lastSpeechIgnored && !isDirect) {
    return { shouldReply: false, strength: 'skip', reason: 'last speech ignored by group' };
  }

  // Gate 5.6 (M6.4): consecutive bot-reply cap — hard anti-monologue gate.
  // Direct triggers still bypass: if someone @s or replies to the bot, respond
  // even mid-streak. Otherwise, after MAX replies without a peer interjection,
  // the bot is talking to itself and must shut up until the streak breaks.
  if (signals.consecutiveReplyCount >= MAX_CONSECUTIVE_BOT_REPLIES && !isDirect) {
    return {
      shouldReply: false,
      strength: 'skip',
      reason: `consecutive-reply cap reached (${signals.consecutiveReplyCount}/${MAX_CONSECUTIVE_BOT_REPLIES})`,
    };
  }

  // Gate 6: normal participation scoring
  // Case 7 tuning: for non-direct (no @, no reply-to-bot) messages,
  // apply a stricter threshold (1.5x minScore) so bot stays silent > 80%
  // of the time in peer-to-peer chat without engagement signals.
  const effectiveMinScore = isDirect ? signals.minScore : signals.minScore * 1.5;
  if (isDirect || signals.participationScore >= effectiveMinScore) {
    return {
      shouldReply: true,
      strength: 'engage',
      reason: isDirect
        ? 'direct trigger (mention/reply)'
        : `score ${signals.participationScore.toFixed(3)} >= ${effectiveMinScore.toFixed(3)}`,
    };
  }

  // Gate 7: default skip
  return {
    shouldReply: false,
    strength: 'skip',
    reason: `score ${signals.participationScore.toFixed(3)} < ${effectiveMinScore.toFixed(3)}`,
  };
}
