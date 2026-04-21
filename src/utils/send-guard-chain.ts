/**
 * PR1: Send-time guard chain scaffold.
 *
 * Chain is populated incrementally: PR1 adds `stickerLeakGuard`; PR2 appends
 * harassment hard-gate; PR4 appends persona fabrication guard. `buildSendGuards`
 * is the single composition point so chat.ts call-sites stay identical across
 * PRs.
 */

import type { GroupMessage } from '../adapter/napcat.js';
import { stripStickerTokens } from './sticker-token-output-guard.js';
import { harassmentHardGate } from './output-hard-gate.js';
import { personaFabricationGuard } from './persona-fabrication-guard.js';

export interface SendGuardCtx {
  groupId: string;
  triggerMessage: GroupMessage;
  isDirect: boolean;
  resultKind: 'reply' | 'fallback' | 'sticker';
}

export type GuardResult =
  | { passed: true; text: string }
  | { passed: false; reason: string; replacement: 'silent' | 'neutral-ack' | 'deflection' };

export type SendGuard = (text: string, ctx: SendGuardCtx) => GuardResult;

/**
 * For-loop early-return chain. First failing guard short-circuits. Each guard
 * sees the text produced by the previous passing guard, so partial strips
 * thread through.
 */
export function runSendGuardChain(
  guards: readonly SendGuard[],
  text: string,
  ctx: SendGuardCtx,
): GuardResult {
  let current = text;
  for (const guard of guards) {
    const result = guard(current, ctx);
    if (!result.passed) return result;
    current = result.text;
  }
  return { passed: true, text: current };
}

export const stickerLeakGuard: SendGuard = (text, ctx) => {
  if (ctx.resultKind === 'sticker') return { passed: true, text };
  const { stripped, hadToken, wasTokenOnly } = stripStickerTokens(text);
  if (!hadToken) return { passed: true, text };
  if (wasTokenOnly || stripped === '') {
    return { passed: false, reason: 'sticker-leak-stripped', replacement: 'silent' };
  }
  return { passed: true, text: stripped };
};

export function buildSendGuards(): SendGuard[] {
  return [stickerLeakGuard, harassmentHardGate, personaFabricationGuard];
}
