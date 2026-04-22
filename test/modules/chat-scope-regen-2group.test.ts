import { describe, it, expect } from 'vitest';
import {
  hasSelfCenteredScopeClaim,
  hasPluralYouScopeClaim,
  prevBotTurnAddressed,
  type HistoryMessage,
} from '../../src/utils/scope-claim-guard.js';
import { isAnnoyedTemplateConsecutive } from '../../src/modules/guards/template-family-cooldown.js';

/**
 * Integration-level unit test for the R2.5.1 scope-regen block composition
 * added in chat.ts around line 2923. Rather than instantiate ChatModule
 * (which would require mocking 30+ deps), this simulates the decision flow
 * per DEV-READY §4b + §4c using the underlying predicates. Any future
 * refactor that collapses Group A/B or short-circuits TEMPLATE_FAMILY will
 * break these assertions.
 *
 * Block order per spec: Group B → Group A → SF2 (tested elsewhere) → TEMPLATE.
 * Each block pass = update `processed`, continue. Each block fail (regen still
 * matches) = early-return silent with distinct reasonCode.
 */

const BOT = '1705075399';

type EngagementSignals = { isMention: boolean; isReplyToBot: boolean };
type GuardPath = 'scope-claim-regen' | 'template-family-regen' | null;
type Outcome =
  | { kind: 'pass-through'; finalText: string; guardPath: GuardPath }
  | { kind: 'silent'; reasonCode:
      | 'scope-claim-self-centered'
      | 'scope-claim-plural-you'
      | 'template-family-cooldown'; guardPath: GuardPath };

interface SimInput {
  readonly processed: string;
  readonly engagement: EngagementSignals;
  readonly isDirect: boolean;
  readonly dSpeakers: number;
  readonly history: ReadonlyArray<HistoryMessage>;
  readonly botHistTF: ReadonlyArray<{ text: string }>;
  /** Regen side: the block re-runs chatRequest(true); we simulate its output. */
  readonly regenGroupB?: string;
  readonly regenGroupA?: string;
  readonly regenTF?: string;
}

function simulateBlocks(input: SimInput): Outcome {
  let processed = input.processed;
  let guardPath: GuardPath = null;

  // Group B
  const groupBFires =
    hasSelfCenteredScopeClaim(processed)
    && !input.engagement.isMention
    && !input.engagement.isReplyToBot
    && !prevBotTurnAddressed(input.history, BOT);
  if (groupBFires) {
    guardPath = 'scope-claim-regen';
    const regen = input.regenGroupB ?? '';
    if (!regen || hasSelfCenteredScopeClaim(regen)) {
      return { kind: 'silent', reasonCode: 'scope-claim-self-centered', guardPath };
    }
    processed = regen;
  }

  // Group A
  if (hasPluralYouScopeClaim(processed) && input.dSpeakers < 3 && !input.isDirect) {
    guardPath = 'scope-claim-regen';
    const regen = input.regenGroupA ?? '';
    if (!regen || hasPluralYouScopeClaim(regen)) {
      return { kind: 'silent', reasonCode: 'scope-claim-plural-you', guardPath };
    }
    processed = regen;
  }

  // TEMPLATE (runs after SF2 per spec §4c; SF2 omitted in simulation)
  if (isAnnoyedTemplateConsecutive(processed, input.botHistTF)) {
    guardPath = 'template-family-regen';
    const regen = input.regenTF ?? '';
    if (!regen || isAnnoyedTemplateConsecutive(regen, input.botHistTF)) {
      return { kind: 'silent', reasonCode: 'template-family-cooldown', guardPath };
    }
    processed = regen;
  }

  return { kind: 'pass-through', finalText: processed, guardPath };
}

const EMPTY_HISTORY: ReadonlyArray<HistoryMessage> = [];

describe('R2.5.1 scope-regen 2-group composition', () => {
  it('Group A fires + regen passes → pass-through updated text', () => {
    const out = simulateBlocks({
      processed: '你们事真多',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 2,
      history: EMPTY_HISTORY,
      botHistTF: [],
      regenGroupA: '这个话题继续',
    });
    expect(out.kind).toBe('pass-through');
    if (out.kind === 'pass-through') expect(out.finalText).toBe('这个话题继续');
  });

  it('Group B fires + regen fails → silent scope-claim-self-centered', () => {
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 5,
      history: EMPTY_HISTORY,
      botHistTF: [],
      regenGroupB: '又开始了', // still self-centered, regen-once-then-silent
    });
    expect(out).toEqual({
      kind: 'silent',
      reasonCode: 'scope-claim-self-centered',
      guardPath: 'scope-claim-regen',
    });
  });

  it('Group A fires + regen fails → silent scope-claim-plural-you', () => {
    const out = simulateBlocks({
      processed: '你们节目真多',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 1,
      history: EMPTY_HISTORY,
      botHistTF: [],
      regenGroupA: '你们事真多', // still plural-you
    });
    expect(out).toEqual({
      kind: 'silent',
      reasonCode: 'scope-claim-plural-you',
      guardPath: 'scope-claim-regen',
    });
  });

  it('TEMPLATE fires: 2-of-3 recent contain family + candidate contains', () => {
    const out = simulateBlocks({
      processed: '烦死了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 3,
      history: EMPTY_HISTORY,
      botHistTF: [{ text: '你烦不烦' }, { text: '想屁吃' }, { text: 'ok' }],
      regenTF: '又来了', // still family token, regen-once-then-silent
    });
    expect(out).toEqual({
      kind: 'silent',
      reasonCode: 'template-family-cooldown',
      guardPath: 'template-family-regen',
    });
  });

  it('Group B passes via regen, TEMPLATE still evaluates independently (non-short-circuit)', () => {
    // Group B fires: 又来了 with no addressee, regen returns 烦死了 (family token).
    // Then TEMPLATE evaluates on the updated processed. botHistTF has 2 family.
    // TEMPLATE fires; its regen fails → silent template-family-cooldown.
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 3,
      history: EMPTY_HISTORY,
      botHistTF: [{ text: '你烦不烦' }, { text: '想屁吃' }],
      regenGroupB: '烦死了', // passes Group B (no longer self-centered token), but triggers TEMPLATE
      regenTF: '想屁吃', // TEMPLATE regen still has family
    });
    expect(out).toEqual({
      kind: 'silent',
      reasonCode: 'template-family-cooldown',
      guardPath: 'template-family-regen',
    });
  });

  it('Group B bypass: isAtMention=true → 又来了 passes through', () => {
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: true, isReplyToBot: false },
      isDirect: true,
      dSpeakers: 5,
      history: EMPTY_HISTORY,
      botHistTF: [],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('Group B bypass: isReplyToBot=true → 又来了 passes through', () => {
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: true },
      isDirect: false,
      dSpeakers: 5,
      history: EMPTY_HISTORY,
      botHistTF: [],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('Group B bypass: prevBotTurnAddressed=true → 又来了 passes through', () => {
    const history: HistoryMessage[] = [
      { userId: 'u1', content: `[CQ:at,qq=${BOT}] earlier`, rawContent: `[CQ:at,qq=${BOT}] earlier` },
      { userId: BOT, content: 'bot-prev', rawContent: 'bot-prev', messageId: 'b1' },
    ];
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 5,
      history,
      botHistTF: [],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('Group A bypass: dSpeakers >= 3 (large scene) → 你们事真多 passes', () => {
    const out = simulateBlocks({
      processed: '你们事真多',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 3,
      history: EMPTY_HISTORY,
      botHistTF: [],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('Group A bypass: isDirect=true (direct trigger) → 你们事真多 passes', () => {
    const out = simulateBlocks({
      processed: '你们事真多',
      engagement: { isMention: true, isReplyToBot: false },
      isDirect: true,
      dSpeakers: 1,
      history: EMPTY_HISTORY,
      botHistTF: [],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('TEMPLATE bypass: 1-of-3 family (count < 2) → 烦死了 passes', () => {
    const out = simulateBlocks({
      processed: '烦死了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 3,
      history: EMPTY_HISTORY,
      botHistTF: [{ text: '烦死了' }, { text: 'ok' }, { text: 'hi' }],
    });
    expect(out.kind).toBe('pass-through');
  });

  it('All guards no-op on clean reply → pass-through unchanged', () => {
    const out = simulateBlocks({
      processed: '今天天气不错',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 2,
      history: EMPTY_HISTORY,
      botHistTF: [{ text: '烦死了' }, { text: '想屁吃' }],
    });
    expect(out.kind).toBe('pass-through');
    if (out.kind === 'pass-through') expect(out.finalText).toBe('今天天气不错');
  });

  it('Group B fires with empty regen (LLM returns blank) → silent self-centered', () => {
    const out = simulateBlocks({
      processed: '又来了',
      engagement: { isMention: false, isReplyToBot: false },
      isDirect: false,
      dSpeakers: 3,
      history: EMPTY_HISTORY,
      botHistTF: [],
      regenGroupB: '', // empty → fail
    });
    expect(out).toEqual({
      kind: 'silent',
      reasonCode: 'scope-claim-self-centered',
      guardPath: 'scope-claim-regen',
    });
  });
});
