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
    | 'self-echo-regen';
  promptVariant?: 'banter' | 'default' | 'careful' | 'char';
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
  | { kind: 'silent';                                meta: BaseResultMeta;         reasonCode: 'guard' | 'scope' | 'confabulation' | 'timing' | 'bot-triggered' | 'downrated' | 'dampener' | 'self-echo' | 'sticker-leak-stripped' | 'hard-gate-blocked' }
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
