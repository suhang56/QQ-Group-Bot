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
// Tail: optional sentence-end particle + optional punct.
export const SELF_CENTERED_SCOPE_CLAIM_PATTERNS: readonly RegExp[] = [
  /^(?:又来了|又开始了|又来搞我|又在搞我|还来|又一次|有完没完)[啊了呢吧哦嗷哈]*[。.!?~～！？]*$/,
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
