/**
 * Apply WeakReplayLabel to a BenchmarkRow using 9-step precedence.
 * First match wins, mirroring R4-lite's strategy classifier.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  BenchmarkRow,
  WeakReplayLabel,
  LabeledBenchmarkRow,
  ExpectedAct,
  ExpectedDecision,
  ContextMsg,
} from './types.js';
import { hasKnownFactTermInDb } from './categories/known-fact-term.js';

const ADMIN_CMD_RE = /^\/[a-z_]+/;
const RELAY_VOTE_RE = /^[\+＋1１]$|^支持$|^同意$|^顶$|^扣1$|^1$/;
const RELAY_CLAIM_RE = /^(抢|来了|\d+楼|先来|占楼)$/;
const RELAY_ECHO_RE_MAX_LEN = 4;
const RELAY_WINDOW_SEC = 30;
const CONFLICT_RE =
  /滚|傻|蠢|笨|垃圾|废物|白痴|脑残|你去死|草你|卧槽|fuck|shit|nmsl|sb|nb|cnm|妈的|干你|操你/i;
const SUMMARIZE_RE = /总结|回顾|recap|summary|说了什么|聊了啥/i;
const BOT_AT_RE_STR = (botId: string) => `\\[CQ:at,qq=${botId}[^\\]]*\\]`;
const BOT_STATUS_RE = /禁言|策略|机器人|bot|关了|开了|休眠|屏蔽|封禁|管理员/i;
const IMAGE_CQ_RE = /\[CQ:(?:image|mface|face)[^\]]*\]/;
const PLURAL_YOU_RE = /你们/;
const TRAILING_PUNCT_RE = /[.!?,。！？，、]+$/;

function normalize(s: string): string {
  return s.replace(/\[CQ:[^\]]*\]/g, '').trim().replace(TRAILING_PUNCT_RE, '');
}

function detectRelay(content: string, context: ContextMsg[]): boolean {
  const cleaned = normalize(content);
  if (!cleaned) return false;
  const windowStart: number = context.length > 0
    ? (context[context.length - 1]?.timestamp ?? 0) - RELAY_WINDOW_SEC
    : 0;
  const recent = context.filter(c => c.timestamp >= windowStart);

  if (RELAY_VOTE_RE.test(cleaned)) {
    return recent.filter(c => RELAY_VOTE_RE.test(normalize(c.content))).length >= 2;
  }
  if (RELAY_CLAIM_RE.test(cleaned)) {
    return recent.filter(c => RELAY_CLAIM_RE.test(normalize(c.content))).length >= 2;
  }
  const len = cleaned.length;
  if (len >= 1 && len <= RELAY_ECHO_RE_MAX_LEN) {
    return recent.filter(c => normalize(c.content) === cleaned).length >= 2;
  }
  return false;
}

function detectConflict(content: string, context: ContextMsg[]): boolean {
  const combined = [content, ...context.map(c => c.content)].join(' ');
  return CONFLICT_RE.test(combined);
}

function detectSummarize(content: string, context: ContextMsg[]): boolean {
  return SUMMARIZE_RE.test(content) && context.length >= 20;
}

function detectBotReferent(content: string, raw: string, botUserId: string): boolean {
  const atBot = new RegExp(BOT_AT_RE_STR(botUserId));
  return atBot.test(raw) || atBot.test(content);
}

function detectIsObjectReact(raw: string, content: string): boolean {
  if (!IMAGE_CQ_RE.test(raw)) return false;
  const stripped = content.replace(/\[CQ:[^\]]*\]/g, '').trim();
  const isShortNonQuestion = stripped.length <= 12 && !/[？?]/.test(stripped);
  return stripped.length === 0 || isShortNonQuestion;
}

function detectIsDirect(raw: string, botUserId: string): boolean {
  const atBot = new RegExp(BOT_AT_RE_STR(botUserId));
  return atBot.test(raw) || /\[CQ:reply,/.test(raw);
}

export function applyWeakLabel(
  row: BenchmarkRow,
  db: DatabaseSync,
  botUserId: string,
  historyLength: number,
): LabeledBenchmarkRow {
  const context = row.triggerContext;
  const content = row.content;
  const raw = (row as unknown as Record<string, unknown>)['rawContent'] as string ?? content;

  const hasKnownFact = hasKnownFactTermInDb(db, {
    id: parseInt(row.messageId, 10),
    group_id: row.groupId,
    user_id: row.userId,
    nickname: row.nickname,
    content: row.content,
    raw_content: raw,
    timestamp: row.timestamp,
    source_message_id: null,
  });

  const isRelay = detectRelay(content, context);
  const isDirect = detectIsDirect(raw, botUserId);
  const isBotStatus = BOT_STATUS_RE.test([content, ...context.map(c => c.content)].join(' '));
  const isImage = IMAGE_CQ_RE.test(raw);
  const isObjectReact = detectIsObjectReact(raw, content);
  const isBurst = (() => {
    const ts = row.timestamp;
    const windowStart = ts - 15;
    return context.filter(c => c.timestamp >= windowStart).length + 1 >= 5;
  })();
  const allowPluralYou = PLURAL_YOU_RE.test([content, ...context.map(c => c.content)].join(' '));

  const riskFlags: string[] = [];

  // Step 1: admin command — skip (not included in benchmark)
  if (ADMIN_CMD_RE.test(content.trim())) {
    riskFlags.push('admin-command-skipped');
  }

  let expectedAct: ExpectedAct;
  let expectedDecision: ExpectedDecision;

  // Step 2: relay
  if (isRelay) {
    expectedAct = 'relay';
    expectedDecision = 'reply';
  }
  // Step 3: conflict
  else if (detectConflict(content, context)) {
    expectedAct = 'conflict_handle';
    expectedDecision = 'reply';
  }
  // Step 4: summarize
  else if (detectSummarize(content, context) && historyLength >= 20) {
    expectedAct = 'summarize';
    expectedDecision = 'reply';
  }
  // Step 5: bot-referent + status keywords
  else if (isBotStatus) {
    const botReferent = detectBotReferent(content, raw, botUserId);
    expectedAct = botReferent ? 'bot_status_query' : 'meta_admin_status';
    expectedDecision = 'reply';
  }
  // Step 6: pure image/mface or image+short caption + no known-fact
  else if (isObjectReact && !hasKnownFact) {
    expectedAct = 'object_react';
    expectedDecision = 'reply';
  }
  // Step 7: direct + not above
  else if (isDirect) {
    expectedAct = 'direct_chat';
    expectedDecision = 'reply';
  }
  // Step 8: other reply-worthy
  else if (!isSilenceCandidate(content, context)) {
    expectedAct = 'chime_in';
    expectedDecision = 'reply';
  }
  // Step 9: silence candidate
  else {
    expectedAct = 'chime_in';
    expectedDecision = 'silent';
  }

  const label: WeakReplayLabel = {
    expectedAct,
    expectedDecision,
    hasKnownFactTerm: hasKnownFact,
    hasRealFactHit: hasKnownFact,
    allowPluralYou,
    isObjectReact,
    isBotStatusContext: isBotStatus,
    isBurst,
    isRelay,
    isDirect,
    riskFlags,
  };

  return { ...row, label };
}

function isSilenceCandidate(content: string, context: ContextMsg[]): boolean {
  const c = content.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!c) return true;
  const speakerIds = new Set(context.map(m => m.userId));
  if (speakerIds.size === 0) return true;
  if (speakerIds.size === 1 && context.length >= 5) return true;
  return false;
}
