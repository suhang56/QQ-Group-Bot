/**
 * R4-lite — Pure-sync rule-based classifier mapping a strategy-preview context
 * to a single UtteranceAct. STATIC CONSTRAINT: no async, no Promise, no I/O,
 * no DB, no LLM. Violation breaks tests (test/utils/strategy-preview.test.ts row 28).
 */

import type { StrategyPreviewContext, UtteranceAct } from './utterance-act.js';

const SUMMARIZE_RE = /总结|概括|tldr|前情提要|刚才发生啥/i;
const CONFLICT_RE  = /你死|干架|冲突|约架|打架|互喷|互骂|对线/;
const BOT_REFERENT_RE = /小号|bot|机器人|@bot|被禁|被踢|被管|停机|重启/i;
const QUESTION_RE = /[?？]|吗|什么|怎么|谁|哪|为什么/;
const IMAGE_OR_MFACE_RE = /\[CQ:(?:image|mface),/;
const CQ_STRIP_RE = /\[CQ:[^\]]+\]/g;

function _stripCq(s: string): string {
  return s.replace(CQ_STRIP_RE, '').trim();
}

function _hasBotReferent(currentContent: string, recent5: Array<{ content: string }>): boolean {
  if (BOT_REFERENT_RE.test(currentContent)) return true;
  for (const m of recent5) {
    if (BOT_REFERENT_RE.test(m.content)) return true;
  }
  return false;
}

function _isObjectReact(
  msg: StrategyPreviewContext['msg'],
  hasKnownFactTerm: boolean,
  hasRealFactHit: boolean | undefined,
): boolean {
  const content = msg.content;
  if (!IMAGE_OR_MFACE_RE.test(content)) return false;
  const stripped = _stripCq(content);
  // Condition A: pure image/mface, no caption text
  if (stripped.length === 0) return true;
  // Condition B: short caption 1–12 chars, non-question, no fact term hit
  if (stripped.length > 12) return false;
  if (QUESTION_RE.test(stripped)) return false;
  if (hasKnownFactTerm) return false;
  // hasRealFactHit only gates when defined; undefined (Router) ⇒ rely on hasKnownFactTerm only
  if (hasRealFactHit === true) return false;
  return true;
}

export function classifyUtteranceAct(ctx: StrategyPreviewContext): UtteranceAct {
  const { msg, recent5Msgs, hasKnownFactTerm, hasRealFactHit, relayHit } = ctx;

  // 1. Relay (caller pre-computes via detectRelay)
  if (relayHit) return 'relay';

  // 2. Conflict
  if (CONFLICT_RE.test(msg.content)) return 'conflict_handle';

  // 3. Summarize narrow — direct + keyword OR keyword alone
  if (SUMMARIZE_RE.test(msg.content)) return 'summarize';

  // 4. Bot-referent 5-msg window anchor
  if (_hasBotReferent(msg.content, recent5Msgs)) {
    if (msg.isDirect || msg.isAtMention) return 'bot_status_query';
    return 'meta_admin_status';
  }

  // 5. Object react
  if (_isObjectReact(msg, hasKnownFactTerm, hasRealFactHit)) return 'object_react';

  // 6. Direct chat
  if (msg.isDirect) return 'direct_chat';

  // 7. Chime in (caller filters shouldReply=false; defensive fall-through still returns chime_in)
  return 'chime_in';
}
