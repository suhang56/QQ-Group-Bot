import type { UtteranceAct } from './utterance-act.js';
import type { ShadowClassifierResult } from '../modules/llm-shadow-classifier.js';
import type { DirectiveMode, DirectiveLengthBudget } from '../modules/reply-planner.js';

export interface BaseResultMeta {
  decisionPath: 'normal' | 'direct' | 'fallback' | 'sticker' | 'silent' | 'defer';
  guardPath?:
    | 'addressee-regen'
    | 'confab-regen'
    | 'hardened-regen'
    | 'entity-guard'
    | 'near-dup'
    | 'qa-guard'
    | 'outsider-guard'
    | 'post-process'
    | 'self-echo-regen'
    | 'scope-claim-regen'
    | 'template-family-regen';
  promptVariant?: 'banter' | 'default' | 'careful' | 'char';
  /** R4-lite: observability label of what the bot intended to do this turn. */
  utteranceAct?: UtteranceAct;
  /**
   * R4.5: optional in-flight LLM shadow classifier promise. Stamped at
   * src/modules/chat.ts:2830 when the per-group flag is on. The decision
   * tracker awaits this post-insert and UPDATEs the just-written
   * chat_decision_events row by id. Promise NEVER rejects (internal try/catch).
   * Routes that don't shadow leave this undefined.
   */
  utteranceActShadowPromise?: Promise<ShadowClassifierResult>;
  /** R9: which path produced the directive — 'no-planner-skipped' when flag
   * off / bot-self / scope-skipped. */
  plannerSource?: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped';
  /** R9: chosen mode (telemetry; not load-bearing for runtime gates). */
  directiveMode?: DirectiveMode;
  /** R9: chosen length budget bucket. */
  directiveLengthBudget?: DirectiveLengthBudget;
  /** R9: ms spent in Planner LLM call + parse + validate. 0 for rule-fallback / no-planner. */
  plannerLatencyMs?: number;
  /** R9: full canonical-key-ordered Directive JSON for offline replay/analytics. */
  directiveJson?: string;
}

export interface ReplyMeta extends BaseResultMeta {
  evasive: boolean;
  injectedFactIds: number[];
  matchedFactIds: number[];
  usedVoiceCount: number;
  usedFactHint: boolean;
}

export interface StickerMeta extends BaseResultMeta {
  key: string;
  score?: number;
}

export type ChatResult =
  | { kind: 'reply';    text: string;                meta: ReplyMeta;              reasonCode: string }
  | { kind: 'sticker';  cqCode: string;              meta: StickerMeta;            reasonCode: string }
  | { kind: 'fallback'; text: string;                meta: BaseResultMeta;         reasonCode: 'pure-at' | 'low-comprehension-direct' | 'bot-blank-needed-ack' | 'dampener-ack' }
  | { kind: 'silent';                                meta: BaseResultMeta;         reasonCode: 'guard' | 'scope' | 'confabulation' | 'timing' | 'bot-triggered' | 'downrated' | 'dampener' | 'self-echo' | 'sticker-leak-stripped' | 'hard-gate-blocked' | 'persona-fabricated' | 'scope-claim-self-centered' | 'scope-claim-plural-you' | 'template-family-cooldown' | 'injection-refused' | 'cancelled-by-direct' | 'addressee-other' }
  | { kind: 'defer';    untilSec: number; targetMsgId: string; meta: BaseResultMeta; reasonCode: 'rate-limit' | 'burst-settle' | 'cooldown' };

export function isSendable(r: ChatResult): r is Extract<ChatResult, { kind: 'reply' | 'sticker' | 'fallback' }> {
  return r.kind === 'reply' || r.kind === 'sticker' || r.kind === 'fallback';
}

export function isReply(r: ChatResult): r is Extract<ChatResult, { kind: 'reply' }> {
  return r.kind === 'reply';
}

export function isSticker(r: ChatResult): r is Extract<ChatResult, { kind: 'sticker' }> {
  return r.kind === 'sticker';
}

export function isSilent(r: ChatResult): r is Extract<ChatResult, { kind: 'silent' }> {
  return r.kind === 'silent';
}

export function isDefer(r: ChatResult): r is Extract<ChatResult, { kind: 'defer' }> {
  return r.kind === 'defer';
}

/** Filter predicate for nullable block assembly in prompt parts. */
export const nonEmptyBlock = (s: string | null | undefined): s is string =>
  typeof s === 'string' && s.length > 0;
