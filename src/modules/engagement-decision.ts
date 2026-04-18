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
  /**
   * M7.2: observed group activity level from GroupActivityTracker. Gate 6
   * scales the effective minScore: busy groups need a higher bar (1.4x) so
   * the bot doesn't pile on, idle groups get a lower bar (0.75x) so one peer
   * speaking into an empty room can still pull a reply.
   */
  readonly activityLevel: 'idle' | 'normal' | 'busy';
  /**
   * M7.1 — pre-chat LLM judge verdict on whether the bot should engage.
   *   'engage' → force engage (even if score is below minScore) unless a
   *              higher-priority suppression gate (5.5, 5.6) fires.
   *   'skip'   → force skip (unless direct trigger or adversarial).
   *   null     → no opinion; fall through to existing gates.
   * Direct triggers (mention/reply-to-bot) always win over 'skip'.
   */
  readonly relevanceOverride: 'engage' | 'skip' | null;
  /**
   * M7.3 — LLM judged the addressee is a specific peer user (not the bot,
   * not the group at large). Suppresses non-direct replies so the bot
   * doesn't barge into a 1:1 conversation. Direct triggers bypass.
   */
  readonly addresseeIsOther: boolean;
  /**
   * M7.4 — LLM air-reading said the moment is awkward (冷场/跑题/刚发过/
   * 话题闭合). Suppresses non-direct replies. Direct triggers bypass.
   */
  readonly awkwardVeto: boolean;
  /**
   * M9.2 — group mood level derived from MoodTracker valence.
   *   'low'    → valence < -0.4 (irritable/down bot should speak less)
   *   'high'   → valence >  0.4 (upbeat bot pipes up more readily)
   *   'normal' → otherwise
   * Gate 6 applies a multiplier: 1.2x raise-the-bar when low, 0.9x lower-the-bar
   * when high. Direct triggers (mention / reply) are unaffected.
   */
  readonly moodLevel: 'low' | 'normal' | 'high';
}

/**
 * Core decision function: given signals, determine engagement level.
 *
 * Decision priority:
 * 1. Pure @-mention (no text) → react (at_only deflection, handled by caller)
 * 2. Short ack / meta-commentary / pic-bot → skip
 * 3. Adversarial patterns → react (deflection, handled by caller)
 * 3.5a Addressee is another user + not direct → skip (M7.3)
 * 3.5b Air-reading awkward + not direct → skip (M7.4)
 * 3.5c LLM judge: skip + not direct → skip (M7.1)
 * 4. Low comprehension + no direct signal → skip
 * 5. Low comprehension + @-mention/reply → react (confused deflection)
 * 5.5 Last speech ignored by group + not direct → skip (Gate 5.5, R3)
 * 5.6 Consecutive bot-reply cap reached + not direct → skip (Gate 5.6, M6.4)
 * 6. Normal scoring: score >= minScore OR LLM judge: engage OR isDirect → engage
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

  // Gate 3.5a (M7.3): LLM says addressee is someone else — don't barge in.
  // Direct triggers bypass; adversarial already returned above.
  if (signals.addresseeIsOther && !isDirect) {
    return { shouldReply: false, strength: 'skip', reason: 'addressee is other user' };
  }

  // Gate 3.5b (M7.4): LLM air-reading judged the moment awkward. Direct
  // triggers bypass; adversarial already returned above.
  if (signals.awkwardVeto && !isDirect) {
    return { shouldReply: false, strength: 'skip', reason: 'air-reading says awkward' };
  }

  // Gate 3.5c (M7.1): LLM judge says skip. Direct triggers bypass so the
  // bot still answers when @ed; adversarial already handled. Anti-monologue
  // gates (5.5, 5.6) still run AFTER and win over any "engage" override.
  if (signals.relevanceOverride === 'skip' && !isDirect) {
    return { shouldReply: false, strength: 'skip', reason: 'pre-chat judge: skip' };
  }

  // Gate 4-5: comprehension-based decision
  const LOW_COMPREHENSION_THRESHOLD = 0.15;
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

  // Gate 6: normal participation scoring with direct + activity + mood + LLM multipliers.
  // Direct-ness scales the bar: 1.0x if @ or reply-to-bot (already-engaged),
  // 1.5x for peer-to-peer chat (Case 7 — bot stays silent > 80% of the time).
  // M7.2 layers activity multiplier: 1.4x in busy groups, 0.75x in idle groups.
  // M9.2 layers mood multiplier: 1.2x when low (irritable bot shuts up more),
  // 0.9x when high (upbeat bot pipes up more readily). Direct triggers bypass
  // regardless.
  // M7.1: relevanceOverride='engage' bypasses score — LLM already judged
  // relevance against bot interests with full context.
  const directMultiplier = isDirect ? 1.0 : 1.5;
  const activityMultiplier = signals.activityLevel === 'busy' ? 1.4
                           : signals.activityLevel === 'idle' ? 0.75
                           : 1.0;
  const moodMultiplier = signals.moodLevel === 'low' ? 1.2
                       : signals.moodLevel === 'high' ? 0.9
                       : 1.0;
  const effectiveMinScore = signals.minScore * directMultiplier * activityMultiplier * moodMultiplier;
  const llmEngageOverride = signals.relevanceOverride === 'engage';
  if (isDirect || llmEngageOverride || signals.participationScore >= effectiveMinScore) {
    return {
      shouldReply: true,
      strength: 'engage',
      reason: isDirect
        ? 'direct trigger (mention/reply)'
        : llmEngageOverride
        ? 'pre-chat judge: engage'
        : `score ${signals.participationScore.toFixed(3)} >= ${effectiveMinScore.toFixed(3)} [${signals.activityLevel}][${signals.moodLevel}]`,
    };
  }

  // Gate 7: default skip
  return {
    shouldReply: false,
    strength: 'skip',
    reason: `score ${signals.participationScore.toFixed(3)} < ${effectiveMinScore.toFixed(3)} [${signals.activityLevel}][${signals.moodLevel}]`,
  };
}
