/**
 * Participation Scorer: computes whether the bot should reply to a message.
 * Extracted from ChatModule's _computeWeightedScore.
 *
 * Note: This is the interface definition and delegation stub. The actual
 * scoring logic remains in ChatModule as inline fallback. Full extraction
 * of _computeWeightedScore requires MessageSignals pre-computation in chat.ts,
 * which is planned but not yet implemented.
 */

export interface MessageSignals {
  readonly isMention: boolean;
  readonly isReplyToBot: boolean;
  readonly isReplyToOther: boolean;
  readonly isImplicitBotRef: boolean;
  readonly hasLoreKeyword: boolean;
  readonly hasImage: boolean;
  readonly hasStickerRequest: boolean;
  readonly isAdmin: boolean;
}

export interface ScoreFactors {
  readonly base: number;
  readonly mention: number;
  readonly replyToBot: number;
  readonly replyToOther: number;
  readonly implicitRef: number;
  readonly loreKeyword: number;
  readonly silence: number;
  readonly continuity: number;
  readonly topicStick: number;
  readonly burst: number;
  /** Interest category match weight (0 when nothing matched). */
  readonly interestMatch: number;
  /** Novelty penalty (negative when trigger tokens overlap recent bot output). */
  readonly noveltyPenalty: number;
}

export interface IParticipationScorer {
  /** Compute the weighted participation score for a message. */
  computeScore(
    groupId: string,
    signals: MessageSignals,
    content: string,
    nowMs: number,
    recent3: ReadonlyArray<{ userId: string; timestamp: number }>,
    recent5: ReadonlyArray<{ timestamp: number }>,
  ): { score: number; factors: ScoreFactors; isDirect: boolean };

  /** Record that bot replied to a user (continuity tracking). */
  markReplyToUser(groupId: string, userId: string, nowMs: number): void;

  /** Record that bot engaged a topic (topic-stick tracking). */
  engageTopic(groupId: string, tokens: Set<string>, nowMs: number): void;
}

/**
 * Stub implementation that delegates to ChatModule's inline _computeWeightedScore.
 * The full extraction will move the scoring logic here and have chat.ts pre-compute
 * MessageSignals before calling computeScore.
 */
export class ParticipationScorer implements IParticipationScorer {
  private readonly lastReplyToUser = new Map<string, number>();
  private readonly engagedTopics = new Map<string, { tokens: Set<string>; until: number; msgCount: number }>();

  computeScore(
    _groupId: string,
    signals: MessageSignals,
    _content: string,
    _nowMs: number,
    _recent3: ReadonlyArray<{ userId: string; timestamp: number }>,
    _recent5: ReadonlyArray<{ timestamp: number }>,
  ): { score: number; factors: ScoreFactors; isDirect: boolean } {
    // Stub: direct triggers always fire
    const isDirect = signals.isMention || signals.isReplyToBot;
    return {
      score: isDirect ? 999 : 0,
      factors: {
        base: 0, mention: 0, replyToBot: 0, replyToOther: 0,
        implicitRef: 0, loreKeyword: 0, silence: 0,
        continuity: 0, topicStick: 0, burst: 0,
        interestMatch: 0, noveltyPenalty: 0,
      },
      isDirect,
    };
  }

  markReplyToUser(groupId: string, userId: string, nowMs: number): void {
    this.lastReplyToUser.set(`${groupId}:${userId}`, nowMs);
  }

  engageTopic(groupId: string, tokens: Set<string>, nowMs: number): void {
    this.engagedTopics.set(groupId, { tokens, until: nowMs + 5 * 60_000, msgCount: 0 });
  }
}
