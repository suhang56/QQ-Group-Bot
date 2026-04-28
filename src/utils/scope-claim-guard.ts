/**
 * R2.5.1 — scope-claim guard (Group A + Group B).
 *
 * Leaf util. No imports from chat.ts / send-guard-chain (circular-free).
 *
 * Group A — plural-you scope-claim (refactor of legacy SPECTATOR_PATTERNS):
 *   bot output contains "你们/你们几个/你们别烦|闹|吵/你们都X啊" templates that
 *   treat the group as a spectator scene. Trigger: speakerCount < 3 && !isDirect.
 *
 * Group B — self-centered scope-claim (new, 2026-04-21 prod incident):
 *   full-line anchored "又来了/又开始了/又来搞我/又在搞我/还来/又一次/有完没完"
 *   w/ optional tail particle + punct. Embedded occurrences NOT matched
 *   (e.g. "又开始了在讨论音乐" → pass through). Trigger: speakerCount-agnostic,
 *   suppress only when bot not currently addressed AND not recently addressed
 *   (prevBotTurnAddressed).
 *
 * Both predicates normalize input the same way: stripCQ → compact whitespace.
 * Input is bot OUTGOING text — user input never routes here.
 */

import { extractTokens } from './text-tokenize.js';
import { FOLLOWUP_FUNCTION_WORDS } from './topic-followup-phrase.js';

const _stripCQ = (s: string): string => s.replace(/\[CQ:[^\]]+\]/g, '').trim();
const _compact = (s: string): string => _stripCQ(s).replace(/\s+/g, '');

// ── Group A — PLURAL_YOU_PATTERNS ───────────────────────────────────────────
// Applied on compact (no-whitespace) bot output.
export const PLURAL_YOU_PATTERNS: readonly RegExp[] = [
  // Hostile suppress-the-crowd — Designer Q1 hostile extension. Whole-line
  // anchored because "你们别烦" embedded in "请你们别烦他" (rare) is legitimate.
  /^你们别(?:烦|闹|吵)[!！~～]*$/,
  /你们事(?:真|都)?多/,
  /你们节目(?:真|都)?多/,
  /你们毛病(?:真|都)?多/,
  /你们真能折腾/,
  /你们又来了|你们又开始了|你们怎么又/,
  /有病(?:吧|啊)?你们|你们有病(?:吧|啊|么)?/,
  /^你们几个(?:又|真|怎么|在|搁|干嘛|干啥|有病|事)/,
  /你们都[^\s]{0,8}啊/,
];

/** True iff compact form matches any plural-you spectator-judgment template. */
export function hasPluralYouScopeClaim(rawText: string): boolean {
  if (typeof rawText !== 'string' || rawText.length === 0) return false;
  const compact = _compact(rawText);
  if (compact.length === 0) return false;
  return PLURAL_YOU_PATTERNS.some(p => p.test(compact));
}

// ── Group B — SELF_CENTERED_SCOPE_CLAIM_PATTERNS ────────────────────────────
// Full-line anchor. Embedded occurrences NOT matched — e.g. "又开始了在讨论音乐"
// has 又开始了 as prefix but is followed by content → NOT a scope-claim.
//
// Tail addressee: optional plural-you (`你们/大家/你俩/诸位/你几个`) BEFORE the
// particle/punct tail. Covers archived 04-23/04-24 live samples where bot ate
// generic 你们 rhetoric and emitted "又来了你们" / "又来这套是吧你们" /
// "又怎么了你们". These are semantically self-centered ("bot feels targeted")
// but shape-wise distinct from Group A (which owns 你们-PREFIX patterns).
//
// Independence invariant: PLURAL_YOU_PATTERNS owns 你们-prefix; this group owns
// 你们-tail. The two never co-fire on any single compact string.
export const SELF_CENTERED_SCOPE_CLAIM_PATTERNS: readonly RegExp[] = [
  /^(?:又来了|又开始了|又来搞我|又在搞我|还来|又一次|有完没完|又来这套(?:是吧|了)?|又怎么了)(?:你们|大家|你俩|诸位|你几个)?[啊了呢吧哦嗷哈]*[。.!?~～！？]*$/,
];

/**
 * True iff bot output is a full-line self-centered scope-claim. Accepts
 * optional trailing particle/punctuation but nothing else after the token.
 * Strips CQ and whitespace before matching.
 */
export function hasSelfCenteredScopeClaim(rawText: string): boolean {
  if (typeof rawText !== 'string' || rawText.length === 0) return false;
  const compact = _compact(rawText);
  if (compact.length === 0) return false;
  return SELF_CENTERED_SCOPE_CLAIM_PATTERNS.some(p => p.test(compact));
}

// ── prevBotTurnAddressed ───────────────────────────────────────────────────
// Checks whether the bot's most-recent own turn was in response to someone
// addressing it. Scans chronological history; finds the last bot message;
// inspects the 2 user messages immediately PRECEDING that bot turn. If either
// of those 2 user msgs contains `[CQ:at,qq=${botUserId}]` OR
// `[CQ:reply,id=<messageId-of-any-bot-msg>]`, returns true.
//
// Cold-start safe: returns false when history has no bot turn, when history
// is empty, or when the window before the bot's prev turn is empty.
export interface HistoryMessage {
  readonly userId: string;
  readonly rawContent?: string;
  readonly content: string;
  readonly messageId?: string;
  readonly timestamp?: number;
}

export function prevBotTurnAddressed(
  history: ReadonlyArray<HistoryMessage>,
  botUserId: string,
): boolean {
  if (!history || history.length === 0) return false;
  if (!botUserId) return false;

  // Find index of LAST bot message (scan right-to-left).
  let botIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.userId === botUserId) {
      botIdx = i;
      break;
    }
  }
  if (botIdx <= 0) return false; // no bot turn, or bot was first — no window

  // Collect all bot messageIds seen at or before botIdx (for CQ:reply target
  // matching). Bot may have multiple prior turns; a reply-to-any-bot-msg in
  // the window still counts as "addressed".
  const botMessageIds = new Set<string>();
  for (let i = 0; i <= botIdx; i++) {
    const m = history[i]!;
    if (m.userId === botUserId && m.messageId) {
      botMessageIds.add(m.messageId);
    }
  }

  // Window = last 2 user (non-bot) msgs before botIdx.
  const window: HistoryMessage[] = [];
  for (let i = botIdx - 1; i >= 0 && window.length < 2; i--) {
    const m = history[i]!;
    if (m.userId === botUserId) continue; // skip earlier bot turns
    window.push(m);
  }
  if (window.length === 0) return false;

  const atBotRe = new RegExp(`\\[CQ:at,qq=${botUserId}(?:[,\\]])`);
  const replyIdRe = /\[CQ:reply,[^\]]*\bid=(-?\d+)/g;

  for (const m of window) {
    const txt = m.rawContent ?? m.content ?? '';
    if (atBotRe.test(txt)) return true;
    // Reset regex lastIndex via fresh exec loop — `g` flag keeps state.
    replyIdRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = replyIdRe.exec(txt)) !== null) {
      if (botMessageIds.has(match[1]!)) return true;
    }
  }
  return false;
}

// ── botIsInCurrentThread (R2.5.1-annex C) ──────────────────────────────────
// 4th condition for Group B fire block. Returns true when the bot is a real
// participant in the current thread, so the self-centered scope-claim guard
// should NOT fire (because bot is plausibly addressed even without an explicit
// @ or reply-to-bot CQ on THIS turn).
//
// Three OR'd sub-conditions (any → return true):
//   (a) Within the last 3 non-bot user turns, some turn @bot or reply-to-bot.
//   (b) engagedTopic for the group is still valid (nowMs < until) AND the
//       trigger's tokens (after FOLLOWUP_FUNCTION_WORDS filter) overlap the
//       topic's token set by ≥ 1 entry.
//   (c) Walking the trigger's [CQ:reply,id=N] chain up to 3 hops lands on a
//       message authored by botUserId. (Hop 1 = the trigger's first reply
//       target; trigger itself is hop 0.)
//
// Cold-start safe: empty history → all sub-conditions false → return false.
// engagedTopicEntry=undefined → (b) skipped. No reply-id → (c) skipped.
export function botIsInCurrentThread(
  triggerMsg: { readonly content: string; readonly rawContent?: string },
  recentHistory: ReadonlyArray<HistoryMessage>,
  engagedTopicEntry: { readonly tokens: ReadonlySet<string>; readonly until: number; readonly msgCount: number } | undefined,
  botUserId: string,
  nowMs: number,
): boolean {
  if (!botUserId) return false;
  const history = recentHistory ?? [];

  // Build botMessageIds across ALL of recentHistory (not bounded by botIdx).
  const botMessageIds = new Set<string>();
  for (const m of history) {
    if (m.userId === botUserId && m.messageId) botMessageIds.add(m.messageId);
  }

  const atBotRe = new RegExp(`\\[CQ:at,qq=${botUserId}(?:[,\\]])`);
  const replyIdRe = /\[CQ:reply,[^\]]*\bid=(-?\d+)/g;

  // (a) Recent direct-address window — last 3 non-bot user turns.
  {
    const window: HistoryMessage[] = [];
    for (let i = history.length - 1; i >= 0 && window.length < 3; i--) {
      const m = history[i]!;
      if (m.userId === botUserId) continue;
      window.push(m);
    }
    for (const m of window) {
      const txt = m.rawContent ?? m.content ?? '';
      if (atBotRe.test(txt)) return true;
      replyIdRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = replyIdRe.exec(txt)) !== null) {
        if (botMessageIds.has(match[1]!)) return true;
      }
    }
  }

  // (b) Engaged-topic content overlap (filtered by FOLLOWUP_FUNCTION_WORDS).
  if (engagedTopicEntry !== undefined && nowMs < engagedTopicEntry.until) {
    const raw = extractTokens(triggerMsg.content);
    for (const t of raw) {
      if (FOLLOWUP_FUNCTION_WORDS.has(t)) continue;
      if (engagedTopicEntry.tokens.has(t)) return true;
    }
  }

  // (c) Reply-chain walk, max 3 hops; hop 1 = first reply target.
  {
    const byId = new Map<string, HistoryMessage>();
    for (const m of history) {
      if (m.messageId !== undefined) byId.set(m.messageId, m);
    }
    let cur = triggerMsg.rawContent ?? triggerMsg.content ?? '';
    for (let hop = 1; hop <= 3; hop++) {
      const m = /\[CQ:reply,[^\]]*\bid=(-?\d+)/.exec(cur);
      if (!m) break;
      const target = byId.get(m[1]!);
      if (!target) break;
      if (target.userId === botUserId) return true;
      cur = target.rawContent ?? target.content ?? '';
    }
  }

  return false;
}
