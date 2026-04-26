import { describe, it, expect } from 'vitest';
import {
  hasSelfCenteredScopeClaim,
  prevBotTurnAddressed,
  botIsInCurrentThread,
  type HistoryMessage,
} from '../../src/utils/scope-claim-guard.js';

/**
 * Integration-level unit test for R2.5.1-annex (C) — Group B fire condition
 * gains `&& !botIsInCurrentThread(...)`. Following the pattern of
 * `chat-scope-regen-2group.test.ts`, this simulates the decision flow
 * against the underlying predicates rather than instantiating ChatModule.
 *
 * Scenario A: Group B candidate output + thread-participation TRUE
 *   → 4th condition negated → block does NOT fire → no silent.
 * Scenario B: Group B candidate output + thread-participation FALSE +
 *   other 3 conditions all false → block FIRES → silent reasonCode
 *   'scope-claim-self-centered'.
 */

const BOT = '1705075399';
const NOW = 1_700_000_000_000;

type EngagementSignals = { isMention: boolean; isReplyToBot: boolean };
type SimResult =
  | { fires: false }
  | { fires: true; reasonCode: 'scope-claim-self-centered' };

interface SimInput {
  readonly processed: string;
  readonly engagement: EngagementSignals;
  readonly history: ReadonlyArray<HistoryMessage>;
  readonly triggerMessage: { content: string; rawContent?: string };
  readonly engagedTopicEntry: { tokens: Set<string>; until: number; msgCount: number } | undefined;
  readonly nowMs: number;
}

function simulateGroupB(input: SimInput): SimResult {
  const groupBFires =
    hasSelfCenteredScopeClaim(input.processed)
    && !input.engagement.isMention
    && !input.engagement.isReplyToBot
    && !prevBotTurnAddressed(input.history, BOT)
    && !botIsInCurrentThread(
      input.triggerMessage,
      input.history,
      input.engagedTopicEntry,
      BOT,
      input.nowMs,
    );
  return groupBFires ? { fires: true, reasonCode: 'scope-claim-self-centered' } : { fires: false };
}

describe('chat.ts Group B — R2.5.1-annex (C) thread-participation 4th condition', () => {
  it('scenario A — Group B candidate + bot in thread (sub-cond a fires) → suppressed', () => {
    const result = simulateGroupB({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      history: [
        { userId: 'u1', content: 'turn3' },
        { userId: 'u2', content: `[CQ:at,qq=${BOT}] sup bot` }, // (a) fires
        { userId: 'u3', content: 'turn1' },
      ],
      triggerMessage: { content: '又来了' },
      engagedTopicEntry: undefined,
      nowMs: NOW,
    });
    expect(result.fires).toBe(false);
  });

  it('scenario B — Group B candidate + thread-participation false + 3 prior conditions false → fires silent', () => {
    const result = simulateGroupB({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      history: [
        { userId: 'u1', content: 'hi' },
        { userId: 'u2', content: 'yo' },
        { userId: 'u3', content: 'sup' },
      ],
      triggerMessage: { content: '又来了' },
      engagedTopicEntry: undefined,
      nowMs: NOW,
    });
    expect(result.fires).toBe(true);
    if (result.fires) expect(result.reasonCode).toBe('scope-claim-self-centered');
  });
});
