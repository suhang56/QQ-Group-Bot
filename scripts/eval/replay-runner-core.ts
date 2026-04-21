/**
 * R6.3 — Replay runner core (testable without CLI).
 *
 * Exports:
 *   withTimeout(p, ms)       — Promise.race + setTimeout, t.unref?.() safe
 *   constructChatModule(...) — builds a ChatModule against tmp-copy DB
 *   buildReplayRow(...)      — single source of truth for ReplayRow shape
 *   runReplayRow(...)        — one-sample generate + tag + row build
 *
 * Aggregation helpers live in ./replay-summary.ts (re-exported here for
 * backwards-compat callers / tests).
 *
 * See DEV-READY §2.2, §3.2, §3.3.
 */

import { ChatModule } from '../../src/modules/chat.js';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type { ChatResult } from '../../src/utils/chat-result.js';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import { hasHarassmentTemplate } from '../../src/utils/output-hard-gate.js';
import { hasSelfPersonaFabrication } from '../../src/utils/persona-fabrication-guard.js';
import type { GoldLabel } from './gold/types.js';
import type {
  ReplayerArgs,
  ReplayRow,
  UtteranceAct,
} from './replay-types.js';
import {
  computeViolationTags,
  type ProjectedRow,
  type ViolationTag,
} from './violation-tags.js';
import { classifyUtterance } from './classify-utterance.js';

export { aggregateSummary } from './replay-summary.js';
export type { ReplayerArgs };

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeoutP]).finally(() => {
    if (t) clearTimeout(t);
  });
}

/**
 * Build a ChatModule wired for replay: real IClaudeClient stub, real Database
 * (caller supplies a tmp-copy path — NEVER pass the prod DB directly), and
 * every writer-facing source left null. Background timers disabled.
 *
 * DEV-READY §3.2 enumerates the write surfaces stubbed by construction.
 */
export function constructChatModule(args: {
  tmpDbPath: string;
  botQQ: string;
  mockClaude: IClaudeClient;
}): { chat: ChatModule; db: Database } {
  if (!args.tmpDbPath.includes('.tmp') && !args.tmpDbPath.includes('synthetic')) {
    throw new Error(
      `constructChatModule refuses to open a DB path that does not look tmp/synthetic: ${args.tmpDbPath}`,
    );
  }
  const db = new Database(args.tmpDbPath);
  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
  return { chat, db };
}

interface BuildReplayRowArgs {
  sampleId: string;
  category: number;
  gold: GoldLabel;
  triggerMessageId: string;
  result: ChatResult | { kind: 'error'; errorMessage: string };
  durationMs: number;
  violationTags: ViolationTag[];
  utteranceAct: UtteranceAct;
}

/**
 * Single source of truth for ReplayRow shape. Every result-kind branch
 * produces the full ReplayRow with explicit nulls per the §2.1 table. Key
 * order inside the returned object mirrors the interface declaration for
 * stable JSON.stringify diffs.
 */
export function buildReplayRow(args: BuildReplayRowArgs): ReplayRow {
  const {
    sampleId, category, gold, triggerMessageId, result,
    durationMs, violationTags, utteranceAct,
  } = args;

  const base = {
    sampleId,
    category,
    goldAct: gold.goldAct,
    goldDecision: gold.goldDecision,
    factNeeded: gold.factNeeded,
    allowBanter: gold.allowBanter,
    allowSticker: gold.allowSticker,
  };

  if (result.kind === 'error') {
    return {
      ...base,
      resultKind: 'error',
      reasonCode: null,
      utteranceAct: 'none',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: null,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: result.errorMessage,
      durationMs,
    };
  }

  if (result.kind === 'reply') {
    return {
      ...base,
      resultKind: 'reply',
      reasonCode: result.reasonCode,
      utteranceAct,
      guardPath: result.meta.guardPath ?? null,
      targetMsgId: triggerMessageId,
      usedFactHint: result.meta.usedFactHint,
      matchedFactIds: [...result.meta.matchedFactIds],
      injectedFactIds: [...result.meta.injectedFactIds],
      replyText: result.text,
      promptVariant: result.meta.promptVariant ?? null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  if (result.kind === 'sticker') {
    return {
      ...base,
      resultKind: 'sticker',
      reasonCode: result.reasonCode,
      utteranceAct: 'object_react',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: result.cqCode,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  if (result.kind === 'fallback') {
    return {
      ...base,
      resultKind: 'fallback',
      reasonCode: result.reasonCode,
      utteranceAct: 'unknown',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: result.text,
      promptVariant: null,
      violationTags: [...violationTags],
      errorMessage: null,
      durationMs,
    };
  }

  // silent | defer
  return {
    ...base,
    resultKind: result.kind,
    reasonCode: result.reasonCode,
    utteranceAct: 'none',
    guardPath: null,
    targetMsgId: triggerMessageId,
    usedFactHint: null,
    matchedFactIds: null,
    injectedFactIds: null,
    replyText: null,
    promptVariant: null,
    violationTags: [...violationTags],
    errorMessage: null,
    durationMs,
  };
}

interface RunReplayRowArgs {
  chat: ChatModule;
  groupId: string;
  triggerMessage: GroupMessage;
  recentMessages: GroupMessage[];
  gold: GoldLabel;
  category: number;
  perSampleTimeoutMs: number;
}

/**
 * Run a single replay sample end-to-end: generate via ChatModule, catch any
 * error/timeout, classify, tag, build ReplayRow. Returns the row.
 */
export async function runReplayRow(args: RunReplayRowArgs): Promise<ReplayRow> {
  const start = Date.now();
  let result: ChatResult | { kind: 'error'; errorMessage: string };
  try {
    result = await withTimeout(
      args.chat.generateReply(args.groupId, args.triggerMessage, args.recentMessages),
      args.perSampleTimeoutMs,
    );
  } catch (err) {
    result = { kind: 'error', errorMessage: err instanceof Error ? err.message : String(err) };
  }
  const durationMs = Date.now() - start;

  const utteranceAct: UtteranceAct =
    result.kind === 'error' ? 'none' : classifyUtterance(result);

  // R2.5 — derive per-guard fired flags from reasonCode / meta.guardPath.
  // reasonCode is the primary signal for silent paths (SF1 → 'dampener',
  // SF2 → 'self-echo', SF3 → 'scope'). When scope fires we need to
  // distinguish bot-not-addressee vs 你们-in-small-scene — the former uses
  // reasonCode 'scope' with NO meta.guardPath, the latter with guardPath
  // 'addressee-regen' (existing) or none when fast-path silent. Since SF3
  // 你们-filter reuses the addressee-regen guardPath, we key off it;
  // bot-not-addressee path sets no guardPath.
  const reasonCode = result.kind === 'error' ? null : (result.reasonCode ?? null);
  const guardPath =
    result.kind === 'error' || result.kind === 'reply' || result.kind === 'sticker'
      ? (result.kind === 'reply' ? (result.meta.guardPath ?? null) : null)
      : (result.kind === 'silent' || result.kind === 'fallback' || result.kind === 'defer')
        ? (result.meta.guardPath ?? null)
        : null;

  const projected: ProjectedRow = {
    category: args.category,
    resultKind: result.kind,
    utteranceAct,
    targetMsgId: args.triggerMessage.messageId,
    matchedFactIds:
      result.kind === 'reply' ? [...result.meta.matchedFactIds] : null,
    replyText:
      result.kind === 'reply' || result.kind === 'fallback'
        ? result.text
        : result.kind === 'sticker'
          ? result.cqCode
          : null,
    reasonCode,
    dampenerFired: reasonCode === 'dampener' || reasonCode === 'dampener-ack',
    selfEchoFired: reasonCode === 'self-echo' || guardPath === 'self-echo-regen',
    scopeGuardFired: reasonCode === 'scope' && guardPath === 'addressee-regen',
    botNotAddresseeFired: reasonCode === 'scope' && guardPath !== 'addressee-regen',
    stickerLeakFired: reasonCode === 'sticker-leak-stripped',
    hardGateFired: reasonCode === 'hard-gate-blocked',
    harassmentEscalationFired:
      (result.kind === 'reply' || result.kind === 'fallback')
        ? hasHarassmentTemplate(result.text)
        : false,
    personaFabricationFired: reasonCode === 'persona-fabricated',
    personaFabricatedInOutput:
      (result.kind === 'reply' || result.kind === 'fallback')
        ? hasSelfPersonaFabrication(result.text)
        : false,
  };

  const violationTags = computeViolationTags(args.gold, projected, args.triggerMessage.messageId);

  return buildReplayRow({
    sampleId: args.gold.sampleId,
    category: args.category,
    gold: args.gold,
    triggerMessageId: args.triggerMessage.messageId,
    result,
    durationMs,
    violationTags,
    utteranceAct,
  });
}
