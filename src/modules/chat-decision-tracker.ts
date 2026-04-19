/**
 * P4 — Chat Decision Tracker
 *
 * Captures every ChatResult decision into chat_decision_events and scores
 * each event by observing followup messages in a delayed background job.
 *
 * IMPORTANT — compare signals by cohort, not absolute score.
 * sig_ignored on a 'silent' result means "group continued without bot"
 * (neutral-to-positive). The same signal on a 'reply' result means "nobody
 * reacted" (negative). Always filter WHERE result_kind = X when comparing
 * cohorts. Never mix result_kinds in AVG(score) queries.
 */

import type { Logger } from 'pino';
import type { ChatResult } from '../utils/chat-result.js';
import type {
  IChatDecisionEventRepository,
  IChatDecisionEffectRepository,
  ChatDecisionEffectRow,
  ChatDecisionEventRow,
  IMessageRepository,
} from '../storage/db.js';

export interface CaptureContext {
  groupId: string;
  triggerMsgId: string | null;
  targetMsgId: string | null;
  triggerUserId: string | null;
  sentBotReplyId: number | null;
  nowSec: number;
}

const EXPLICIT_NEGATIVE_RE = /废物|傻逼|滚|去死|垃圾|笨蛋|蠢货|闭嘴|烦死了|烦死|太烦了/;
const CORRECTION_RE = /不对[啊吧哦嗯]?|错了[啊吧哦]?|我说的是|不是这意思|理解错了|没说这个|你搞错了/;
const BOT_REF_RE = /\[CQ:at,qq=\d+\]|@\S+/;

const WEIGHTS = {
  sig_explicit_negative:    -1.0,
  sig_correction:           -0.7,
  sig_continued_topic:      -0.2,
  sig_ignored:              -0.1,
  sig_target_user_replied:  +0.5,
  sig_other_at_bot:         +0.7,
} as const;

export class ChatDecisionTracker {
  constructor(private readonly deps: {
    events: IChatDecisionEventRepository;
    effects: IChatDecisionEffectRepository;
    messages: IMessageRepository;
    logger: Logger;
  }) {}

  captureDecision(result: ChatResult, ctx: CaptureContext): void {
    try {
      const meta = result.meta;
      let replyText: string | null = null;
      let usedFactIds: string | null = null;
      let usedVoiceCount: number | null = null;

      if (result.kind === 'reply') {
        replyText = result.text;
        usedFactIds = result.meta.matchedFactIds.length > 0
          ? JSON.stringify(result.meta.matchedFactIds)
          : null;
        usedVoiceCount = result.meta.usedVoiceCount;
      } else if (result.kind === 'sticker') {
        replyText = result.cqCode;
      } else if (result.kind === 'fallback') {
        replyText = result.text;
      }

      const eventId = this.deps.events.insert({
        group_id:          ctx.groupId,
        trigger_msg_id:    ctx.triggerMsgId,
        target_msg_id:     ctx.targetMsgId,
        trigger_user_id:   ctx.triggerUserId,
        result_kind:       result.kind,
        reason_code:       result.reasonCode,
        decision_path:     meta.decisionPath ?? null,
        guard_path:        result.kind === 'reply' ? (meta.guardPath ?? null) : null,
        prompt_variant:    result.kind === 'reply' ? (meta.promptVariant ?? null) : null,
        sent_bot_reply_id: ctx.sentBotReplyId,
        reply_text:        replyText,
        used_fact_ids:     usedFactIds,
        used_voice_count:  usedVoiceCount,
        captured_at_sec:   ctx.nowSec,
      });

      this.deps.effects.insertPlaceholder(eventId, ctx.groupId);
    } catch (err) {
      this.deps.logger.warn({ err }, 'captureDecision failed');
    }
  }

  async scoreUnscored(): Promise<void> {
    const SCORE_DELAY_SEC = 120;
    const LIMIT = 200;
    const cutoffSec = Math.floor(Date.now() / 1000) - SCORE_DELAY_SEC;

    const rows = this.deps.effects.getUnscored(cutoffSec, LIMIT);
    for (const eff of rows) {
      try {
        await this._scoreOne(eff);
      } catch (err) {
        this.deps.logger.warn({ err, effectId: eff.id }, 'scoreOne failed — skipping');
      }
    }
  }

  private async _scoreOne(eff: ChatDecisionEffectRow): Promise<void> {
    const event: ChatDecisionEventRow | undefined = this.deps.events.getById(eff.decision_event_id);
    if (!event) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const followups = this.deps.messages.getAfter(event.group_id, event.captured_at_sec, 3);

    const followupIds = followups.map(m => String(m.id));
    const texts = followups.map(m => m.content);

    const sig_explicit_negative = texts.some(t => EXPLICIT_NEGATIVE_RE.test(t)) ? 1 : 0;
    const sig_correction = texts.some(t => CORRECTION_RE.test(t)) ? 1 : 0;
    const sig_ignored = followups.length === 0 ? 1 : 0;

    const sig_continued_topic = (
      followups.length > 0 &&
      !texts.some(t => BOT_REF_RE.test(t))
    ) ? 1 : 0;

    const sig_target_user_replied = (
      event.trigger_user_id !== null &&
      followups.some(m => m.userId === event.trigger_user_id)
    ) ? 1 : 0;

    const sig_other_at_bot = followups.some(
      m => m.userId !== event.trigger_user_id && BOT_REF_RE.test(m.rawContent ?? m.content)
    ) ? 1 : 0;

    const rawScore =
      sig_explicit_negative    * WEIGHTS.sig_explicit_negative +
      sig_correction           * WEIGHTS.sig_correction +
      sig_continued_topic      * WEIGHTS.sig_continued_topic +
      sig_ignored              * WEIGHTS.sig_ignored +
      sig_target_user_replied  * WEIGHTS.sig_target_user_replied +
      sig_other_at_bot         * WEIGHTS.sig_other_at_bot;

    const score = Math.max(-1, Math.min(1, rawScore));

    this.deps.effects.updateScored(eff.id, {
      sig_explicit_negative,
      sig_correction,
      sig_ignored,
      sig_continued_topic,
      sig_target_user_replied,
      sig_other_at_bot,
      followup_msg_ids: JSON.stringify(followupIds),
      score,
      scored_at_sec: nowSec,
    });

    // satisfy async signature (no actual async ops needed — DB is sync)
    await Promise.resolve();
  }
}
